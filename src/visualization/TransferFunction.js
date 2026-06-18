import { DataTexture, RGBAFormat, UnsignedByteType, LinearFilter, ClampToEdgeWrapping } from "three";

const LUT_N = 256;

function hexRGB(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function rgbHex(c) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
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

function stopPosition(q, key) {
  if (key === "0") return 0;
  if (key === "1") return 1;
  return q[`q${String(key).replace(".", "")}`] ?? 0;
}

function colorStops(q, theme) {
  const stops = theme?.tfStops || [
    ["0", "#02030a"], ["25", "#070b18"], ["50", "#111936"], ["75", "#28305f"],
    ["90", "#4e3672"], ["95", "#854071"], ["99", "#c8688c"], ["1", "#f4e9ff"],
  ];
  return stops.map(([p, color]) => ({ p: stopPosition(q, p), c: hexRGB(color) }));
}

function alphaStops(q) {
  return [
    { p: 0.0, a: 0.0 }, { p: q.q25, a: 0.0 }, { p: q.q50, a: 0.0025 }, { p: q.q75, a: 0.015 },
    { p: q.q90, a: 0.050 }, { p: q.q95, a: 0.135 }, { p: q.q99, a: 0.35 }, { p: 1.0, a: 0.62 },
  ];
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function clampStopPosition(stops, index, p) {
  if (index <= 0) return 0;
  if (index >= stops.length - 1) return 1;
  const eps = 0.006;
  return Math.max(stops[index - 1].p + eps, Math.min(stops[index + 1].p - eps, p));
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
    this.data = new Uint8Array(LUT_N * 4);
    this.texture = new DataTexture(this.data, LUT_N, 1, RGBAFormat, UnsignedByteType);
    this.texture.minFilter = this.texture.magFilter = LinearFilter;
    this.texture.wrapS = this.texture.wrapT = ClampToEdgeWrapping;
    this.theme = null;
    this.setRecommendedStable();
  }

  setRecommendedStable(theme = this.theme) {
    if (theme) this.theme = theme;
    this.colorAnchors = colorStops(this.q, this.theme).map((s) => ({ p: s.p, c: [...s.c] }));
    this.alphaAnchors = alphaStops(this.q).map((s) => ({ p: s.p, a: s.a }));
    this.build();
  }

  setTheme(theme) {
    this.theme = theme;
    this.colorAnchors = colorStops(this.q, theme).map((s) => ({ p: s.p, c: [...s.c] }));
    this.build();
  }

  moveColorStop(index, p) {
    if (!this.colorAnchors[index]) return;
    this.colorAnchors[index].p = clampStopPosition(this.colorAnchors, index, clamp01(p));
    this.build();
  }

  moveAlphaStop(index, p, a) {
    if (!this.alphaAnchors[index]) return;
    this.alphaAnchors[index].p = clampStopPosition(this.alphaAnchors, index, clamp01(p));
    this.alphaAnchors[index].a = clamp01(a);
    this.build();
  }

  setColorStop(index, color) {
    if (!this.colorAnchors[index]) return;
    this.colorAnchors[index].c = hexRGB(color);
    this.build();
  }

  build() {
    const stops = this.colorAnchors;
    const anchors = this.alphaAnchors.map((s) => [s.p, s.a]);
    for (let i = 0; i < LUT_N; i++) {
      const x = i / (LUT_N - 1);
      const c = sampleStops(stops, x);
      const a = sampleAnchors(anchors, x);
      this.data[i * 4 + 0] = Math.round(c[0]);
      this.data[i * 4 + 1] = Math.round(c[1]);
      this.data[i * 4 + 2] = Math.round(c[2]);
      this.data[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
    }
    this.texture.needsUpdate = true;
  }

  cssStops() {
    return this.colorAnchors.map((s, i) => ({
      i,
      p: s.p,
      color: `rgb(${s.c[0] | 0},${s.c[1] | 0},${s.c[2] | 0})`,
      hex: rgbHex(s.c),
    }));
  }

  alphaCurve() {
    return this.alphaAnchors.map((s, i) => ({ i, p: s.p, a: s.a }));
  }
}
