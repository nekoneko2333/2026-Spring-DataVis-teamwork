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
import { DEFAULT_THEME, THEMES } from "./themes.js";

const $ = (s) => document.querySelector(s);
const TOTAL_VOX = 128 * 128 * 128;
const fmt = (v, d = 3) => (v == null ? "—" : d3.format(`.${d}g`)(v));

class App {
  constructor() {
    this.dm = new DataManager();
    this.fullResTimer = null;
    this.labelTimer = null;
    this.playTimer = null;
    this.lastStepTime = 0;
    this.stepInterval = 160; // ms，探索播放按关键帧推进，避免相邻 step 变化太弱
    this.playbackStride = 3; // 每帧跨 3 个数据步，接近手动拖动时的可见变化
    this.playbackSteps = 128; // 播放时保留足够 ray-march 步进，避免体渲染发糊
    this.cinematicSteps = 96;
    this.storyTweenLastStep = -1;
    this.chapterFxTimer = null;
    this.networkModel = "fixed";
    this.networkVisible = true;
    this.renderPreset = "structure";
    this.storyExporting = false;
    this.tabCharts = {};
    this.page = "showcase";
    this.themeName = DEFAULT_THEME;
    this.theme = THEMES[this.themeName];
    this.storyProgressFrame = null;
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
    this._buildCharts();
    this._buildUI();
    this._bindEvents();
    this._applyTheme(this.themeName);
    this._setPage("showcase");

    await this.applyStep(0, { force: true });
    this._setView(0);
    $("#loadingOverlay").classList.add("hidden");
    this._enterCinematicHome();
    setTimeout(() => this._resizeAll(), 60);
  }

  // ---------------- charts ----------------
  _buildCharts() {
    const { meta, stats, histograms, power, morphology } = state;
    this.histogram = new Histogram($("#histChart"), meta, (sel) => this._onBrush(sel, "hist"));
    this.histogram.setTF(this.tf);
    this.fingerprint = new Fingerprint($("#fingerprintChart"), meta, histograms);
    this.series = new TimeSeries($("#seriesChart"), [
      { key: "gini", label: "Gini", color: this.theme.series.gini, values: stats.steps.map((s) => s.gini) },
      { key: "entropy", label: "熵", color: this.theme.series.entropy, values: stats.steps.map((s) => s.entropy) },
      { key: "variance", label: "方差", color: this.theme.series.variance, values: stats.steps.map((s) => s.variance) },
      { key: "kurtosis", label: "峰度", color: this.theme.series.kurtosis, values: stats.steps.map((s) => s.kurtosis) },
      { key: "skewness", label: "偏度", color: this.theme.series.skewness, values: stats.steps.map((s) => s.skewness) },
      { key: "maxlog", label: "max logρ", color: this.theme.series.maxlog, values: stats.steps.map((s) => s.max) },
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
      this._timelineLegendHTML();
    // 统计格
    this.statKeys = [
      ["max", "max ρ", "gold"], ["mean", "mean", ""], ["std", "std", ""], ["median", "median", ""],
      ["skewness", "skew", "cyan"], ["kurtosis", "kurt", "cyan"], ["gini", "Gini", "gold"], ["entropy", "entropy", "cyan"],
    ];
    $("#statGrid").innerHTML = this.statKeys.map(([k, lbl, cls]) =>
      `<div class="stat-cell"><div class="k">${lbl}</div><div class="v ${cls}" id="stat-${k}">—</div></div>`).join("");
    // 形态学 bars
    this.morphClasses = this._morphClasses();
    $("#morphBars").innerHTML = this.morphClasses.map(([k, lbl, c]) =>
      `<div class="morph-row"><span class="name">${lbl}</span><div class="bar"><div id="morph-${k}" style="background:${c}"></div></div><span class="pct" id="morphpct-${k}">—</span></div>`).join("");
    // atlas 控制
    $("#atlasControls").innerHTML = `
      <div class="topology-hint"><span>亮节点 = 高密度</span><span>亮边 = 强连接</span></div>
      <div class="network-models" id="networkModels">
        <h3>拓扑模型</h3>
        <button data-model="fixed" class="active">定长</button>
        <button data-model="varying">自适应</button>
        <button data-model="nearest">近邻</button>
        <div class="network-rule" id="networkRule">固定半径</div>
      </div>
      <div class="degree-panel">
        <h3>平均度</h3>
        <div class="component-label" id="componentLabel">弱连接</div>
        <div id="degreeChart" class="degree-chart"></div>
        <div class="degree-readout"><span>k</span><strong id="degreeValue">—</strong></div>
      </div>
      <div class="method-switch" id="methodSwitch">
        <button data-method="tweb" class="active">T-web (势场)</button>
        <button data-method="proxy">density-Hessian</button>
      </div>
      <div class="toggle-row" id="clsToggles">
        <div class="cls-toggle" data-cls="sheet"><span class="sw" style="background:${this.theme.morph.sheet}"></span>墙</div>
        <div class="cls-toggle" data-cls="filament"><span class="sw" style="background:${this.theme.morph.filament}"></span>丝</div>
        <div class="cls-toggle" data-cls="node"><span class="sw" style="background:${this.theme.morph.node}"></span>节点</div>
      </div>
      <label>叠加强度 <input type="range" id="atlasOpacity" min="0.1" max="0.95" step="0.05" value="0.55"></label>`;
    // probe 控制
    $("#probeControls").innerHTML = `
      <label>A <input type="range" id="probeA" min="0.05" max="2" step="0.05" value="0.55"><span id="probeAv">0.55</span></label>
      <label>β <input type="range" id="probeBeta" min="0.6" max="3" step="0.1" value="1.6"><span id="probeBv">1.6</span></label>
      <button id="probeClear" class="action" style="padding:4px 10px">清除探针</button>`;
    this._renderTFEditor();
    this._syncTFControls();
    this._prepareCinematicMetrics();
    this._buildCinematicOverlay();
    $("#btnStory").textContent = "短片";
  }

  _timelineLegendHTML() {
    return `<span style="color:${this.theme.timeline.early}">早期(低Gini)</span><span style="color:${this.theme.timeline.legendLate}">晚期(高Gini)</span><span style="color:#5d6b86">大小=高密度占比</span>`;
  }

  _morphClasses() {
    return [
      ["void", "空洞", this.theme.morph.void],
      ["sheet", "墙", this.theme.morph.sheet],
      ["filament", "丝", this.theme.morph.filament],
      ["node", "节点", this.theme.morph.node],
    ];
  }

  _applyTheme(name) {
    this.themeName = name;
    this.theme = THEMES[name];
    $("#app").dataset.theme = name;

    if (this.tf) {
      this.tf.setTheme(this.theme);
      this.renderer.setTF(this.tf.texture);
      this._refreshTFViews();
      this._renderTFEditor();
    }
    if (this.renderer) this.renderer.setTheme(this.theme);
    if (this.timeline) this.timeline.setTheme(this.theme);
    if (this.fingerprint) this.fingerprint.setTheme(this.theme);
    if (this.power) this.power.setTheme(this.theme);
    if (this.probe) this.probe.setTheme(this.theme);
    if (this.series) this.series.setTheme(this.theme);

    $("#timelineLegend").innerHTML = this._timelineLegendHTML();
    this.morphClasses = this._morphClasses();
    for (const [k, , color] of this.morphClasses) {
      const bar = $(`#morph-${k}`);
      if (bar) bar.style.background = color;
    }
    for (const cls of ["sheet", "filament", "node"]) {
      const sw = document.querySelector(`.cls-toggle[data-cls="${cls}"] .sw`);
      if (sw) sw.style.background = this.theme.morph[cls];
    }
  }

  _renderTFEditor() {
    const host = $("#tfEditor");
    host.innerHTML = "";
    host.classList.add("tf-editor");

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.className = "tf-color-input";
    host.appendChild(colorInput);

    const curve = document.createElement("div");
    curve.className = "tf-curve";
    host.appendChild(curve);

    const svg = d3.select(curve).append("svg").attr("class", "tf-svg").style("width", "100%").style("height", "100%");
    const grad = document.createElement("div");
    grad.className = "tf-gradient";
    host.appendChild(grad);

    const colorStopsLayer = document.createElement("div");
    colorStopsLayer.className = "tf-color-stops";
    grad.appendChild(colorStopsLayer);

    const r = host.getBoundingClientRect();
    const w = Math.max(140, r.width);
    const h = Math.max(54, (r.height || 92) - 28);
    const x = d3.scaleLinear().domain([0, 1]).range([0, w]);
    const y = d3.scaleLinear().domain([0, 1]).range([h - 6, 6]);

    const g = svg.append("g");
    const gridVals = [0, 0.25, 0.5, 0.75, 1];
    g.selectAll("line.tf-grid").data(gridVals).join("line")
      .attr("class", "tf-gridline")
      .attr("x1", (d) => x(d)).attr("x2", (d) => x(d))
      .attr("y1", 0).attr("y2", h);
    g.append("text").attr("class", "tf-label").attr("x", 4).attr("y", 12).text("alpha");

    const areaPath = g.append("path").attr("class", "tf-area");
    const linePath = g.append("path").attr("class", "tf-line");
    const alphaGroup = g.append("g");
    const area = d3.area().x((d) => x(d.p)).y0(h).y1((d) => y(d.a)).curve(d3.curveMonotoneX);
    const line = d3.line().x((d) => x(d.p)).y((d) => y(d.a)).curve(d3.curveMonotoneX);

    const refresh = () => {
      const stops = this.tf.cssStops();
      const alpha = this.tf.alphaCurve();
      grad.style.background = `linear-gradient(90deg, ${stops.map((s) => `${s.color} ${(s.p * 100).toFixed(1)}%`).join(",")})`;
      areaPath.attr("d", area(alpha));
      linePath.attr("d", line(alpha));

      alphaGroup.selectAll("circle").data(alpha, (d) => d.i).join("circle")
        .attr("class", "tf-alpha-stop")
        .attr("cx", (d) => x(d.p))
        .attr("cy", (d) => y(d.a))
        .attr("r", 5)
        .call(d3.drag().on("drag", (ev, d) => {
          const p = Math.max(0, Math.min(1, x.invert(ev.x)));
          const a = Math.max(0, Math.min(1, y.invert(ev.y)));
          this.tf.moveAlphaStop(d.i, p, a);
          this._refreshTFViews();
          refresh();
        }));

      colorStopsLayer.innerHTML = "";
      stops.forEach((stop) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tf-color-stop";
        btn.style.left = `${x(stop.p)}px`;
        btn.style.background = stop.color;
        let moved = false;

        btn.addEventListener("pointerdown", (ev) => {
          ev.preventDefault();
          moved = false;
          const onMove = (mv) => {
            moved = true;
            const rect = grad.getBoundingClientRect();
            const p = Math.max(0, Math.min(1, (mv.clientX - rect.left) / rect.width));
            this.tf.moveColorStop(stop.i, p);
            this._refreshTFViews();
            refresh();
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp, { once: true });
        });

        btn.addEventListener("click", () => {
          if (moved) return;
          colorInput.value = stop.hex;
          colorInput.oninput = (e) => {
            this.tf.setColorStop(stop.i, e.target.value);
            this._refreshTFViews();
            refresh();
          };
          colorInput.click();
        });

        colorStopsLayer.appendChild(btn);
      });
    };

    refresh();
  }

  _refreshTFViews() {
    this.histogram._recolor();
  }

  _syncTFControls() {
    $("#densityScale").value = String(state.tf.densityScale);
    $("#stepQuality").value = String(state.tf.steps);
    $("#isoValue").value = String(state.tf.isoValue);
  }

  _prepareCinematicMetrics() {
    const steps = state.stats.steps;
    const extent = (values) => {
      const e = d3.extent(values);
      return { min: e[0] ?? 0, max: e[1] ?? 1 };
    };
    this.cineRanges = {
      gini: extent(steps.map((s) => s.gini)),
      variance: extent(steps.map((s) => s.variance)),
      max: extent(steps.map((s) => s.max)),
    };
    const morphSrc = state.morphology?.tweb?.steps || state.morphology?.steps || [];
    this.cineRanges.void = extent(morphSrc.map((s) => s.fractions?.void ?? 0));
  }

  _buildCinematicOverlay() {
    const viewport = $("#viewport");
    if ($("#cinematicOverlay") || !viewport) return;
    const overlay = document.createElement("div");
    overlay.id = "cinematicOverlay";
    overlay.className = "cinematic-overlay hidden";
    overlay.innerHTML = `
      <div class="cinema-starfield" aria-hidden="true"></div>
      <svg class="cinema-network" viewBox="0 0 1200 700" preserveAspectRatio="none" aria-hidden="true">
        <g class="network-lines">
          <path d="M66 518 L178 426 L318 458 L456 328 L612 372 L760 238 L916 292 L1088 178" />
          <path d="M142 188 L286 246 L456 328 L584 154 L760 238 L982 112" />
          <path d="M318 458 L390 592 L612 372 L716 534 L916 292 L1050 508" />
          <path d="M178 426 L286 246 L584 154 L612 372 L716 534" />
          <path d="M456 328 L760 238 L1050 508" />
        </g>
        <g class="network-nodes">
          <circle cx="66" cy="518" r="2.6" /><circle cx="178" cy="426" r="3.2" />
          <circle cx="318" cy="458" r="4.2" /><circle cx="456" cy="328" r="5.4" />
          <circle cx="612" cy="372" r="4.6" /><circle cx="760" cy="238" r="5.8" />
          <circle cx="916" cy="292" r="4.2" /><circle cx="1088" cy="178" r="3.2" />
          <circle cx="142" cy="188" r="2.8" /><circle cx="286" cy="246" r="3.6" />
          <circle cx="584" cy="154" r="4.8" /><circle cx="982" cy="112" r="3.4" />
          <circle cx="390" cy="592" r="2.8" /><circle cx="716" cy="534" r="4.0" />
          <circle cx="1050" cy="508" r="3.8" />
        </g>
      </svg>
      <div class="cinema-titleblock">
        <div class="cinema-kicker" id="cineKicker">NYX COSMIC WEB / DENSITY NETWORK</div>
        <h2 id="cineTitle">Cosmic Web</h2>
        <p id="cineText">从近乎均匀的密度涨落开始，重建片层、丝状连接、节点塌缩和低密度空洞逐渐成形的过程。</p>
        <div class="cinema-hero-actions">
          <button id="cinemaStart" type="button">播放生成短片</button>
          <button id="cinemaExploreHome" type="button">进入数据探索</button>
        </div>
      </div>
      <div class="cinema-metrics" aria-label="cinematic metrics">
        <div class="metric-primary">
          <span>Web Maturity</span>
          <strong id="cineMaturity">0%</strong>
          <i><b id="cineMaturityBar"></b></i>
        </div>
        <div class="metric-grid">
          <div><span>Stage</span><strong id="cineStage">Seed</strong></div>
          <div><span>Gini</span><strong id="cineGini">0.000</strong></div>
          <div><span>Void</span><strong id="cineVoid">0.0%</strong></div>
          <div><span>Max log rho</span><strong id="cineMax">0.00</strong></div>
        </div>
      </div>
      <div class="cinema-progress" aria-label="story progress">
        <div class="cinema-progress-track"><b id="cineProgressFill"></b></div>
        <div class="cinema-chapters">
          <span>初始微扰</span><span>片层坍缩</span><span>丝状连接</span><span>节点增长</span><span>空洞成熟</span>
        </div>
      </div>
      <div class="cinema-actions">
        <button id="cinemaReplay" type="button">重看短片</button>
        <button id="cinemaExplore" type="button">进入探索模式</button>
      </div>`;
    const skip = document.createElement("button");
    skip.id = "cinemaSkip";
    skip.type = "button";
    skip.className = "cinema-skip";
    skip.textContent = "跳到最终结构";
    overlay.appendChild(skip);
    viewport.appendChild(overlay);
    $("#cinemaStart").addEventListener("click", () => { void this._startStory(); });
    $("#cinemaExploreHome").addEventListener("click", () => this._exitCinematic({ restoreCamera: false, page: "explore" }));
    $("#cinemaReplay").addEventListener("click", () => { void this._startStory(); });
    $("#cinemaExplore").addEventListener("click", () => this._exitCinematic({ restoreCamera: false, page: "explore" }));
    $("#cinemaSkip").addEventListener("click", () => this._finishCinematic());
  }

  _normMetric(value, range) {
    const span = Math.max(range.max - range.min, 1e-9);
    return Math.max(0, Math.min(1, (value - range.min) / span));
  }

  _maturityForStep(step) {
    const s = state.stats.steps[step];
    const morphSrc = state.morphology?.tweb?.steps || state.morphology?.steps || [];
    const voidFrac = morphSrc[step]?.fractions?.void ?? 0;
    const score =
      0.42 * this._normMetric(s.gini, this.cineRanges.gini) +
      0.24 * this._normMetric(s.variance, this.cineRanges.variance) +
      0.22 * this._normMetric(s.max, this.cineRanges.max) +
      0.12 * this._normMetric(voidFrac, this.cineRanges.void);
    return Math.round(Math.max(0, Math.min(1, score)) * 100);
  }

  _stageForStep(step) {
    if (step < 16) return "初始微扰";
    if (step < 38) return "片层坍缩";
    if (step < 66) return "丝状连接";
    if (step < 88) return "节点增长";
    return "空洞成熟";
  }

  _stageIndexForStep(step) {
    if (step < 16) return 0;
    if (step < 38) return 1;
    if (step < 66) return 2;
    if (step < 88) return 3;
    return 4;
  }

  _updateStageJumps(step = state.step) {
    const idx = this._stageIndexForStep(step);
    document.querySelectorAll("#stageJumps button").forEach((b, i) => b.classList.toggle("active", i === idx));
  }

  _updateCinematicHUD(step = state.step) {
    if (!$("#cinematicOverlay")) return;
    const s = state.stats.steps[step];
    const morphSrc = state.morphology?.tweb?.steps || state.morphology?.steps || [];
    const voidFrac = morphSrc[step]?.fractions?.void ?? 0;
    const maturity = this._maturityForStep(step);
    $("#cineMaturity").textContent = `${maturity}%`;
    $("#cineMaturityBar").style.width = `${maturity}%`;
    $("#cineProgressFill").style.width = `${(step / Math.max(1, state.meta.timeSteps - 1)) * 100}%`;
    $("#cineStage").textContent = this._stageForStep(step);
    $("#cineGini").textContent = d3.format(".3f")(s.gini);
    $("#cineVoid").textContent = `${(voidFrac * 100).toFixed(1)}%`;
    $("#cineMax").textContent = s.max.toFixed(2);
    const chapterIndex = step < 16 ? 0 : step < 38 ? 1 : step < 66 ? 2 : step < 88 ? 3 : 4;
    document.querySelectorAll(".cinema-chapters span").forEach((el, i) => {
      const active = i === chapterIndex;
      el.classList.toggle("active", active);
    });
  }

  _setCinematicChapter(kicker, title, text) {
    const overlay = $("#cinematicOverlay");
    overlay?.classList.add("chapter-changing");
    clearTimeout(this.chapterFxTimer);
    this.chapterFxTimer = setTimeout(() => overlay?.classList.remove("chapter-changing"), 520);
    $("#cineKicker").textContent = kicker;
    $("#cineTitle").textContent = title;
    $("#cineText").textContent = text;
    $("#storyCaption").innerHTML = `<span class="chapter">${kicker}</span>${text}`;
  }

  _applyRecommendedTF() {
    this._applyRenderPreset("structure");
  }

  _applyRenderPreset(name = "structure") {
    const presets = {
      structure: { mode: 0, density: 0.80, steps: 256, iso: 0.40, alpha: "structure", brush: null, atlas: false },
      evolution: { mode: 0, density: 1.18, steps: 288, iso: 0.40, alpha: "evolution", brush: null, atlas: false },
      dense: { mode: 3, density: 1.02, steps: 256, iso: 0.54, alpha: "dense", brush: null, atlas: false },
      void: { mode: 4, density: 0.92, steps: 256, iso: 0.28, alpha: "void", brush: null, atlas: false },
    };
    const p = presets[name] || presets.structure;
    this.renderPreset = name;
    state.tf.densityScale = p.density;
    state.tf.steps = p.steps;
    state.tf.isoValue = p.iso;
    state.atlas.active = p.atlas;

    this.tf.setAlphaProfile(p.alpha);
    this.renderer.setDensityScale(state.tf.densityScale);
    this.renderer.setSteps(state.playing ? Math.min(state.tf.steps, this.playbackSteps) : state.tf.steps);
    this.renderer.setIso(state.tf.isoValue);
    this.renderer.setAtlas(state.atlas.active, state.atlas.opacity, state.atlas.classes);
    $("#btnAtlas").classList.toggle("active", state.atlas.active);

    this._clearBrush();
    this._setMode(p.mode);
    if (p.brush && p.mode === 0) {
      const ranges = {
        void: [0, this.percent("25")],
        top1: [this.percent("99"), 1],
      };
      const [min, max] = ranges[p.brush];
      state.brush = { active: true, min, max, label: p.brush };
      this.renderer.setBrush(true, min, max);
      this.histogram.setRangeNorm(min, max);
    }

    document.querySelectorAll("#renderPresets button").forEach((b) => b.classList.toggle("active", b.dataset.preset === name));
    this._syncTFControls();
    this._refreshTFViews();
    this._renderTFEditor();
  }

  // ---------------- events ----------------
  _bindEvents() {
    $("#pageTabs").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const page = b.dataset.page;
      if (page === "showcase") {
        this._enterCinematicHome();
      } else if (state.story.running || $("#app").classList.contains("story-mode")) {
        this._exitCinematic({ restoreCamera: false, restorePage: false, restoreRenderState: false, page });
      } else {
        this._setPage(page);
      }
    });

    $("#timeSlider").addEventListener("input", (e) => { this.pause(); this.setStep(+e.target.value); });
    $("#btnPlay").addEventListener("click", () => this.togglePlay());
    $("#stageJumps").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      this.pause();
      this.setStep(+b.dataset.step);
      if (this.page === "showcase") this._setPage("explore");
    });

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

    $("#tfRecommend").addEventListener("click", () => this._applyRecommendedTF());
    $("#renderPresets").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      this._applyRenderPreset(b.dataset.preset);
    });

    $("#densityScale").addEventListener("input", (e) => {
      state.tf.densityScale = +e.target.value;
      this.renderer.setDensityScale(state.tf.densityScale);
      document.querySelectorAll("#renderPresets button").forEach((b) => b.classList.remove("active"));
    });
    $("#stepQuality").addEventListener("input", (e) => {
      state.tf.steps = +e.target.value;
      this.renderer.setSteps(state.playing ? Math.min(state.tf.steps, this.playbackSteps) : state.tf.steps);
      document.querySelectorAll("#renderPresets button").forEach((b) => b.classList.remove("active"));
    });
    $("#isoValue").addEventListener("input", (e) => {
      state.tf.isoValue = +e.target.value;
      this.renderer.setIso(state.tf.isoValue);
      document.querySelectorAll("#renderPresets button").forEach((b) => b.classList.remove("active"));
    });

    // atlas
    $("#btnAtlas").addEventListener("click", () => this._toggleAtlas());
    $("#networkModels").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      this._setNetworkModel(b.dataset.model);
    });
    $("#clsToggles").addEventListener("click", (e) => {
      const t = e.target.closest(".cls-toggle"); if (!t) return;
      const c = t.dataset.cls; state.atlas.classes[c] = !state.atlas.classes[c];
      t.classList.toggle("off", !state.atlas.classes[c]);
      this._activateAtlasFromControls();
    });
    $("#atlasOpacity").addEventListener("input", (e) => {
      state.atlas.opacity = +e.target.value;
      this._activateAtlasFromControls();
    });
    $("#methodSwitch").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      state.atlas.method = b.dataset.method;
      document.querySelectorAll("#methodSwitch button").forEach((x) => x.classList.toggle("active", x === b));
      this._updateMorph(state.step);
      this._activateAtlasFromControls();
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
    $("#btnExport").addEventListener("click", () => this._exportStoryVideo());
    $("#btnTopology").addEventListener("click", () => this._toggleTopology());

    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { this._toggleProbe(false); } });
    window.addEventListener("resize", () => this._resizeAll());

    // 初始 atlas class 显示
    for (const c of ["sheet", "filament", "node"]) {
      const t = document.querySelector(`.cls-toggle[data-cls="${c}"]`);
      if (t) t.classList.toggle("off", !state.atlas.classes[c]);
    }
  }

  _resizeAll() {
    if ($("#center") && getComputedStyle($("#center")).display !== "none") this.renderer._resize();
    this.histogram.resize(); this.timeline.resize(); this._renderTFEditor();
    const c = this.tabCharts[this._tab || "hist"]; if (c) c.forEach((ch) => ch.resize());
  }

  _setPage(page) {
    const legacy = { render: "explore", stats: "charts", brush: "params", web: "explore" };
    page = legacy[page] || page;
    const pages = new Set(["showcase", "explore", "params", "charts"]);
    if (!pages.has(page)) page = "explore";
    this.page = page;
    $("#app").dataset.page = page;
    if (this.renderer) this.renderer.setActive(page !== "charts");
    this._syncPageChrome(page);
    document.querySelectorAll("#pageTabs button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));

    const preferredTab = {
      showcase: this._tab || "hist",
      explore: this._tab || "hist",
      params: this._tab === "probe" ? "probe" : "hist",
      charts: this._tab && this._tab !== "probe" ? this._tab : "fingerprint",
    }[page];
    this._setTab(preferredTab);

    requestAnimationFrame(() => this._resizeAll());
    setTimeout(() => this._resizeAll(), 80);
  }

  // ---------------- step / playback ----------------
  async applyStep(step, { fromPlayback = false, force = false } = {}) {
    state.step = step;
    $("#timeSlider").value = step;
    $("#stepLabel").textContent = `t = ${String(step).padStart(4, "0")}`;
    this._updateStageJumps(step);
    if (state.story.running || $("#app").classList.contains("story-mode")) this._updateCinematicHUD(step);
    const skipChartUpdates = fromPlayback && state.story.running;
    if (!skipChartUpdates) {
      // 图表联动
      this.histogram.update(step, state.histograms.matrix[step]);
      this.fingerprint.update(step); this.series.update(step);
      this.power.update(step); this.timeline.update(step);
      this._updateStatGrid(step); this._updateMorph(step);
      if (state.brush.active) this._updateSelStats(step);
      if (this.histogram.tf) { /* recolored on tf change */ }
    }
    if (!fromPlayback || this.networkVisible) this._updateNetworkLayer(step);

    const cached = fromPlayback ? this.dm.getCachedVolumeSet(step) : null;
    if (cached) {
      this.renderer.setVolumeTexture(cached.volumeTex);
      this.renderer.setGradientTexture(cached.gradientTex, cached.gradientScale);
      $("#loadState").textContent = "● 全分辨率(缓存)";
    } else {
      // 低分辨率即时显示
      this.renderer.setVolumeTexture(this.dm.getPreviewTexture(step));
      {
        const previewGrad = this.dm.getPreviewGradientTexture(step);
        this.renderer.setGradientTexture(previewGrad.texture, previewGrad.scale);
      }
      $("#loadState").textContent = fromPlayback ? "○ 预览(播放)" : "○ 预览";
    }

    // 预取
    this.dm.prefetch(step, this._dir || 1, fromPlayback ? 4 : 2);

    if (state.renderMode === 5) this._scheduleMesh(step);
    if (!fromPlayback) {
      this._scheduleFullRes(step);
      if (state.atlas.active) this._scheduleLabel(step);
    }
    if (force) {
      const entry = await this.dm.getVolumeSet(step);
      this.renderer.setVolumeTexture(entry.volumeTex);
      this.renderer.setGradientTexture(entry.gradientTex, entry.gradientScale);
      $("#loadState").textContent = "● 全分辨率";
    }
  }

  _scheduleFullRes(step) {
    clearTimeout(this.fullResTimer);
    this.fullResTimer = setTimeout(async () => {
      try {
        const entry = await this.dm.getVolumeSet(step);
        if (state.step === step && !state.playing) {
          this.renderer.setVolumeTexture(entry.volumeTex);
          this.renderer.setGradientTexture(entry.gradientTex, entry.gradientScale);
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

  setStep(step, opts = {}) {
    step = Math.min(state.meta.timeSteps - 1, Math.max(0, step));
    this.applyStep(step, opts);
  }

  togglePlay() { state.playing ? this.pause() : this.play(); }
  play() {
    if (state.playing) return;
    const last = state.meta.timeSteps - 1;
    if (state.step >= last) this.setStep(0);
    state.playing = true;
    $("#btnPlay").textContent = "❚❚";
    this.renderer.setSteps(Math.min(state.tf.steps, this.playbackSteps));
    this.dm.prefetch(state.step, 1, Math.max(8, this.playbackStride * 4));
    clearInterval(this.playTimer);
    this.playTimer = setInterval(() => this._tick(), this.stepInterval);
  }

  _syncPageChrome(page = this.page) {
    const compact = page === "explore";
    const labels = compact
      ? {
          timeline: ["时间", ""],
          tf: ["视图", ""],
          stat: ["状态", ""],
          morph: ["拓扑", ""],
        }
      : {
          timeline: ["时间控制", "Time evolution"],
          tf: ["传递函数", "Transfer function"],
          stat: ["当前统计", "Current step"],
          morph: ["宇宙网形态", "Cosmic web"],
        };
    $("#timelinePanelTitle").textContent = labels.timeline[0];
    $("#timelinePanelSub").textContent = labels.timeline[1];
    $("#tfPanelTitle").textContent = labels.tf[0];
    $("#tfPanelSub").textContent = labels.tf[1];
    $("#statPanelTitle").textContent = labels.stat[0];
    $("#statPanelSub").textContent = labels.stat[1];
    $("#morphPanelTitle").textContent = labels.morph[0];
    $("#morphPanelSub").textContent = labels.morph[1];
  }
  pause() {
    if (!state.playing) return;
    state.playing = false;
    $("#btnPlay").textContent = "▶";
    clearInterval(this.playTimer);
    this.playTimer = null;
    this.renderer.setSteps(state.tf.steps);
    this._scheduleFullRes(state.step);
    if (state.atlas.active) this._scheduleLabel(state.step);
  }

  _tick() {
    if (!state.playing) return;
    this._dir = 1;
    const last = state.meta.timeSteps - 1;
    if (state.step >= last) {
      this.pause();
      return;
    }
    const next = Math.min(last, state.step + this.playbackStride);
    this.applyStep(next, { fromPlayback: true });
    if (next >= last) this.pause();
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

  _setNetworkModel(model = "nearest") {
    this.networkModel = model;
    document.querySelectorAll("#networkModels button").forEach((b) => b.classList.toggle("active", b.dataset.model === model));
    this._updateNetworkRule(model);
    this._setTopologyVisible(true);
    this._clearBrush();
    this._setMode(0);
    this.renderer.setAtlas(state.atlas.active, state.atlas.opacity, state.atlas.classes);
    $("#btnAtlas").classList.toggle("active", state.atlas.active);
    if (state.atlas.active) this._scheduleLabel(state.step);
    this._updateNetworkLayer(state.step);
  }

  _updateNetworkRule(model = this.networkModel || "fixed") {
    const el = $("#networkRule");
    if (!el) return;
    const labels = {
      fixed: "固定半径",
      varying: "局部半径",
      nearest: "近邻连接",
    };
    el.textContent = labels[model] || labels.fixed;
  }

  _activateAtlasFromControls() {
    state.atlas.active = true;
    $("#btnAtlas").classList.add("active");
    this.renderer.setAtlas(true, state.atlas.opacity, state.atlas.classes);
    this._scheduleLabel(state.step);
  }

  _toggleProbe(force) {
    const on = force != null ? force : !state.probe.active;
    state.probe.active = on;
    $("#btnProbe").classList.toggle("active", on);
    $("#probeHint").classList.toggle("hidden", !on);
    if (on) {
      this.renderer.enablePicking((line) => this._onProbe(line));
      this._setPage("params");
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

  _enterCinematicHome() {
    state.story.running = false;
    this.pause();
    this._setPage("showcase");
    this._clearBrush();
    this._setMode(0);
    state.tf.densityScale = 1.05;
    this.renderer.setDensityScale(state.tf.densityScale);
    this.renderer.setControlsEnabled(false);
    this.renderer.setCameraPose([1.86, 0.94, 1.52], [0.12, -0.02, 0]);
    this._setTopologyVisible(false);
    $("#app").classList.add("story-mode", "cinema-home");
    $("#cinematicOverlay").classList.remove("hidden", "running", "complete");
    $("#cinematicOverlay").classList.add("home");
    $("#storyCaption").classList.add("hidden");
    $("#btnStory").textContent = "生成短片";
    this._setCinematicChapter(
      "NYX COSMIC WEB / DENSITY NETWORK",
      "Cosmic Web",
      "从近乎均匀的密度涨落开始，重建片层、丝状连接、节点塌缩和低密度空洞逐渐成形的过程。"
    );
    this._updateCinematicHUD(state.step);
  }

  _toggleStory() {
    if (state.story.running || $("#app").classList.contains("story-mode")) {
      this._exitCinematic({ restoreCamera: true, restorePage: true, restoreRenderState: true });
      return;
    }
    void this._startStory();
  }

  _toggleTopology() {
    this._setTopologyVisible(!this.networkVisible);
  }

  _setTopologyVisible(visible, { updateButton = true } = {}) {
    this.networkVisible = !!visible;
    this.renderer?.setNetworkVisible(this.networkVisible);
    if (updateButton) {
      const btn = $("#btnTopology");
      btn?.classList.toggle("active", this.networkVisible);
      btn?.setAttribute("aria-pressed", String(this.networkVisible));
    }
    const overlay = $("#cinematicOverlay");
    overlay?.classList.toggle("topology-visible", this.networkVisible);
    overlay?.classList.toggle("topology-muted", !this.networkVisible);
  }

  async _exportStoryVideo() {
    const btn = $("#btnExport");
    if (this.storyExporting) return;
    this.storyExporting = true;
    btn.disabled = true;
    btn.textContent = "实时";
    try {
      alert("已取消固定视频短片。现在首页短片会直接使用实时体渲染，播放期间禁用视角操作，结束或进入探索后恢复旋转。");
    } finally {
      this.storyExporting = false;
      btn.disabled = false;
      btn.textContent = "导出";
    }
  }

  _storyShot(from, to, k) {
    const ease = (t) => t * t * (3 - 2 * t);
    const lerp = (a, b, t) => a + (b - a) * t;
    const mix = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
    const t = ease(k);
    this.renderer.setCameraPose(mix(from.position, to.position, t), mix(from.target, to.target, t));
  }

  _applyStoryLook({ mode = 0, density = 0.8, brush = null, atlas = false, atlasOpacity = 0.55, topology = false, brushBoost = 1 } = {}) {
    this._setMode(mode);
    state.tf.densityScale = density;
    this.renderer.setDensityScale(density);
    this._setTopologyVisible(topology, { updateButton: false });
    if (brush) {
      const ranges = {
        sheet: [this.percent("25"), this.percent("90")],
        filament: [this.percent("75"), this.percent("95")],
        node: [this.percent("95"), 1],
        top1: [this.percent("99"), 1],
        void: [0, this.percent("25")],
      };
      const [mn, mx] = ranges[brush];
      state.brush = { active: true, min: mn, max: mx, label: brush };
      this.renderer.setBrush(true, mn, mx, brushBoost);
      this.histogram.setRangeNorm(mn, mx);
    } else {
      this._clearBrush();
    }
    state.atlas.active = atlas;
    state.atlas.opacity = atlasOpacity;
    $("#btnAtlas").classList.toggle("active", atlas);
    this.renderer.setAtlas(atlas, atlasOpacity, state.atlas.classes);
    if (atlas) this._scheduleLabel(state.step);
  }

  _storyDelay(ms) {
    return new Promise((resolve) => {
      this._storyTimer = setTimeout(resolve, ms);
    });
  }

  async _transitionStoryLook(look) {
    const overlay = $("#cinematicOverlay");
    overlay?.classList.add("look-fade");
    await this._storyDelay(120);
    if (!state.story.running) return false;
    this._applyStoryLook(look);
    await this._storyDelay(240);
    overlay?.classList.remove("look-fade");
    return state.story.running;
  }

  _tweenStoryStep(fromStep, toStep, duration, fromShot, toShot) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      let lastStep = -1;
      const run = () => {
        if (!state.story.running) return resolve(false);
        const k = Math.min(1, (performance.now() - t0) / duration);
        const eased = k * k * (3 - 2 * k);
        const step = Math.round(fromStep + (toStep - fromStep) * eased);
        if (step !== lastStep) {
          lastStep = step;
          this.setStep(step, { fromPlayback: true });
        }
        if (fromShot && toShot) this._storyShot(fromShot, toShot, k);
        if (k < 1) requestAnimationFrame(run);
        else resolve(true);
      };
      run();
    });
  }

  async _startStory({ exportMode = false } = {}) {
    if (state.story.running) return;
    this.pause();
    this._clearBrush();
    if (!$("#app").classList.contains("story-mode")) {
      this.pageBeforeStory = this.page;
      this.storyCameraPose = this.renderer.getCameraPose();
    }
    this.storySavedRender = {
      renderMode: state.renderMode,
      densityScale: state.tf.densityScale,
      steps: state.tf.steps,
      atlasActive: state.atlas.active,
      atlasOpacity: state.atlas.opacity,
      networkVisible: this.networkVisible,
      brush: { ...state.brush },
    };

    state.story.running = true;
    this.storyExporting = exportMode;
    this.storyTweenLastStep = -1;
    this.renderer.setSteps(Math.min(state.tf.steps, exportMode ? 80 : this.cinematicSteps));
    this.renderer.setControlsEnabled(false);
    this._setPage("showcase");
    $("#app").classList.add("story-mode");
    $("#app").classList.remove("cinema-home");
    $("#btnStory").textContent = "停止";
    $("#cinematicOverlay").classList.remove("hidden", "home", "complete");
    $("#cinematicOverlay").classList.add("running");
    $("#storyCaption").classList.remove("hidden");
    this._updateCinematicHUD(state.step);

    const shots = {
      far: { position: [1.90, 1.02, 1.62], target: [0.12, -0.02, 0.0] },
      drift: { position: [1.16, 0.58, 1.06], target: [0.08, -0.02, 0.02] },
      thread: { position: [-0.82, 0.34, 0.86], target: [0.08, 0.03, 0.00] },
      node: { position: [0.48, 0.28, 0.58], target: [-0.03, 0.02, 0.02] },
      void: { position: [-0.26, -0.20, 0.70], target: [0.12, 0.08, -0.02] },
      atlas: { position: [1.12, -0.46, 0.82], target: [0.02, 0.00, 0.00] },
    };

    const chapters = [
      {
        from: 0, to: 14, duration: 4200, shot0: shots.far, shot1: shots.drift,
        look: { mode: 0, density: 0.86, topology: true },
        kicker: "STAGE 01 / INITIAL FLUCTUATIONS",
        title: "初始微扰",
        text: "宇宙早期的密度场接近均匀，只存在很弱的涨落。后面的网状结构并不是突然出现，而是从这些微小差异被引力逐渐放大开始。",
      },
      {
        from: 14, to: 38, duration: 5000, shot0: shots.drift, shot1: shots.thread,
        look: { mode: 0, density: 1.30, brush: "sheet", brushBoost: 5.5, topology: true },
        kicker: "STAGE 02 / SHEETS",
        title: "片层坍缩",
        text: "随着涨落增长，物质先在较大的面状区域聚集，形成墙和片层。它们像宇宙网的薄膜边界，随后会被更细的丝状结构连接起来。",
      },
      {
        from: 38, to: 66, duration: 5600, shot0: shots.thread, shot1: shots.node,
        look: { mode: 0, density: 1.08, brush: "filament", topology: true },
        kicker: "STAGE 03 / FILAMENTS",
        title: "丝状连接",
        text: "片层继续被拉伸和汇聚，中高密度通道逐渐连成细丝。这里显示的是物质运输的主干，也是 cosmic web 最容易被识别的骨架。",
      },
      {
        from: 66, to: 88, duration: 5000, shot0: shots.node, shot1: shots.void,
        look: { mode: 3, density: 1.10, topology: true },
        kicker: "STAGE 04 / NODES",
        title: "节点增长",
        text: "丝状结构交汇处的密度增长最快，形成最亮的节点。这里不是恒星照片，而是密度场中塌缩最强的位置被高亮出来。",
      },
      {
        from: 88, to: 99, duration: 4600, shot0: shots.void, shot1: shots.atlas,
        look: { mode: 0, density: 1.08, atlas: true, atlasOpacity: 0.66, topology: true },
        kicker: "STAGE 05 / VOIDS",
        title: "空洞成熟",
        text: "物质持续向墙、丝和节点迁移，低密度区域被抽空并扩展成空洞。最终画面把空洞、墙、丝和节点放回同一个三维宇宙网中。",
      },
    ];

    this.setStep(0, { fromPlayback: true });
    this.renderer.setCameraPose(shots.far.position, shots.far.target);
    for (const chapter of chapters) {
      if (!state.story.running) return;
      this._setCinematicChapter(chapter.kicker, chapter.title, chapter.text);
      const ready = await this._transitionStoryLook(chapter.look);
      if (!ready) return;
      const done = await this._tweenStoryStep(chapter.from, chapter.to, chapter.duration, chapter.shot0, chapter.shot1);
      if (!done) return;
    }
    this._finishCinematic();
  }

  _finishCinematic() {
    state.story.running = false;
    this.renderer.setSteps(state.tf.steps);
    this.setStep(99);
    this._applyStoryLook({ mode: 0, density: 1.08, atlas: true, atlasOpacity: 0.66, topology: true });
    $("#cinematicOverlay").classList.remove("running", "look-fade", "chapter-changing");
    $("#cinematicOverlay").classList.add("complete");
    $("#btnStory").textContent = "重看";
    this.renderer.setControlsEnabled(true);
    this._setCinematicChapter(
      "COMPLETE / COSMIC WEB",
      "成熟宇宙网",
      "短片已停在最终结构。现在可以旋转观察，或进入探索模式查看直方图、功率谱、形态分类和探针剖面。"
    );
    this._updateCinematicHUD(99);
  }

  _exitCinematic({ restoreCamera = false, restorePage = false, restoreRenderState = false, page = null } = {}) {
    state.story.running = false;
    clearTimeout(this._storyTimer);
    cancelAnimationFrame(this.storyProgressFrame);
    $("#app").classList.remove("story-mode", "cinema-home");
    $("#cinematicOverlay").classList.add("hidden");
    $("#cinematicOverlay").classList.remove("home", "running", "complete", "look-fade", "chapter-changing");
    $("#storyCaption").classList.add("hidden");
    $("#btnStory").textContent = "短片";
    this.renderer.setControlsEnabled(true);
    this.renderer.setSteps(state.tf.steps);
    if (restoreRenderState && this.storySavedRender) {
      state.tf.densityScale = this.storySavedRender.densityScale;
      state.tf.steps = this.storySavedRender.steps;
      this.renderer.setDensityScale(state.tf.densityScale);
      this.renderer.setSteps(state.tf.steps);
      state.atlas.active = this.storySavedRender.atlasActive;
      state.atlas.opacity = this.storySavedRender.atlasOpacity;
      state.brush = { ...this.storySavedRender.brush };
      this._setTopologyVisible(this.storySavedRender.networkVisible);
      this._setMode(this.storySavedRender.renderMode);
      this.renderer.setAtlas(state.atlas.active, state.atlas.opacity, state.atlas.classes);
      this.renderer.setBrush(state.brush.active, state.brush.min, state.brush.max);
      $("#btnAtlas").classList.toggle("active", state.atlas.active);
      this.storySavedRender = null;
    }
    if (restoreCamera && this.storyCameraPose) {
      this.renderer.setCameraPose(this.storyCameraPose.position, this.storyCameraPose.target);
      this.storyCameraPose = null;
    }
    const nextPage = page || (restorePage ? this.pageBeforeStory : "explore");
    this.pageBeforeStory = null;
    if (nextPage) this._setPage(nextPage);
  }

  _stopStory() {
    this._exitCinematic({ restoreCamera: true, restorePage: true, restoreRenderState: true });
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
    this._renderDegreeChart(step);
  }

  _updateNetworkLayer(step = state.step) {
    if (!this.dm?.preview || !this.renderer) return;
    const network = this.dm.buildNetwork(step, this.networkModel || "fixed");
    this.currentNetwork = network;
    const opacity = this.networkModel === "fixed" ? 0.16 : this.networkModel === "varying" ? 0.20 : 0.24;
    const pointOpacity = this.networkModel === "fixed" ? 0.58 : this.networkModel === "varying" ? 0.68 : 0.74;
    this.renderer.setNetworkGeometry(network, { opacity, pointOpacity });
    this._renderDegreeChart(step);
  }

  _degreeDistribution(step) {
    if (!this.currentNetwork || this.currentNetwork.step !== step || this.currentNetwork.model !== (this.networkModel || "fixed")) {
      this.currentNetwork = this.dm.buildNetwork(step, this.networkModel || "fixed");
    }
    if (this.currentNetwork) {
      return {
        bins: this.currentNetwork.degreeBins,
        avg: this.currentNetwork.averageDegree,
        label: this.currentNetwork.componentLabel,
      };
    }
    const counts = state.histograms?.matrix?.[step] || [];
    const bins = Array.from({ length: 24 }, () => 0);
    let total = 0;
    let weighted = 0;
    const mode = this.networkModel || "nearest";
    const maxDegree = mode === "fixed" ? 34 : mode === "varying" ? 45 : 50;
    const baseDegree = mode === "fixed" ? 4 : mode === "varying" ? 3 : 5;
    const curve = mode === "fixed" ? 1.65 : mode === "varying" ? 1.08 : 0.82;
    const networkWeight = mode === "fixed" ? 2.8 : mode === "varying" ? 2.35 : 2.0;
    counts.forEach((count, i) => {
      const t = counts.length > 1 ? i / (counts.length - 1) : 0;
      const weight = count * Math.pow(Math.max(t, 0.02), networkWeight);
      const degree = Math.min(maxDegree, Math.round(baseDegree + Math.pow(t, curve) * (maxDegree - baseDegree)));
      const bin = Math.min(bins.length - 1, Math.floor((degree / 50) * bins.length));
      bins[bin] += weight;
      total += weight;
      weighted += weight * degree;
    });
    return {
      bins,
      avg: total ? weighted / total : 0,
      label: mode === "fixed" ? "定长连接" : mode === "varying" ? "自适应连接" : "近邻连接",
    };
  }

  _renderDegreeChart(step = state.step) {
    const el = $("#degreeChart");
    if (!el) return;
    const { bins, avg, label } = this._degreeDistribution(step);
    const max = Math.max(...bins);
    const denom = max > 0 ? max : 1;
    el.innerHTML = bins.map((v, i) => {
      const h = Math.max(2, (v / denom) * 58);
      const tick = i % 4 === 0 ? `<span>${Math.round((i / (bins.length - 1)) * 50)}</span>` : "";
      return `<i style="height:${h.toFixed(1)}px">${tick}</i>`;
    }).join("");
    $("#degreeValue").textContent = d3.format(".2f")(avg);
    $("#componentLabel").textContent = label;
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
