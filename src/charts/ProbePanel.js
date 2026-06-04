// Cosmic Probe 面板 (创新点 A+D): 沿探针视线的
//  ① log-density 剖面曲线;  ② 莱曼-α proxy 吸收谱 (透射流量 F=exp(-τ), τ=A·∫ρ^β ds)。
// 物理限定: 仅密度驱动的教学/可视分析近似, 非严格辐射转移。
import * as d3 from "d3";

export class ProbePanel {
  constructor(el, meta) {
    this.el = el; this.meta = meta;
    this.margin = { top: 14, right: 50, bottom: 24, left: 50 };
    this.samples = null; this.A = 0.55; this.beta = 1.6;
    this._build();
  }

  _build() {
    this.svg = d3.select(this.el).append("svg").style("width", "100%").style("height", "100%");
    this.g = this.svg.append("g");
    this.gx = this.g.append("g").attr("class", "axis");
    this.gyL = this.g.append("g").attr("class", "axis");
    this.gyR = this.g.append("g").attr("class", "axis");
    this.areaDens = this.g.append("path").attr("fill", "rgba(13,140,138,0.16)").attr("stroke", "#0d8c8a").attr("stroke-width", 1.6);
    this.fluxArea = this.g.append("path").attr("fill", "rgba(217,119,6,0.12)");
    this.fluxLine = this.g.append("path").attr("fill", "none").attr("stroke", "#d97706").attr("stroke-width", 1.8);
    this.lxd = this.g.append("text").attr("fill", "#0d8c8a").attr("font-size", 10).text("log10 ρ");
    this.lxf = this.g.append("text").attr("fill", "#c06a09").attr("font-size", 10).attr("text-anchor", "end").text("透射流量 F");
    this.lpos = this.g.append("text").attr("fill", "#5d6b86").attr("font-size", 10).attr("text-anchor", "end").text("沿视线位置 →");
    this.srcNote = this.g.append("text").attr("fill", "#5d6b86").attr("font-size", 9).attr("x", 2).attr("y", -2);
    this.empty = this.g.append("text").attr("fill", "#5d6b86").attr("font-size", 12);
    this.x = d3.scaleLinear().domain([0, 1]);
    this.yD = d3.scaleLinear().domain([this.meta.globalLogMin, this.meta.globalLogMax]);
    this.yF = d3.scaleLinear().domain([0, 1.02]);
    this._resize();
  }

  setParams(A, beta) { this.A = A; this.beta = beta; this._draw(); }
  setSamples(normSamples, full) { this.samples = normSamples; this.full = full; this._draw(); }

  _resize() {
    const r = this.el.getBoundingClientRect();
    this.iw = Math.max(200, r.width) - this.margin.left - this.margin.right;
    this.ih = Math.max(90, r.height) - this.margin.top - this.margin.bottom;
    this.g.attr("transform", `translate(${this.margin.left},${this.margin.top})`);
    this.x.range([0, this.iw]); this.yD.range([this.ih, 0]); this.yF.range([this.ih, 0]);
    this.gx.attr("transform", `translate(0,${this.ih})`).call(d3.axisBottom(this.x).ticks(6).tickFormat(d3.format(".1f")));
    this.gyL.call(d3.axisLeft(this.yD).ticks(5).tickFormat(d3.format(".1f")));
    this.gyR.attr("transform", `translate(${this.iw},0)`).call(d3.axisRight(this.yF).ticks(5).tickFormat(d3.format(".1f")));
    this.lxd.attr("x", -8).attr("y", -4);
    this.lxf.attr("x", this.iw + 44).attr("y", -4);
    this.lpos.attr("x", this.iw).attr("y", this.ih + 22);
    this.empty.attr("x", this.iw / 2 - 90).attr("y", this.ih / 2);
    this._draw();
  }

  _draw() {
    if (!this.samples) {
      this.empty.text("在 3D 视图中点击拉出探针视线…");
      this.srcNote.text("");
      this.areaDens.attr("d", null); this.fluxLine.attr("d", null); this.fluxArea.attr("d", null);
      return;
    }
    this.empty.text("");
    this.srcNote.text(this.full ? "采样: 全分辨率 128³" : "采样: 64³ 预览(平滑, 停稳后自动升采样)");
    const { globalLogMin, globalLogMax } = this.meta;
    const q50 = this.meta.globalPercentiles["50"];
    const n = this.samples.length;
    const logD = new Float32Array(n);
    const rhoB = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ld = globalLogMin + this.samples[i] * (globalLogMax - globalLogMin);
      logD[i] = ld;
      const rhoRel = Math.pow(10, ld - q50);     // 相对密度(中位数=1)
      rhoB[i] = Math.pow(rhoRel, this.beta);
    }
    // 视线积分(小高斯核近似热展宽), 得到光学深度 τ -> F=exp(-τ)
    const tau = this._smooth(rhoB, 2).map((v) => this.A * v);
    const F = tau.map((t) => Math.exp(-t));

    const px = (i) => this.x(i / (n - 1));
    const aD = d3.area().x((d, i) => px(i)).y0(this.ih).y1((d) => this.yD(d)).curve(d3.curveMonotoneX);
    this.areaDens.attr("d", aD(Array.from(logD)));
    const lF = d3.line().x((d, i) => px(i)).y((d) => this.yF(d)).curve(d3.curveMonotoneX);
    const aF = d3.area().x((d, i) => px(i)).y0(0).y1((d) => this.yF(d)).curve(d3.curveMonotoneX);
    this.fluxArea.attr("d", aF(Array.from(F)));
    this.fluxLine.attr("d", lF(Array.from(F)));
  }

  _smooth(arr, sigma) {
    const radius = Math.ceil(sigma * 2);
    const ker = [];
    let sum = 0;
    for (let i = -radius; i <= radius; i++) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); ker.push(w); sum += w; }
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = Math.min(arr.length - 1, Math.max(0, i + k));
        acc += arr[j] * ker[k + radius];
      }
      out[i] = acc / sum;
    }
    return out;
  }

  resize() { this._resize(); }
}
