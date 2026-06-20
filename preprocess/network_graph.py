"""
T-web filament-node skeleton graph for the Story Mode network layer.

This script converts the classified cosmic web volume into a topology graph:
  1. Use strict T-web labels: 2=filament, 3=node.
  2. Skeletonize the filament+node mask to obtain the web centerline.
  3. Treat T-web node components and skeleton junctions/endpoints as graph nodes.
  4. Trace graph edges along the skeleton paths.

Default output is designed for the final Story chapter:
  public/data/network/t0099_skeleton_u8.bin
  public/data/network/t0099_graph.json
  public/data/network/summary.json

Usage:
  python preprocess/network_graph.py
  python preprocess/network_graph.py --step 99
  python preprocess/network_graph.py --all
"""
from __future__ import annotations

import argparse
import json
import math
import os
import time
from collections import defaultdict, deque

import numpy as np
from scipy import ndimage
from skimage.morphology import skeletonize

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "public", "data")
NYX = os.path.join(ROOT, "Nyx")
LABEL_DIR = os.path.join(DATA, "labels_tweb")
OUT = os.path.join(DATA, "network")

NX = NY = NZ = 128
STRUCT26 = np.ones((3, 3, 3), dtype=bool)
NEIGHBORS26 = [
    (dz, dy, dx)
    for dz in (-1, 0, 1)
    for dy in (-1, 0, 1)
    for dx in (-1, 0, 1)
    if not (dz == 0 and dy == 0 and dx == 0)
]


def load_meta() -> dict:
    with open(os.path.join(DATA, "metadata.json"), encoding="utf-8") as f:
        return json.load(f)


def load_labels(step: int) -> np.ndarray:
    path = os.path.join(LABEL_DIR, f"t{step:04d}_labels_u8.bin")
    if not os.path.exists(path):
        raise FileNotFoundError(f"Missing T-web labels: {path}. Run preprocess/tweb.py first.")
    return np.fromfile(path, dtype=np.uint8).reshape((NZ, NY, NX), order="C")


def load_log_density(step: int, meta: dict) -> np.ndarray:
    raw_path = os.path.join(NYX, f"{step:04d}.dat")
    if os.path.exists(raw_path):
        return np.fromfile(raw_path, dtype="<f4").reshape((NZ, NY, NX), order="F").astype(np.float32)

    rel = meta["files"]["volume"].replace("{:04d}", f"{step:04d}")
    vol_path = os.path.join(DATA, rel)
    if not os.path.exists(vol_path):
        raise FileNotFoundError(f"Missing volume data: {raw_path} or {vol_path}")
    u16 = np.fromfile(vol_path, dtype=np.uint16).reshape((NZ, NY, NX), order="C")
    norm = u16.astype(np.float32) / 65535.0
    return meta["globalLogMin"] + norm * (meta["globalLogMax"] - meta["globalLogMin"])


def world_from_zyx(p: np.ndarray | tuple[int, int, int]) -> list[float]:
    z, y, x = p
    return [
        float(x / (NX - 1) - 0.5),
        float(y / (NY - 1) - 0.5),
        float(z / (NZ - 1) - 0.5),
    ]


def distance_world(a: np.ndarray, b: np.ndarray) -> float:
    dz, dy, dx = (a - b).astype(float)
    return math.sqrt((dx / (NX - 1)) ** 2 + (dy / (NY - 1)) ** 2 + (dz / (NZ - 1)) ** 2)


def remove_small_components(mask: np.ndarray, min_size: int) -> np.ndarray:
    lab, n = ndimage.label(mask, structure=STRUCT26)
    if n == 0:
        return mask
    sizes = np.bincount(lab.ravel())
    keep = sizes >= min_size
    keep[0] = False
    return keep[lab]


def component_records(mask: np.ndarray, vol: np.ndarray, min_size: int, kind: str, start_id: int) -> tuple[list[dict], np.ndarray]:
    lab, n = ndimage.label(mask, structure=STRUCT26)
    nodes: list[dict] = []
    owner = np.full(mask.shape, -1, dtype=np.int32)
    next_id = start_id

    for comp_id in range(1, n + 1):
        coords = np.argwhere(lab == comp_id)
        size = int(coords.shape[0])
        if size < min_size:
            continue
        vals = vol[lab == comp_id]
        center = coords.mean(axis=0)
        radius = ((size * 3.0 / (4.0 * math.pi)) ** (1.0 / 3.0)) / (NX - 1)
        owner[lab == comp_id] = next_id
        nodes.append({
            "id": next_id,
            "type": kind,
            "center": world_from_zyx(center),
            "voxelCenter": [float(center[2]), float(center[1]), float(center[0])],
            "voxelCount": size,
            "meanLogDensity": float(vals.mean()),
            "maxLogDensity": float(vals.max()),
            "radius": float(radius),
            "degree": 0,
        })
        next_id += 1
    return nodes, owner


def skeleton_neighbor_count(skel: np.ndarray) -> np.ndarray:
    counts = np.zeros(skel.shape, dtype=np.uint8)
    for dz, dy, dx in NEIGHBORS26:
        src = skel[
            max(0, -dz): min(NZ, NZ - dz),
            max(0, -dy): min(NY, NY - dy),
            max(0, -dx): min(NX, NX - dx),
        ]
        dst = counts[
            max(0, dz): min(NZ, NZ + dz),
            max(0, dy): min(NY, NY + dy),
            max(0, dx): min(NX, NX + dx),
        ]
        dst += src.astype(np.uint8)
    return counts


def add_topology_nodes(
    skel: np.ndarray,
    counts: np.ndarray,
    vol: np.ndarray,
    owner: np.ndarray,
    nodes: list[dict],
    min_junction_voxels: int,
    keep_endpoints: bool,
) -> tuple[list[dict], np.ndarray]:
    next_id = len(nodes)
    occupied = owner >= 0
    topo_specs = [("junction", (counts >= 3) & skel & ~occupied, min_junction_voxels)]
    if keep_endpoints:
        topo_specs.append(("endpoint", (counts == 1) & skel & ~occupied, 1))

    for kind, mask, min_size in topo_specs:
        lab, n = ndimage.label(mask, structure=STRUCT26)
        for comp_id in range(1, n + 1):
            coords = np.argwhere(lab == comp_id)
            size = int(coords.shape[0])
            if size < min_size:
                continue
            vals = vol[lab == comp_id]
            center = coords.mean(axis=0)
            owner[lab == comp_id] = next_id
            nodes.append({
                "id": next_id,
                "type": kind,
                "center": world_from_zyx(center),
                "voxelCenter": [float(center[2]), float(center[1]), float(center[0])],
                "voxelCount": size,
                "meanLogDensity": float(vals.mean()),
                "maxLogDensity": float(vals.max()),
                "radius": 0.012 if kind == "junction" else 0.008,
                "degree": 0,
            })
            next_id += 1
    return nodes, owner


def skel_neighbors(p: tuple[int, int, int], skel: np.ndarray) -> list[tuple[int, int, int]]:
    z, y, x = p
    out = []
    for dz, dy, dx in NEIGHBORS26:
        zz, yy, xx = z + dz, y + dy, x + dx
        if 0 <= zz < NZ and 0 <= yy < NY and 0 <= xx < NX and skel[zz, yy, xx]:
            out.append((zz, yy, xx))
    return out


def nearest_owned_neighbor(p: tuple[int, int, int], owner: np.ndarray) -> int:
    z, y, x = p
    best = -1
    best_d2 = 1e9
    for dz in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                zz, yy, xx = z + dz, y + dy, x + dx
                if 0 <= zz < NZ and 0 <= yy < NY and 0 <= xx < NX:
                    oid = int(owner[zz, yy, xx])
                    if oid >= 0:
                        d2 = dz * dz + dy * dy + dx * dx
                        if d2 < best_d2:
                            best = oid
                            best_d2 = d2
    return best


def trace_edges(
    skel: np.ndarray,
    owner: np.ndarray,
    labels: np.ndarray,
    vol: np.ndarray,
    min_length: float,
    min_filament_ratio: float,
) -> list[dict]:
    start_voxels = [tuple(p) for p in np.argwhere(skel & (owner >= 0))]
    visited_segments: set[tuple[tuple[int, int, int], tuple[int, int, int]]] = set()
    edges = []
    edge_seen: set[tuple[int, int, tuple[tuple[int, int, int], ...]]] = set()

    for start in start_voxels:
        source = int(owner[start])
        for nb in skel_neighbors(start, skel):
            key = tuple(sorted((start, nb)))
            if key in visited_segments:
                continue
            path = [start]
            prev = start
            cur = nb
            target = -1
            guard = 0

            while guard < skel.size:
                guard += 1
                visited_segments.add(tuple(sorted((prev, cur))))
                path.append(cur)
                cur_owner = int(owner[cur])
                if cur_owner >= 0 and cur_owner != source:
                    target = cur_owner
                    break

                candidates = [q for q in skel_neighbors(cur, skel) if q != prev]
                candidates = [q for q in candidates if tuple(sorted((cur, q))) not in visited_segments]
                if not candidates:
                    target = nearest_owned_neighbor(cur, owner)
                    break
                if len(candidates) > 1:
                    owned = [q for q in candidates if owner[q] >= 0]
                    cur_count = skeleton_neighbor_count_at(cur, skel)
                    if owned:
                        candidates = owned
                    elif cur_count >= 3:
                        target = nearest_owned_neighbor(cur, owner)
                        break
                prev, cur = cur, candidates[0]

            if target < 0 or target == source or len(path) < 2:
                continue

            arr = np.array(path, dtype=np.int16)
            length = sum(distance_world(arr[i - 1], arr[i]) for i in range(1, len(arr)))
            if length < min_length:
                continue
            lbl_vals = labels[arr[:, 0], arr[:, 1], arr[:, 2]]
            filament_ratio = float(np.mean(lbl_vals == 2))
            node_ratio = float(np.mean(lbl_vals == 3))
            if filament_ratio < min_filament_ratio and node_ratio < 0.25:
                continue
            vals = vol[arr[:, 0], arr[:, 1], arr[:, 2]]
            a, b = sorted((source, target))
            sparse_key = tuple(map(tuple, arr[:: max(1, len(arr) // 16)].tolist()))
            seen_key = (a, b, sparse_key)
            if seen_key in edge_seen:
                continue
            edge_seen.add(seen_key)

            density_norm = float(np.clip((vals.mean() - vol.min()) / max(vol.max() - vol.min(), 1e-6), 0, 1))
            weight = float(np.clip(0.55 * filament_ratio + 0.25 * node_ratio + 0.20 * density_norm, 0.05, 1.0))
            stride = max(1, int(math.ceil(len(path) / 96)))
            points = [world_from_zyx(p) for p in arr[::stride]]
            if points[-1] != world_from_zyx(arr[-1]):
                points.append(world_from_zyx(arr[-1]))
            edges.append({
                "id": len(edges),
                "source": source,
                "target": target,
                "points": points,
                "length": float(length),
                "filamentRatio": filament_ratio,
                "nodeRatio": node_ratio,
                "meanLogDensity": float(vals.mean()),
                "maxLogDensity": float(vals.max()),
                "weight": weight,
            })
    return merge_parallel_edges(edges)


def skeleton_neighbor_count_at(p: tuple[int, int, int], skel: np.ndarray) -> int:
    return len(skel_neighbors(p, skel))


def merge_parallel_edges(edges: list[dict]) -> list[dict]:
    best: dict[tuple[int, int], dict] = {}
    for edge in edges:
        key = tuple(sorted((edge["source"], edge["target"])))
        score = edge["weight"] / max(edge["length"], 1e-6)
        prev = best.get(key)
        if prev is None or score > prev["_score"]:
            edge["_score"] = score
            best[key] = edge
    merged = []
    for edge in best.values():
        edge.pop("_score", None)
        edge["id"] = len(merged)
        merged.append(edge)
    return merged


def graph_metrics(nodes: list[dict], edges: list[dict]) -> dict:
    degrees = defaultdict(int)
    adj = defaultdict(list)
    for e in edges:
        degrees[e["source"]] += 1
        degrees[e["target"]] += 1
        adj[e["source"]].append(e["target"])
        adj[e["target"]].append(e["source"])
    for node in nodes:
        node["degree"] = int(degrees[node["id"]])

    active = {n["id"] for n in nodes if degrees[n["id"]] > 0}
    seen = set()
    largest = 0
    for node_id in active:
        if node_id in seen:
            continue
        q = deque([node_id])
        seen.add(node_id)
        size = 0
        while q:
            u = q.popleft()
            size += 1
            for v in adj[u]:
                if v not in seen:
                    seen.add(v)
                    q.append(v)
        largest = max(largest, size)

    return {
        "nodeCount": len(nodes),
        "clusterNodeCount": sum(1 for n in nodes if n["type"] == "cluster"),
        "junctionCount": sum(1 for n in nodes if n["type"] == "junction"),
        "endpointCount": sum(1 for n in nodes if n["type"] == "endpoint"),
        "edgeCount": len(edges),
        "meanDegree": float(np.mean([degrees[n["id"]] for n in nodes])) if nodes else 0.0,
        "largestComponentRatio": float(largest / len(nodes)) if nodes else 0.0,
        "meanEdgeLength": float(np.mean([e["length"] for e in edges])) if edges else 0.0,
        "totalSkeletonLength": float(sum(e["length"] for e in edges)),
    }


def build_step(args: argparse.Namespace, step: int, meta: dict) -> dict:
    labels = load_labels(step)
    vol = load_log_density(step, meta)

    web_mask = (labels == 2) | (labels == 3)
    node_mask = labels == 3
    web_mask = remove_small_components(web_mask, args.min_web_voxels)
    if args.close:
        web_mask = ndimage.binary_closing(web_mask, structure=STRUCT26, iterations=1)
    skel = skeletonize(web_mask).astype(bool)

    os.makedirs(OUT, exist_ok=True)
    skel.astype(np.uint8).ravel(order="C").tofile(os.path.join(OUT, f"t{step:04d}_skeleton_u8.bin"))

    nodes, owner = component_records(node_mask & web_mask, vol, args.min_node_voxels, "cluster", 0)
    counts = skeleton_neighbor_count(skel)
    nodes, owner = add_topology_nodes(
        skel,
        counts,
        vol,
        owner,
        nodes,
        args.min_junction_voxels,
        args.keep_endpoints,
    )
    edges = trace_edges(skel, owner, labels, vol, args.min_edge_length, args.min_filament_ratio)
    metrics = graph_metrics(nodes, edges)

    graph = {
        "step": step,
        "method": "T-web filament-node skeleton graph",
        "source": "Nyx gas log-density field + Poisson tidal-tensor T-web labels",
        "parameters": {
            "minWebVoxels": args.min_web_voxels,
            "minNodeVoxels": args.min_node_voxels,
            "minJunctionVoxels": args.min_junction_voxels,
            "minEdgeLength": args.min_edge_length,
            "minFilamentRatio": args.min_filament_ratio,
            "closedMask": bool(args.close),
            "keptEndpoints": bool(args.keep_endpoints),
        },
        "nodes": nodes,
        "edges": edges,
        "metrics": metrics,
    }
    with open(os.path.join(OUT, f"t{step:04d}_graph.json"), "w", encoding="utf-8") as f:
        json.dump(graph, f, indent=2)
    return graph


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--step", type=int, default=99, help="Time step to process.")
    p.add_argument("--all", action="store_true", help="Process all available steps.")
    p.add_argument("--min-web-voxels", type=int, default=80)
    p.add_argument("--min-node-voxels", type=int, default=12)
    p.add_argument("--min-junction-voxels", type=int, default=1)
    p.add_argument("--min-edge-length", type=float, default=0.018)
    p.add_argument("--min-filament-ratio", type=float, default=0.20)
    p.add_argument("--close", action="store_true", help="Apply one binary closing pass before skeletonization.")
    p.add_argument("--keep-endpoints", action="store_true", help="Keep skeleton endpoints as graph nodes.")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    meta = load_meta()
    steps = range(int(meta.get("timeSteps", 100))) if args.all else [args.step]
    t0 = time.time()
    summaries = []
    for step in steps:
        graph = build_step(args, step, meta)
        m = graph["metrics"]
        summaries.append({"step": step, **m})
        print(
            f"step {step:04d}: nodes={m['nodeCount']} edges={m['edgeCount']} "
            f"meanDegree={m['meanDegree']:.2f} largest={m['largestComponentRatio']:.2f}"
        )

    with open(os.path.join(OUT, "summary.json"), "w", encoding="utf-8") as f:
        json.dump({
            "method": "T-web filament-node skeleton graph",
            "steps": summaries,
            "generatedSteps": list(steps),
            "elapsedSeconds": time.time() - t0,
        }, f, indent=2)
    print(f"Done in {time.time() - t0:.1f}s -> {OUT}")


if __name__ == "__main__":
    main()
