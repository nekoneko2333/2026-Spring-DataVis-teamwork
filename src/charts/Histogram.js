// log-density 直方图 + D3 刷选。柱子按传递函数着色, 与 3D 视图颜色呼应。
// 刷选 -> 归一化区间 [0,1] -> 通过回调驱动 3D 体素过滤与选区统计。
import * as d3 from "d3";

export class Histogram {
  constructor(el, meta, onBrush) {
    this.el = el;
    this.meta = meta;
    this.onBrush = onBrush;
    this.margin = { top: 12, right: 14, bottom: 26, left: 46 };
    this.centersNorm = meta.histCenters.map(
      (v) => (v - meta.globalLogMin) / (meta.globalLogMax - meta.globalLogMin)
    );
    this.centersLog = meta.histCenters;
    this.tf = null;
    this._build();
  }

  setTF(tf) { this.tf = tf; this._recolor(); }

  _build() {
    this.svg = d3.select(this.el).append("svg").style("width", "100%").style("height", "100%");
    this.gRoot = this.svg.append("g");
    this.gGrid = this.gRoot.append("g").attr("class", "grid");
    this.gBars = this.gRoot.append("g");
    this.gBrush = this.gRoot.append("g").attr("class", "brush");
    this.gx = this.gRoot.append("g").attr("class", "axis");
    this.gy = this.gRoot.append("g").attr("class", "axis");
    this.label = this.gRoot.append("text").attr("fill", "#5d6b86").attr("font-size", 10);

    this.x = d3.scaleLinear().domain([this.meta.globalLogMin, this.meta.globalLogMax]);
    this.y = d3.scalePow().exponent(0.42).domain([0, 1]); // 兼顾主峰与长尾

    this.brush = d3.brushX().on("brush end", (ev) => this._brushed(ev));
    this._suppress = false;
    this._resize();
  }

  _resize() {
    const r = this.el.getBoundingClientRect();
    this.W = Math.max(200, r.width);
    this.H = Math.max(120, r.height);
    const iw = this.W - this.margin.left - this.margin.right;
    const ih = this.H - this.margin.top - this.margin.bottom;
    this.iw = iw; this.ih = ih;
    this.gRoot.attr("transform", `translate(${this.margin.left},${this.margin.top})`);
    this.x.range([0, iw]);
    this.y.range([ih, 0]);
    this.brush.extent([[0, 0], [iw, ih]]);
    this.gBrush.call(this.brush);
    this.gx.attr("transform", `translate(0,${ih})`).call(d3.axisBottom(this.x).ticks(7).tickFormat(d3.format(".1f")));
    this.gy.call(d3.axisLeft(this.y).ticks(4).tickFormat(d3.format(".0%")));
    this.label.attr("x", iw - 2).attr("y", ih + 22).attr("text-anchor", "end").text("log10 density →");
    if (this._counts) this.update(this._step, this._counts);
  }

  update(step, counts) {
    this._step = step; this._counts = counts;
    const ih = this.ih;
    const ymax = d3.max(counts) || 1;
    this.y.domain([0, ymax]);
    this.gy.call(d3.axisLeft(this.y).ticks(4).tickFormat(d3.format(".1%")));
    const n = counts.length;
    const bw = this.iw / n;
    const bars = this.gBars.selectAll("rect").data(counts);
    bars.join("rect")
      .attr("x", (d, i) => i * bw)
      .attr("width", Math.max(0.6, bw - 0.4))
      .attr("y", (d) => this.y(d))
      .attr("height", (d) => ih - this.y(d))
      .attr("fill", (d, i) => this._barColor(i));
  }

  _barColor(i) {
    if (!this.tf) return "#7f8790";
    const x = this.centersNorm[i];
    const j = Math.min(255, Math.max(0, Math.round(x * 255)));
    const d = this.tf.data;
    const floor = 58;
    const r = Math.max(floor, d[j * 4]);
    const g = Math.max(floor, d[j * 4 + 1]);
    const b = Math.max(floor, d[j * 4 + 2]);
    return `rgb(${r},${g},${b})`;
  }
  _recolor() {
    this.gBars.selectAll("rect").attr("fill", (d, i) => this._barColor(i));
  }

  _brushed(ev) {
    if (this._suppress) return;
    if (!ev.selection) { this.onBrush(null); return; }
    const [x0, x1] = ev.selection;
    const lo = this.x.invert(x0), hi = this.x.invert(x1);
    const span = this.meta.globalLogMax - this.meta.globalLogMin;
    const nmin = (lo - this.meta.globalLogMin) / span;
    const nmax = (hi - this.meta.globalLogMin) / span;
    this.onBrush({ min: nmin, max: nmax, logMin: lo, logMax: hi });
  }

  // 外部(快捷按钮/模式)设定刷选范围, 不回环触发
  setRangeNorm(nmin, nmax) {
    this._suppress = true;
    if (nmin == null) {
      this.gBrush.call(this.brush.move, null);
    } else {
      const lo = this.meta.globalLogMin + nmin * (this.meta.globalLogMax - this.meta.globalLogMin);
      const hi = this.meta.globalLogMin + nmax * (this.meta.globalLogMax - this.meta.globalLogMin);
      this.gBrush.call(this.brush.move, [this.x(lo), this.x(hi)]);
    }
    this._suppress = false;
  }

  resize() { this._resize(); }
}
