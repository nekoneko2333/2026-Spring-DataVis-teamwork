# Nyx Cosmic Explorer

Nyx Cosmic Explorer 是面向 Nyx 宇宙学模拟密度场的可视分析系统。项目使用 WebGL2 / Three.js / D3 构建交互式前端，围绕 100 个时间步、`128^3` 体素数据展示宇宙密度演化、体渲染、形态分类、统计特征、功率谱、三维结构提取和交互刷选分析。

当前提交版本不包含原始 `Nyx/*.dat` 数据，已保留前端运行所需的中间数据 `public/data/`。

## 目录结构

```text
src/                 前端源码
public/data/         前端运行所需的预处理数据
preprocess/          数据预处理与统计分析代码
outputs/             生成图、截图、poster 素材与最终 poster
outputs/poster/      最终 poster SVG/PNG 及分区素材
docs/                最终答卷 DOCX/PDF
index.html           Vite 入口页面
package.json         前端依赖与启动脚本
```

## 环境要求

- Node.js 18+
- 支持 WebGL2 的浏览器
- Python 3.10+（仅在需要重新预处理数据时使用）

## 安装与运行

```bash
npm install
npm run dev
```

浏览器打开：

```text
http://localhost:5173/
```

生产构建：

```bash
npm run build
```

## 数据说明

前端直接读取 `public/data/` 中的预处理数据，包括：

- 体数据与梯度体
- 预览体数据
- 形态分类标签
- 统计量、直方图、功率谱
- Marching Cubes 网格与连通域相关数据

原始 Nyx 数据目录 `Nyx/` 未随当前版本保留。如果需要完全重新生成中间数据，需要自行准备原始 `0000.dat` 至 `0099.dat`，再运行 `preprocess/` 中的相关脚本。

## 最终成果文件

答卷：

```text
docs/Cherac_answerSheet.docx
docs/Cherac_answerSheet.pdf
```

Poster：

```text
outputs/poster/poster.svg
outputs/poster/poster.png
```

Poster 分区素材也保存在 `outputs/poster/` 中，文件名按 A-G 区域和用途编号。

