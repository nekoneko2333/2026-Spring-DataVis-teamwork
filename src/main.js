import "./styles.css";
import * as d3 from "d3";
import { state, bus, normToLog, logToNorm } from "./state.js";
import { DataManager } from "./data/DataManager.js";
import { TransferFunction } from "./visualization/TransferFunction.js";
import { VolumeRenderer } from "./visualization/VolumeRenderer.js";
import { Histogram } from "./charts/Histogram.js";
import { Fingerprint } from "./charts/Fingerprint.js";
import { TimeSeries } from "./charts/TimeSeries.js";
import { PowerSpectrum } from "./charts/PowerSpectrum.js";
import { Timeline } from "./charts/Timeline.js";
import { ProbePanel } from "./charts/ProbePanel.js";

const $ = (s) => document.querySelector(s);
const TOTAL_VOX = 128 * 128 * 128;
const fmt = (v, d = 3) => (v == null ? "—" : d3.format(`.${d}g`)(v));

class App {
  constructor() {
    this.dm = new DataManager();
    this.fullResTimer = null;
    this.labelTimer = null;
    this.lastStepTime = 0;
    this.stepInterval = 78; // ms, ≈13 步/s 播放
    this.playbackSteps = 110; // 播放时降低 ray-march 步进数(弱机更流畅)
    this.tabCharts = {};
  }

  async start() {
    const { meta, stats, hist, power, morph } = await this.dm.init();
    state.meta = meta; state.stats = stats; state.histograms = hist; state.power = power; state.morphology = morph;
    this.percent = (k) => logToNorm(meta.globalPercentiles[k]);

    await this.dm.loadPreview();

    this.tf = new TransferFunction(meta);
    this.renderer = new VolumeRenderer($("#glcanvas"), meta, this.tf.texture);
    this.renderer.setHiClip(this.percent("99"));
    this.renderer.setLoClip(this.percent("25"));
    this.renderer.onFrame = () => this._tick();

    this._buildCharts();
    this._buildUI();
    this._bindEvents();

    await this.applyStep(0, { force: true });
    this._setView(0);
    $("#loadingOverlay").classList.add("hidden");
    setTimeout(() => this._resizeAll(), 60);
  }

  // ---------------- charts ----------------
  _buildCharts() {
    const { meta, stats, histograms, power, morphology } = state;
    this.histogram = new Histogram($("#histChart"), meta, (sel) => this._onBrush(sel, "hist"));
    this.histogram.setTF(this.tf);
    this.fingerprint = new Fingerprint($("#fingerprintChart"), meta, histograms);
    this.series = new TimeSeries($("#seriesChart"), [
      { key: "gini", label: "Gini", color: "#d97706", values: stats.steps.map((s) => s.gini) },
      { key: "entropy", label: "熵", color: "#0d8c8a", values: stats.steps.map((s) => s.entropy) },
      { key: "variance", label: "方差", color: "#6d5ef0", values: stats.steps.map((s) => s.variance) },
      { key: "kurtosis", label: "峰度", color: "#db2777", values: stats.steps.map((s) => s.kurtosis) },
      { key: "skewness", label: "偏度", color: "#2e9e4f", values: stats.steps.map((s) => s.skewness) },
      { key: "maxlog", label: "max logρ", color: "#e8590c", values: stats.steps.map((s) => s.max) },
    ]);
    this.power = new PowerSpectrum($("#powerChart"), power);
    this.timeline = new Timeline($("#timelineChart"), stats, morphology, (s) => this.setStep(s));
    this.probe = new ProbePanel($("#probeChart"), meta);
    this.tabCharts = {
      hist: [this.histogram], fingerprint: [this.fingerprint],
      series: [this.series], power: [this.power], probe: [this.probe],
    };
  }

  // ---------------- UI ----------------
  _buildUI() {
    // 时间轴 legend
    $("#timelineLegend").innerHTML =
      `<span style="color:#2563eb">早期(低Gini)</span><span style="color:#c06a09">晚期(高Gini)</span><span style="color:#5d6b86">大小=高密度占比</span>`;
    // 统计格
    this.statKeys = [
      ["max", "max log ρ", "gold"], ["mean", "mean", ""], ["std", "std", ""], ["median", "median", ""],
      ["skewness", "偏度", "cyan"], ["kurtosis", "峰度", "cyan"], ["gini", "Gini", "gold"], ["entropy", "熵", "cyan"],
    ];
    $("#statGrid").innerHTML = this.statKeys.map(([k, lbl, cls]) =>
      `<div class="stat-cell"><div class="k">${lbl}</div><div class="v ${cls}" id="stat-${k}">—</div></div>`).join("");
    // 形态学 bars
    this.morphClasses = [["void", "空洞", "#46568a"], ["sheet", "墙", "#2f74e0"], ["filament", "丝", "#0ea5a3"], ["node", "节点", "#d68a06"]];
    $("#morphBars").innerHTML = this.morphClasses.map(([k, lbl, c]) =>
      `<div class="morph-row"><span class="name">${lbl}</span><div class="bar"><div id="morph-${k}" style="background:${c}"></div></div><span class="pct" id="morphpct-${k}">—</span></div>`).join("");
    // atlas 控制
    $("#atlasControls").innerHTML = `
      <div class="method-switch" id="methodSwitch">
        <button data-method="tweb" class="active">T-web (势场)</button>
        <button data-method="proxy">density-Hessian</button>
      </div>
      <div class="toggle-row" id="clsToggles">
        <div class="cls-toggle" data-cls="sheet"><span class="sw" style="background:#2f74e0"></span>墙</div>
        <div class="cls-toggle" data-cls="filament"><span class="sw" style="background:#0ea5a3"></span>丝</div>
        <div class="cls-toggle" data-cls="node"><span class="sw" style="background:#d68a06"></span>节点</div>
      </div>
      <label>叠加强度 <input type="range" id="atlasOpacity" min="0.1" max="0.95" step="0.05" value="0.55"></label>
      <div id="methodNote" style="font-size:10px;opacity:.7"></div>`;
    this._updateMethodNote();
    // probe 控制
    $("#probeControls").innerHTML = `
      <label>A <input type="range" id="probeA" min="0.05" max="2" step="0.05" value="0.55"><span id="probeAv">0.55</span></label>
      <label>β <input type="range" id="probeBeta" min="0.6" max="3" step="0.1" value="1.6"><span id="probeBv">1.6</span></label>
      <span style="opacity:.7">密度驱动 proxy: τ = A·∫ρ^β ds, F = e^(−τ) (非严格辐射转移)</span>
      <button id="probeClear" class="action" style="padding:4px 10px">清除探针</button>`;
    this._renderTFEditor();
  }

  _renderTFEditor() {
    const host = $("#tfEditor");
    host.innerHTML = "";
    const stops = this.tf.cssStops();
    const grad = stops.map((s) => `${s.color} ${(s.p * 100).toFixed(1)}%`).join(",");
    const bar = document.createElement("div");
    Object.assign(bar.style, { position: "absolute", left: 0, right: 0, bottom: 0, height: "16px", borderRadius: "4px", background: `linear-gradient(90deg, ${grad})` });
    host.appendChild(bar);
    const svg = d3.select(host).append("svg").style("width", "100%").style("height", "calc(100% - 18px)");
    const r = host.getBoundingClientRect();
    const w = r.width, h = Math.max(40, r.height - 18);
    const x = d3.scaleLinear().domain([0, 1]).range([0, w]);
    const y = d3.scaleLinear().domain([0, 1]).range([h, 4]);
    const ac = this.tf.alphaCurve();
    const area = d3.area().x((d) => x(d.p)).y0(h).y1((d) => y(d.a)).curve(d3.curveMonotoneX);
    svg.append("path").attr("d", area(ac)).attr("fill", "rgba(13,140,138,0.16)").attr("stroke", "#0d8c8a").attr("stroke-width", 1.4);
    svg.append("text").attr("x", 4).attr("y", 12).attr("fill", "#5d6b86").attr("font-size", 9).text("不透明度 ↑");
  }

  // ---------------- events ----------------
  _bindEvents() {
    $("#timeSlider").addEventListener("input", (e) => { this.pause(); this.setStep(+e.target.value); });
    $("#btnPlay").addEventListener("click", () => this.togglePlay());

    $("#modeTabs").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      this._setMode(+b.dataset.mode);
    });

    $("#bottomTabs").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      this._setTab(b.dataset.tab);
    });

    $("#brushQuick").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      this._quickBrush(b.dataset.brush, b);
    });

    $("#tfPresets").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      $("#tfPresets .active")?.classList.remove("active"); b.classList.add("active");
      this.tf.setPreset(b.dataset.preset); this.histogram._recolor(); this._renderTFEditor();
    });

    $("#densityScale").addEventListener("input", (e) => this.renderer.setDensityScale(+e.target.value));
    $("#stepQuality").addEventListener("input", (e) => { state.tf.steps = +e.target.value; if (!state.playing) this.renderer.setSteps(state.tf.steps); });
    $("#isoValue").addEventListener("input", (e) => this.renderer.setIso(+e.target.value));

    // atlas
    $("#btnAtlas").addEventListener("click", () => this._toggleAtlas());
    $("#clsToggles").addEventListener("click", (e) => {
      const t = e.target.closest(".cls-toggle"); if (!t) return;
      const c = t.dataset.cls; state.atlas.classes[c] = !state.atlas.classes[c];
      t.classList.toggle("off", !state.atlas.classes[c]);
      this.renderer.setAtlas(state.atlas.active, state.atlas.opacity, state.atlas.classes);
    });
    $("#atlasOpacity").addEventListener("input", (e) => {
      state.atlas.opacity = +e.target.value;
      this.renderer.setAtlas(state.atlas.active, state.atlas.opacity, state.atlas.classes);
    });
    $("#methodSwitch").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      state.atlas.method = b.dataset.method;
      document.querySelectorAll("#methodSwitch button").forEach((x) => x.classList.toggle("active", x === b));
      this._updateMethodNote();
      this._updateMorph(state.step);
      if (state.atlas.active) this._scheduleLabel(state.step);
    });

    // probe
    $("#btnProbe").addEventListener("click", () => this._toggleProbe());
    $("#probeClear").addEventListener("click", () => { this.renderer.clearProbe(); this.probe.setSamples(null); });
    $("#probeA").addEventListener("input", (e) => { state.probe.A = +e.target.value; $("#probeAv").textContent = e.target.value; this.probe.setParams(state.probe.A, state.probe.beta); });
    $("#probeBeta").addEventListener("input", (e) => { state.probe.beta = +e.target.value; $("#probeBv").textContent = e.target.value; this.probe.setParams(state.probe.A, state.probe.beta); });

    // 时间轴布局切换 (线性 / 螺旋)
    $("#timelineLayout").addEventListener("click", (e) => {
      const next = this.timeline.layout === "linear" ? "spiral" : "linear";
      this.timeline.setLayout(next);
      e.target.textContent = next === "spiral" ? "⟲ 线性" : "⟳ 螺旋";
    });

    // story
    $("#btnStory").addEventListener("click", () => this._toggleStory());

    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { this._toggleProbe(false); } });
    window.addEventListener("resize", () => this._resizeAll());

    // 初始 atlas class 显示
    for (const c of ["sheet", "filament", "node"]) {
      const t = document.querySelector(`.cls-toggle[data-cls="${c}"]`);
      if (t) t.classList.toggle("off", !state.atlas.classes[c]);
    }
  }

  _resizeAll() {
    this.renderer._resize();
    this.histogram.resize(); this.timeline.resize(); this._renderTFEditor();
    const c = this.tabCharts[this._tab || "hist"]; if (c) c.forEach((ch) => ch.resize());
  }

  // ---------------- step / playback ----------------
  async applyStep(step, { fromPlayback = false, force = false } = {}) {
    state.step = step;
    $("#timeSlider").value = step;
    $("#stepLabel").textContent = `t = ${String(step).padStart(4, "0")}`;
    // 图表联动
    this.histogram.update(step, state.histograms.matrix[step]);
    this.fingerprint.update(step); this.series.update(step);
    this.power.update(step); this.timeline.update(step);
    this._updateStatGrid(step); this._updateMorph(step);
    if (state.brush.active) this._updateSelStats(step);
    if (this.histogram.tf) { /* recolored on tf change */ }

    // 低分辨率即时显示
    this.renderer.setVolumeTexture(this.dm.getPreviewTexture(step));
    $("#loadState").textContent = fromPlayback ? "○ 预览(播放)" : "○ 预览";

    // 预取
    this.dm.prefetch(step, this._dir || 1, fromPlayback ? 2 : 3);

    if (state.renderMode === 5) this._scheduleMesh(step);
    if (!fromPlayback) {
      this._scheduleFullRes(step);
      if (state.atlas.active) this._scheduleLabel(step);
    }
    if (force) {
      const tex = await this.dm.getVolumeTexture(step);
      this.renderer.setVolumeTexture(tex);
      $("#loadState").textContent = "● 全分辨率";
    }
  }

  _scheduleFullRes(step) {
    clearTimeout(this.fullResTimer);
    this.fullResTimer = setTimeout(async () => {
      try {
        const tex = await this.dm.getVolumeTexture(step);
        if (state.step === step && !state.playing) {
          this.renderer.setVolumeTexture(tex);
          $("#loadState").textContent = "● 全分辨率";
          // 全分辨率到位后: 选区统计升级为精确值; 探针用全分辨率重采
          if (state.brush.active) this._updateSelStats(step);
          if (state.probe.line && this._tab === "probe") {
            const { samples, full } = this.dm.sampleLine(step, state.probe.line.uvw0, state.probe.line.uvw1, 320);
            this.probe.setSamples(samples, full);
          }
        }
      } catch (e) { /* ignore */ }
    }, 150);
  }

  _scheduleLabel(step) {
    clearTimeout(this.labelTimer);
    this.labelTimer = setTimeout(async () => {
      try {
        const tex = await this.dm.getLabelTexture(step, state.atlas.method);
        if (state.step === step) {
          this.renderer.setLabelTexture(tex);
          this.renderer.setAtlas(state.atlas.active, state.atlas.opacity, state.atlas.classes);
        }
      } catch (e) {}
    }, 120);
  }

  _scheduleMesh(step) {
    clearTimeout(this.meshTimer);
    this.meshTimer = setTimeout(async () => {
      try {
        const m = await this.dm.loadMesh(step);
        if (m && state.renderMode === 5) {
          this.renderer.setMesh(m.positions, m.indices);
          $("#loadState").textContent = `● MC 网格 (步 ${m.step} · ${(m.faces / 1000).toFixed(0)}k 面)`;
        }
      } catch (e) {}
    }, 120);
  }

  _updateMethodNote() {
    const el = $("#methodNote"); if (!el) return;
    el.textContent = state.atlas.method === "tweb"
      ? "严格 T-web: 解 Poisson 求势场潮汐张量特征值分类 (Hahn2007/Forero-Romero2009)"
      : "smoothed log-density Hessian 形态学近似 (非严格 T-web)";
  }

  setStep(step, opts = {}) {
    step = Math.min(state.meta.timeSteps - 1, Math.max(0, step));
    this.applyStep(step, opts);
  }

  togglePlay() { state.playing ? this.pause() : this.play(); }
  play() {
    state.playing = true; $("#btnPlay").textContent = "❚❚"; this.lastStepTime = performance.now();
    this.renderer.setSteps(Math.min(state.tf.steps, this.playbackSteps));  // 播放降步进保帧率
  }
  pause() {
    if (!state.playing) return;
    state.playing = false; $("#btnPlay").textContent = "▶";
    this.renderer.setSteps(state.tf.steps);       // 恢复高质量步进
    this._scheduleFullRes(state.step);            // 暂停后补全分辨率
    if (state.atlas.active) this._scheduleLabel(state.step);
  }

  _tick() {
    if (!state.playing) return;
    const now = performance.now();
    if (now - this.lastStepTime >= this.stepInterval) {
      this.lastStepTime = now;
      this._dir = 1;
      const next = (state.step + 1) % state.meta.timeSteps;
      this.applyStep(next, { fromPlayback: true });
    }
  }

  // ---------------- mode / brush ----------------
  _setMode(m) {
    const prev = state.renderMode;
    state.renderMode = m;
    document.querySelectorAll("#modeTabs button").forEach((b) => b.classList.toggle("active", +b.dataset.mode === m));
    // MC 真实网格模式
    if (m === 5) {
      this.renderer.setMeshMode(true);
      $("#loadState").textContent = "○ 加载 MC 网格…";
      this._scheduleMesh(state.step);
      return;
    }
    if (prev === 5) this.renderer.setMeshMode(false);
    this.renderer.setMode(m);
    // top1% / void 为独立高亮模式: 清除手动刷选, 反向高亮直方图相应区间
    if (m === 3) { this._clearBrush(); this.histogram.setRangeNorm(this.percent("99"), 1); }
    else if (m === 4) { this._clearBrush(); this.histogram.setRangeNorm(0, this.percent("25")); }
  }

  _setTab(tab) {
    this._tab = tab;
    document.querySelectorAll("#bottomTabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.tab === tab));
    const c = this.tabCharts[tab]; if (c) setTimeout(() => c.forEach((ch) => ch.resize()), 20);
  }

  _onBrush(sel, source) {
    if (!sel) { this._clearBrush(); return; }
    state.brush = { active: true, min: sel.min, max: sel.max, label: "custom" };
    if (state.renderMode >= 2) this._setMode(0);
    this.renderer.setBrush(true, sel.min, sel.max);
    this._updateSelStats(state.step);
    document.querySelectorAll("#brushQuick button").forEach((b) => b.classList.remove("active"));
  }

  _quickBrush(kind, btn) {
    document.querySelectorAll("#brushQuick button").forEach((b) => b.classList.remove("active"));
    if (kind === "clear") { this._clearBrush(); return; }
    const ranges = {
      void: [0, this.percent("25")],
      sheet: [this.percent("25"), this.percent("75")],
      filament: [this.percent("75"), this.percent("95")],
      node: [this.percent("95"), 1],
      top1: [this.percent("99"), 1],
      top01: [this.percent("99.9"), 1],
    };
    const [mn, mx] = ranges[kind];
    state.brush = { active: true, min: mn, max: mx, label: kind };
    if (state.renderMode >= 2) this._setMode(0);
    this.renderer.setBrush(true, mn, mx);
    this.histogram.setRangeNorm(mn, mx);
    this._updateSelStats(state.step);
    btn.classList.add("active");
  }

  _clearBrush() {
    state.brush = { active: false, min: 0, max: 1, label: null };
    this.renderer.setBrush(false, 0, 1);
    this.histogram.setRangeNorm(null);
    document.querySelectorAll("#brushQuick button").forEach((b) => b.classList.remove("active"));
    $("#selStats").innerHTML = "框选直方图以筛选体素";
  }

  // ---------------- atlas / probe / story ----------------
  _toggleAtlas() {
    state.atlas.active = !state.atlas.active;
    $("#btnAtlas").classList.toggle("active", state.atlas.active);
    if (state.atlas.active) {
      this._scheduleLabel(state.step);
    } else {
      this.renderer.setAtlas(false, state.atlas.opacity, state.atlas.classes);
    }
  }

  _toggleProbe(force) {
    const on = force != null ? force : !state.probe.active;
    state.probe.active = on;
    $("#btnProbe").classList.toggle("active", on);
    $("#probeHint").classList.toggle("hidden", !on);
    if (on) {
      this.renderer.enablePicking((line) => this._onProbe(line));
      this._setTab("probe");
    } else {
      this.renderer.disablePicking();
      this.renderer.clearProbe();      // 退出探针(ESC/按钮)时一并清除 3D 视线与剖面
      this.probe.setSamples(null);
      state.probe.line = null;
    }
  }

  _onProbe(line) {
    state.probe.line = line;
    const { samples, full } = this.dm.sampleLine(state.step, line.uvw0, line.uvw1, 320);
    this.probe.setParams(state.probe.A, state.probe.beta);
    this.probe.setSamples(samples, full);
    this._setTab("probe");
    // 反向联动: 探针视线跨越的密度区间 -> 高亮直方图对应区段
    let lo = Infinity, hi = -Infinity;
    for (const v of samples) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (isFinite(lo)) this.histogram.setRangeNorm(lo, hi);
  }

  _toggleStory() {
    if (state.story.running) { this._stopStory(); return; }
    this._startStory();
  }

  _startStory() {
    state.story.running = true;
    $("#btnStory").textContent = "■ 停止";
    $("#storyCaption").classList.remove("hidden");
    this.pause(); this._clearBrush();
    const cap = (chapter, text) => { $("#storyCaption").innerHTML = `<span class="chapter">${chapter}</span>${text}`; };
    const tweenStep = (from, to, dur) => new Promise((res) => {
      const t0 = performance.now();
      const run = () => {
        if (!state.story.running) return res();
        const k = Math.min(1, (performance.now() - t0) / dur);
        this.setStep(Math.round(from + (to - from) * k), { fromPlayback: true });
        if (k < 1) requestAnimationFrame(run); else res();
      };
      run();
    });
    const wait = (ms) => new Promise((res) => { this._storyTimer = setTimeout(res, ms); });

    (async () => {
      this._setMode(0);
      cap("第一幕 · 初生", "早期宇宙气体密度近乎均匀, log 密度分布窄而对称, 仅有微弱涨落 —— 结构的种子。");
      this.setStep(0); await wait(3200);
      if (!state.story.running) return;
      cap("第二幕 · 成丝", "引力放大涨落, 物质沿网状丝结构汇聚。刷选中高密度区间, 青色丝状网络逐渐显现。");
      this._quickBrush("filament", document.querySelector('#brushQuick [data-brush="filament"]'));
      await tweenStep(0, 62, 5200);
      if (!state.story.running) return;
      cap("第三幕 · 分化", "晚期密度两极分化: 节点处物质塌缩成最亮团块, 空洞被进一步抽空。高亮 Top1% 致密节点。");
      this._clearBrush(); this._setMode(3);
      await tweenStep(62, 99, 4200);
      if (!state.story.running) return;
      cap("第四幕 · 宇宙图谱", "叠加形态学分类 (Cosmic Atlas): 金=节点, 青=丝, 蓝=墙, 暗=空洞 —— 统计长尾与空间宇宙网一一对应。");
      this._setMode(0);
      if (!state.atlas.active) this._toggleAtlas();
      await wait(5200);
      this._stopStory();
    })();
  }

  _stopStory() {
    state.story.running = false;
    clearTimeout(this._storyTimer);
    $("#btnStory").textContent = "▶ Story Mode";
    $("#storyCaption").classList.add("hidden");
  }

  // ---------------- panels update ----------------
  _updateStatGrid(step) {
    const s = state.stats.steps[step];
    for (const [k] of this.statKeys) {
      const el = $(`#stat-${k}`); if (el) el.textContent = fmt(s[k], 4);
    }
  }

  _updateMorph(step) {
    if (!state.morphology) { $("#morphBars").style.opacity = 0.4; return; }
    const src = (state.atlas.method === "tweb" && state.morphology.tweb)
      ? state.morphology.tweb.steps : state.morphology.steps;
    const f = src[step].fractions;
    for (const [k] of this.morphClasses) {
      const pct = (f[k] || 0) * 100;
      const bar = $(`#morph-${k}`); const lbl = $(`#morphpct-${k}`);
      if (bar) bar.style.width = `${Math.min(100, pct * (k === "node" ? 8 : k === "filament" ? 3 : 1))}%`;
      if (lbl) lbl.textContent = `${pct.toFixed(pct < 1 ? 2 : 1)}%`;
    }
  }

  _updateSelStats(step) {
    const { min, max } = state.brush;
    let count, frac, meanLog, maxLog, src;
    const ex = this.dm.selectionStats(step, min, max);   // 全分辨率逐体素精确
    if (ex) {
      count = ex.count; frac = ex.fraction;
      meanLog = ex.count ? normToLog(ex.meanNorm) : 0;
      maxLog = ex.count ? normToLog(ex.maxNorm) : 0;
      src = "全分辨率精确";
    } else {                                              // 回退: 256 桶直方图估计
      const centers = state.meta.histCenters;
      const span = state.meta.globalLogMax - state.meta.globalLogMin;
      const row = state.histograms.matrix[step];
      let f = 0, wsum = 0, hiBin = -1;
      for (let i = 0; i < row.length; i++) {
        const cn = (centers[i] - state.meta.globalLogMin) / span;
        if (cn >= min && cn <= max) { f += row[i]; wsum += row[i] * centers[i]; if (row[i] > 0) hiBin = i; }
      }
      count = Math.round(f * TOTAL_VOX); frac = f;
      meanLog = f > 0 ? wsum / f : 0; maxLog = hiBin >= 0 ? centers[hiBin] : 0;
      src = "直方图估计";
    }
    const label = { void: "Void 空洞", sheet: "Sheet 墙", filament: "Filament 丝", node: "Node 节点", top1: "Top 1%", top01: "Top 0.1%", custom: "自定义" }[state.brush.label] || "选区";
    $("#selStats").innerHTML = `
      <div style="margin-bottom:6px"><span class="hl">${label}</span> · logρ ∈ [${normToLog(min).toFixed(2)}, ${normToLog(max).toFixed(2)}]</div>
      <table>
        <tr><td>体素数</td><td>${count.toLocaleString()}</td></tr>
        <tr><td>占比</td><td>${(frac * 100).toFixed(2)}%</td></tr>
        <tr><td>均值 logρ</td><td>${meanLog.toFixed(3)}</td></tr>
        <tr><td>最大 logρ</td><td>${maxLog.toFixed(3)}</td></tr>
      </table>
      <div style="font-size:9px;opacity:.65;margin-top:4px">统计口径: ${src}</div>`;
  }

  _setView(step) {
    $("#viewBadges").innerHTML =
      `<div class="badge">数据 <b>128³ · 100 步</b></div>
       <div class="badge">logρ ∈ <b>[${state.meta.globalLogMin.toFixed(2)}, ${state.meta.globalLogMax.toFixed(2)}]</b></div>
       <div class="badge">归一化 <b>全局一致</b></div>`;
  }
}

const app = new App();
window.__app = app;
app.start().catch((e) => {
  console.error(e);
  $("#loadingOverlay").innerHTML = `<div style="color:#ff77c8;padding:20px;text-align:center">加载失败<br><small>${e.message}</small></div>`;
});
