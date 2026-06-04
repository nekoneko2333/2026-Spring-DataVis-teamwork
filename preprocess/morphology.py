"""
宇宙网形态学分类 + 连通域分析 (创新点 B / P1 #7,#8)
================================================
方法: 对平滑后的 log-density 场计算 Hessian, 解 3 个特征值,
      按"负特征值个数"(密度场凹陷=塌缩方向) 分类:
        负特征值数 = 3 -> node (节点, 局部极大)
                    = 2 -> filament (丝)
                    = 1 -> sheet (墙)
                    = 0 -> void (空洞)
物理限定: 仅用密度场 => 这是 smoothed log-density Hessian morphology proxy,
          非严格 T-web(后者基于引力势 Hessian)。报告中如实说明。

另: 对固定高密度阈值做连通域分析, 统计节点数/最大团块体积随时间。

输出:
  public/data/labels/t{:04d}_labels_u8.bin   (u8, order='C', x 最快)
  public/data/morphology.json                (每步形态学体积占比 + 连通域指标)
"""
import os
import json
import time
import numpy as np
from scipy import ndimage

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(_ROOT, "Nyx")
OUT_DIR = os.path.join(_ROOT, "public", "data")
LBL_DIR = os.path.join(OUT_DIR, "labels")
os.makedirs(LBL_DIR, exist_ok=True)

NX = NY = NZ = 128
N_STEPS = 100
SIGMA = 2.0              # 平滑尺度(体素), 去噪并定义形态学尺度
LAMBDA_TH = 0.8         # 特征值阈值(相对 eigenvalue std); 经调参得到 void 主导的合理体积占比


def load_volume_zyx(step):
    arr = np.fromfile(os.path.join(DATA_DIR, f"{step:04d}.dat"), dtype="<f4")
    return arr.reshape((NZ, NY, NX), order="F").astype(np.float32)


def symmetric_eig3(a, b, c, d, e, f):
    """解对称 3x3 矩阵 [[a,d,e],[d,b,f],[e,f,c]] 的特征值 (逐体素, 全向量化)。
    返回 (eig1>=eig2>=eig3)。"""
    p1 = d * d + e * e + f * f
    q = (a + b + c) / 3.0
    a1, b1, c1 = a - q, b - q, c - q
    p2 = a1 * a1 + b1 * b1 + c1 * c1 + 2.0 * p1
    p = np.sqrt(np.maximum(p2 / 6.0, 1e-30))
    # det(A - qI)
    detB = (a1 * (b1 * c1 - f * f)
            - d * (d * c1 - f * e)
            + e * (d * f - b1 * e))
    r = detB / (2.0 * p ** 3)
    r = np.clip(r, -1.0, 1.0)
    phi = np.arccos(r) / 3.0
    eig1 = q + 2.0 * p * np.cos(phi)
    eig3 = q + 2.0 * p * np.cos(phi + 2.0 * np.pi / 3.0)
    eig2 = 3.0 * q - eig1 - eig3
    return eig1, eig2, eig3


def classify(vol):
    """返回 label 体 (u8): 0 void,1 sheet,2 filament,3 node。"""
    # Hessian 各分量 (高斯二阶导); 轴序 (z,y,x): 0=z,1=y,2=x
    Hzz = ndimage.gaussian_filter(vol, SIGMA, order=[2, 0, 0])
    Hyy = ndimage.gaussian_filter(vol, SIGMA, order=[0, 2, 0])
    Hxx = ndimage.gaussian_filter(vol, SIGMA, order=[0, 0, 2])
    Hzy = ndimage.gaussian_filter(vol, SIGMA, order=[1, 1, 0])
    Hzx = ndimage.gaussian_filter(vol, SIGMA, order=[1, 0, 1])
    Hyx = ndimage.gaussian_filter(vol, SIGMA, order=[0, 1, 1])
    # 对称矩阵 [[Hxx,Hyx,Hzx],[Hyx,Hyy,Hzy],[Hzx,Hzy,Hzz]]
    e1, e2, e3 = symmetric_eig3(Hxx, Hyy, Hzz, Hyx, Hzx, Hzy)
    # 用全局尺度做相对阈值
    scale = np.std([e1, e2, e3])
    th = LAMBDA_TH * scale
    neg = (e1 < -th).astype(np.uint8) + (e2 < -th).astype(np.uint8) + (e3 < -th).astype(np.uint8)
    return neg  # 0..3 直接就是 void/sheet/filament/node


def main():
    t0 = time.time()
    # 固定高密度阈值(用聚合 99% 分位), 保证跨时间步可比
    meta = json.load(open(os.path.join(OUT_DIR, "metadata.json"), encoding="utf-8"))
    hi_th = meta["globalPercentiles"]["99"]
    print(f"高密度连通域阈值(固定) logDensity > {hi_th:.4f}")

    records = []
    structure = np.ones((3, 3, 3))  # 26-连通
    for s in range(N_STEPS):
        vol = load_volume_zyx(s)
        labels = classify(vol)
        labels.ravel(order="C").astype(np.uint8).tofile(
            os.path.join(LBL_DIR, f"t{s:04d}_labels_u8.bin"))

        total = labels.size
        frac = {
            "void": float((labels == 0).mean()),
            "sheet": float((labels == 1).mean()),
            "filament": float((labels == 2).mean()),
            "node": float((labels == 3).mean()),
        }
        # 连通域: 固定高密度阈值
        mask = vol > hi_th
        lab, n = ndimage.label(mask, structure=structure)
        if n > 0:
            sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1))
            max_blob = int(sizes.max())
            mean_blob = float(sizes.mean())
        else:
            max_blob, mean_blob = 0, 0.0
        records.append({
            "step": s,
            "fractions": frac,
            "highThreshold": float(hi_th),
            "highVoxels": int(mask.sum()),
            "nodeCount": int(n),
            "maxBlobVoxels": max_blob,
            "meanBlobVoxels": mean_blob,
        })
        if s % 10 == 0 or s == N_STEPS - 1:
            print(f"  step {s:3d}: node%={frac['node']*100:5.2f} "
                  f"fil%={frac['filament']*100:5.2f} void%={frac['void']*100:5.2f} "
                  f"clusters={n} maxBlob={max_blob}")

    with open(os.path.join(OUT_DIR, "morphology.json"), "w", encoding="utf-8") as f:
        json.dump({
            "sigma": SIGMA,
            "lambdaTh": LAMBDA_TH,
            "labelMap": {"0": "void", "1": "sheet", "2": "filament", "3": "node"},
            "steps": records,
        }, f, indent=2)
    print(f"完成, 用时 {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
