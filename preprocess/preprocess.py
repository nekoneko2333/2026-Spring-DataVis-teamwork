"""
预处理主脚本 (P0)
================================================
读取 100 个时间步, 统一导出前端数据契约:
  public/data/metadata.json
  public/data/stats.json            每步统计量(min/max/mean/std/分位数/偏度/峰度/Gini/熵)
  public/data/histograms.json       每步 log-density 直方图(固定全局分箱) + 演化指纹矩阵
  public/data/powerspectrum.json    每步径向平均功率谱 P(k) (创新点 C)
  public/data/volumes/t0000_u16.bin 全分辨率归一化体数据 (前端 3D 纹理, x 变化最快)
  public/data/preview_u8.bin        64^3 低分辨率预览(全部时间步拼接, 保证播放 >15fps)

关键约定(已由 explore.py 验证):
  - 读取 reshape(order='F') -> (z,y,x)
  - 存储值 V 已是 log-density, 不再取 log
  - 归一化用全局 min/max, 跨时间步颜色可比
  - u16 bin 按 order='C' 写出 => x 变化最快, 匹配 Three.js Data3DTexture(NX,NY,NZ)
"""
import os
import json
import time
import numpy as np
from scipy import stats as sstats

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(_ROOT, "Nyx")
OUT_DIR = os.path.join(_ROOT, "public", "data")
VOL_DIR = os.path.join(OUT_DIR, "volumes")
os.makedirs(VOL_DIR, exist_ok=True)

NX = NY = NZ = 128
N_STEPS = 100
HIST_BINS = 256          # 直方图 / 指纹图 分箱数
PREVIEW_N = 64           # 低分辨率预览边长
PK_BINS = 48             # 功率谱 k 分箱数


def load_volume_zyx(step):
    path = os.path.join(DATA_DIR, f"{step:04d}.dat")
    arr = np.fromfile(path, dtype="<f4")
    assert arr.size == NX * NY * NZ, f"step {step}: size {arr.size}"
    return arr.reshape((NZ, NY, NX), order="F").astype(np.float64)


def gini(values):
    """对非负线性量计算 Gini 系数 (尺度不变)。"""
    v = np.sort(values.ravel())
    n = v.size
    cum = np.cumsum(v, dtype=np.float64)
    if cum[-1] == 0:
        return 0.0
    # Gini = (2*sum(i*v_i))/(n*sum(v)) - (n+1)/n , i=1..n
    idx = np.arange(1, n + 1, dtype=np.float64)
    return float((2.0 * np.sum(idx * v)) / (n * cum[-1]) - (n + 1.0) / n)


def shannon_entropy(counts):
    p = counts.astype(np.float64)
    s = p.sum()
    if s == 0:
        return 0.0
    p = p[p > 0] / s
    return float(-np.sum(p * np.log2(p)))


def radial_power_spectrum(delta, k_edges):
    """delta: 过密度场 (rho/mean - 1)。返回各 k 分箱的平均功率。"""
    fk = np.fft.rfftn(delta)
    pk3d = (fk * np.conj(fk)).real / delta.size
    kz = np.fft.fftfreq(NZ) * NZ
    ky = np.fft.fftfreq(NY) * NY
    kx = np.fft.rfftfreq(NX) * NX
    KZ, KY, KX = np.meshgrid(kz, ky, kx, indexing="ij")
    kmag = np.sqrt(KZ ** 2 + KY ** 2 + KX ** 2).ravel()
    pk = pk3d.ravel()
    which = np.digitize(kmag, k_edges) - 1
    out = np.zeros(len(k_edges) - 1)
    cnt = np.zeros(len(k_edges) - 1)
    np.add.at(out, np.clip(which, 0, len(out) - 1), pk)
    np.add.at(cnt, np.clip(which, 0, len(out) - 1), 1.0)
    cnt[cnt == 0] = 1
    return out / cnt


def block_downsample(vol, factor):
    """块平均降采样 (z,y,x)。"""
    f = factor
    s = vol.reshape(NZ // f, f, NY // f, f, NX // f, f)
    return s.mean(axis=(1, 3, 5))


def main():
    t0 = time.time()
    print("[1/4] 扫描全局 min/max ...")
    gmin, gmax = np.inf, -np.inf
    for s in range(N_STEPS):
        vol = load_volume_zyx(s)
        gmin = min(gmin, float(vol.min()))
        gmax = max(gmax, float(vol.max()))
    print(f"      globalLogMin={gmin:.6f}  globalLogMax={gmax:.6f}")

    hist_edges = np.linspace(gmin, gmax, HIST_BINS + 1)
    hist_centers = 0.5 * (hist_edges[:-1] + hist_edges[1:])
    k_edges = np.linspace(0.5, NX // 2, PK_BINS + 1)
    k_centers = 0.5 * (k_edges[:-1] + k_edges[1:])

    pct_levels = [0.1, 1, 5, 25, 50, 75, 95, 99, 99.9]

    stats_list = []
    hist_matrix = []      # 指纹图: 每行一个时间步的归一化直方图
    pk_matrix = []
    preview = np.empty((N_STEPS, PREVIEW_N, PREVIEW_N, PREVIEW_N), dtype=np.uint8)

    rng = gmax - gmin
    factor = NX // PREVIEW_N

    print("[2/4] 逐步统计 + 导出体数据 ...")
    for s in range(N_STEPS):
        vol = load_volume_zyx(s)
        flat = vol.ravel()

        # --- 统计量 (log-density 上) ---
        pcts = np.percentile(flat, pct_levels)
        sk = float(sstats.skew(flat))
        ku = float(sstats.kurtosis(flat))  # 超额峰度
        # --- Gini 用线性相对密度 (尺度不变, 防溢出) ---
        rho_rel = np.power(10.0, flat - gmin)
        gini_v = gini(rho_rel)
        # --- 直方图 + 熵 ---
        counts, _ = np.histogram(flat, bins=hist_edges)
        ent = shannon_entropy(counts)
        hist_matrix.append((counts / counts.sum()).tolist())

        # --- 功率谱 ---
        rho_lin = np.power(10.0, vol - gmin)
        delta = rho_lin / rho_lin.mean() - 1.0
        pk = radial_power_spectrum(delta, k_edges)
        pk_matrix.append(pk.tolist())

        stats_list.append({
            "step": s,
            "min": float(flat.min()),
            "max": float(flat.max()),
            "mean": float(flat.mean()),
            "std": float(flat.std()),
            "variance": float(flat.var()),
            "median": float(np.median(flat)),
            "skewness": sk,
            "kurtosis": ku,
            "gini": gini_v,
            "entropy": ent,
            "percentiles": {str(p): float(v) for p, v in zip(pct_levels, pcts)},
        })

        # --- 全分辨率 u16 体数据 (order='C' => x 最快) ---
        norm = (vol - gmin) / rng
        u16 = np.clip(np.round(norm * 65535.0), 0, 65535).astype("<u2")
        u16.ravel(order="C").tofile(os.path.join(VOL_DIR, f"t{s:04d}_u16.bin"))

        # --- 低分辨率预览 u8 ---
        dvol = block_downsample(vol, factor)
        dnorm = np.clip(np.round((dvol - gmin) / rng * 255.0), 0, 255).astype(np.uint8)
        preview[s] = dnorm

        if s % 10 == 0 or s == N_STEPS - 1:
            print(f"      step {s:3d}/{N_STEPS}  max={flat.max():.3f}  gini={gini_v:.4f}  skew={sk:.3f}")

    # 预览拼接写出 (order='C', x 最快)
    preview.ravel(order="C").tofile(os.path.join(OUT_DIR, "preview_u8.bin"))

    print("[3/4] 写出 json ...")
    # 全局分位数 (用所有步聚合) 用于默认传递函数阈值
    all_pcts = {}
    agg = []
    for s in range(0, N_STEPS, 10):
        agg.append(load_volume_zyx(s).ravel())
    agg = np.concatenate(agg)
    for p in [1, 5, 25, 50, 75, 90, 95, 99, 99.9]:
        all_pcts[str(p)] = float(np.percentile(agg, p))

    metadata = {
        "shape": [NZ, NY, NX],
        "axisOrder": "zyx",
        "textureLayout": "x-fastest (Data3DTexture width=NX height=NY depth=NZ)",
        "timeSteps": N_STEPS,
        "valueTransform": "stored_is_log_density",
        "note": "存储值已是 log-density; 前端反归一化 logDensity = globalLogMin + n*(globalLogMax-globalLogMin)",
        "globalLogMin": gmin,
        "globalLogMax": gmax,
        "histBins": HIST_BINS,
        "histEdges": hist_edges.tolist(),
        "histCenters": hist_centers.tolist(),
        "previewSize": PREVIEW_N,
        "globalPercentiles": all_pcts,
        "powerSpectrumK": k_centers.tolist(),
        "files": {
            "volume": "volumes/t{:04d}_u16.bin",
            "preview": "preview_u8.bin",
            "labels": "labels/t{:04d}_labels_u8.bin",
        },
    }
    with open(os.path.join(OUT_DIR, "metadata.json"), "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    with open(os.path.join(OUT_DIR, "stats.json"), "w", encoding="utf-8") as f:
        json.dump({"steps": stats_list}, f, indent=2)

    with open(os.path.join(OUT_DIR, "histograms.json"), "w", encoding="utf-8") as f:
        json.dump({
            "bins": HIST_BINS,
            "edges": hist_edges.tolist(),
            "centers": hist_centers.tolist(),
            "matrix": hist_matrix,   # [step][bin] 归一化频数 = 演化指纹图
        }, f)

    with open(os.path.join(OUT_DIR, "powerspectrum.json"), "w", encoding="utf-8") as f:
        json.dump({
            "k": k_centers.tolist(),
            "matrix": pk_matrix,     # [step][kbin]
        }, f)

    print(f"[4/4] 完成, 用时 {time.time()-t0:.1f}s -> {OUT_DIR}")
    print(f"      全分辨率体数据: {N_STEPS} x 4MB = {N_STEPS*4}MB")


if __name__ == "__main__":
    main()
