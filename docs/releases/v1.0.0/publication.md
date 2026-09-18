# v1.0.0 发布记录

**发布日期**: 2026-09-15
**Tag**: v1.0.0
**形态**: 通用分发包首次公开发布

## 发布内容

### 核心产物
- 仓库源码（git）：bridge/mcp（7 个 .mjs，零三方依赖）+ config + launchers + scripts + docs + public-install
- Release 资产（zip，手动上传或 release.yml 自动打包）:
  - `multi-agent-bridge-dist-v1.0.0-public-linux.zip`
  - `multi-agent-bridge-dist-v1.0.0-public-win.zip`

### 版本要点
- 57 个 MCP 协作工具（任务管理 / 共享记忆 / Agent调用 / 文件操作 / 工作流 / 向量记忆）
- 5 个 CLI Agent：claude / codex / opencode / qwen / dsh
- 核心零三方依赖（纯 Node.js stdlib）
- 可选向量记忆层（ONNX + sqlite-vec，模型按需下载）
- 跨平台安装向导（install-win.bat / install.sh）

## 校验

- 源码层：7 个 .mjs 全部经 `process.env.*` 读取密钥，无硬编码
- 文档层：移除所有内部信息（人名、内部域名/端点、本机路径、内部项目代号、内部工具历史、内部代码规范），保留通用架构与使用文档
- 配置层：env.tmpl / .env.example 全部用 `<YOUR_...>` / `sk-xxxx` 占位符
- 安全自检命令（AGENTS.md §7）无命中

## 大文件处理

- `model_quantized.onnx`（118MB）/ `tokenizer.json`（9MB）不入 git
- 改为 `assets-optional/download-vector-assets.{sh,ps1}` 按需下载（默认源 HuggingFace）
- 仓库体积：约 0.7MB（不含向量层）

## 校验方式

```bash
# 解压 zip 或 git clone 后
node scripts/probe-cli.mjs                      # 探测 worker
node scripts/smoke-test.mjs                     # 冒烟测试
node bridge/mcp/shared-context-server.mjs       # 启动桥服务
```

## 后续

- 公网首次发布，接受社区反馈（Issue）
- 后续版本按 `release: vX.X.X` + `docs: record vX.X.X publication` 流程
