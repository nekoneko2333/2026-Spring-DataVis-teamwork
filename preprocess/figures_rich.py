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

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "Microsoft JhengHei", "SimSun", "DejaVu Sans"]
plt.rcParams.update({
    "axes.unicode_minus": False, "figure.facecolor": "white", "axes.facecolor": "white",
    "savefig.facecolor": "white", "text.color": "#1b2740", "axes.labelcolor": "#1b2740",
    "xtick.color": "#5d6b86", "ytick.color": "#5d6b86", "axes.edgecolor": "#c6d2e6",
    "font.size": 10, "axes.titlecolor": "#0d8c8a",
})

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(_ROOT, "public", "data")
NYX = os.path.join(_ROOT, "Nyx")
OUT = os.path.join(_ROOT, "outputs")
cosmic = LinearSegmentedColormap.from_list("cosmic", ["#05040c", "#10204a", "#1f6f9e", "#38e1d6", "#ffcc66", "#fffaf0"])
CLASS_COLORS = ["#46568a", "#2f74e0", "#0ea5a3", "#d68a06"]  # void/sheet/filament/node

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
    lines = [("穿过 NODE 节点", v[zc, yc, :], "#d68a06"),
             ("穿过 FILAMENT 丝", v[zf, yf, :], "#0ea5a3"),
             ("穿过 VOID 空洞", v[zv, yv, :], "#2f74e0")]
    x = np.linspace(0, 1, 128)
    fig, axes = plt.subplots(3, 1, figsize=(9.5, 8), sharex=True)
    for ax, (name, ld, c) in zip(axes, lines):
        F = proxy_spectrum(ld)
        ax.fill_between(x, ld, GMIN, color=c, alpha=0.16)
        ax.plot(x, ld, color=c, lw=1.8, label="log10 ρ")
        ax.set_ylim(GMIN, GMAX); ax.set_ylabel("log10 ρ", color=c)
        ax2 = ax.twinx()
        ax2.plot(x, F, color="#c0392b", lw=1.8, label="透射流量 F")
        ax2.fill_between(x, F, 0, color="#c0392b", alpha=0.08)
        ax2.set_ylim(0, 1.05); ax2.set_ylabel("透射流量 F", color="#c0392b")
        ax.set_title(name)
    axes[-1].set_xlabel("沿视线位置 (归一化)")
    fig.suptitle("莱曼-α proxy 合成光谱: τ=A·∫ρ^β ds, F=exp(−τ)  (密度驱动近似, 非严格辐射转移)",
                 color="#0d8c8a", fontsize=12)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "lyman_alpha_lines.png"), dpi=130); plt.close()


def fig_morph_slices():
    z = 64
    v = load_vol(99)[z]
    px = load_labels("labels", 99)[z]
    tw = load_labels("labels_tweb", 99)[z]
    cmap_cls = ListedColormap(CLASS_COLORS)
    fig, axes = plt.subplots(1, 3, figsize=(14, 4.8))
    axes[0].imshow(v, origin="lower", cmap=cosmic); axes[0].set_title("log 密度切片 z=64  t=99")
    for ax, lab, title in [(axes[1], px, "density-Hessian 形态学"), (axes[2], tw, "严格 T-web (势场)")]:
        ax.imshow(v, origin="lower", cmap="gray", alpha=0.55)
        masked = np.ma.masked_where(lab == 0, lab)  # 隐藏 void
        ax.imshow(masked, origin="lower", cmap=cmap_cls, vmin=0, vmax=3, alpha=0.85)
        ax.set_title(title)
    from matplotlib.patches import Patch
    axes[2].legend(handles=[Patch(color=CLASS_COLORS[i], label=l) for i, l in
                            enumerate(["void(隐)", "sheet 墙", "filament 丝", "node 节点"])],
                   loc="upper right", fontsize=8, framealpha=0.85)
    fig.suptitle("宇宙网形态学分类叠加在密度切片上 (两种方法对比)", color="#0d8c8a", fontsize=12)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "morph_slices.png"), dpi=130); plt.close()


def fig_evolution_gallery():
    steps = [0, 20, 40, 60, 80, 99]
    mips = [load_vol(s).max(axis=0) for s in steps]
    vmin = min(m.min() for m in mips); vmax = max(m.max() for m in mips)
    fig, axes = plt.subplots(1, 6, figsize=(16, 3.1))
    for ax, s, m in zip(axes, steps, mips):
        ax.imshow(m, origin="lower", cmap="magma", vmin=vmin, vmax=vmax)
        ax.set_title(f"t = {s}", fontsize=11); ax.set_xticks([]); ax.set_yticks([])
    fig.suptitle("密度场 MIP 演化画廊: 早期弥散 → 晚期节点/丝增亮、空洞变暗", color="#0d8c8a", fontsize=12)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "evolution_gallery.png"), dpi=130); plt.close()


def fig_skeleton():
    tw = load_labels("labels_tweb", 99)
    mask = tw >= 2  # filament + node
    skel = skeletonize(mask)
    zz, yy, xx = np.where(skel)
    fig = plt.figure(figsize=(8.5, 7.5))
    ax = fig.add_subplot(111, projection="3d")
    ax.scatter(xx, yy, zz, s=1.2, c=zz, cmap="cool", alpha=0.55, linewidths=0)
    ax.set_title(f"高密度丝状结构骨架线提取 (skeletonize 3D, t=99, {len(xx)} 骨架体素)", color="#0d8c8a")
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.pane.set_facecolor("white"); axis.pane.set_alpha(0.4)
    ax.set_xlabel("x"); ax.set_ylabel("y"); ax.set_zlabel("z"); ax.view_init(28, 42)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "skeleton_3d.png"), dpi=130); plt.close()


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
    fig = plt.figure(figsize=(8.5, 7.5))
    ax = fig.add_subplot(111, projection="3d")
    ax.scatter(xx, yy, zz, s=2, c=ids % 20, cmap="tab20", alpha=0.6, linewidths=0)
    ax.set_title(f"高密度连通域 3D 散点 (logρ>{hi:.2f}, 共 {n} 团块, t=99)", color="#0d8c8a")
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.pane.set_facecolor("white"); axis.pane.set_alpha(0.4)
    ax.set_xlabel("x"); ax.set_ylabel("y"); ax.set_zlabel("z"); ax.view_init(26, 130)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "clusters_3d.png"), dpi=130); plt.close()


def fig_void_top():
    z = 64
    v = load_vol(99)[z]
    q99, q5 = gp["99"], gp["5"]
    fig, axes = plt.subplots(1, 2, figsize=(11, 5.2))
    for ax, mask, col, title in [
        (axes[0], v >= q99, "#d68a06", f"Top1% 高密度 (logρ≥{q99:.2f}) — 宇宙网节点"),
        (axes[1], v <= q5, "#2f74e0", f"Bottom5% 低密度 (logρ≤{q5:.2f}) — 空洞")]:
        ax.imshow(v, origin="lower", cmap="gray", alpha=0.5)
        overlay = np.ma.masked_where(~mask, np.ones_like(v))
        ax.imshow(overlay, origin="lower", cmap=ListedColormap([col]), alpha=0.9)
        ax.set_title(title); ax.set_xticks([]); ax.set_yticks([])
    fig.suptitle("密度尾部 对应 空间结构: 高密度尾=节点, 低密度=空洞 (切片 z=64, t=99)", color="#0d8c8a", fontsize=12)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "void_top_slices.png"), dpi=130); plt.close()


def fig_dual_compare():
    a, b = 10, 90
    va, vb = load_vol(a), load_vol(b)
    ma, mb = va.max(axis=0), vb.max(axis=0)
    diff = mb - ma
    vmin = min(ma.min(), mb.min()); vmax = max(ma.max(), mb.max())
    fig, axes = plt.subplots(1, 3, figsize=(14, 4.6))
    axes[0].imshow(ma, origin="lower", cmap="magma", vmin=vmin, vmax=vmax); axes[0].set_title(f"MIP  t={a}")
    axes[1].imshow(mb, origin="lower", cmap="magma", vmin=vmin, vmax=vmax); axes[1].set_title(f"MIP  t={b}")
    d = np.abs(diff).max()
    im = axes[2].imshow(diff, origin="lower", cmap="RdBu_r", vmin=-d, vmax=d)
    axes[2].set_title(f"差异 (t{b} − t{a}): 红=增强, 蓝=减弱")
    plt.colorbar(im, ax=axes[2], fraction=0.046)
    for ax in axes: ax.set_xticks([]); ax.set_yticks([])
    fig.suptitle("双时间步对比: 节点/丝处密度增强, 空洞处减弱", color="#0d8c8a", fontsize=12)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "dual_step_compare.png"), dpi=130); plt.close()


def _to_rgb(a2d, cmap, vmin, vmax, size=384, label=None):
    n = np.clip((a2d - vmin) / (vmax - vmin), 0, 1)
    rgb = (plt.get_cmap(cmap)(n)[..., :3] * 255).astype(np.uint8)
    im = Image.fromarray(rgb[::-1]).resize((size, size), Image.BILINEAR)  # origin lower
    if label:
        d = ImageDraw.Draw(im); d.text((10, 8), label, fill=(255, 255, 255))
    return im


def gif_evolution():
    mips = [load_vol(s).max(axis=0) for s in range(100)]
    vmin = min(m.min() for m in mips); vmax = max(m.max() for m in mips)
    frames = [_to_rgb(m, "magma", vmin, vmax, 384, f"t={s:03d}  MIP") for s, m in enumerate(mips)]
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
