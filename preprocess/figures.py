"""
Report static figures (matplotlib, light publication style).
Generated from public/data JSON + raw volumes:
  fingerprint.png           100-step density evolution fingerprint
  histograms_over_time.png  log-density histogram over time
  metric_curves.png         Gini / entropy / variance / skewness / kurtosis / max over time
  power_evolution.png       power spectrum P(k) over time
  cluster_evolution.png     connected components: node count / largest blob over time
  morphology_compare.png    density-Hessian vs strict T-web volume fractions
  slices_comparison.png     early / mid / late MIP and central slices
(Chinese-labelled rich figures are produced by figures_rich.py.)
"""
import os
import json
import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(_ROOT, "public", "data")
NYX = os.path.join(_ROOT, "Nyx")
OUT = os.path.join(_ROOT, "outputs")
os.makedirs(OUT, exist_ok=True)
plt.rcParams.update({
    "figure.facecolor": "white", "axes.facecolor": "white",
    "savefig.facecolor": "white", "text.color": "#1b2740",
    "axes.labelcolor": "#1b2740", "xtick.color": "#5d6b86", "ytick.color": "#5d6b86",
    "axes.edgecolor": "#c6d2e6", "font.size": 10, "axes.titlecolor": "#0d8c8a",
})
cosmic = LinearSegmentedColormap.from_list("cosmic", ["#05040c", "#10204a", "#1f6f9e", "#38e1d6", "#ffcc66", "#fffaf0"])

meta = json.load(open(os.path.join(DATA, "metadata.json"), encoding="utf-8"))
stats = json.load(open(os.path.join(DATA, "stats.json"), encoding="utf-8"))["steps"]
hist = json.load(open(os.path.join(DATA, "histograms.json"), encoding="utf-8"))
power = json.load(open(os.path.join(DATA, "powerspectrum.json"), encoding="utf-8"))
morph_full = json.load(open(os.path.join(DATA, "morphology.json"), encoding="utf-8"))
morph = morph_full["steps"]
N = meta["timeSteps"]


def load_vol(step):
    arr = np.fromfile(os.path.join(NYX, f"{step:04d}.dat"), dtype="<f4")
    return arr.reshape((128, 128, 128), order="F")


def fig_fingerprint():
    M = np.array(hist["matrix"]); centers = hist["centers"]
    fig, ax = plt.subplots(figsize=(9, 5))
    im = ax.imshow(M ** 0.42, aspect="auto", origin="lower", cmap=cosmic,
                   extent=[centers[0], centers[-1], 0, N - 1])
    ax.set_xlabel("log10 density"); ax.set_ylabel("time step")
    ax.set_title("Density Evolution Fingerprint  (time x log-density)")
    cb = plt.colorbar(im, ax=ax); cb.set_label("normalized freq ^0.42")
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "fingerprint.png"), dpi=130); plt.close()


def fig_histograms():
    centers = np.array(hist["centers"]); M = hist["matrix"]
    steps = np.linspace(0, N - 1, 9).astype(int)
    fig, ax = plt.subplots(figsize=(9, 5))
    cmap = plt.get_cmap("plasma")
    for i, s in enumerate(steps):
        ax.plot(centers, M[s], color=cmap(i / (len(steps) - 1)), label=f"t={s}", lw=1.6)
    ax.set_yscale("log"); ax.set_xlabel("log10 density"); ax.set_ylabel("normalized freq")
    ax.set_title("log-density histogram over time (high-density tail grows)")
    ax.legend(ncol=3, fontsize=8, framealpha=0.15, labelcolor="#1b2740")
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "histograms_over_time.png"), dpi=130); plt.close()


def fig_metrics():
    t = np.arange(N)
    series = [
        ("gini", "Gini coefficient", "#d97706"), ("entropy", "Shannon entropy (bits)", "#0d8c8a"),
        ("variance", "Variance of log-density", "#6d5ef0"), ("skewness", "Skewness", "#2e9e4f"),
        ("kurtosis", "Excess kurtosis", "#db2777"), ("max", "max log10 density", "#e8590c"),
    ]
    fig, axes = plt.subplots(2, 3, figsize=(13, 6.5))
    for ax, (k, lbl, c) in zip(axes.ravel(), series):
        y = [s[k] for s in stats]
        ax.plot(t, y, color=c, lw=2); ax.fill_between(t, y, min(y), color=c, alpha=0.12)
        ax.set_title(lbl); ax.set_xlabel("time step"); ax.grid(alpha=0.12)
    fig.suptitle("Global density-distribution statistics over time", color="#0d8c8a", fontsize=13)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "metric_curves.png"), dpi=130); plt.close()


def fig_power():
    k = np.array(power["k"]); M = power["matrix"]
    fig, ax = plt.subplots(figsize=(8.5, 5.5))
    cmap = plt.get_cmap("viridis")
    for s in range(0, N, 8):
        ax.loglog(k, np.array(M[s]), color=cmap(s / N), lw=1.3, alpha=0.8)
    ax.loglog(k, np.array(M[0]), color="#2563eb", lw=2.4, label="t=0 early")
    ax.loglog(k, np.array(M[N - 1]), color="#c06a09", lw=2.4, label="t=99 late")
    ax.set_xlabel("k (wavenumber)"); ax.set_ylabel("P(k)")
    ax.set_title("Power spectrum P(k) evolution (small-scale power grows = structure growth)")
    ax.legend(framealpha=0.15, labelcolor="#1b2740"); ax.grid(alpha=0.12, which="both")
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "power_evolution.png"), dpi=130); plt.close()


def fig_clusters():
    t = np.arange(N)
    nc = [m["nodeCount"] for m in morph]; mb = [m["maxBlobVoxels"] for m in morph]
    fig, ax1 = plt.subplots(figsize=(9, 5))
    ax1.plot(t, nc, color="#0d8c8a", lw=2)
    ax1.set_xlabel("time step"); ax1.set_ylabel("cluster count", color="#0d8c8a")
    ax2 = ax1.twinx(); ax2.plot(t, mb, color="#c06a09", lw=2)
    ax2.set_ylabel("largest blob (voxels)", color="#c06a09")
    ax1.set_title("Connected-component analysis: count down + largest blob up (hierarchical merging)")
    ax1.grid(alpha=0.12)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "cluster_evolution.png"), dpi=130); plt.close()


def fig_morph_compare():
    proxy = morph; tweb = morph_full.get("tweb", {}).get("steps")
    classes = ["void", "sheet", "filament", "node"]
    colors = ["#46568a", "#2f74e0", "#0ea5a3", "#d68a06"]
    t = np.arange(N)
    fig, axes = plt.subplots(1, 2, figsize=(13, 5.2), sharey=True)
    for ax, data, title in [(axes[0], proxy, "density-Hessian morphology"),
                            (axes[1], tweb, "strict T-web (Poisson tidal tensor)")]:
        if data is None:
            ax.set_visible(False); continue
        F = {c: np.array([d["fractions"][c] * 100 for d in data]) for c in classes}
        ax.stackplot(t, [F[c] for c in classes], colors=colors, labels=classes, alpha=0.9)
        ax.set_title(title); ax.set_xlabel("time step"); ax.set_xlim(0, N - 1); ax.set_ylim(0, 100)
        ax.set_ylabel("volume fraction (%)")
    axes[1].legend(loc="center right", framealpha=0.5, labelcolor="#1b2740")
    fig.suptitle("Cosmic-web volume fractions over time (void-dominated, expanding)", color="#0d8c8a", fontsize=13)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "morphology_compare.png"), dpi=130); plt.close()


def fig_slices():
    steps = [0, 50, 99]
    fig, axes = plt.subplots(2, 3, figsize=(13, 8.6))
    for j, s in enumerate(steps):
        v = load_vol(s); mip = v.max(axis=0); sl = v[64, :, :]
        a = axes[0, j].imshow(mip, origin="lower", cmap="magma"); axes[0, j].set_title(f"MIP (z)  t={s}")
        plt.colorbar(a, ax=axes[0, j], fraction=0.046)
        b = axes[1, j].imshow(sl, origin="lower", cmap=cosmic); axes[1, j].set_title(f"slice z=64  t={s}")
        plt.colorbar(b, ax=axes[1, j], fraction=0.046)
    fig.suptitle("Early / mid / late comparison: structure contrast increases over time", color="#0d8c8a", fontsize=13)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "slices_comparison.png"), dpi=130); plt.close()


if __name__ == "__main__":
    fig_fingerprint(); print("fingerprint")
    fig_histograms(); print("histograms")
    fig_metrics(); print("metrics")
    fig_power(); print("power")
    fig_clusters(); print("clusters")
    fig_morph_compare(); print("morphology_compare")
    fig_slices(); print("slices")
    print("done ->", OUT)
