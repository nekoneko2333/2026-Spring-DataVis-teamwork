"""
严格 T-web 宇宙网分类 (创新点 B 升级版)
================================================
不再用密度场 Hessian, 而是:
  1) 过密度 delta = rho/<rho> - 1 (rho = 10^V);
  2) 解 Poisson 方程 ∇²φ = delta (FFT: φ_k = -delta_k / k²);
  3) 潮汐张量 T_ij = ∂²φ/∂x_i∂x_j (傅里叶: T_ij(k) = (k_i k_j / k²)·delta_k);
  4) 求 3 个特征值, 统计 > λ_th 的个数(塌缩方向):
       3 -> node, 2 -> filament, 1 -> sheet, 0 -> void。
参考 Hahn 2007 / Forero-Romero 2009。

用法:
  python preprocess/tweb.py tune     # 在 step50 上扫描 λ_th, 打印体积占比
  python preprocess/tweb.py          # 处理全部 100 步, 导出 labels_tweb + 写回 morphology.json
"""
import os
import sys
import json
import time
import numpy as np
from scipy import ndimage
from morphology import load_volume_zyx, symmetric_eig3

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(_ROOT, "public", "data")
LBL = os.path.join(DATA, "labels_tweb")
os.makedirs(LBL, exist_ok=True)
NX = NY = NZ = 128
N_STEPS = 100
SIGMA = 2.0
LAMBDA_TH = 0.2   # 相对 eigenvalue std 的阈值(经 tune 选择)

# 预计算傅里叶波数与 1/k²
_kz = np.fft.fftfreq(NZ) * NZ
_ky = np.fft.fftfreq(NY) * NY
_kx = np.fft.rfftfreq(NX) * NX
_KZ, _KY, _KX = np.meshgrid(_kz, _ky, _kx, indexing="ij")
_K2 = _KZ ** 2 + _KY ** 2 + _KX ** 2
_INV_K2 = np.zeros_like(_K2)
_nz = _K2 > 0
_INV_K2[_nz] = 1.0 / _K2[_nz]
_GAUSS = np.exp(-_K2 * (SIGMA / NX * 2 * np.pi) ** 2 / 2.0)  # 傅里叶域高斯平滑


def tidal_eigs(vol):
    rho = np.power(10.0, vol.astype(np.float64))
    delta = rho / rho.mean() - 1.0
    dk = np.fft.rfftn(delta) * _GAUSS
    # T_ij(k) = (k_i k_j / k²) · delta_k
    comp = {}
    pairs = {"zz": (_KZ, _KZ), "yy": (_KY, _KY), "xx": (_KX, _KX),
             "zy": (_KZ, _KY), "zx": (_KZ, _KX), "yx": (_KY, _KX)}
    for name, (ka, kb) in pairs.items():
        comp[name] = np.fft.irfftn(dk * (ka * kb) * _INV_K2, s=(NZ, NY, NX))
    # 对称矩阵 [[xx,yx,zx],[yx,yy,zy],[zx,zy,zz]]
    e1, e2, e3 = symmetric_eig3(comp["xx"], comp["yy"], comp["zz"],
                                comp["yx"], comp["zx"], comp["zy"])
    return e1, e2, e3


def classify(e1, e2, e3, lam):
    scale = np.std(np.stack([e1, e2, e3]))
    th = lam * scale
    # 潮汐张量: 塌缩方向 => 特征值 > th
    cnt = (e1 > th).astype(np.uint8) + (e2 > th).astype(np.uint8) + (e3 > th).astype(np.uint8)
    return cnt  # 0 void,1 sheet,2 filament,3 node


def tune():
    e1, e2, e3 = tidal_eigs(load_volume_zyx(50))
    scale = np.std(np.stack([e1, e2, e3]))
    print(f"eigenvalue std = {scale:.5f}")
    print(f"{'lambda':>7}{'void%':>8}{'sheet%':>8}{'fil%':>8}{'node%':>8}")
    for lam in [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0]:
        lab = classify(e1, e2, e3, lam)
        fr = [float((lab == k).mean()) * 100 for k in range(4)]
        print(f"{lam:7.2f}{fr[0]:8.2f}{fr[1]:8.2f}{fr[2]:8.2f}{fr[3]:8.2f}")


def main():
    t0 = time.time()
    structure = np.ones((3, 3, 3))
    meta = json.load(open(os.path.join(DATA, "metadata.json"), encoding="utf-8"))
    hi_th = meta["globalPercentiles"]["99"]
    recs = []
    for s in range(N_STEPS):
        vol = load_volume_zyx(s)
        e1, e2, e3 = tidal_eigs(vol)
        lab = classify(e1, e2, e3, LAMBDA_TH)
        lab.ravel(order="C").astype(np.uint8).tofile(os.path.join(LBL, f"t{s:04d}_labels_u8.bin"))
        frac = {n: float((lab == k).mean()) for k, n in enumerate(["void", "sheet", "filament", "node"])}
        recs.append({"step": s, "fractions": frac})
        if s % 10 == 0 or s == N_STEPS - 1:
            print(f"  step {s:3d}: node%={frac['node']*100:5.2f} fil%={frac['filament']*100:5.2f} "
                  f"sheet%={frac['sheet']*100:5.2f} void%={frac['void']*100:5.2f}")
    # 写回 morphology.json 增加 tweb 段
    mp = os.path.join(DATA, "morphology.json")
    morph = json.load(open(mp, encoding="utf-8"))
    morph["tweb"] = {"sigma": SIGMA, "lambdaTh": LAMBDA_TH,
                     "method": "Poisson tidal-tensor T-web (Hahn2007/Forero-Romero2009)",
                     "steps": recs}
    json.dump(morph, open(mp, "w", encoding="utf-8"), indent=2)
    print(f"完成 T-web, 用时 {time.time()-t0:.1f}s -> {LBL}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "tune":
        tune()
    else:
        main()
