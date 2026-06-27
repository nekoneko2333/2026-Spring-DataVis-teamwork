"""
丰富版静态可视化结果 (亮色发表风格)。补齐并扩展 prompt 第五章静态图:
  lyman_alpha_lines.png  穿过 node/filament/void 三类视线的莱曼-α proxy 合成光谱 (创新点 A/D 静态版)
  morph_slices.png       密度切片上叠加 T-web vs density-Hessian 形态学分类
  evolution_gallery.png   6 个时间步 MIP 演化画廊
  skeleton_3d.png        高密度丝状结构骨架线提取 (skeletonize, P2#14)
  clusters_3d.png        高密度连通域 3D 散点(按团块着色)
  void_top_slices.png    top1% 高密度 + bottom5% 空洞 切片高亮
  dual_step_compare.png  双时间步对比 + 差异图 (P2#14)
  evolution_mip.gif      100 步 MIP 时间演化动图
  flythrough_t99.gif     t99 沿 z 切片穿越动图
"""
import os
import json
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.colors import LinearSegmentedColormap, ListedColormap
from scipy import ndimage
from skimage.morphology import skeletonize
from PIL import Image, ImageDraw
from plot_style import (
    DENSITY_CMAP,
    DENSITY_CMAP_STRONG,
    DIVERGING_CMAP,
    OKABE_ITO,
    PAPER,
    WEB_CLASSES,
    WEB_CLASSES_MUTED,
    add_panel_label,
    apply_paper_style,
    legend_clean,
    style_axes,
)

apply_paper_style()

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(_ROOT, "public", "data")
NYX = os.path.join(_ROOT, "Nyx")
OUT = os.path.join(_ROOT, "outputs")
cosmic = DENSITY_CMAP
CLASS_COLORS = [WEB_CLASSES_MUTED[c] for c in ["void", "sheet", "filament", "node"]]

meta = json.load(open(os.path.join(DATA, "metadata.json"), encoding="utf-8"))
GMIN, GMAX = meta["globalLogMin"], meta["globalLogMax"]
gp = meta["globalPercentiles"]


def load_vol(s):
    return np.fromfile(os.path.join(NYX, f"{s:04d}.dat"), dtype="<f4").reshape((128, 128, 128), order="F")


def load_labels(folder, s):
    return np.fromfile(os.path.join(DATA, folder, f"t{s:04d}_labels_u8.bin"), dtype=np.uint8).reshape((128, 128, 128))


def proxy_spectrum(logd_line, A=0.55, beta=1.6):
    q50 = gp["50"]
    rho_rel = np.power(10.0, logd_line - q50)
    rb = np.power(rho_rel, beta)
    rb = ndimage.gaussian_filter1d(rb, 2.0)
    tau = A * rb
    return np.exp(-tau)


def fig_lyman_alpha():
    v = load_vol(99)
    tw = load_labels("labels_tweb", 99)
    # node: 全局最大密度所在列; void: 列最大值最小的列; filament: filament 体素最多的列
    zc, yc, xc = np.unravel_index(np.argmax(v), v.shape)
    colmax = v.max(axis=2)  # (z,y)
    zv, yv = np.unravel_index(np.argmin(colmax), colmax.shape)
    filcount = (tw == 2).sum(axis=2)  # (z,y) filament 体素数
    zf, yf = np.unravel_index(np.argmax(filcount), filcount.shape)
    lines = [("NODE sightline", v[zc, yc, :], PAPER["orange"]),
             ("FILAMENT sightline", v[zf, yf, :], PAPER["teal"]),
             ("VOID sightline", v[zv, yv, :], PAPER["blue"])]
    x = np.linspace(0, 1, 128)
    fig, axes = plt.subplots(3, 1, figsize=(9.2, 7.6), sharex=True)
    for i, (ax, (name, ld, c)) in enumerate(zip(axes, lines)):
        F = proxy_spectrum(ld)
        ax.fill_between(x, ld, GMIN, color=c, alpha=0.16)
        ax.plot(x, ld, color=c, lw=1.8, label="log10 rho")
        ax.set_ylim(GMIN, GMAX); ax.set_ylabel("log10 rho", color=c)
        ax2 = ax.twinx()
        ax2.plot(x, F, color=PAPER["sky"], lw=1.8, label="Flux F")
        ax2.fill_between(x, F, 0, color=PAPER["sky"], alpha=0.08)
        ax2.set_ylim(0, 1.05); ax2.set_ylabel("Flux F", color=PAPER["sky"])
        ax.set_title(name)
        style_axes(ax)
        ax2.spines["top"].set_visible(False)
        ax2.spines["right"].set_color(PAPER["spine"])
        add_panel_label(ax, chr(ord("a") + i))
    axes[-1].set_xlabel("Normalized line position")
    fig.suptitle("Lyman-alpha proxy spectra: tau = A * integral rho^beta ds, F = exp(-tau)",
                 color=PAPER["ink"], fontsize=12)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "lyman_alpha_lines.png"), dpi=180); plt.close()


def fig_morph_slices():
    z = 64
    v = load_vol(99)[z]
    px = load_labels("labels", 99)[z]
    tw = load_labels("labels_tweb", 99)[z]
    cmap_cls = ListedColormap(CLASS_COLORS)
    fig, axes = plt.subplots(1, 3, figsize=(13.4, 4.6))
    axes[0].imshow(v, origin="lower", cmap=DENSITY_CMAP_STRONG,
                   vmin=np.percentile(v, 0.5), vmax=np.percentile(v, 99.7))
    axes[0].set_title("Log-density slice, z=64, t=99")
    for ax, lab, title in [(axes[1], px, "Density-Hessian morphology"), (axes[2], tw, "Strict T-web")]:
        ax.imshow(v, origin="lower", cmap=DENSITY_CMAP, alpha=0.58)
        masked = np.ma.masked_where(lab == 0, lab)  # 隐藏 void
        ax.imshow(masked, origin="lower", cmap=cmap_cls, vmin=0, vmax=3, alpha=0.82)
        ax.set_title(title)
    from matplotlib.patches import Patch
    axes[2].legend(handles=[Patch(color=CLASS_COLORS[i], label=l) for i, l in
                            enumerate(["void (hidden)", "sheet", "filament", "node"])],
                   loc="upper right", fontsize=8, framealpha=0.95, edgecolor=PAPER["grid"])
    for i, ax in enumerate(axes):
        style_axes(ax, grid=False)
        ax.set_xticks([]); ax.set_yticks([])
        add_panel_label(ax, chr(ord("a") + i))
    fig.suptitle("Cosmic-web morphology overlays on a density slice", color=PAPER["ink"], fontsize=12)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "morph_slices.png"), dpi=180); plt.close()


def fig_evolution_gallery():
    steps = [0, 20, 40, 60, 80, 99]
    mips = [load_vol(s).max(axis=0) for s in steps]
    vmin = min(m.min() for m in mips); vmax = max(m.max() for m in mips)
    fig, axes = plt.subplots(1, 6, figsize=(15.5, 3.05))
    for ax, s, m in zip(axes, steps, mips):
        ax.imshow(m, origin="lower", cmap=DENSITY_CMAP_STRONG, vmin=vmin, vmax=vmax)
        ax.set_title(f"t = {s}", fontsize=11); ax.set_xticks([]); ax.set_yticks([])
        style_axes(ax, grid=False)
    fig.suptitle("MIP evolution gallery: diffuse early field to late-time filaments and nodes",
                 color=PAPER["ink"], fontsize=12)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "evolution_gallery.png"), dpi=180); plt.close()


def fig_skeleton():
    tw = load_labels("labels_tweb", 99)
    mask = tw >= 2  # filament + node
    skel = skeletonize(mask)
    zz, yy, xx = np.where(skel)
    fig = plt.figure(figsize=(8.2, 7.2))
    ax = fig.add_subplot(111, projection="3d")
    ax.scatter(xx, yy, zz, s=6.0, c=PAPER["sky"], alpha=0.98, linewidths=0, depthshade=False)
    ax.set_title(f"3D skeleton of high-density filaments (t=99, {len(xx)} voxels)", color=PAPER["ink"])
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.pane.set_facecolor(PAPER["panel"]); axis.pane.set_alpha(0.82)
    ax.set_xlabel("x"); ax.set_ylabel("y"); ax.set_zlabel("z"); ax.view_init(28, 42)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "skeleton_3d.png"), dpi=180); plt.close()


def fig_clusters_3d():
    v = load_vol(99)
    hi = gp["99"]
    mask = v > hi
    lab, n = ndimage.label(mask, structure=np.ones((3, 3, 3)))
    sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1))
    order = np.argsort(sizes)[::-1]
    keep = set((order[:40] + 1).tolist())  # 最大 40 个团块
    zz, yy, xx = np.where(mask)
    ids = lab[zz, yy, xx]
    sel = np.array([i in keep for i in ids])
    zz, yy, xx, ids = zz[sel], yy[sel], xx[sel], ids[sel]
    if len(xx) > 40000:
        idx = np.random.default_rng(0).choice(len(xx), 40000, replace=False)
        zz, yy, xx, ids = zz[idx], yy[idx], xx[idx], ids[idx]
    fig = plt.figure(figsize=(8.2, 7.2))
    ax = fig.add_subplot(111, projection="3d")
    ax.scatter(xx, yy, zz, s=4.0, c=PAPER["blue"],
               alpha=0.78, linewidths=0, depthshade=False)
    ax.set_title(f"High-density connected components (log rho > {hi:.2f}, {n} components, t=99)",
                 color=PAPER["ink"])
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.pane.set_facecolor(PAPER["panel"]); axis.pane.set_alpha(0.82)
    ax.set_xlabel("x"); ax.set_ylabel("y"); ax.set_zlabel("z"); ax.view_init(26, 130)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "clusters_3d.png"), dpi=180); plt.close()


def fig_void_top():
    z = 64
    v = load_vol(99)[z]
    q99, q5 = gp["99"], gp["5"]
    fig, axes = plt.subplots(1, 2, figsize=(10.8, 5.0))
    for ax, mask, col, title in [
        (axes[0], v >= q99, PAPER["orange"], f"Top 1% high density (log rho >= {q99:.2f})"),
        (axes[1], v <= q5, PAPER["blue"], f"Bottom 5% low density (log rho <= {q5:.2f})")]:
        ax.imshow(v, origin="lower", cmap=DENSITY_CMAP, alpha=0.65)
        overlay = np.ma.masked_where(~mask, np.ones_like(v))
        ax.imshow(overlay, origin="lower", cmap=ListedColormap([col]), alpha=0.9)
        ax.set_title(title); ax.set_xticks([]); ax.set_yticks([])
        style_axes(ax, grid=False)
    fig.suptitle("Density tails mapped to spatial structures (slice z=64, t=99)",
                 color=PAPER["ink"], fontsize=12)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "void_top_slices.png"), dpi=180); plt.close()


def fig_dual_compare():
    a, b = 10, 90
    va, vb = load_vol(a), load_vol(b)
    ma, mb = va.max(axis=0), vb.max(axis=0)
    diff = mb - ma
    vmin = min(ma.min(), mb.min()); vmax = max(ma.max(), mb.max())
    fig, axes = plt.subplots(1, 3, figsize=(13.4, 4.5))
    axes[0].imshow(ma, origin="lower", cmap=DENSITY_CMAP_STRONG, vmin=vmin, vmax=vmax); axes[0].set_title(f"MIP, t={a}")
    axes[1].imshow(mb, origin="lower", cmap=DENSITY_CMAP_STRONG, vmin=vmin, vmax=vmax); axes[1].set_title(f"MIP, t={b}")
    d = np.abs(diff).max()
    im = axes[2].imshow(diff, origin="lower", cmap=DIVERGING_CMAP, vmin=-d, vmax=d)
    axes[2].set_title(f"Difference (t{b} - t{a})")
    plt.colorbar(im, ax=axes[2], fraction=0.046)
    for i, ax in enumerate(axes):
        ax.set_xticks([]); ax.set_yticks([])
        style_axes(ax, grid=False)
        add_panel_label(ax, chr(ord("a") + i))
    fig.suptitle("Dual-step comparison: density enhancement in filaments and nodes",
                 color=PAPER["ink"], fontsize=12)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "dual_step_compare.png"), dpi=180); plt.close()


def _to_rgb(a2d, cmap, vmin, vmax, size=384, label=None):
    n = np.clip((a2d - vmin) / (vmax - vmin), 0, 1)
    cm = cmap if hasattr(cmap, "__call__") else plt.get_cmap(cmap)
    rgb = (cm(n)[..., :3] * 255).astype(np.uint8)
    im = Image.fromarray(rgb[::-1]).resize((size, size), Image.BILINEAR)  # origin lower
    if label:
        d = ImageDraw.Draw(im); d.text((10, 8), label, fill=(255, 255, 255))
    return im


def gif_evolution():
    mips = [load_vol(s).max(axis=0) for s in range(100)]
    vmin = min(m.min() for m in mips); vmax = max(m.max() for m in mips)
    frames = [_to_rgb(m, DENSITY_CMAP_STRONG, vmin, vmax, 384, f"t={s:03d}  MIP") for s, m in enumerate(mips)]
    frames[0].save(os.path.join(OUT, "evolution_mip.gif"), save_all=True,
                   append_images=frames[1:], duration=70, loop=0)


def gif_flythrough():
    v = load_vol(99)
    vmin, vmax = GMIN, np.percentile(v, 99.5)
    frames = [_to_rgb(v[z], cosmic, vmin, vmax, 384, f"t=99  z={z:03d}") for z in range(0, 128, 1)]
    frames[0].save(os.path.join(OUT, "flythrough_t99.gif"), save_all=True,
                   append_images=frames[1:], duration=45, loop=0)


if __name__ == "__main__":
    fig_lyman_alpha(); print("lyman_alpha_lines")
    fig_morph_slices(); print("morph_slices")
    fig_evolution_gallery(); print("evolution_gallery")
    fig_skeleton(); print("skeleton_3d")
    fig_clusters_3d(); print("clusters_3d")
    fig_void_top(); print("void_top_slices")
    fig_dual_compare(); print("dual_step_compare")
    gif_evolution(); print("evolution_mip.gif")
    gif_flythrough(); print("flythrough_t99.gif")
    print("done ->", OUT)
