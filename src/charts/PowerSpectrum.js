// 功率谱 P(k) 演化 (创新点 C): log-log 图。早期步偏蓝、晚期步偏金,
// 当前步加粗高亮, 定量展示结构增长(小尺度/大 k 功率随时间上升)。
import * as d3 from "d3";

export class PowerSpectrum {
  constructor(el, power) {
    this.el = el; this.power = power;
    this.k = power.k; this.M = power.matrix; this.N = this.M.length;
    this.margin = { top: 12, right: 16, bottom: 28, left: 50 };
    this.color = d3.scaleSequential(d3.interpolateRgbBasis(["#2563eb", "#0d8c8a", "#c06a09"])).domain([0, this.N - 1]);
    this._build();
  }

  _build() {
    this.svg = d3.select(this.el).append("svg").style("width", "100%").style("height", "100%");
    this.g = this.svg.append("g");
    this.gx = this.g.append("g").attr("class", "axis");
    this.gy = this.g.append("g").attr("class", "axis");
    this.gFaint = this.g.append("g");
    this.gHot = this.g.append("g");
    this.lx = this.g.append("text").attr("fill", "#5d6b86").attr("font-size", 10).text("k →");
    this.ly = this.g.append("text").attr("fill", "#5d6b86").attr("font-size", 10).attr("transform", "rotate(-90)").text("P(k)");
    this.x = d3.scaleLog().domain([Math.max(this.k[0], 0.6), this.k[this.k.length - 1]]);
    let lo = Infinity, hi = -Infinity;
    for (const row of this.M) for (const v of row) { if (v > 0 && v < lo) lo = v; if (v > hi) hi = v; }
    this.y = d3.scaleLog().domain([Math.max(lo, hi * 1e-6), hi]);
    this._resize();
  }

  _resize() {
    const r = this.el.getBoundingClientRect();
    this.iw = Math.max(200, r.width) - this.margin.left - this.margin.right;
    this.ih = Math.max(110, r.height) - this.margin.top - this.margin.bottom;
    this.g.attr("transform", `translate(${this.margin.left},${this.margin.top})`);
    this.x.range([0, this.iw]); this.y.range([this.ih, 0]);
    this.gx.attr("transform", `translate(0,${this.ih})`).call(d3.axisBottom(this.x).ticks(5, "~s"));
    this.gy.call(d3.axisLeft(this.y).ticks(5, "~e"));
    this.lx.attr("x", this.iw).attr("y", this.ih + 24).attr("text-anchor", "end");
    this.ly.attr("x", -8).attr("y", -38).attr("text-anchor", "end");
    this._drawFaint();
    if (this._step != null) this.update(this._step);
  }

  _line() {
    return d3.line().defined((d) => d[1] > 0).x((d) => this.x(d[0])).y((d) => this.y(d[1])).curve(d3.curveMonotoneX);
  }
  _pts(step) { return this.k.map((kk, i) => [kk, this.M[step][i]]); }

  _drawFaint() {
    const line = this._line();
    const steps = d3.range(0, this.N, 10);
    this.gFaint.selectAll("path").data(steps).join("path")
      .attr("fill", "none").attr("stroke", (s) => this.color(s)).attr("stroke-width", 1)
      .attr("opacity", 0.28).attr("d", (s) => line(this._pts(s)));
  }

  update(step) {
    this._step = step;
    const line = this._line();
    this.gHot.selectAll("path").data([step]).join("path")
      .attr("fill", "none").attr("stroke", (s) => this.color(s)).attr("stroke-width", 2.6)
      .attr("opacity", 1).attr("d", (s) => line(this._pts(s)));
  }

  resize() { this._resize(); }
}
