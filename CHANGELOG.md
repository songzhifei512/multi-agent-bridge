# Changelog

本文件记录 multi-agent-bridge 的版本变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-09-15

### Added
- 通用分发包首次公开发布
- 核心 MCP Server（57 个协作工具），纯 Node.js 标准库，零三方依赖
- 支持 5 个 CLI Agent：claude / codex / opencode / qwen / dsh
- 可选向量记忆层（ONNX + sqlite-vec），embedding 模型按需下载
- 跨平台安装向导（install-win.bat / install.sh）与探测/压测脚本
- 双语 README（中文 / English）
- CI（ci.yml 三平台冒烟 + release.yml tag 触发打包）
- AGENTS.md AI 协作指南
- 配置模板（env.tmpl / claude-mcp-config.json.tmpl / codex-mcp-config.toml.tmpl）与 .env.example

### Changed
- 目录结构扁平化（消除原 multi-agent-bridge-dist/ 嵌套，bridge/config/launchers/scripts/docs 提升至仓库根）
- 向量层 embedding 模型不再随包内置（原 118MB onnx + 9MB tokenizer），改为按需下载（assets-optional/download-vector-assets.{sh,ps1}）
- 文档保留通用架构与使用文档

### Removed
- 大文件分发物（model_quantized.onnx / tokenizer.json，改走 GitHub Release 资产或按需下载）
