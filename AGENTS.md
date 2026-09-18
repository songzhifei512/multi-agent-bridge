# AGENTS.md — multi-agent-bridge 仓库协作指南

> 本文件给 AI 协作者（Claude Code / Codex / DSH 等）提供仓库契约，确保改动符合规范。

## 1. 仓库概览

- **形态**：公网分发包，核心 MCP Server 纯 Node.js 标准库（零三方依赖）
- **版本**：v1.0.0；**许可证**：MIT；**默认分支**：main
- **关键约束**：源码不得硬编码任何密钥/凭证/内部端点（见 §3）

## 2. 目录结构

```
bridge/mcp/       # 核心 MCP Server（9 个文件：8 个 .mjs + 1 个 package.json，零依赖）
config/           # 配置模板（env.tmpl / mcp-config.tmpl）
launchers/        # 安装/启动脚本（install-win.bat / install.sh）
scripts/          # 探测/测试脚本（probe-cli / smoke-test / ...）
assets-optional/  # 可选向量层（模型按需下载，不入 git）
docs/             # 文档（cookbook / releases）
public-install/   # 公网安装指引（INSTALL / ENV_SETUP / .env.example）
skills/           # AI 协作技能（multi-agent skill）
.github/          # CI（ci.yml 三平台冒烟）与 Release 工作流
```

## 3. 安全与合规红线

- 所有密钥走环境变量（`process.env.*`）或配置模板占位符（`<YOUR_...>`）
- **禁止提交**：`.env`、`.agents/`、真实本机路径、人名、公司内部域名/端点、内部项目代号
- 改动涉及配置/脚本/docs 时，必须经安全自检（见 §7）再提交
- 大文件（onnx/tokenizer）不入 git，走 `assets-optional/download-vector-assets.{sh,ps1}` 按需下载

## 4. 提交规范

Conventional Commits：`type(scope): subject`（subject ≤ 72 字符，祈使语气）

| type | 用途 | scope |
|------|------|-------|
| `feat` | 新功能 | bridge / config / launcher / script / assets |
| `fix` | 缺陷修复 | 同上 |
| `docs` | 文档变更 | docs |
| `test` | 测试脚本 | script |
| `refactor` | 重构 | bridge |
| `chore` | 脚手架/杂项 | — |
| `ci` | CI 配置 | ci |
| `release` | 版本发布 | — |

- body 写动机/根因/验证；引用 issue 用 `(#NN)`
- 主题行英文优先，中文可

## 5. 分支与 PR

- 分支命名：`feat/xxx` / `fix/xxx` / `docs/xxx`
- 合并方式：**Create a merge commit**（不 squash，保留拓扑）
- main 保护：CI 绿

## 6. 版本与 Release

- tag：`vX.X.X`
- CHANGELOG 按 Keep a Changelog，版本分 Added/Changed/Fixed/Removed
- Release 资产：linux/win 两个 zip（手动上传或 release.yml 自动打包）
- 发布提交：`release: vX.X.X` + `docs: record vX.X.X publication`

## 7. CI 与本地验证

- **CI**（ci.yml）：三平台（ubuntu/windows/macos）`node --check` + smoke-test
- **本地验证**：
  ```bash
  node scripts/smoke-test.mjs       # 冒烟压测
  node scripts/probe-cli.mjs        # 探测 worker
  node bridge/mcp/shared-context-server.mjs  # 启动
  ```
- **安全自检**（改 docs/config 后建议跑）：
  ```bash
  # 检查硬编码密钥/真实 token（占位符 sk-xxxx/sk-ant-< 应排除）
  grep -rE 'sk-ant-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{40,}|AKIA[0-9A-Z]{16}' bridge/ config/ scripts/
  # 检查本机路径（~/<user> 形式应排除）
  grep -rE 'C:\\Users\\[^<]|/home/[a-z]|/(?:data|opt|srv|mnt)/[a-z]' bridge/ config/ launchers/ scripts/ docs/
  # 检查邮箱/手机号
  grep -rE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|1[3-9][0-9]{9}' bridge/ docs/
  # 预期：仅占位符/示例/127.0.0.1，无真实值
  ```

## 8. 常用命令

| 操作 | 命令 |
|------|------|
| 启动桥服务 | `node bridge/mcp/shared-context-server.mjs` |
| 启动面板 | `node bridge/mcp/bridge-web-panel.mjs` |
| 探测 worker | `node scripts/probe-cli.mjs` |
| 冒烟测试 | `node scripts/smoke-test.mjs` |
| 并发压测 | `node scripts/concurrency-test.mjs` |
| 完整压测 | `node scripts/full-test.mjs` |
| 探测向量层 | `node scripts/probe-vector.mjs` |
| 下载向量模型 | `bash assets-optional/download-vector-assets.sh` |
