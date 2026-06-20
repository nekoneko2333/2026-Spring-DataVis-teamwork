# Story Mode: T-web Skeleton Network Layer

This note records the new Story Mode extension inspired by Coutinho et al.,
*The Network Behind the Cosmic Web* (arXiv:1604.03236).

## Goal

The project already visualizes the Nyx gas-density volume as a continuous 3D
field and classifies it with T-web labels:

- `0`: void
- `1`: sheet
- `2`: filament
- `3`: node

The new layer adds a final Story chapter that turns the visible cosmic web into
a graph and presents it as a separate topology inset, not as a heavy 3D overlay:

```text
density volume -> T-web morphology -> filament/node skeleton -> topology graph
```

This is closer to the paper's network view of the cosmic web than a simple
nearest-neighbor drawing, because graph edges follow the extracted filament
skeleton instead of straight lines between dense points.

## Method

The implementation is in:

```text
preprocess/network_graph.py
```

For each processed step, the script:

1. Loads strict T-web labels from `public/data/labels_tweb/`.
2. Builds the web mask from `filament + node` voxels.
3. Removes tiny disconnected components.
4. Skeletonizes the 3D mask to get a centerline representation.
5. Uses T-web node connected components as physical graph nodes.
6. Adds skeleton junctions, and optionally endpoints, as topology nodes.
7. Traces graph edges along skeleton paths.
8. Stores edge statistics such as length, filament support, density and weight.

The default is step `99`, because late-time structure is visually clearest and
is the most useful for the final Story chapter.

## Run

Run the normal preprocessing first:

```bash
python preprocess/preprocess.py
python preprocess/morphology.py
python preprocess/tweb.py
```

Then generate the Story network:

```bash
python preprocess/network_graph.py
```

Optional commands:

```bash
python preprocess/network_graph.py --step 62
python preprocess/network_graph.py --all
python preprocess/network_graph.py --step 99 --close --keep-endpoints
```

## Output

Default output:

```text
public/data/network/t0099_skeleton_u8.bin
public/data/network/t0099_graph.json
public/data/network/summary.json
```

The graph JSON has this structure:

```json
{
  "step": 99,
  "method": "T-web filament-node skeleton graph",
  "nodes": [
    {
      "id": 0,
      "type": "cluster",
      "center": [0.0, 0.0, 0.0],
      "voxelCount": 120,
      "meanLogDensity": 12.3,
      "maxLogDensity": 14.1,
      "radius": 0.02,
      "degree": 3
    }
  ],
  "edges": [
    {
      "id": 0,
      "source": 0,
      "target": 1,
      "points": [[0.0, 0.0, 0.0], [0.1, 0.0, 0.0]],
      "length": 0.1,
      "filamentRatio": 0.8,
      "meanLogDensity": 10.9,
      "weight": 0.7
    }
  ],
  "metrics": {
    "nodeCount": 20,
    "edgeCount": 34,
    "largestComponentRatio": 0.8,
    "meanDegree": 3.4
  }
}
```

## Frontend Integration

Network data loading was added to:

```text
src/data/DataManager.js
```

Story Mode renders the network as a D3/SVG topology inset in:

```text
src/main.js
src/styles.css
```

A lightweight 3D overlay API exists in `VolumeRenderer`, but the Story chapter now uses the inset because it preserves the readability of the main volume rendering.

The fifth chapter automatically loads:

```text
public/data/network/t0099_graph.json
```

If the file is missing, Story Mode continues without crashing and displays a
caption telling the user to run `python preprocess/network_graph.py`.

## Visual Encoding

The final Story chapter uses a two-layer composition:

- Main viewport: keeps the 3D volume/T-web view as the spatial evidence.
- Network inset: shows a clean 2D topology summary extracted from the 3D graph.

Inset encoding:

- Gold circles: T-web node components, projected by their 3D centers.
- Cyan small circles: skeleton junctions.
- Cyan lines: high-confidence filament skeleton connections.
- Node size: component voxel count.
- Edge opacity: skeleton edge weight.
- Bottom metrics: visible key nodes, visible skeleton edges and largest component ratio.

This separation is deliberate. Directly drawing balls and lines over the 3D volume made the Story frame look like a debugging overlay and obscured the density structures. The inset keeps the network abstraction legible while leaving the main cosmic-web volume visually clean.

## Scientific Limitation

The paper constructs networks from galaxy distributions and compares multiple
galaxy-based linking models. This project uses a gridded gas-density field, not
a galaxy catalog with galaxy positions, sizes and velocities.

Therefore this implementation is an inspired adaptation, not a reproduction of
the paper's exact pipeline. The graph nodes come from T-web high-collapse
regions, and the graph edges follow filament skeleton paths extracted from the
classified volume.

Recommended report wording:

```text
Inspired by Coutinho et al. (2016), we introduce a network abstraction layer
for the cosmic web. Because the Nyx dataset is a gridded gas-density field
rather than a galaxy catalog, we do not directly reproduce their galaxy-based
network construction. Instead, we classify the density field with a T-web
tidal-tensor method, skeletonize filament-node regions, and convert the
skeleton into a graph whose vertices correspond to high-collapse nodes and
topological junctions, while edges follow filamentary skeleton paths.
```
