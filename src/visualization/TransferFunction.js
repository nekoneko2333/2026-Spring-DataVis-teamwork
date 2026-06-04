// 基于分位数的自适应传递函数: 把归一化 log-density [0,1] 映射到 RGBA。
// 颜色: void 深蓝/黑 -> filament 青/紫 -> node 金 -> top 白(发光);
// 透明度: void 近透明, 随密度上升, 突出宇宙网结构。
import { DataTexture, RGBAFormat, UnsignedByteType, LinearFilter, ClampToEdgeWrapping } from "three";

const LUT_N = 256;

function hexRGB(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function lerp(a, b, t) { return a + (b - a) * t; }

function sampleStops(stops, x) {
  if (x <= stops[0].p) return stops[0].c;
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i].p) {
      const a = stops[i - 1], b = stops[i];
      const t = (x - a.p) / Math.max(b.p - a.p, 1e-6);
      return [lerp(a.c[0], b.c[0], t), lerp(a.c[1], b.c[1], t), lerp(a.c[2], b.c[2], t)];
    }
  }
  return stops[stops.length - 1].c;
}

function sampleAnchors(anchors, x) {
  if (x <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    if (x <= anchors[i][0]) {
      const a = anchors[i - 1], b = anchors[i];
      const t = (x - a[0]) / Math.max(b[0] - a[0], 1e-6);
      return lerp(a[1], b[1], t);
    }
  }
  return anchors[anchors.length - 1][1];
}

// 颜色预设
function colorStops(preset, q) {
  // q: 归一化分位数 {25,50,75,90,95,99,999}
  switch (preset) {
    case "fire":
      return [
        { p: 0.0, c: hexRGB("#05030a") }, { p: q.q25, c: hexRGB("#2a0a06") },
        { p: q.q50, c: hexRGB("#7a1e08") }, { p: q.q75, c: hexRGB("#d4561a") },
        { p: q.q95, c: hexRGB("#ffae33") }, { p: q.q999, c: hexRGB("#fff2b0") },
        { p: 1.0, c: hexRGB("#ffffff") },
      ];
    case "ice":
      return [
        { p: 0.0, c: hexRGB("#02040c") }, { p: q.q25, c: hexRGB("#081634") },
        { p: q.q50, c: hexRGB("#0f3a78") }, { p: q.q75, c: hexRGB("#2f8ad8") },
        { p: q.q95, c: hexRGB("#79d6ff") }, { p: q.q999, c: hexRGB("#d8f6ff") },
        { p: 1.0, c: hexRGB("#ffffff") },
      ];
    case "spectral":
      return [
        { p: 0.0, c: hexRGB("#08030f") }, { p: q.q25, c: hexRGB("#23206b") },
        { p: q.q50, c: hexRGB("#1f8f9e") }, { p: q.q75, c: hexRGB("#6fcf52") },
        { p: q.q90, c: hexRGB("#f2d43d") }, { p: q.q99, c: hexRGB("#ef5d3a") },
        { p: 1.0, c: hexRGB("#fff3e8") },
      ];
    case "cosmic":
    default:
      return [
        { p: 0.0, c: hexRGB("#03040c") }, { p: q.q25, c: hexRGB("#0a1838") },
        { p: q.q50, c: hexRGB("#163a6b") }, { p: q.q75, c: hexRGB("#1f8fae") },
        { p: q.q90, c: hexRGB("#38e1d6") }, { p: q.q95, c: hexRGB("#a78bfa") },
        { p: q.q99, c: hexRGB("#ffcc66") }, { p: 1.0, c: hexRGB("#fffaf0") },
      ];
  }
}

export class TransferFunction {
  constructor(meta) {
    this.meta = meta;
    const gp = meta.globalPercentiles;
    const norm = (v) => (v - meta.globalLogMin) / (meta.globalLogMax - meta.globalLogMin);
    this.q = {
      q25: norm(gp["25"]), q50: norm(gp["50"]), q75: norm(gp["75"]),
      q90: norm(gp["90"]), q95: norm(gp["95"]), q99: norm(gp["99"]), q999: norm(gp["99.9"]),
    };
    // 透明度锚点(基于分位数): void 透明, filament 上升, node 高
    this.alphaAnchors = [
      [0.0, 0.0], [this.q.q25, 0.0], [this.q.q50, 0.012], [this.q.q75, 0.06],
      [this.q.q90, 0.16], [this.q.q95, 0.30], [this.q.q99, 0.62], [1.0, 0.95],
    ];
    this.preset = "cosmic";
    this.data = new Uint8Array(LUT_N * 4);
    this.texture = new DataTexture(this.data, LUT_N, 1, RGBAFormat, UnsignedByteType);
    this.texture.minFilter = this.texture.magFilter = LinearFilter;
    this.texture.wrapS = this.texture.wrapT = ClampToEdgeWrapping;
    this.build();
  }

  setPreset(p) { this.preset = p; this.build(); }

  build() {
    const stops = colorStops(this.preset, this.q);
    for (let i = 0; i < LUT_N; i++) {
      const x = i / (LUT_N - 1);
      const c = sampleStops(stops, x);
      const a = sampleAnchors(this.alphaAnchors, x);
      this.data[i * 4 + 0] = Math.round(c[0]);
      this.data[i * 4 + 1] = Math.round(c[1]);
      this.data[i * 4 + 2] = Math.round(c[2]);
      this.data[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
    }
    this.texture.needsUpdate = true;
    this._stops = stops;
  }

  // 返回用于 UI 绘制的渐变 stops (css 颜色 + 位置)
  cssStops() {
    return this._stops.map((s) => ({
      p: s.p, color: `rgb(${s.c[0]|0},${s.c[1]|0},${s.c[2]|0})`,
    }));
  }
  alphaCurve() { return this.alphaAnchors.map(([p, a]) => ({ p, a })); }
}
