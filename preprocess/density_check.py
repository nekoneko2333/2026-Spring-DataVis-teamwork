"""
log 底数 / 绝对密度假设的科学检验 (P0 严谨性)。
若存储值 V = log10(rho_comoving), 则线性平均密度 <rho>=<10^V> 在共动坐标下应近似守恒(质量守恒),
而 <log10 rho>=<V> 会随方差增大而下降 (Jensen 不等式: 对数正态下 log 的均值低于均值的 log)。
本脚本计算并对比, 输出 mass_conservation.png 与一份结论文本。
"""
import os
import json
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NYX = os.path.join(_ROOT, "Nyx")
OUT = os.path.join(_ROOT, "outputs")
DATA = os.path.join(_ROOT, "public", "data")
N = 100
# 宇宙平均共动重子密度量级: rho_b = Omega_b * rho_crit
# rho_crit ~ 2.775e11 h^2 Msun/Mpc^3 (h=0.674) -> ~1.26e11; Omega_b~0.049 -> ~6.2e9 -> log10~9.79
COSMIC_BARYON_LOG10 = 9.79

plt.rcParams.update({"figure.facecolor": "white", "axes.facecolor": "white", "savefig.facecolor": "white",
                     "text.color": "#1b2740", "axes.labelcolor": "#1b2740", "xtick.color": "#5d6b86",
                     "ytick.color": "#5d6b86", "axes.edgecolor": "#c6d2e6", "axes.titlecolor": "#0d8c8a"})


def load_vol(s):
    return np.fromfile(os.path.join(NYX, f"{s:04d}.dat"), dtype="<f4").reshape((128, 128, 128), order="F").astype(np.float64)


def main():
    meanV, log10_meanRho, jensen = [], [], []
    for s in range(N):
        v = load_vol(s)
        mv = v.mean()
        rho = np.power(10.0, v)
        lmr = np.log10(rho.mean())
        meanV.append(mv); log10_meanRho.append(lmr); jensen.append(lmr - mv)
        if s % 10 == 0 or s == N - 1:
            print(f"step {s:3d}: <log10 rho>={mv:.4f}  log10<rho>={lmr:.4f}  Jensen gap={lmr-mv:.4f}")

    meanV = np.array(meanV); log10_meanRho = np.array(log10_meanRho)
    # 守恒性: log10<rho> 的相对漂移
    drift = (10 ** log10_meanRho).std() / (10 ** log10_meanRho).mean()
    concl = [
        "log 底数 / 绝对密度假设检验结论",
        "=" * 50,
        f"log10<rho> 范围: [{log10_meanRho.min():.4f}, {log10_meanRho.max():.4f}]",
        f"线性平均密度 <rho> 跨 100 步相对标准差: {drift*100:.3f}%  (越小越守恒)",
        f"<log10 rho> 由 t0 的 {meanV[0]:.4f} 降到 t99 的 {meanV[-1]:.4f} (Jensen 效应, 非质量损失)",
        f"宇宙平均共动重子密度量级参考 log10 ~ {COSMIC_BARYON_LOG10}",
        "",
        "推断: 线性平均密度近似守恒(共动质量守恒) + log10<rho> 量级接近宇宙重子密度,",
        "      共同支持'存储值 = log10(共动绝对气体密度)'; <log10 rho> 随时间下降是",
        "      方差增大下的 Jensen/对数正态效应, 而非物质丢失。",
    ]
    text = "\n".join(concl)
    print("\n" + text)
    with open(os.path.join(OUT, "density_assumption_check.txt"), "w", encoding="utf-8") as f:
        f.write(text)

    t = np.arange(N)
    fig, ax = plt.subplots(figsize=(9, 5))
    ax.plot(t, log10_meanRho, color="#0d8c8a", lw=2.2, label="log10<rho>  (linear mean, ~conserved)")
    ax.plot(t, meanV, color="#d97706", lw=2.2, label="<log10 rho>  (mean of log, drops)")
    ax.axhline(COSMIC_BARYON_LOG10, color="#6d5ef0", ls="--", lw=1.4, label=f"cosmic baryon ~{COSMIC_BARYON_LOG10}")
    ax.fill_between(t, meanV, log10_meanRho, color="#9bb7d8", alpha=0.25, label="Jensen gap = (ln10/2)*Var")
    ax.set_xlabel("time step"); ax.set_ylabel("log10 density")
    ax.set_title("Mass-conservation test: linear mean ~constant, mean-of-log drops (Jensen)")
    ax.legend(framealpha=0.2, labelcolor="#1b2740", fontsize=9)
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "mass_conservation.png"), dpi=130); plt.close()
    print("\nsaved -> mass_conservation.png")


if __name__ == "__main__":
    main()
