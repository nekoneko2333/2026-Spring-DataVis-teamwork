import json
import os
import time

import numpy as np
from scipy import stats as sstats

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(_ROOT, "Nyx")
OUT_DIR = os.path.join(_ROOT, "public", "data")
VOL_DIR = os.path.join(OUT_DIR, "volumes")
GRAD_DIR = os.path.join(OUT_DIR, "gradients")

os.makedirs(VOL_DIR, exist_ok=True)
os.makedirs(GRAD_DIR, exist_ok=True)

NX = NY = NZ = 128
N_STEPS = 100
HIST_BINS = 256
PREVIEW_N = 64
PK_BINS = 48


def load_volume_zyx(step):
    path = os.path.join(DATA_DIR, f"{step:04d}.dat")
    arr = np.fromfile(path, dtype="<f4")
    if arr.size != NX * NY * NZ:
        raise ValueError(f"step {step}: expected {NX * NY * NZ} values, got {arr.size}")
    return arr.reshape((NZ, NY, NX), order="F").astype(np.float32)


def gini(values):
    v = np.sort(values.ravel())
    n = v.size
    cum = np.cumsum(v, dtype=np.float64)
    if cum[-1] == 0:
        return 0.0
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
    fk = np.fft.rfftn(delta)
    pk3d = (fk * np.conj(fk)).real / delta.size
    kz = np.fft.fftfreq(NZ) * NZ
    ky = np.fft.fftfreq(NY) * NY
    kx = np.fft.rfftfreq(NX) * NX
    kzv, kyv, kxv = np.meshgrid(kz, ky, kx, indexing="ij")
    kmag = np.sqrt(kzv ** 2 + kyv ** 2 + kxv ** 2).ravel()
    pk = pk3d.ravel()
    which = np.digitize(kmag, k_edges) - 1
    out = np.zeros(len(k_edges) - 1)
    cnt = np.zeros(len(k_edges) - 1)
    np.add.at(out, np.clip(which, 0, len(out) - 1), pk)
    np.add.at(cnt, np.clip(which, 0, len(out) - 1), 1.0)
    cnt[cnt == 0] = 1.0
    return out / cnt


def block_downsample(vol, factor):
    f = factor
    shaped = vol.reshape(NZ // f, f, NY // f, f, NX // f, f)
    return shaped.mean(axis=(1, 3, 5))


def compute_gradient_components(norm_vol):
    spacing = (1.0 / norm_vol.shape[0], 1.0 / norm_vol.shape[1], 1.0 / norm_vol.shape[2])
    gz, gy, gx = np.gradient(norm_vol, *spacing, edge_order=1)
    return np.stack([gx, gy, gz], axis=-1).astype(np.float32)


def quantize_gradient(grad, scale):
    if scale <= 0:
        return np.full(grad.shape, 127, dtype=np.uint8)
    normalized = np.clip(grad / scale, -1.0, 1.0)
    encoded = np.round((normalized + 1.0) * 127.0)
    return np.clip(encoded, 0, 254).astype(np.uint8)


def main():
    t0 = time.time()
    print("[1/5] scanning global log-density range ...")
    gmin = np.inf
    gmax = -np.inf
    for step in range(N_STEPS):
        vol = load_volume_zyx(step)
        gmin = min(gmin, float(vol.min()))
        gmax = max(gmax, float(vol.max()))
    print(f"      globalLogMin={gmin:.6f} globalLogMax={gmax:.6f}")

    rng = gmax - gmin
    factor = NX // PREVIEW_N

    print("[2/5] scanning gradient scales ...")
    grad_scale = 0.0
    preview_grad_scale = 0.0
    for step in range(N_STEPS):
        vol = load_volume_zyx(step)
        norm = ((vol - gmin) / rng).astype(np.float32)
        grad = compute_gradient_components(norm)
        grad_scale = max(grad_scale, float(np.max(np.abs(grad))))

        preview_norm = block_downsample(norm, factor)
        preview_grad = compute_gradient_components(preview_norm)
        preview_grad_scale = max(preview_grad_scale, float(np.max(np.abs(preview_grad))))

        if step % 10 == 0 or step == N_STEPS - 1:
            print(f"      step {step:3d}/{N_STEPS} gradScale={grad_scale:.4f} previewScale={preview_grad_scale:.4f}")

    hist_edges = np.linspace(gmin, gmax, HIST_BINS + 1)
    hist_centers = 0.5 * (hist_edges[:-1] + hist_edges[1:])
    k_edges = np.linspace(0.5, NX // 2, PK_BINS + 1)
    k_centers = 0.5 * (k_edges[:-1] + k_edges[1:])
    pct_levels = [0.1, 1, 5, 25, 50, 75, 95, 99, 99.9]

    stats_list = []
    hist_matrix = []
    pk_matrix = []
    preview = np.empty((N_STEPS, PREVIEW_N, PREVIEW_N, PREVIEW_N), dtype=np.uint8)
    preview_gradients = np.empty((N_STEPS, PREVIEW_N, PREVIEW_N, PREVIEW_N, 3), dtype=np.uint8)

    print("[3/5] exporting volumes, gradients, and statistics ...")
    for step in range(N_STEPS):
        vol = load_volume_zyx(step)
        flat = vol.ravel()

        pcts = np.percentile(flat, pct_levels)
        sk = float(sstats.skew(flat))
        ku = float(sstats.kurtosis(flat))
        rho_rel = np.power(10.0, flat - gmin)
        gini_v = gini(rho_rel)
        counts, _ = np.histogram(flat, bins=hist_edges)
        ent = shannon_entropy(counts)
        hist_matrix.append((counts / counts.sum()).tolist())

        rho_lin = np.power(10.0, vol - gmin)
        delta = rho_lin / rho_lin.mean() - 1.0
        pk = radial_power_spectrum(delta, k_edges)
        pk_matrix.append(pk.tolist())

        stats_list.append({
            "step": step,
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

        norm = ((vol - gmin) / rng).astype(np.float32)
        u16 = np.clip(np.round(norm * 65535.0), 0, 65535).astype("<u2")
        u16.ravel(order="C").tofile(os.path.join(VOL_DIR, f"t{step:04d}_u16.bin"))

        grad = compute_gradient_components(norm)
        grad_u8 = quantize_gradient(grad, grad_scale)
        grad_u8.reshape(-1, 3, order="C").tofile(os.path.join(GRAD_DIR, f"t{step:04d}_grad_u8.bin"))

        preview_norm = block_downsample(norm, factor).astype(np.float32)
        preview[step] = np.clip(np.round(preview_norm * 255.0), 0, 255).astype(np.uint8)

        preview_grad = compute_gradient_components(preview_norm)
        preview_gradients[step] = quantize_gradient(preview_grad, preview_grad_scale)

        if step % 10 == 0 or step == N_STEPS - 1:
            print(f"      step {step:3d}/{N_STEPS} max={flat.max():.3f} gini={gini_v:.4f} skew={sk:.3f}")

    preview.ravel(order="C").tofile(os.path.join(OUT_DIR, "preview_u8.bin"))
    preview_gradients.reshape(-1, 3, order="C").tofile(os.path.join(OUT_DIR, "preview_grad_u8.bin"))

    print("[4/5] writing metadata and JSON summaries ...")
    all_pcts = {}
    agg = []
    for step in range(0, N_STEPS, 10):
        agg.append(load_volume_zyx(step).ravel())
    agg = np.concatenate(agg)
    for p in [1, 5, 25, 50, 75, 90, 95, 99, 99.9]:
        all_pcts[str(p)] = float(np.percentile(agg, p))

    metadata = {
        "shape": [NZ, NY, NX],
        "axisOrder": "zyx",
        "textureLayout": "x-fastest (Data3DTexture width=NX height=NY depth=NZ)",
        "timeSteps": N_STEPS,
        "valueTransform": "stored_is_log_density",
        "note": "Stored values are log-density. Frontend reconstructs normalized values with global min/max.",
        "globalLogMin": gmin,
        "globalLogMax": gmax,
        "histBins": HIST_BINS,
        "histEdges": hist_edges.tolist(),
        "histCenters": hist_centers.tolist(),
        "previewSize": PREVIEW_N,
        "globalPercentiles": all_pcts,
        "powerSpectrumK": k_centers.tolist(),
        "gradientEncoding": "u8-rgb encoded with zero at 127 and value = (byte/127 - 1) * scale",
        "gradientScale": grad_scale,
        "previewGradientScale": preview_grad_scale,
        "files": {
            "volume": "volumes/t{:04d}_u16.bin",
            "gradient": "gradients/t{:04d}_grad_u8.bin",
            "preview": "preview_u8.bin",
            "previewGradient": "preview_grad_u8.bin",
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
            "matrix": hist_matrix,
        }, f)

    with open(os.path.join(OUT_DIR, "powerspectrum.json"), "w", encoding="utf-8") as f:
        json.dump({
            "k": k_centers.tolist(),
            "matrix": pk_matrix,
        }, f)

    print("[5/5] done")
    print(f"      output: {OUT_DIR}")
    print(f"      gradient scale: {grad_scale:.6f}")
    print(f"      preview gradient scale: {preview_grad_scale:.6f}")
    print(f"      elapsed: {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
