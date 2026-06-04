// 体数据加载器: JSON 元数据 + 全分辨率 u16 体数据(按需流式 + LRU) +
// 64^3 低分辨率预览(常驻内存, 保证播放/拖动 >15fps) + 形态学 label 体。
import {
  Data3DTexture, RedFormat, FloatType, UnsignedByteType,
  LinearFilter, NearestFilter, ClampToEdgeWrapping,
} from "three";

const DATA = "./data";

export class DataManager {
  constructor() {
    this.meta = null;
    this.NX = this.NY = this.NZ = 128;
    this.cache = new Map();       // step -> {tex, ts}  全分辨率
    this.inflight = new Map();    // step -> Promise
    this.cacheLimit = 14;         // LRU 容量(每个 ~8MB GPU)
    this.labelCache = new Map();
    this.labelInflight = new Map();
    this.labelLimit = 6;
    this.preview = null;          // Uint8Array 全部步
    this.previewTex = null;       // 复用的 64^3 纹理
    this.previewN = 64;
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
    this.meta = meta;
    this.mcManifest = mc;
    this.meshCache = new Map();
    [this.NZ, this.NY, this.NX] = meta.shape;
    this.previewN = meta.previewSize;
    return { meta, stats, hist, power, morph, mc };
  }

  async loadPreview(onProgress) {
    const res = await fetch(`${DATA}/${this.meta.files.preview}`);
    const buf = await res.arrayBuffer();
    this.preview = new Uint8Array(buf);
    const n = this.previewN;
    this.previewTex = new Data3DTexture(new Float32Array(n * n * n), n, n, n);
    this.previewTex.format = RedFormat;
    this.previewTex.type = FloatType;
    this.previewTex.minFilter = this.previewTex.magFilter = LinearFilter;
    this.previewTex.wrapS = this.previewTex.wrapT = this.previewTex.wrapR = ClampToEdgeWrapping;
    if (onProgress) onProgress(1);
  }

  // 低分辨率纹理(就地更新, 极快): 用于播放/拖动
  getPreviewTexture(step) {
    const n = this.previewN, vox = n * n * n;
    const off = step * vox;
    const dst = this.previewTex.image.data;
    const src = this.preview;
    for (let i = 0; i < vox; i++) dst[i] = src[off + i] / 255;
    this.previewTex.needsUpdate = true;
    return this.previewTex;
  }

  _decodeU16(buf) {
    const u16 = new Uint16Array(buf);
    const f = new Float32Array(u16.length);
    const inv = 1 / 65535;
    for (let i = 0; i < u16.length; i++) f[i] = u16[i] * inv;
    return f;
  }

  _makeVolTex(f32) {
    const t = new Data3DTexture(f32, this.NX, this.NY, this.NZ);
    t.format = RedFormat; t.type = FloatType;
    t.minFilter = t.magFilter = LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  }

  // 全分辨率纹理(异步)。命中缓存即时返回。
  getVolumeTexture(step) {
    if (this.cache.has(step)) {
      const e = this.cache.get(step); e.ts = performance.now();
      return Promise.resolve(e.tex);
    }
    if (this.inflight.has(step)) return this.inflight.get(step);
    const url = `${DATA}/${this.meta.files.volume.replace("{:04d}", String(step).padStart(4, "0"))}`;
    const p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const tex = this._makeVolTex(this._decodeU16(buf));
        this._put(this.cache, this.cacheLimit, step, tex);
        this.inflight.delete(step);
        return tex;
      })
      .catch((e) => { this.inflight.delete(step); throw e; });
    this.inflight.set(step, p);
    return p;
  }

  // label 体纹理(0..3, nearest)。method: 'proxy'(density-Hessian) | 'tweb'(T-web)
  getLabelTexture(step, method = "proxy") {
    const key = `${method}:${step}`;
    if (this.labelCache.has(key)) {
      const e = this.labelCache.get(key); e.ts = performance.now();
      return Promise.resolve(e.tex);
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
        t.format = RedFormat; t.type = FloatType;
        t.minFilter = t.magFilter = NearestFilter;
        t.wrapS = t.wrapT = t.wrapR = ClampToEdgeWrapping;
        t.needsUpdate = true;
        this._put(this.labelCache, this.labelLimit, key, t);
        this.labelInflight.delete(key);
        return t;
      })
      .catch((e) => { this.labelInflight.delete(key); throw e; });
    this.labelInflight.set(key, p);
    return p;
  }

  // Marching Cubes 网格(按最近可用步吸附)
  nearestMeshStep(step) {
    if (!this.mcManifest) return null;
    let best = this.mcManifest.steps[0], bd = Infinity;
    for (const s of this.mcManifest.steps) {
      const d = Math.abs(s - step);
      if (d < bd) { bd = d; best = s; }
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
      const nV = head[0], nF = head[1];
      const positions = new Float32Array(buf, 8, nV * 3);
      const indices = new Uint32Array(buf, 8 + nV * 12, nF * 3);
      const mesh = { step: s, positions, indices, verts: nV, faces: nF };
      this.meshCache.set(s, mesh);
      return mesh;
    });
  }

  _put(cache, limit, step, tex) {
    cache.set(step, { tex, ts: performance.now() });
    while (cache.size > limit) {
      let oldest = null, oldTs = Infinity;
      for (const [k, v] of cache) if (v.ts < oldTs) { oldTs = v.ts; oldest = k; }
      if (oldest === null) break;
      cache.get(oldest).tex.dispose();
      cache.delete(oldest);
    }
  }

  // 预取邻近时间步(播放方向优先)
  prefetch(step, dir = 1, radius = 3) {
    const N = this.meta.timeSteps;
    for (let d = 1; d <= radius; d++) {
      const s = (step + dir * d + N) % N;
      if (!this.cache.has(s) && !this.inflight.has(s)) this.getVolumeTexture(s);
    }
  }

  isCached(step) { return this.cache.has(step); }

  // 沿视线三线性采样归一化密度 (Cosmic Probe)。优先用已缓存的全分辨率(128^3),
  // 否则回退到 64^3 预览; 返回 {samples, full} 标明数据来源。
  sampleLine(step, uvw0, uvw1, n = 256) {
    const e = this.cache.get(step);
    if (e) {
      return { samples: this._sampleArray(e.tex.image.data, this.NX, 0, 1.0, uvw0, uvw1, n), full: true };
    }
    const N = this.previewN;
    return { samples: this._sampleArray(this.preview, N, step * N * N * N, 1 / 255, uvw0, uvw1, n), full: false };
  }

  _sampleArray(src, N, base, scale, uvw0, uvw1, n) {
    const out = new Float32Array(n);
    const tri = (x, y, z) => {
      x = Math.min(Math.max(x * (N - 1), 0), N - 1.001);
      y = Math.min(Math.max(y * (N - 1), 0), N - 1.001);
      z = Math.min(Math.max(z * (N - 1), 0), N - 1.001);
      const x0 = x | 0, y0 = y | 0, z0 = z | 0, fx = x - x0, fy = y - y0, fz = z - z0;
      const idx = (xx, yy, zz) => base + xx + N * (yy + N * zz); // x 最快
      const c000 = src[idx(x0, y0, z0)], c100 = src[idx(x0 + 1, y0, z0)];
      const c010 = src[idx(x0, y0 + 1, z0)], c110 = src[idx(x0 + 1, y0 + 1, z0)];
      const c001 = src[idx(x0, y0, z0 + 1)], c101 = src[idx(x0 + 1, y0, z0 + 1)];
      const c011 = src[idx(x0, y0 + 1, z0 + 1)], c111 = src[idx(x0 + 1, y0 + 1, z0 + 1)];
      const c00 = c000 * (1 - fx) + c100 * fx, c10 = c010 * (1 - fx) + c110 * fx;
      const c01 = c001 * (1 - fx) + c101 * fx, c11 = c011 * (1 - fx) + c111 * fx;
      const c0 = c00 * (1 - fy) + c10 * fy, c1 = c01 * (1 - fy) + c11 * fy;
      return (c0 * (1 - fz) + c1 * fz) * scale;
    };
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      out[i] = tri(uvw0.x + (uvw1.x - uvw0.x) * t, uvw0.y + (uvw1.y - uvw0.y) * t, uvw0.z + (uvw1.z - uvw0.z) * t);
    }
    return out;
  }

  // 选区精确统计: 在已缓存的全分辨率体上逐体素统计 [nmin,nmax] 区间。未缓存返回 null。
  selectionStats(step, nmin, nmax) {
    const e = this.cache.get(step);
    if (!e) return null;
    const d = e.tex.image.data;
    const total = d.length;
    let count = 0, sum = 0, mx = -1;
    for (let i = 0; i < total; i++) {
      const v = d[i];
      if (v >= nmin && v <= nmax) { count++; sum += v; if (v > mx) mx = v; }
    }
    return { count, total, fraction: count / total, meanNorm: count ? sum / count : 0, maxNorm: count ? mx : 0, exact: true };
  }
}
