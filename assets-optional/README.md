# assets-optional — 可选向量记忆层（默认不引入原生二进制）

## 这是什么

`multi-agent-bridge-dist` 的**核心是零三方依赖纯 JS**（只用 `node:` 内建 + 交叉 import），
因此能开机即跑。**向量记忆层**（语义检索 `memory_search` / `task_sediment` 的嵌入式索引）
依赖两个**可选原生**依赖，本分发包**默认不携带**（避免体积与平台碎片）：

| 包 | 作用 | 缺省影响 |
|---|---|---|
| `onnxruntime-node` | 文本 embedding 推理 | 无语义检索，走纯文本兜底 |
| sqlite-vec 原生 `vec0.dll/.so` | 向量索引存储 | 同上 |

> 「纯文本兜底」= 记忆按关键词/标签精确匹配，核心任务队列、协作、派发均不受影响，功能完整可用。

## 按需下载（减小仓库体积）

embedding 模型（`model-multilingual/`，约 120MB）**不随仓库内置**，需要向量记忆层时按需下载：
- `model_quantized.onnx`（118MB，MiniLM-L12-v2 多语言，384 维）
- `tokenizer.json` · `config.json` · `tokenizer_config.json`

```bash
# Linux/macOS
bash assets-optional/download-vector-assets.sh
# Windows
powershell -ExecutionPolicy Bypass -File assets-optional\download-vector-assets.ps1
```

> 默认从 HuggingFace 公开源拉取；可用 `VECTOR_MODEL_URL` 环境变量覆盖为私有镜像源。

下载后，安装向导（`launchers/install-*.bat/sh`）会在探测向量层前，把模型自动复制到用户级
`~/.agents/vector/model-multilingual/`（即 `vec_memory.mjs` 的默认 `VECTOR_DIR` 命中路径），
**无需手动配 `VECTOR_MODEL`/`VECTOR_TOK`**。

> 若你的模型放在别处，可用环境变量覆盖：
> `VECTOR_MODEL=/path/model_quantized.onnx` `VECTOR_TOK=/path/tokenizer.json` `VECTOR_DIR=/path/vec`

## 判断是否已具备

```bash
node scripts/probe-vector.mjs
```

- `vectorLayerReady: true` → 已可用，跳过本目录；
- `false` → 需补齐，见下。

## 补齐（按需，两种形态）

### 形态 A：npm 拉取（推荐，公共源）
```bash
cd assets-optional
npm install onnxruntime-node         # embedding 推理
npm install sqlite-vec    # sqlite-vec 的 JS 封装（或已有系统 vec0 库）
```
私有/受限环境可自配镜像源（如 `npm config set registry <MIRROR>`）安装同款依赖后即可。

### 形态 B：复用已有向量库（不重复装）
如果目标机**已装向量记忆运行时**（其 `~/.agents/vector/vec.db` 与 `vec0.dll/.so` 就在），
本包**自动复用**，不会重复建库——`probe-vector.mjs` 检测到既有 `vec0` 即视为就绪，无需额外安装。

## 安装后校验

```bash
node scripts/probe-vector.mjs --json   # vectorLayerReady 应变 true
```

版本清单见 `vector-deps.json`。平台差异：
- **win32**：npm 装的 `onnxruntime-node` 自带预编译，`vec0.dll` 默认。
- **linux**：特定 glibc 环境需在 config 加 `LD_PRELOAD=<LIBRT_PATH>`（见 `config/env.tmpl`）。