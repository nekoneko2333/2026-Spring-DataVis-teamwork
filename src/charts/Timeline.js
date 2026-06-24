// 时间轴: 100 个节点, 颜色映射 Gini(结构不均匀度), 半径映射高密度体素占比(结构增长)。
// 支持两种布局: linear(普通时间轴) / spiral(阿基米德螺旋, 炫技)。可点击/拖动选步。
import * as d3 from "d3";

export class Timeline {
  constructor(el, stats, morph, onPick) {
    this.el = el; this.onPick = onPick;
    this.N = stats.steps.length;
    this.gini = stats.steps.map((s) => s.gini);
    const total = 128 * 128 * 128;
    this.highFrac = morph
      ? morph.steps.map((s) => s.highVoxels / total)
      : stats.steps.map((s) => 1 - s.percentiles["99"] / s.max);
    this.margin = { top: 16, right: 14, bottom: 18, left: 14 };
    this.layout = "linear";
    this.theme = null;
    this.giniColor = d3.scaleSequential(d3.interpolateRgbBasis(["#7f8796", "#a6b2bd", "#d3d8df"]))
      .domain(d3.extent(this.gini));
    this.rScale = d3.scaleSqrt().domain(d3.extent(this.highFrac)).range([1.5, 5]);
    this.lin = d3.scaleLinear().domain([0, this.N - 1]);
    this._build();
  }

  setLayout(mode) { this.layout = mode; this._resize(); }
  setTheme(theme) {
    this.theme = theme;
    this.giniColor = d3.scaleSequential(d3.interpolateRgbBasis([
      theme.timeline.early,
      theme.timeline.mid,
      theme.timeline.late,
    ])).domain(d3.extent(this.gini));
    if (this.cursor) this.cursor.attr("stroke", theme.timeline.cursor);
    this._resize();
  }

  _build() {
    this.svg = d3.select(this.el).append("svg").style("width", "100%").style("height", "100%");
    this.g = this.svg.append("g");
    this.track = this.g.append("path").attr("fill", "none").attr("stroke", "rgba(70,100,150,0.30)").attr("stroke-width", 1);
    this.gDots = this.g.append("g");
    this.cursor = this.g.append("circle").attr("r", 7).attr("fill", "none")
      .attr("stroke", "#1b2740").attr("stroke-width", 1.5).attr("opacity", 0.85);
    this.svg.on("pointerdown", (ev) => this._pick(ev));
    this.svg.on("pointermove", (ev) => { if (ev.buttons === 1) this._pick(ev); });
    this._resize();
  }

  _computePositions() {
    const iw = this.iw, ih = this.ih, pos = new Array(this.N);
    if (this.layout === "spiral") {
      const cx = iw / 2, cy = ih / 2;
      const turns = 3.2, maxR = Math.min(iw, ih) / 2 - 6;
      for (let i = 0; i < this.N; i++) {
        const f = i / (this.N - 1);
        const theta = f * turns * 2 * Math.PI - Math.PI / 2;
        const r = 7 + f * (maxR - 7);
        pos[i] = { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) };
      }
    } else {
      const cy = ih / 2;
      this.lin.range([0, iw]);
      for (let i = 0; i < this.N; i++) pos[i] = { x: this.lin(i), y: cy };
    }
    return pos;
  }

  _pick(ev) {
    const [mx, my] = d3.pointer(ev, this.g.node());
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.N; i++) {
      const dx = mx - this.pos[i].x, dy = my - this.pos[i].y;
      const d = this.layout === "spiral" ? dx * dx + dy * dy : Math.abs(dx);
      if (d < bd) { bd = d; best = i; }
    }
    this.onPick(best);
  }

  _resize() {
    const r = this.el.getBoundingClientRect();
    this.iw = Math.max(180, r.width) - this.margin.left - this.margin.right;
    this.ih = Math.max(40, r.height) - this.margin.top - this.margin.bottom;
    this.g.attr("transform", `translate(${this.margin.left},${this.margin.top})`);
    this.pos = this._computePositions();
    const lineGen = d3.line().x((d) => d.x).y((d) => d.y).curve(d3.curveCatmullRom);
    this.track.attr("d", lineGen(this.pos));
    this.gDots.selectAll("circle").data(d3.range(this.N)).join("circle")
      .attr("cx", (i) => this.pos[i].x).attr("cy", (i) => this.pos[i].y)
      .attr("r", (i) => this.rScale(this.highFrac[i]))
      .attr("fill", (i) => this.giniColor(this.gini[i]))
      .attr("opacity", 0.92);
    if (this._step != null) this.update(this._step);
  }

  update(step) {
    this._step = step;
    const p = this.pos[step];
    this.cursor.attr("cx", p.x).attr("cy", p.y);
  }

  resize() { this._resize(); }
}
