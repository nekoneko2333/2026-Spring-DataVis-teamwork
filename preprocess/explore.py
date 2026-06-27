"""
数据探查脚本 (P0 - 执行顺序第 1 步)
================================================
目标:
  1. 验证字节序 / 列优先(order='F') 读取是否正确;
  2. 输出 xy / xz / yz 三方向切片核对轴向(无错位/转置/镜像);
  3. 打印真实 min/max/mean/std 与分位数, 检查是否含 0/负值;
  4. 判断数值是绝对密度还是过密度(1+delta), 并决定是否取 log;
  5. 把结论写入 outputs/explore/exploration_report.txt。

读取约定(来自数据事实): little-endian float32, 列优先(z 变化最快)。
flat index = z + nz*(y + ny*x)  => reshape(order='F') 直接得到 (z, y, x)。
"""
import os
import json
import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from plot_style import DENSITY_CMAP, HEAT_CMAP, PAPER, apply_paper_style, style_axes

apply_paper_style()

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(_ROOT, "Nyx")
OUT_DIR = os.path.join(_ROOT, "outputs", "explore")
os.makedirs(OUT_DIR, exist_ok=True)

NX = NY = NZ = 128
EXPECTED_BYTES = NX * NY * NZ * 4  # 8,388,608


def load_volume_zyx(path):
    """读取单个 .dat 为 (z, y, x) 体数据。"""
    arr = np.fromfile(path, dtype="<f4")  # little-endian float32
    assert arr.size == NX * NY * NZ, f"{path} size={arr.size} (expected {NX*NY*NZ})"
    # 列优先: flat = z + nz*(y + ny*x) => order='F' 得到 axes=(z,y,x)
    vol_zyx = arr.reshape((NZ, NY, NX), order="F")
    return vol_zyx


def describe(name, vol):
    flat = vol.ravel()
    qs = [0, 0.1, 1, 5, 25, 50, 75, 95, 99, 99.9, 100]
    qv = np.percentile(flat, qs)
    lines = []
    lines.append(f"=== {name} ===")
    lines.append(f"  shape           : {vol.shape} (z,y,x)")
    lines.append(f"  dtype           : {vol.dtype}")
    lines.append(f"  min / max       : {flat.min():.6g} / {flat.max():.6g}")
    lines.append(f"  mean / std      : {flat.mean():.6g} / {flat.std():.6g}")
    lines.append(f"  median          : {np.median(flat):.6g}")
    lines.append(f"  #(<=0)          : {(flat <= 0).sum()}  ({100*(flat<=0).mean():.4f}%)")
    lines.append(f"  #(==0)          : {(flat == 0).sum()}")
    lines.append(f"  #(<0)           : {(flat < 0).sum()}")
    lines.append(f"  #(nan)/#(inf)   : {np.isnan(flat).sum()} / {np.isinf(flat).sum()}")
    lines.append("  percentiles:")
    for q, v in zip(qs, qv):
        lines.append(f"    {q:6.2f}% -> {v:.6g}")
    return "\n".join(lines), qv


def save_axis_check(vol, tag):
    """保存三方向中心切片 + 三方向 MIP, 用于核对轴向。"""
    cz, cy, cx = NZ // 2, NY // 2, NX // 2
    # 用 log 显示便于看结构
    def L(a):
        return np.log10(np.clip(a, a[a > 0].min() if (a > 0).any() else 1e-10, None))

    slices = {
        "xy_z-mid (vol[z, :, :])": L(vol[cz, :, :]),
        "xz_y-mid (vol[:, y, :])": L(vol[:, cy, :]),
        "yz_x-mid (vol[:, :, x])": L(vol[:, :, cx]),
    }
    mips = {
        "MIP along z": L(vol.max(axis=0)),
        "MIP along y": L(vol.max(axis=1)),
        "MIP along x": L(vol.max(axis=2)),
    }
    fig, axes = plt.subplots(2, 3, figsize=(15, 10))
    for ax, (title, img) in zip(axes[0], slices.items()):
        im = ax.imshow(img, origin="lower", cmap=HEAT_CMAP, aspect="equal")
        ax.set_title(title, fontsize=10)
        plt.colorbar(im, ax=ax, fraction=0.046)
    for ax, (title, img) in zip(axes[1], mips.items()):
        im = ax.imshow(img, origin="lower", cmap=DENSITY_CMAP, aspect="equal")
        ax.set_title(title, fontsize=10)
        plt.colorbar(im, ax=ax, fraction=0.046)
    for ax in axes.ravel():
        style_axes(ax, grid=False)
        ax.set_xticks([]); ax.set_yticks([])
    fig.suptitle(f"Axis / orientation check  [{tag}]  (log10 density)", fontsize=13)
    plt.tight_layout()
    p = os.path.join(OUT_DIR, f"axis_check_{tag}.png")
    plt.savefig(p, dpi=180)
    plt.close()
    return p


def save_hist(vol, tag):
    flat = vol.ravel()
    pos = flat[flat > 0]
    logv = np.log10(pos)
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.5))
    axes[0].hist(flat, bins=200, color=PAPER["blue"], alpha=0.88)
    axes[0].set_title(f"linear density hist [{tag}]")
    axes[0].set_yscale("log")
    axes[1].hist(logv, bins=200, color=PAPER["orange"], alpha=0.88)
    axes[1].set_title(f"log10 density hist [{tag}]")
    axes[1].set_yscale("log")
    for ax in axes:
        style_axes(ax)
    plt.tight_layout()
    p = os.path.join(OUT_DIR, f"hist_{tag}.png")
    plt.savefig(p, dpi=180)
    plt.close()
    return p


def main():
    report = []
    report.append("Nyx 宇宙学体数据 — 数据探查报告")
    report.append("=" * 60)
    report.append(f"数据目录: {DATA_DIR}")
    report.append(f"单文件期望字节数: {EXPECTED_BYTES} = 128^3 * 4")
    report.append("读取: np.fromfile('<f4').reshape((128,128,128), order='F') -> (z,y,x)")
    report.append("")

    # 抽样三个时间步: 早 / 中 / 晚
    sample_steps = [0, 50, 99]
    qv_all = {}
    for s in sample_steps:
        path = os.path.join(DATA_DIR, f"{s:04d}.dat")
        sz = os.path.getsize(path)
        vol = load_volume_zyx(path)
        text, qv = describe(f"t={s:04d}  (file bytes={sz})", vol)
        report.append(text)
        report.append("")
        qv_all[s] = qv
        p1 = save_axis_check(vol, f"t{s:04d}")
        p2 = save_hist(vol, f"t{s:04d}")
        report.append(f"  -> axis check : {p1}")
        report.append(f"  -> histogram  : {p2}")
        report.append("")

    # ---- 结论推断 ----
    report.append("=" * 60)
    report.append("结论推断")
    report.append("=" * 60)

    # 用早期步判断绝对密度 vs 过密度
    vol0 = load_volume_zyx(os.path.join(DATA_DIR, "0000.dat"))
    vol99 = load_volume_zyx(os.path.join(DATA_DIR, "0099.dat"))
    mean0 = vol0.mean()
    mean99 = vol99.mean()
    report.append(f"t0000 mean = {mean0:.6g}, t0099 mean = {mean99:.6g}")
    report.append(
        "判断: 若各步均值≈1 且早期方差极小, 多为过密度 (1+delta) / 归一化密度;"
    )
    report.append(
        "      若均值为某物理常数且随时间基本守恒, 为绝对(共动)密度。"
    )
    report.append(f"全场是否含 <=0 值: t0000={int((vol0<=0).sum())}, t0099={int((vol99<=0).sum())}")
    report.append(
        "决定: 密度场动态范围极大(长尾), 统计与传递函数一律采用 log10;"
    )
    report.append("      若存在 0 值, 取 log 前用极小正数 floor 截断。")
    report.append("")
    report.append("轴向核对: 请人工查看 axis_check_*.png, 确认 xy/xz/yz 切片与 MIP 无错位/转置/镜像。")

    out_text = "\n".join(report)
    with open(os.path.join(OUT_DIR, "exploration_report.txt"), "w", encoding="utf-8") as f:
        f.write(out_text)

    # 同时存一份机器可读 json, 供后续预处理参考
    summary = {
        "shape": [NZ, NY, NX],
        "axisOrder": "zyx",
        "sampleSteps": sample_steps,
        "means": {str(s): float(load_volume_zyx(os.path.join(DATA_DIR, f"{s:04d}.dat")).mean()) for s in sample_steps},
    }
    with open(os.path.join(OUT_DIR, "exploration_summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    print(out_text)
    print("\n[done] outputs ->", OUT_DIR)


if __name__ == "__main__":
    main()
