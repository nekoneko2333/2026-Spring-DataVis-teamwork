// 演化"指纹图": 时间(行) × log-density(列) 的 2D 热力图, 频数着色。
// canvas 绘制底图 + SVG 轴/时间游标。
import * as d3 from "d3";

export class Fingerprint {
  constructor(el, meta, hist) {
    this.el = el; this.meta = meta; this.hist = hist;
    this.bins = hist.bins; this.steps = meta.timeSteps;
    this.margin = { top: 10, right: 16, bottom: 26, left: 46 };
    this.scaleColors = ["#020202", "#090909", "#1f1f1f", "#6e737a", "#aeb4ba", "#ffffff"];
    this.markerColor = "#f2f5f8";
    this._buildImage();
    this._build();
  }

  _buildImage() {
    const M = this.hist.matrix;
    let mx = 0;
    for (const row of M) for (const v of row) if (v > mx) mx = v;
    this.maxFreq = mx;
    const off = document.createElement("canvas");
    off.width = this.bins; off.height = this.steps;
    const ctx = off.getContext("2d");
    const img = ctx.createImageData(this.bins, this.steps);
    for (let s = 0; s < this.steps; s++) {
      for (let b = 0; b < this.bins; b++) {
        const v = Math.pow(M[s][b] / mx, 0.42);
        const c = d3.rgb(d3.interpolateRgbBasis(this.scaleColors)(v));
        const idx = (s * this.bins + b) * 4;
        img.data[idx] = c.r; img.data[idx + 1] = c.g; img.data[idx + 2] = c.b; img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.offscreen = off;
  }

  _build() {
    this.canvas = d3.select(this.el).append("canvas")
      .style("position", "absolute").style("image-rendering", "auto").node();
    this.svg = d3.select(this.el).append("svg")
      .style("position", "absolute").style("inset", "0").style("width", "100%").style("height", "100%");
    this.g = this.svg.append("g");
    this.gx = this.g.append("g").attr("class", "axis");
    this.gy = this.g.append("g").attr("class", "axis");
    this.marker = this.g.append("line").attr("stroke", this.markerColor).attr("stroke-width", 1.5).attr("opacity", 0.9);
    this.g.append("text").attr("fill", "#5d6b86").attr("font-size", 10).attr("x", -34).attr("y", -2).text("step");
    this.x = d3.scaleLinear().domain([this.meta.globalLogMin, this.meta.globalLogMax]);
    this.y = d3.scaleLinear().domain([0, this.steps - 1]);
    this._resize();
  }

  _resize() {
    const r = this.el.getBoundingClientRect();
    const iw = Math.max(200, r.width) - this.margin.left - this.margin.right;
    const ih = Math.max(120, r.height) - this.margin.top - this.margin.bottom;
    this.iw = iw; this.ih = ih;
    this.g.attr("transform", `translate(${this.margin.left},${this.margin.top})`);
    this.x.range([0, iw]); this.y.range([0, ih]);
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = iw * dpr; this.canvas.height = ih * dpr;
    Object.assign(this.canvas.style, {
      left: `${this.margin.left}px`, top: `${this.margin.top}px`,
      width: `${iw}px`, height: `${ih}px`,
    });
    const ctx = this.canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.offscreen, 0, 0, this.canvas.width, this.canvas.height);
    this.gx.attr("transform", `translate(0,${ih})`).call(d3.axisBottom(this.x).ticks(7).tickFormat(d3.format(".1f")));
    this.gy.call(d3.axisLeft(this.y).ticks(6).tickFormat(d3.format("d")));
    this.marker.attr("x1", 0).attr("x2", iw);
    if (this._step != null) this.update(this._step);
  }

  update(step) {
    this._step = step;
    const yy = this.y(step);
    this.marker.attr("y1", yy).attr("y2", yy);
  }

  setTheme(theme) {
    this.scaleColors = theme.fingerprint;
    this.markerColor = theme.accent;
    this._buildImage();
    if (this.marker) this.marker.attr("stroke", this.markerColor);
    this._resize();
  }

  resize() { this._resize(); }
}
