import {
  ClampToEdgeWrapping,
  Data3DTexture,
  FloatType,
  LinearFilter,
  NearestFilter,
  RedFormat,
  RGBFormat,
  UnsignedByteType,
} from "three";

const DATA = "./data";

export class DataManager {
  constructor() {
    this.meta = null;
    this.NX = this.NY = this.NZ = 128;
    this.cache = new Map();
    this.inflight = new Map();
    this.cacheLimit = 14;
    this.labelCache = new Map();
    this.labelInflight = new Map();
    this.labelLimit = 6;
    this.networkCache = new Map();
    this.networkInflight = new Map();
    this.preview = null;
    this.previewGradient = null;
    this.previewTex = null;
    this.previewGradientTex = null;
    this.previewN = 64;
  }

  _validateMetadata(meta) {
    const missing = [];
    if (!meta?.files?.volume) missing.push("files.volume");
    if (!meta?.files?.preview) missing.push("files.preview");
    if (!meta?.files?.gradient) missing.push("files.gradient");
    if (!meta?.files?.previewGradient) missing.push("files.previewGradient");
    if (meta?.gradientScale == null) missing.push("gradientScale");
    if (meta?.previewGradientScale == null) missing.push("previewGradientScale");
    if (missing.length > 0) {
      const detail = missing.join(", ");
      throw new Error(`public/data mismatch: missing ${detail}. Re-run preprocess/preprocess.py to generate gradient data.`);
    }
  }

  async init() {
    const [meta, stats, hist, power, morph, mc] = await Promise.all([
      fetch(`${DATA}/metadata.json`).then((r) => r.json()),
      fetch(`${DATA}/stats.json`).then((r) => r.json()),
      fetch(`${DATA}/histograms.json`).then((r) => r.json()),
      fetch(`${DATA}/powerspectrum.json`).then((r) => r.json()),
      fetch(`${DATA}/morphology.json`).then((r) => r.json()).catch(() => null),
      fetch(`${DATA}/mc_manifest.json`).then((r) => r.json()).catch(() => null),
    ]);
    this._validateMetadata(meta);
    this.meta = meta;
    this.mcManifest = mc;
    this.meshCache = new Map();
    [this.NZ, this.NY, this.NX] = meta.shape;
    this.previewN = meta.previewSize;
    return { meta, stats, hist, power, morph, mc };
  }

  async loadPreview(onProgress) {
    const [previewRes, previewGradRes] = await Promise.all([
      fetch(`${DATA}/${this.meta.files.preview}`),
      fetch(`${DATA}/${this.meta.files.previewGradient}`),
    ]);
    this.preview = new Uint8Array(await previewRes.arrayBuffer());
    this.previewGradient = new Uint8Array(await previewGradRes.arrayBuffer());

    const n = this.previewN;
    this.previewTex = new Data3DTexture(new Float32Array(n * n * n), n, n, n);
    this.previewTex.format = RedFormat;
    this.previewTex.type = FloatType;
    this.previewTex.minFilter = this.previewTex.magFilter = LinearFilter;
    this.previewTex.wrapS = this.previewTex.wrapT = this.previewTex.wrapR = ClampToEdgeWrapping;

    this.previewGradientTex = new Data3DTexture(new Uint8Array(n * n * n * 3), n, n, n);
    this.previewGradientTex.format = RGBFormat;
    this.previewGradientTex.type = UnsignedByteType;
    this.previewGradientTex.minFilter = this.previewGradientTex.magFilter = LinearFilter;
    this.previewGradientTex.wrapS = this.previewGradientTex.wrapT = this.previewGradientTex.wrapR = ClampToEdgeWrapping;

    if (onProgress) onProgress(1);
  }

  getPreviewTexture(step) {
    const n = this.previewN;
    const vox = n * n * n;
    const off = step * vox;
    const dst = this.previewTex.image.data;
    const src = this.preview;
    for (let i = 0; i < vox; i++) dst[i] = src[off + i] / 255;
    this.previewTex.needsUpdate = true;
    return this.previewTex;
  }

  getPreviewGradientTexture(step) {
    const n = this.previewN;
    const vox3 = n * n * n * 3;
    const off = step * vox3;
    const dst = this.previewGradientTex.image.data;
    dst.set(this.previewGradient.subarray(off, off + vox3));
    this.previewGradientTex.needsUpdate = true;
    return {
      texture: this.previewGradientTex,
      scale: this.meta.previewGradientScale,
    };
  }

  _decodeU16(buf) {
    const u16 = new Uint16Array(buf);
    const f = new Float32Array(u16.length);
    const inv = 1 / 65535;
    for (let i = 0; i < u16.length; i++) f[i] = u16[i] * inv;
    return f;
  }

  _makeVolumeTexture(f32) {
    const t = new Data3DTexture(f32, this.NX, this.NY, this.NZ);
    t.format = RedFormat;
    t.type = FloatType;
    t.minFilter = t.magFilter = LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  }

  _makeGradientTexture(u8) {
    const t = new Data3DTexture(u8, this.NX, this.NY, this.NZ);
    t.format = RGBFormat;
    t.type = UnsignedByteType;
    t.minFilter = t.magFilter = LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  }

  getVolumeSet(step) {
    if (this.cache.has(step)) {
      const entry = this.cache.get(step);
      entry.ts = performance.now();
      return Promise.resolve(entry);
    }
    if (this.inflight.has(step)) return this.inflight.get(step);

    const volumeUrl = `${DATA}/${this.meta.files.volume.replace("{:04d}", String(step).padStart(4, "0"))}`;
    const gradientUrl = `${DATA}/${this.meta.files.gradient.replace("{:04d}", String(step).padStart(4, "0"))}`;
    const p = Promise.all([
      fetch(volumeUrl).then((r) => r.arrayBuffer()),
      fetch(gradientUrl).then((r) => r.arrayBuffer()),
    ]).then(([volumeBuf, gradientBuf]) => {
      const volumeData = this._decodeU16(volumeBuf);
      const entry = {
        volumeData,
        volumeTex: this._makeVolumeTexture(volumeData),
        gradientTex: this._makeGradientTexture(new Uint8Array(gradientBuf)),
        gradientScale: this.meta.gradientScale,
        ts: performance.now(),
      };
      this._putVolumeEntry(step, entry);
      this.inflight.delete(step);
      return entry;
    }).catch((e) => {
      this.inflight.delete(step);
      throw e;
    });

    this.inflight.set(step, p);
    return p;
  }

  getVolumeTexture(step) {
    return this.getVolumeSet(step).then((entry) => entry.volumeTex);
  }

  getGradientTexture(step) {
    return this.getVolumeSet(step).then((entry) => ({
      texture: entry.gradientTex,
      scale: entry.gradientScale,
    }));
  }

  getLabelTexture(step, method = "proxy") {
    const key = `${method}:${step}`;
    if (this.labelCache.has(key)) {
      const entry = this.labelCache.get(key);
      entry.ts = performance.now();
      return Promise.resolve(entry.tex);
    }
    if (this.labelInflight.has(key)) return this.labelInflight.get(key);
    let rel = this.meta.files.labels.replace("{:04d}", String(step).padStart(4, "0"));
    if (method === "tweb") rel = rel.replace("labels/", "labels_tweb/");
    const url = `${DATA}/${rel}`;
    const p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const u8 = new Uint8Array(buf);
        const f = new Float32Array(u8.length);
        for (let i = 0; i < u8.length; i++) f[i] = u8[i];
        const t = new Data3DTexture(f, this.NX, this.NY, this.NZ);
        t.format = RedFormat;
        t.type = FloatType;
        t.minFilter = t.magFilter = NearestFilter;
        t.wrapS = t.wrapT = t.wrapR = ClampToEdgeWrapping;
        t.needsUpdate = true;
        this._putLabelEntry(key, t);
        this.labelInflight.delete(key);
        return t;
      })
      .catch((e) => {
        this.labelInflight.delete(key);
        throw e;
      });
    this.labelInflight.set(key, p);
    return p;
  }

  nearestMeshStep(step) {
    if (!this.mcManifest) return null;
    let best = this.mcManifest.steps[0];
    let bestDist = Infinity;
    for (const s of this.mcManifest.steps) {
      const d = Math.abs(s - step);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  loadMesh(step) {
    const s = this.nearestMeshStep(step);
    if (s == null) return Promise.resolve(null);
    if (this.meshCache.has(s)) return Promise.resolve(this.meshCache.get(s));
    const url = `${DATA}/${this.mcManifest.file.replace("{:04d}", String(s).padStart(4, "0"))}`;
    return fetch(url).then((r) => r.arrayBuffer()).then((buf) => {
      const head = new Uint32Array(buf, 0, 2);
      const nV = head[0];
      const nF = head[1];
      const positions = new Float32Array(buf, 8, nV * 3);
      const indices = new Uint32Array(buf, 8 + nV * 12, nF * 3);
      const mesh = { step: s, positions, indices, verts: nV, faces: nF };
      this.meshCache.set(s, mesh);
      return mesh;
    });
  }

  getNetwork(step = 99) {
    if (this.networkCache.has(step)) return Promise.resolve(this.networkCache.get(step));
    if (this.networkInflight.has(step)) return this.networkInflight.get(step);
    const url = `${DATA}/network/t${String(step).padStart(4, "0")}_graph.json`;
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Network graph not found: ${url}`);
        return r.json();
      })
      .then((graph) => {
        this.networkCache.set(step, graph);
        this.networkInflight.delete(step);
        return graph;
      })
      .catch((e) => {
        this.networkInflight.delete(step);
        throw e;
      });
    this.networkInflight.set(step, p);
    return p;
  }
  _putVolumeEntry(step, entry) {
    this.cache.set(step, entry);
    while (this.cache.size > this.cacheLimit) {
      let oldest = null;
      let oldestTs = Infinity;
      for (const [k, v] of this.cache) {
        if (v.ts < oldestTs) {
          oldestTs = v.ts;
          oldest = k;
        }
      }
      if (oldest == null) break;
      const stale = this.cache.get(oldest);
      stale.volumeTex.dispose();
      stale.gradientTex.dispose();
      this.cache.delete(oldest);
    }
  }

  _putLabelEntry(step, tex) {
    this.labelCache.set(step, { tex, ts: performance.now() });
    while (this.labelCache.size > this.labelLimit) {
      let oldest = null;
      let oldestTs = Infinity;
      for (const [k, v] of this.labelCache) {
        if (v.ts < oldestTs) {
          oldestTs = v.ts;
          oldest = k;
        }
      }
      if (oldest == null) break;
      this.labelCache.get(oldest).tex.dispose();
      this.labelCache.delete(oldest);
    }
  }

  prefetch(step, dir = 1, radius = 3) {
    const total = this.meta.timeSteps;
    for (let d = 1; d <= radius; d++) {
      const s = (step + dir * d + total) % total;
      if (!this.cache.has(s) && !this.inflight.has(s)) this.getVolumeSet(s);
    }
  }

  isCached(step) {
    return this.cache.has(step);
  }

  sampleLine(step, uvw0, uvw1, n = 256) {
    const entry = this.cache.get(step);
    if (entry) {
      return { samples: this._sampleArray(entry.volumeData, this.NX, 0, 1.0, uvw0, uvw1, n), full: true };
    }
    const N = this.previewN;
    return {
      samples: this._sampleArray(this.preview, N, step * N * N * N, 1 / 255, uvw0, uvw1, n),
      full: false,
    };
  }

  _sampleArray(src, N, base, scale, uvw0, uvw1, n) {
    const out = new Float32Array(n);
    const tri = (x, y, z) => {
      x = Math.min(Math.max(x * (N - 1), 0), N - 1.001);
      y = Math.min(Math.max(y * (N - 1), 0), N - 1.001);
      z = Math.min(Math.max(z * (N - 1), 0), N - 1.001);
      const x0 = x | 0;
      const y0 = y | 0;
      const z0 = z | 0;
      const fx = x - x0;
      const fy = y - y0;
      const fz = z - z0;
      const idx = (xx, yy, zz) => base + xx + N * (yy + N * zz);
      const c000 = src[idx(x0, y0, z0)];
      const c100 = src[idx(x0 + 1, y0, z0)];
      const c010 = src[idx(x0, y0 + 1, z0)];
      const c110 = src[idx(x0 + 1, y0 + 1, z0)];
      const c001 = src[idx(x0, y0, z0 + 1)];
      const c101 = src[idx(x0 + 1, y0, z0 + 1)];
      const c011 = src[idx(x0, y0 + 1, z0 + 1)];
      const c111 = src[idx(x0 + 1, y0 + 1, z0 + 1)];
      const c00 = c000 * (1 - fx) + c100 * fx;
      const c10 = c010 * (1 - fx) + c110 * fx;
      const c01 = c001 * (1 - fx) + c101 * fx;
      const c11 = c011 * (1 - fx) + c111 * fx;
      const c0 = c00 * (1 - fy) + c10 * fy;
      const c1 = c01 * (1 - fy) + c11 * fy;
      return (c0 * (1 - fz) + c1 * fz) * scale;
    };
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      out[i] = tri(
        uvw0.x + (uvw1.x - uvw0.x) * t,
        uvw0.y + (uvw1.y - uvw0.y) * t,
        uvw0.z + (uvw1.z - uvw0.z) * t
      );
    }
    return out;
  }

  selectionStats(step, nmin, nmax) {
    const entry = this.cache.get(step);
    if (!entry) return null;
    const d = entry.volumeData;
    const total = d.length;
    let count = 0;
    let sum = 0;
    let mx = -1;
    for (let i = 0; i < total; i++) {
      const v = d[i];
      if (v >= nmin && v <= nmax) {
        count++;
        sum += v;
        if (v > mx) mx = v;
      }
    }
    return {
      count,
      total,
      fraction: count / total,
      meanNorm: count ? sum / count : 0,
      maxNorm: count ? mx : 0,
      exact: true,
    };
  }
}
