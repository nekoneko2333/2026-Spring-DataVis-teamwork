"""
Marching Cubes 真实三角网格导出 (P0 等值面 stretch)
================================================
在 ray-march iso 近似之外, 用 skimage.measure.marching_cubes 抽取真实三角网格,
等值面 level 与前端 iso 默认一致(归一化 0.40 -> logDensity)。
为控制体积, 仅对关键步导出, 前端按最近步吸附显示。

二进制格式 (little-endian):
  uint32 nVerts, uint32 nFaces, float32 positions[nVerts*3] (世界坐标 [-0.5,0.5]),
  uint32 indices[nFaces*3]
顶点坐标轴序映射: world(x,y,z) = data(x,y,z) (verts 列 z,y,x -> 重排)
法线由前端 computeVertexNormals 生成(双面材质)。
"""
import os
import json
import time
import numpy as np
from skimage import measure
from morphology import load_volume_zyx

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(_ROOT, "public", "data")
MESH = os.path.join(DATA, "meshes")
os.makedirs(MESH, exist_ok=True)
NX = NY = NZ = 128
ISO_NORM = 0.40
STEPS = list(range(0, 100, 10)) + [99]


def main():
    t0 = time.time()
    meta = json.load(open(os.path.join(DATA, "metadata.json"), encoding="utf-8"))
    gmin, gmax = meta["globalLogMin"], meta["globalLogMax"]
    level = gmin + ISO_NORM * (gmax - gmin)
    print(f"iso level (logDensity) = {level:.4f}  (normalized {ISO_NORM})")
    recs = []
    for s in STEPS:
        vol = load_volume_zyx(s)  # (z,y,x)
        verts, faces, normals, _ = measure.marching_cubes(vol, level=level, step_size=1)
        # verts 列: 0=z,1=y,2=x -> 世界 (x,y,z), 归一化到 [-0.5,0.5]
        pos = np.empty_like(verts, dtype=np.float32)
        pos[:, 0] = verts[:, 2] / (NX - 1) - 0.5
        pos[:, 1] = verts[:, 1] / (NY - 1) - 0.5
        pos[:, 2] = verts[:, 0] / (NZ - 1) - 0.5
        idx = faces.astype(np.uint32)
        path = os.path.join(MESH, f"t{s:04d}_mesh.bin")
        with open(path, "wb") as f:
            np.array([pos.shape[0], idx.shape[0]], dtype="<u4").tofile(f)
            pos.astype("<f4").ravel(order="C").tofile(f)
            idx.ravel(order="C").astype("<u4").tofile(f)
        kb = os.path.getsize(path) / 1024
        recs.append({"step": s, "verts": int(pos.shape[0]), "faces": int(idx.shape[0])})
        print(f"  step {s:3d}: verts={pos.shape[0]:7d} faces={idx.shape[0]:7d}  ({kb:.0f} KB)")
    manifest = {
        "isoNorm": ISO_NORM, "isoLogDensity": level,
        "steps": STEPS, "file": "meshes/t{:04d}_mesh.bin",
        "info": recs,
    }
    json.dump(manifest, open(os.path.join(DATA, "mc_manifest.json"), "w", encoding="utf-8"), indent=2)
    print(f"完成 MC 导出, 用时 {time.time()-t0:.1f}s -> {MESH}")


if __name__ == "__main__":
    main()
