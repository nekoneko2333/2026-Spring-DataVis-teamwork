// 统计量随时间曲线 (Gini/熵/方差/峰度/...)。各序列归一化到 [0,1] 便于同图对比,
// 悬停显示真实值, 图例可切换, 竖线标记当前时间步。
import * as d3 from "d3";

export class TimeSeries {
  constructor(el, series) {
    this.el = el;
    this.series = series; // [{key,label,color,values:[...]}]
    this.on = new Set(series.map((s) => s.key));
    this.margin = { top: 12, right: 16, bottom: 26, left: 30 };
    this.N = series[0].values.length;
    this._build();
  }

  _build() {
    this.svg = d3.select(this.el).append("svg").style("width", "100%").style("height", "100%");
    this.g = this.svg.append("g");
    this.gx = this.g.append("g").attr("class", "axis");
    this.gGrid = this.g.append("g").attr("class", "grid");
    this.gLines = this.g.append("g");
    this.marker = this.g.append("line").attr("stroke", "#c06a09").attr("stroke-dasharray", "3,3").attr("opacity", 0.8);
    this.focus = this.g.append("g");
    this.legend = d3.select(this.el).append("div").attr("class", "ts-legend")
      .style("position", "absolute").style("top", "2px").style("right", "16px")
      .style("display", "flex").style("gap", "10px").style("flex-wrap", "wrap").style("font-size", "10px");
    this._buildLegend();
    this.tip = d3.select(this.el).append("div").attr("class", "chart-tip").style("opacity", 0);
    this.x = d3.scaleLinear().domain([0, this.N - 1]);
    this.y = d3.scaleLinear().domain([0, 1]);
    // 预归一化
    this.norm = {};
    for (const s of this.series) {
      const ext = d3.extent(s.values);
      this.norm[s.key] = s.values.map((v) => (v - ext[0]) / Math.max(ext[1] - ext[0], 1e-12));
      s.ext = ext;
    }
    this._resize();
    this.svg.on("mousemove", (ev) => this._hover(ev)).on("mouseleave", () => this.tip.style("opacity", 0));
  }

  _buildLegend() {
    this.legend.selectAll("*").remove();
    for (const s of this.series) {
      const item = this.legend.append("div").style("cursor", "pointer")
        .style("opacity", this.on.has(s.key) ? 1 : 0.35)
        .on("click", () => { this.on.has(s.key) ? this.on.delete(s.key) : this.on.add(s.key); this._buildLegend(); this._draw(); });
      item.html(`<span style="color:${s.color}">●</span> ${s.label}`);
    }
  }

  _resize() {
    const r = this.el.getBoundingClientRect();
    this.iw = Math.max(200, r.width) - this.margin.left - this.margin.right;
    this.ih = Math.max(110, r.height) - this.margin.top - this.margin.bottom;
    this.g.attr("transform", `translate(${this.margin.left},${this.margin.top})`);
    this.x.range([0, this.iw]); this.y.range([this.ih, 0]);
    this.gx.attr("transform", `translate(0,${this.ih})`).call(d3.axisBottom(this.x).ticks(8).tickFormat(d3.format("d")));
    this.gGrid.call(d3.axisLeft(this.y).ticks(4).tickSize(-this.iw).tickFormat("")).select(".domain").remove();
    this.marker.attr("y1", 0).attr("y2", this.ih);
    this._draw();
  }

  _draw() {
    const line = d3.line().x((d, i) => this.x(i)).y((d) => this.y(d)).curve(d3.curveMonotoneX);
    const data = this.series.filter((s) => this.on.has(s.key));
    const sel = this.gLines.selectAll("path").data(data, (d) => d.key);
    sel.join("path")
      .attr("fill", "none").attr("stroke", (d) => d.color).attr("stroke-width", 1.8)
      .attr("opacity", 0.9).attr("d", (d) => line(this.norm[d.key]));
    if (this._step != null) this.update(this._step);
  }

  update(step) {
    this._step = step;
    this.marker.attr("x1", this.x(step)).attr("x2", this.x(step));
    const dots = this.focus.selectAll("circle").data(this.series.filter((s) => this.on.has(s.key)), (d) => d.key);
    dots.join("circle").attr("r", 3).attr("fill", (d) => d.color)
      .attr("cx", this.x(step)).attr("cy", (d) => this.y(this.norm[d.key][step]));
  }

  _hover(ev) {
    const [mx] = d3.pointer(ev, this.g.node());
    let i = Math.round(this.x.invert(mx));
    i = Math.min(this.N - 1, Math.max(0, i));
    const rows = this.series.filter((s) => this.on.has(s.key))
      .map((s) => `<div><span style="color:${s.color}">●</span> ${s.label}: <b>${d3.format(".4g")(s.values[i])}</b></div>`).join("");
    this.tip.style("opacity", 1).html(`<div style="color:#c06a09">t = ${i}</div>${rows}`)
      .style("left", `${Math.min(ev.offsetX + 14, this.el.clientWidth - 150)}px`).style("top", `${ev.offsetY + 8}px`);
  }

  resize() { this._resize(); }
}
