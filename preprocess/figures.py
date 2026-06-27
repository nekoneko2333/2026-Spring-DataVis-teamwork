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
from plot_style import (
    DENSITY_CMAP,
    DENSITY_CMAP_STRONG,
    HEAT_CMAP,
    OKABE_ITO,
    PAPER,
    WEB_CLASSES,
    WEB_CLASSES_MUTED,
    add_panel_label,
    apply_paper_style,
    legend_clean,
    style_axes,
)

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(_ROOT, "public", "data")
NYX = os.path.join(_ROOT, "Nyx")
OUT = os.path.join(_ROOT, "outputs")
os.makedirs(OUT, exist_ok=True)
apply_paper_style()
cosmic = DENSITY_CMAP

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
    fig, ax = plt.subplots(figsize=(8.6, 4.8))
    im = ax.imshow(M ** 0.42, aspect="auto", origin="lower", cmap=HEAT_CMAP,
                   extent=[centers[0], centers[-1], 0, N - 1])
    ax.set_xlabel("log10 density"); ax.set_ylabel("time step")
    ax.set_title("Density evolution fingerprint")
    style_axes(ax, grid=False)
    cb = plt.colorbar(im, ax=ax, fraction=0.046, pad=0.025); cb.set_label("normalized frequency$^{0.42}$")
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "fingerprint.png"), dpi=180); plt.close()


def fig_histograms():
    centers = np.array(hist["centers"]); M = hist["matrix"]
    steps = np.linspace(0, N - 1, 9).astype(int)
    fig, ax = plt.subplots(figsize=(8.6, 4.8))
    cmap = DENSITY_CMAP_STRONG
    for i, s in enumerate(steps):
        ax.plot(centers, M[s], color=cmap(0.35 + 0.55 * i / (len(steps) - 1)), label=f"t={s}", lw=1.7)
    ax.set_yscale("log"); ax.set_xlabel("log10 density"); ax.set_ylabel("normalized freq")
    ax.set_title("Log-density histogram over time")
    style_axes(ax)
    legend_clean(ax, ncol=3, loc="upper right")
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "histograms_over_time.png"), dpi=180); plt.close()


def fig_metrics():
    t = np.arange(N)
    series = [
        ("gini", "Gini coefficient", OKABE_ITO[1]), ("entropy", "Shannon entropy (bits)", OKABE_ITO[0]),
        ("variance", "Variance of log-density", OKABE_ITO[2]), ("skewness", "Skewness", OKABE_ITO[4]),
        ("kurtosis", "Excess kurtosis", OKABE_ITO[3]), ("max", "Max log10 density", PAPER["slate"]),
    ]
    fig, axes = plt.subplots(2, 3, figsize=(12.4, 6.2))
    for i, (ax, (k, lbl, c)) in enumerate(zip(axes.ravel(), series)):
        y = [s[k] for s in stats]
        ax.plot(t, y, color=c, lw=2.1); ax.fill_between(t, y, min(y), color=c, alpha=0.10)
        ax.set_title(lbl); ax.set_xlabel("time step"); ax.grid(alpha=0.12)
        style_axes(ax)
        add_panel_label(ax, chr(ord("a") + i))
    fig.suptitle("Global density-distribution statistics over time", color=PAPER["ink"], fontsize=13)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "metric_curves.png"), dpi=180); plt.close()


def fig_power():
    k = np.array(power["k"]); M = power["matrix"]
    fig, ax = plt.subplots(figsize=(8.2, 5.2))
    cmap = DENSITY_CMAP
    for s in range(0, N, 8):
        ax.loglog(k, np.array(M[s]), color=cmap(0.28 + 0.45 * s / N), lw=1.0, alpha=0.65)
    ax.loglog(k, np.array(M[0]), color=OKABE_ITO[0], lw=2.5, label="t=0 early")
    ax.loglog(k, np.array(M[N - 1]), color=OKABE_ITO[3], lw=2.5, label="t=99 late")
    ax.set_xlabel("k (wavenumber)"); ax.set_ylabel("P(k)")
    ax.set_title("Power spectrum evolution")
    style_axes(ax)
    ax.grid(alpha=0.55, which="both")
    legend_clean(ax, loc="best")
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "power_evolution.png"), dpi=180); plt.close()


def fig_clusters():
    t = np.arange(N)
    nc = [m["nodeCount"] for m in morph]; mb = [m["maxBlobVoxels"] for m in morph]
    fig, ax1 = plt.subplots(figsize=(8.6, 4.8))
    ax1.plot(t, nc, color=PAPER["blue"], lw=2.4, marker="o", ms=2.6, markevery=8,
             label="component count")
    ax1.set_xlabel("Time step"); ax1.set_ylabel("Component count", color=PAPER["blue"])
    ax2 = ax1.twinx()
    ax2.plot(t, mb, color=PAPER["orange"], lw=2.4, marker="s", ms=2.6, markevery=8,
             label="largest component")
    ax2.set_ylabel("Largest component (voxels)", color=PAPER["orange"])
    ax1.set_title("Connected-component evolution")
    style_axes(ax1)
    ax2.spines["top"].set_visible(False)
    ax2.spines["right"].set_color(PAPER["spine"])
    lines = ax1.get_lines() + ax2.get_lines()
    labels = [l.get_label() for l in lines]
    ax1.legend(lines, labels, loc="center right", frameon=True, framealpha=0.95,
               edgecolor=PAPER["grid"])
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "cluster_evolution.png"), dpi=180); plt.close()


def fig_morph_compare():
    proxy = morph; tweb = morph_full.get("tweb", {}).get("steps")
    classes = ["void", "sheet", "filament", "node"]
    colors = [WEB_CLASSES_MUTED[c] for c in classes]
    t = np.arange(N)
    fig, axes = plt.subplots(1, 2, figsize=(12.5, 4.9), sharey=True)
    for i, (ax, data, title) in enumerate([
        (axes[0], proxy, "Density-Hessian morphology"),
        (axes[1], tweb, "Strict T-web (Poisson tidal tensor)"),
    ]):
        if data is None:
            ax.set_visible(False); continue
        F = {c: np.array([d["fractions"][c] * 100 for d in data]) for c in classes}
        layers = [F[c] for c in classes]
        ax.stackplot(t, layers, colors=colors, labels=classes, alpha=0.88,
                     edgecolor=PAPER["bg"], linewidth=0.55)
        cumulative = np.cumsum(layers, axis=0)
        for boundary in cumulative[:-1]:
            ax.plot(t, boundary, color=PAPER["bg"], lw=0.9, alpha=0.95)
        ax.set_title(title); ax.set_xlabel("Time step"); ax.set_xlim(0, N - 1); ax.set_ylim(0, 100)
        ax.set_ylabel("Volume fraction (%)")
        style_axes(ax)
        add_panel_label(ax, chr(ord("a") + i))
    legend_clean(axes[1], loc="center right", title="Class")
    fig.suptitle("Cosmic-web volume fractions over time", color=PAPER["ink"], fontsize=13)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "morphology_compare.png"), dpi=180); plt.close()


def fig_slices():
    steps = [0, 50, 99]
    fig, axes = plt.subplots(2, 3, figsize=(12.6, 8.2))
    vols = [load_vol(s) for s in steps]
    mips = [v.max(axis=0) for v in vols]
    slices = [v[64, :, :] for v in vols]
    mip_vmin = min(np.percentile(m, 0.5) for m in mips)
    mip_vmax = max(np.percentile(m, 99.7) for m in mips)
    sl_vmin = min(np.percentile(s, 0.5) for s in slices)
    sl_vmax = max(np.percentile(s, 99.7) for s in slices)
    for j, s in enumerate(steps):
        mip = mips[j]; sl = slices[j]
        a = axes[0, j].imshow(mip, origin="lower", cmap=DENSITY_CMAP_STRONG,
                              vmin=mip_vmin, vmax=mip_vmax)
        axes[0, j].set_title(f"MIP (z), t={s}")
        plt.colorbar(a, ax=axes[0, j], fraction=0.046)
        b = axes[1, j].imshow(sl, origin="lower", cmap=DENSITY_CMAP_STRONG,
                              vmin=sl_vmin, vmax=sl_vmax)
        axes[1, j].set_title(f"Slice z=64, t={s}")
        plt.colorbar(b, ax=axes[1, j], fraction=0.046)
        for ax in (axes[0, j], axes[1, j]):
            style_axes(ax, grid=False)
            ax.set_xticks([]); ax.set_yticks([])
    fig.suptitle("Early / mid / late comparison: structure contrast increases over time", color=PAPER["ink"], fontsize=13)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "slices_comparison.png"), dpi=180); plt.close()


if __name__ == "__main__":
    fig_fingerprint(); print("fingerprint")
    fig_histograms(); print("histograms")
    fig_metrics(); print("metrics")
    fig_power(); print("power")
    fig_clusters(); print("clusters")
    fig_morph_compare(); print("morphology_compare")
    fig_slices(); print("slices")
    print("done ->", OUT)
