# Nyx 宇宙学气体密度场可视分析系统 — 报告草稿

> 一个基于 Web（Three.js + WebGL2 3D 纹理光线步进 + D3）的交互式三维体数据可视分析系统，
> 面向 Nyx 宇宙学模拟的 100 个时间步、128³ 气体密度场，支持全分辨率实时体渲染、
> 相空间刷选统计-空间双向联动、宇宙网形态学分类与合成莱曼-α 探针。

---

## 1. 数据与读取方式

- **数据**：`Nyx/0000.dat ~ 0099.dat`，共 100 个时间步；单文件 8,388,608 字节 = 2,097,152 个 `float32` = **128×128×128** 体数据。
- **编码**：little-endian `float32`，**列优先**存储（flat index = `z + nz*(y + ny*x)`，z 变化最快）。
- **读取**（已用切片图人工核对轴向，固化在代码中）：

```python
arr = np.fromfile(path, dtype="<f4")            # little-endian float32
vol_zyx = arr.reshape((128, 128, 128), order="F")  # 直接得到 axes (z, y, x)
```

- **轴向验证**：输出 xy / xz / yz 三方向中心切片与三方向 MIP（见 `outputs/explore/axis_check_*.png`），
  三视图结构互相吻合、无错位/转置/镜像，确认 `order="F"` → `(z,y,x)` 正确。

### 数据探查关键结论（实现前第一步）

| 项目 | 结论 |
|---|---|
| 真实范围 | 全局 `min≈7.753`，`max≈14.523`（跨全部 100 步）|
| 0 / 负值 / NaN | **无**（`#(<=0)=0`，无 NaN/Inf）|
| 分布形态 | 单峰、近对数正态、带显著**高密度长尾** |
| 是否取 log | **数值本身已是 log-density**；若再取 log10 会把数据压到 0.89–1.16 过度压缩。故**直接把存储值当作 log 密度**处理，不再取 log |
| 绝对密度 vs 过密度 | 以 ~2× 的线性范围无法解释宇宙网的巨大密度反差；作为 log 密度则对应约 10⁶·⁷ 的密度对比（空洞→节点），与宇宙学结构形成一致。Gini/功率谱等线性量在管线中用 `10^V` 还原 |

> 探查依据：`outputs/explore/exploration_report.txt`、`hist_t*.png`（左图“原始值直方图”即 log 密度分布，呈对数正态+长尾；右图再取 log10 明显过压）。

### 1.1 数据单位与 log 底数的严谨论证（质量守恒检验）

线性空间指标（Gini、功率谱、莱曼-α）依赖于对“底数/单位”的假设。我们不止于假设，而是用**质量守恒**做了定量检验（`preprocess/density_check.py`，图 `outputs/mass_conservation.png`）：

- 设 `V = log10(ρ)`，计算每步的**线性平均密度** `⟨ρ⟩ = ⟨10^V⟩`：结果 `log10⟨ρ⟩ = 9.8285`，**100 步精确不变**（小数点后 4 位一致）——共动坐标下总质量严格守恒，正是物理上应有的行为。
- 该值 `≈ 9.83` 与宇宙平均**共动重子密度** `Ω_b·ρ_crit ≈ 6×10⁹ M⊙/Mpc³`（`log10 ≈ 9.79`）量级吻合，**共同支持“存储值 = log10(共动绝对气体密度, M⊙/Mpc³)”**，底数为 10 而非 e。
- 同时解释了为何 `⟨log10 ρ⟩` 反而**下降**（9.485→9.319）：这是 **Jensen 不等式 / 对数正态效应**——`log10⟨ρ⟩ − ⟨log10 ρ⟩ = (ln10/2)·Var(ln ρ)` 随方差增大而扩大（Jensen 间隙 0.343→0.510），是**结构增长**的体现而非物质丢失。

> 结论：底数=10、绝对共动密度的假设有质量守恒 + 宇宙学量级双重支撑；本系统对 Gini/功率谱/莱曼-α 既给出该假设下的绝对值，也始终强调其**随时间的相对演化**（趋势对底数选择稳健）。

---

## 2. 预处理与数据契约

`preprocess/preprocess.py` 一次性导出前端统一契约（全局归一化，跨时间步颜色可比）：

- `public/data/metadata.json`：`shape=[128,128,128]`，`axisOrder="zyx"`，`timeSteps=100`，
  `valueTransform="stored_is_log_density"`，`globalLogMin=7.753`，`globalLogMax=14.523`，
  直方图边界、全局分位数、功率谱 k 轴等。
- `public/data/stats.json`：每步 `min/max/mean/std/variance/median/skewness/kurtosis/gini/entropy` 与
  分位数（0.1/1/5/25/50/75/95/99/99.9%）。
- `public/data/histograms.json`：每步 log 密度直方图（256 固定全局分箱）——同时构成**演化指纹矩阵**。
- `public/data/powerspectrum.json`：每步径向平均功率谱 `P(k)`。
- `public/data/volumes/t0000_u16.bin … `：全分辨率归一化 **u16** 体数据（前端 3D 纹理；`order="C"` 写出，x 变化最快，匹配 `Data3DTexture(NX,NY,NZ)`）。
- `public/data/preview_u8.bin`：64³ 低分辨率预览（全部时间步拼接），保证播放/拖动 >15fps。
- `public/data/labels/t0000_labels_u8.bin …`：形态学分类标签（见 §6）。
- `public/data/morphology.json`：每步形态学体积占比 + 连通域指标。

**归一化**：`normalized = (V − globalLogMin) / (globalLogMax − globalLogMin)`，u16 量化为 65536 级，
前端反归一化即可得 log 密度；u16 在 6.77 的 log 跨度上分辨率 ≈ 1e-4，无可见分层。

---

## 3. 体渲染与传递函数设计

### 3.1 光线步进（ray marching）

- WebGL2 `sampler3D` + GLSL ES 3.00，单位立方体背面渲染，片元内做**相机射线 ∩ AABB**求进出点后步进。
- **五种模式**（`src/visualization/shaders.js`）：
  1. **体渲染**：前向合成 + 步长不透明度修正；中心差分梯度求法线，做 ambient+diffuse+Blinn-Phong 高光，得到电影级体光照。
  2. **MIP**：最大密度投影，经传递函数着色，凸显整张宇宙网。
  3. **等值面**：阈值首次穿越处用梯度法线着色（开销低、不卡死）。
  4. **Top1% 高亮**：仅累计 `d ≥ 99% 分位`的体素，金→白发光，突出致密节点。
  5. **Void 空洞**：仅累计低密度体素，蓝色薄雾显示空洞拓扑。
  6. **MC 网格**：加载 Marching Cubes 真实三角网格（见创新点 B′），场景光照标准材质渲染。
- 抖动采样（`hash(gl_FragCoord)`）消除木纹状分层；步进数（96–512）可调，播放时自动用低分辨率预览保帧率。

### 3.2 自适应传递函数（`TransferFunction.js`）

- **颜色锚点放在分位数位置**（自适应）：void 深蓝/黑 → 中密度蓝/青 → filament 青/紫 → node 金 → top 白（发光）。
- **不透明度曲线由分位数驱动**：q25 以下近透明（看穿空洞），随密度上升，node 段陡升、top 段接近不透明（发光）。
- 直方图柱子用同一传递函数着色，使**底部直方图与 3D 视图颜色一一呼应**（见主界面截图）。
- 预设：Cosmic / Fire / Ice / Spectral。

---

## 4. 相空间刷选：统计 ↔ 空间双向联动（核心）

- **正向（直方图 → 3D）**：在底部 log 密度直方图中用 D3 `brushX` 框选密度区间 → 归一化区间 `[min,max]`
  作为 uniform 传入着色器；着色器对区间外体素**实时门控**（`gate=0`），3D 视图只显示/高亮匹配体素。
  右侧“选区联动”面板实时显示**选区体素数、占比、均值 logρ、最大 logρ**：当前步全分辨率体数据已缓存时为
  **逐体素精确统计**（与 GPU 过滤所用的连续归一化值完全一致），未加载时回退为 256 桶直方图估计，面板内注明统计口径。
- **快捷刷选阈值说明**：Void/Filament/Node/Top1%/Top0.1% 使用**全局固定分位数阈值**（非每步重算），
  保证跨时间步可比，并直观展示“晚期超过 Top1% 阈值的体素 > 1%”这一**长尾变胖**现象（标称名仅指阈值来源，按钮含悬浮说明）。
- **反向（3D/模式 → 直方图）**：选择 Top1% / Void 模式或快捷刷选按钮时，直方图自动高亮对应密度区间（`setRangeNorm`）；
  **Cosmic Probe 在 3D 中拉出视线后，直方图自动高亮该视线跨越的 [min,max] 密度区段**，实现探针→统计的反向联动。
- **快捷刷选**：Void / Sheet / Filament / Node / Top1% / Top0.1%（区间由全局分位数定义），一键联动。
- 见 `outputs/screens/05_t99_top1.png`（Top1% + 直方图高密度尾高亮）、`07_t99_filament_brush.png`、`report_node_brush.png`。

---

## 5. 密度分布的“两极分化”演化规律（定量）

由 `stats.json` 与图 `outputs/metric_curves.png`、`fingerprint.png`、`histograms_over_time.png`、`power_evolution.png`：

- **长尾抬升**：`max log10ρ` 由 ~13.84（t0）升至 ~14.45（t99）；直方图高密度尾随时间整体抬高。
- **不均匀度上升**：**Gini 0.654 → 0.761** 单调上升（对线性密度 `10^V` 计算，尺度不变），是结构增长最直接的量化指标。
- **方差/熵上升**：`Var(logρ) 0.187→0.249`，Shannon 熵 `6.03→6.24`（分布展宽）；**超额峰度 1.63→1.45 下降**（由集中向双侧展开）。
- **功率谱增长**：`P(k)` 整体抬升、小尺度（大 k）增长更明显，定量证明引力放大涨落、结构由大到小层级生长。
- **连通域**：固定高密度阈值下，连通域**数量 183→142 下降、最大团块体积 11990→14345 上升**（小团块层级合并为大结构）——见 `cluster_evolution.png`。

> 物理图景：早期气体近均匀（窄峰），引力不稳定放大涨落，物质沿丝状网络汇聚到节点，空洞被抽空——
> 即从“均匀”走向“**长尾两极分化**”。本系统用统计曲线 + 指纹图 + 功率谱多视角共同佐证这一规律。

---

## 6. 创新点

### A. 合成莱曼-α 森林光谱（密度驱动 proxy）
在 3D 视图点击拉出一条**视线**（相机射线 ∩ 立方体的弦），沿线采样密度，计算光学深度
`τ = A·∫ ρ^β ds`（小高斯核近似热展宽），透射流量 `F = exp(−τ)`，得到该视线的 1D 吸收谱。
`A、β` 可交互调节。**物理限定**：当前数据仅含气体密度，缺温度/电离态/速度场，
这是**教学/可视分析近似**，非严格 Lyman-α 辐射转移。价值：把三维密度结构与真实天文观测量直接关联。
见 `outputs/screens/12_probe.png`。

### B. 宇宙网形态学分类（两种方法，前端可切换）
1. **density-Hessian 近似**：对平滑（σ=2 体素）log 密度场计算 Hessian，解析求 3 个特征值，按**负特征值个数**分类
   （3→node、2→filament、1→sheet、0→void）。体积占比约 void 52–54% / sheet 41% / filament 4.5% / node 0.1%。
2. **严格 T-web（升级实现）**：过密度 `δ=ρ/⟨ρ⟩−1`，**FFT 解 Poisson 方程** `∇²φ=δ`（`φ_k=−δ_k/k²`），
   求**势场潮汐张量** `T_ij=∂²φ/∂x_i∂x_j` 的 3 个特征值，按 **> λ_th 的个数**分类（参考 Hahn 2007 / Forero-Romero 2009，`λ_th=0.2`）。
   得到更符合文献的 void 主导占比：t0 时 void 59% / sheet 31% / fil 9.4% / node 0.25%，
   **t99 时 void 升至 79%、sheet 降至 15%**——清晰呈现"空洞扩张、墙→丝→节点层级塌缩"。

前端 Cosmic Atlas 面板可一键在 **T-web ↔ density-Hessian** 间切换，形态学占比条同步更新；
两法对比见 `outputs/morphology_compare.png`（密度法偏多 sheet，T-web 更 void 主导，是已知差异）。
**物理限定**：density-Hessian 仅用密度场，为形态学近似；T-web 基于引力势，更严格。
见 `outputs/screens/ext_atlas_tweb_t99.png`、`ext_atlas_proxy_t99.png`、`08_t99_atlas.png`。

### B′. Marching Cubes 真实三角网格（等值面升级实现）
在 ray-march iso 近似之外，用 `skimage.measure.marching_cubes`（`preprocess/mc_export.py`）在与前端 iso 一致的
等值面（logρ≈10.46）抽取**真实三角网格**（每步约 15 万面），导出紧凑二进制（顶点+索引），前端"MC 网格"模式
加载并以**场景光照标准材质**（金色、双面、法线由 `computeVertexNormals` 生成）渲染，时间轴按最近预计算步吸附。
见 `outputs/screens/ext_mc_mesh_t99.png`。

### C. 量化两极分化演化
Gini/偏度/峰度/熵/方差曲线 + 功率谱 `P(k)` 演化 + **演化指纹图**（时间×log密度 2D 热力图，报告核心图）。
> 功率谱说明：基于 `rfftn` 的径向平均，**未做体积/shot-noise 定标、未对 Hermitian 半平面加权**，
> 因此是**非定标的相对 P(k)**，仅用于刻画结构功率随时间的相对演化（本系统的用途），不作绝对功率定标。

### D. Cosmic Probe 宇宙探针（演示型）
同一条视线同时给出 **① 密度剖面曲线** 与 **② 莱曼-α proxy 光谱**：线穿过 node/filament/void 时，
剖面与吸收谱形态明显不同，直观展示“统计 ↔ 空间结构”的对应关系，适合答辩现场演示。

### E. Story Mode 叙事导览
一键播放“早期均匀 → 中期成丝 → 后期节点/空洞分化 → 形态学图谱”四幕，自动联动时间步、刷选区间、渲染模式与说明面板。

### F. 螺旋时间轴（P2 炫技）
左侧时间轴支持 **线性 ↔ 螺旋** 一键切换：100 步沿阿基米德螺旋排布，节点颜色映射 Gini、半径映射高密度占比，
由内向外即“时间向晚 + 结构增长”，见 `outputs/screens/ext_spiral_timeline.png`。

---

## 7. 密度区间 ↔ 空间结构的对应关系

| 密度区间 | 空间结构 | 系统中的体现 |
|---|---|---|
| 高密度长尾（Top1%/Top0.1%） | 宇宙网**节点**（团块） | Top1% 模式金色发光团块；node 刷选；连通域最大团块 |
| 中高密度（75–95%） | **丝状结构** filament | filament 刷选/Cosmic Atlas 青色丝网 |
| 中低密度（25–75%） | **墙/片** sheet | Atlas 蓝色墙面（默认弱显） |
| 低密度（<25% / bottom5%） | **空洞** void | Void 模式蓝色薄雾、空洞拓扑 |

---

## 8. 可视化技术在宇宙学数据分析中的价值

- **全分辨率实时体渲染 + 多模式**：无需降采样即可在浏览器交互探索 128³ 全体素，快速建立三维结构直觉。
- **相空间刷选联动**：把抽象的密度统计（直方图/分位数）与具体空间结构绑定，实现“看见统计量背后的形态”。
- **形态学分类与连通域**：比简单按密度分档更科学地刻画 void/sheet/filament/node 与层级合并。
- **观测量桥接**：莱曼-α proxy 把模拟密度与真实观测（吸收谱）联系起来，体现物理理解。
- **时序定量分析**：指纹图/统计曲线/功率谱共同、定量地刻画结构增长，可作为模拟诊断工具。

---

## 9. 验收清单对照

- [x] 读取任一 `.dat` 打印真实 min/max/mean 及分位数（`explore.py`）。
- [x] 切片图验证 z/y/x 轴向正确（`axis_check_*.png`）。
- [x] 主视图 100 步切换；低分辨率预览保证播放 >15fps，首载异步 + loading 状态，播放预取前后步。
- [x] 体渲染/MIP/等值面三种（实为六种：体渲染/MIP/等值面/Top1%/Void/MC 网格）模式可切换；等值面已用 Marching Cubes 导出真实三角网格。
- [x] 直方图框选 → 3D 实时高亮匹配体素 + 选区统计。
- [x] Top1%/Void 等快捷刷选一键生效。
- [x] 演化指纹图 + 多条统计量随时间曲线。
- [x] P1 完成多项（形态学分类+Atlas、连通域、指纹图、创新仪表盘）；P2/创新点完成多项（莱曼-α proxy、功率谱、Cosmic Probe、Story Mode、螺旋时间轴）。
- [x] 进阶升级：Marching Cubes 真实三角网格；严格 T-web（Poisson 势场潮汐张量）并与密度法可切换对比。
- [x] P2#14：双时间步对比 + 差异图（`dual_step_compare.png`）；高密度丝状结构骨架线提取（`skeleton_3d.png`，skeletonize 3D）。
- [x] 反向联动：Cosmic Probe 视线 → 直方图密度区间高亮（P0#4 反向联动项）。
- [x] 莱曼-α 合成光谱静态图（穿过 node/filament/void 三类视线）。
- [x] `outputs/` 静态图齐全，本报告叙事完整。

## 10. 图表清单（`outputs/`）

| 文件 | 说明 |
|---|---|
| `explore/axis_check_t*.png` | 轴向核对（xy/xz/yz 切片 + 三向 MIP） |
| `explore/hist_t*.png` | 原始值/再取 log10 直方图对比（论证“已是 log”） |
| `slices_comparison.png` | 早/中/后期 MIP 与切片对比 |
| `screens/report_volume_t00/t50/t99.png` | 早/中/后期三维体渲染对比 |
| `fingerprint.png` | 100 步密度演化指纹图 |
| `histograms_over_time.png` | log 密度直方图随时间 |
| `metric_curves.png` | Gini/熵/方差/偏度/峰度/max 随时间曲线 |
| `power_evolution.png` | 功率谱 P(k) 演化 |
| `cluster_evolution.png` | 连通域数量/最大团块体积随时间 |
| `screens/05_t99_top1.png` | Top1% 高密度三维高亮 |
| `screens/06_t99_void.png` | 低密度空洞图 |
| `screens/08_t99_atlas.png` | void/filament/node 标签叠加 |
| `screens/report_node_brush.png` / `07_t99_filament_brush.png` | 刷选高密度/丝状后的三维联动 |
| `screens/12_probe.png` | 莱曼-α proxy 光谱 + 密度剖面 |
| `screens/11_power.png` | 功率谱演化（交互界面） |
| `morphology_compare.png` | density-Hessian vs 严格 T-web 体积占比演化对比 |
| `screens/ext_mc_mesh_t99.png` | Marching Cubes 真实三角网格渲染 |
| `screens/ext_atlas_tweb_t99.png` / `ext_atlas_proxy_t99.png` | T-web / 密度法 Cosmic Atlas 叠加 |
| `screens/ext_spiral_timeline.png` | 螺旋时间轴 |
| `lyman_alpha_lines.png` | 莱曼-α proxy 合成光谱: 穿过 node/filament/void 三类视线 |
| `morph_slices.png` | 密度切片上叠加 T-web vs density-Hessian 形态学分类 |
| `evolution_gallery.png` | 6 时间步 MIP 演化画廊 |
| `skeleton_3d.png` | 高密度丝状结构骨架线提取 (skeletonize 3D) |
| `clusters_3d.png` | 高密度连通域 3D 散点(按团块着色) |
| `void_top_slices.png` | Top1% 节点 + Bottom5% 空洞 切片高亮 |
| `dual_step_compare.png` | 双时间步对比 + 差异图 |
| `mass_conservation.png` | 质量守恒检验: log10⟨ρ⟩ 恒定 ≈ 宇宙重子密度, 论证 log10 绝对密度假设 |
| `evolution_mip.gif` | 100 步密度 MIP 时间演化动图 |
| `flythrough_t99.gif` | t99 沿 z 切片穿越动图 |
