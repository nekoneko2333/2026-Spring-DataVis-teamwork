# Nyx Cosmic Explorer

基于 Nyx 宇宙学模拟密度场的三维体可视化项目。前端使用 Vite + Three.js + D3，`preprocess/` 下的 Python 脚本负责数据预处理与统计分析。

## 环境

- Node.js 18+
- Python 3.10+
- 支持 WebGL2 的浏览器

## 目录

```text
src/                   前端源码
src/visualization/     体渲染、传递函数、Shader
src/data/              数据加载与缓存
preprocess/            预处理脚本
public/data/           前端运行数据
Nyx/                   原始模拟数据
```

## 安装

```bash
npm install
pip install -r requirements.txt
```

## 数据准备

项目运行依赖 `public/data/`。

如果只有原始 Nyx 数据，请放到：

```text
Nyx/
  0000.dat
  0001.dat
  ...
```

然后执行：

```bash
python preprocess/explore.py
python preprocess/preprocess.py
python preprocess/morphology.py
python preprocess/tweb.py
python preprocess/mc_export.py
```

当前预处理会生成：

- 标量体数据
- 预计算梯度体
- 预览体及其梯度体

如果 `public/data/` 是旧版本，需要重新运行 `preprocess/preprocess.py`，否则前端会缺少梯度数据。

## 启动

```bash
npm run dev
```

浏览器打开：

```text
http://localhost:5173/
```

## 说明

- 当前体渲染使用预计算梯度体做光照
- `mode 0` 使用自适应步长
- `mode 0` 新增轻量体阴影，用于增强节点厚度和前后遮挡层次
