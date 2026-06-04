# Nyx Cosmic Explorer

基于 Nyx 宇宙学模拟气体密度场的交互式三维体数据可视分析系统。前端使用 Vite、Three.js 和 D3，Python 脚本负责原始数据预处理、统计分析和报告图生成。

## 项目说明

本仓库只提交源码、配置、文档和预处理脚本。以下目录体积较大或可生成，已被 `.gitignore` 排除，不会随 GitHub 仓库一起下载：

- `Nyx/`：原始模拟数据，约 100 个 `*.dat` 文件。
- `public/data/`：前端运行需要的预处理数据，约 860 MB。
- `outputs/`：报告图片、截图和分析输出。
- `node_modules/`、`dist/`：依赖和构建产物。

因此，其他人 clone 仓库后需要先准备数据，再启动前端。

## 环境要求

- Node.js 18+
- Python 3.10+
- 现代浏览器，建议 Chrome 或 Edge，并支持 WebGL2

## 从 GitHub 拉取后运行

```bash
git clone https://github.com/nekoneko2333/2026-Spring-DataVis-teamwork.git
cd 2026-Spring-DataVis-teamwork
```

安装前端依赖：

```bash
npm install
```

安装 Python 依赖：

```bash
pip install -r requirements.txt
```

## 准备数据

项目运行需要 `public/data/`。有两种方式准备。

方式一：直接复制已经生成好的数据

如果团队成员已经提供了完整的 `public/data/`，把它放到项目根目录下：

```text
2026-Spring-DataVis-teamwork/
  public/
    data/
      metadata.json
      stats.json
      histograms.json
      powerspectrum.json
      morphology.json
      preview_u8.bin
      volumes/
      labels/
      labels_tweb/
      meshes/
```

方式二：从原始 Nyx 数据重新生成

把原始数据放到项目根目录的 `Nyx/` 文件夹中：

```text
2026-Spring-DataVis-teamwork/
  Nyx/
    0000.dat
    0001.dat
    ...
    0099.dat
```

然后按顺序运行预处理脚本：

```bash
python preprocess/explore.py
python preprocess/preprocess.py
python preprocess/morphology.py
python preprocess/tweb.py
python preprocess/mc_export.py
```

可选：生成报告分析图和截图输出：

```bash
python preprocess/density_check.py
python preprocess/figures.py
python preprocess/figures_rich.py
```

## 启动开发服务器

确认 `public/data/` 已存在后运行：

```bash
npm run dev
```

浏览器打开：

```text
http://localhost:5173/
```

## 构建生产版本

```bash
npm run build
```

构建结果会生成到 `dist/`。本地预览：

```bash
npm run preview
```

## 项目结构

```text
src/                 前端源码
src/visualization/   Three.js 体渲染、传递函数和 shader
src/charts/          D3 图表组件
src/data/            数据加载和缓存逻辑
preprocess/          Python 数据预处理和统计脚本
scripts/             Playwright 截图验证脚本
public/data/         预处理后的前端数据，不提交到 Git
Nyx/                 原始模拟数据，不提交到 Git
outputs/             分析图和截图输出，不提交到 Git
```

## 常见问题

如果页面打开后没有数据或控制台出现 `404`，通常是因为缺少 `public/data/`。请先复制团队提供的数据，或者使用 `Nyx/` 原始数据运行预处理脚本。

如果 `npm install` 失败，先确认 Node.js 版本是否为 18 或更高。

如果 Python 脚本找不到数据，确认原始文件路径为 `Nyx/0000.dat` 到 `Nyx/0099.dat`，并且命令是在项目根目录执行。
