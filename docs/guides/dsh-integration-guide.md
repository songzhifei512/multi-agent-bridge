# DSH 安装与 multi-agent 接入指南

> **文档版本**：v1.0.1
> **适用版本**：multi-agent-bridge v1.0.1+
> **适用平台**：Windows / macOS / Linux

---

## 目录

1. [概述](#1-概述)
2. [前置条件](#2-前置条件)
3. [DSH CLI 安装](#3-dsh-cli-安装)
4. [multi-agent MCP Server 接入](#4-multi-agent-mcp-server-接入)
5. [dsh-panel 侧边栏安装](#5-dsh-panel-侧边栏安装)
6. [验证安装](#6-验证安装)
7. [常见问题](#7-常见问题)
8. [卸载与重置](#8-卸载与重置)

---

## 1. 概述

DSH（DeepSeek Harness）是 DeepSeek 推出的 AI Agent 执行框架。multi-agent-bridge 支持两种方式与 DSH 集成：

| 集成方式 | 说明 | 适用场景 |
|---------|------|---------|
| **MCP 工具接入** | 在 DSH 中配置 MCP Server，使用 59 个协作工具 | 用 DSH 做主控，调用其他 Agent |
| **dsh-panel 侧边栏** | DSH Desktop 右侧边栏可视化面板 | 在 DSH 桌面端中直观管理协作任务 |

两种方式可独立使用，也可同时启用。

---

## 2. 前置条件

### 2.1 软件要求

| 软件 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | 18+ | 运行 MCP Server |
| npm | 9+ | 安装 CLI 工具 |
| DSH Desktop（可选） | 最新版 | 使用 dsh-panel 侧边栏时需要 |
| DSH CLI（可选） | 最新版 | 将 DSH 作为 Worker 时需要 |

### 2.2 API 密钥

根据需要使用的 Worker 准备对应的 API Key：

| Worker | 密钥 / 配置 | 获取地址 |
|--------|------------|---------|
| Claude Code | `ANTHROPIC_AUTH_TOKEN` | console.anthropic.com |
| Codex | `OPENAI_API_KEY` | platform.openai.com |
| Qwen | `DASHSCOPE_API_KEY` | bailian.console.aliyun.com |
| DSH | 走 ~/.dsh 凭证 | platform.deepseek.com |
| opencode | `OPENAI_API_KEY`（OpenAI 兼容） | 对应端点提供商 |

---

## 3. DSH CLI 安装

> 本节适用于将 DSH 作为 **Worker** 被其他主控派发执行的场景。
> 如果你只是用 DSH 做主控来调用 multi-agent 工具，可跳过本节，直接看 [第 4 章](#4-multi-agent-mcp-server-接入)。

### 3.1 安装方式

#### 方式一：npm 全局安装（推荐）

```bash
npm install -g @deepseek-ai/dsh-cli
```

安装后验证：

```bash
dsh --version
```

#### 方式二：DSH Desktop 自带

DSH Desktop 安装后，通常会附带 CLI。找到 DSH Desktop 的安装路径：

| 平台 | 默认路径 |
|------|---------|
| Windows | `%LOCALAPPDATA%\Programs\deepseek-dsh\` |
| macOS | `/Applications/DeepSeek DSH.app/Contents/` |

CLI 入口通常在：
```
resources/app/lib/desktop-cli.js
```

设置环境变量指向该入口：

```bash
# Windows PowerShell
[Environment]::SetEnvironmentVariable("DSH_BIN", "C:\Users\<用户名>\AppData\Local\Programs\deepseek-dsh\resources\app\lib\desktop-cli.js", "User")
```

### 3.2 配置凭证

首次使用前，需要配置 DSH 的 API 凭证：

```bash
dsh config
```

按提示输入 API Key。配置文件默认保存在 `~/.dsh/` 目录下。

### 3.3 验证 DSH Worker

在 multi-agent 中验证：

调用 `agent_scan` 工具，查看 `dsh` 的 `available` 是否为 `true`。

```
agent_scan()
```

---

## 4. multi-agent MCP Server 接入

> 本节适用于在 **DSH 中使用 multi-agent 的 59 个协作工具**的场景。
> 即：DSH 作为主控，通过 MCP 协议调用 shared-context-server。

### 4.1 获取 multi-agent 代码

```bash
git clone https://github.com/songzhifei512/multi-agent-bridge.git
cd multi-agent-bridge
```

> 核心 MCP Server 为纯 Node.js 标准库实现，零三方依赖，无需 `npm install`。

### 4.2 配置环境变量

复制环境变量模板并填写实际配置：

```bash
# 复制模板
copy config\env.tmpl .env  # Windows
cp config/env.tmpl .env    # macOS / Linux
```

编辑 `.env` 文件，至少填写以下内容：

```env
# 工作区根目录（任务沙箱将创建在此目录下）
BRIDGE_WORK_ROOT=D:\ai-workspace

# Claude（作为 Worker 时需要）
ANTHROPIC_AUTH_TOKEN=sk-ant-...

# Qwen（作为 Worker 时需要；推荐配置，用于文档生成/质量门禁）
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_API_KEY=sk-...

# Web 面板端口（默认 3333）
BRIDGE_PORT=3333
```

> 也可以不使用 `.env` 文件，直接在 DSH 的 MCP 配置中通过 `env` 字段传入。

### 4.3 配置 DSH 的 MCP Server

找到 DSH 的配置文件：

| 平台 | 配置路径 |
|------|---------|
| Windows | `%USERPROFILE%\.dsh\config.json` 或 DSH Desktop 设置中 |
| macOS | `~/.dsh/config.json` |

在配置中添加 MCP Server：

```json
{
  "mcpServers": {
    "shared-context": {
      "command": "node",
      "args": [
        "<仓库绝对路径>/multi-agent/bridge/mcp/shared-context-server.mjs"
      ],
      "env": {
        "BRIDGE_WORK_ROOT": "<工作区根目录>",
        "BRIDGE_PORT": "3333",
        "ANTHROPIC_AUTH_TOKEN": "sk-ant-...",
        "QWEN_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "DASHSCOPE_API_KEY": "sk-..."
      }
    }
  }
}
```

**注意事项**：

1. `args` 中的路径必须是 `shared-context-server.mjs` 的**绝对路径**
2. 路径使用正斜杠 `/`（Node.js 在 Windows 下也支持）
3. `env` 中的环境变量会传递给 MCP Server 子进程
4. 根据实际需要启用的 Worker 填写对应环境变量，不需要的可以不填

### 4.4 重启 DSH

修改配置后，重启 DSH 以使 MCP Server 配置生效。

---

## 5. dsh-panel 侧边栏安装

> dsh-panel 是 DSH Desktop 的右侧边栏插件，提供可视化的任务管理界面。

### 5.1 构建 dsh-panel

进入 dsh-panel 目录并构建：

```bash
cd dsh-panel
npm install
npm run build
```

构建产物输出到 `dist/` 目录：

```
dist/
  ├── index.js          # 后端（Cordis 插件入口）
  ├── client.js         # 前端（侧边栏 UI）
  └── client/
      └── index.js      # 客户端模块
```

### 5.2 安装到 DSH Desktop

#### 方式一：开发模式链接

在 dsh-panel 目录下执行：

```bash
# 建立软链接到 DSH 插件目录
# Windows（管理员 PowerShell）
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.dsh\plugins\dsh-bridge-panel" -Target "<仓库路径>\multi-agent\dsh-panel"
```

#### 方式二：手动复制

将整个 `dsh-panel` 目录复制到 DSH 插件目录：

| 平台 | 插件目录 |
|------|---------|
| Windows | `%USERPROFILE%\.dsh\plugins\` |
| macOS | `~/.dsh/plugins/` |

复制后的目录结构：

```
.dsh/
  └── plugins/
      └── dsh-bridge-panel/
          ├── package.json
          ├── cordis.patch.yml
          └── dist/
              ├── index.js
              └── client.js
```

### 5.3 验证安装

重启 DSH Desktop，查看右侧边栏是否出现「Bridge」面板。

面板正常显示即安装成功。如果面板为空或报错，参见 [第 7 章常见问题](#7-常见问题)。

---

## 6. 验证安装

完成以上步骤后，按以下顺序验证安装是否正确。

### 6.1 验证 MCP 工具可用性

在 DSH 中调用 MCP 工具：

```
shared-context.agent_scan()
```

**预期结果**：返回所有已注册 Worker 的可用性状态，至少能看到工具列表。

### 6.2 验证 Worker 可用性

调用 `agent_list` 查看可用的 Worker：

```
shared-context.agent_list()
```

**预期结果**：列出所有注册的 Worker 及其能力标签。

### 6.3 验证任务派发

创建一个简单任务并执行：

```
shared-context.task_create({ title: "测试任务", description: "输出 hello world" })
```

记下返回的 task_id，然后用一个可用的 Worker 执行：

```
shared-context.run_claude({ task_id: "<task_id>", prompt: "输出 hello world" })
```

**预期结果**：任务状态变为 `running`，完成后变为 `completed`，`result` 字段包含输出内容。

### 6.4 验证 Web 面板

在浏览器中打开：

```
http://localhost:3333
```

**预期结果**：Web 控制台正常显示，能看到任务列表和状态。

### 6.5 验证 dsh-panel

在 DSH Desktop 右侧边栏中：

1. 查看 Bridge 面板是否显示
2. 确认连接状态为「已连接」
3. 尝试创建一个任务，确认面板能正常显示

---

## 7. 常见问题

### 7.1 MCP Server 连不上

**现象**：DSH 中调用 shared-context 工具报错，或工具列表为空。

**排查步骤**：

1. **手动启动看报错**：
   ```bash
   node <仓库绝对路径>/multi-agent/bridge/mcp/shared-context-server.mjs
   ```
   如果启动就报错，根据错误信息定位。

2. **检查配置路径**：确认 `args` 中的路径是绝对路径且指向正确的文件。

3. **检查 node 可用性**：
   ```bash
   node --version
   ```

4. **查看 DSH 日志**：DSH 的 MCP 连接日志通常在其日志目录中。

---

### 7.2 dsh-panel 侧边栏不显示

**现象**：DSH Desktop 右侧边栏没有 Bridge 面板。

**排查步骤**：

1. **确认插件目录正确**：插件是否在 `~/.dsh/plugins/` 目录下。

2. **确认构建产物存在**：`dist/index.js` 和 `dist/client.js` 是否存在。

3. **检查 package.json**：确认 `dsh` 字段配置正确。

4. **查看 DSH 插件加载日志**：DSH 启动日志中是否有插件加载失败的信息。

5. **重启 DSH Desktop**：插件安装后需重启才能生效。

---

### 7.3 面板显示「未连接」

**现象**：dsh-panel 显示连接状态为「未连接」或「离线」。

**原因**：面板前端无法连接到 Bridge Web Server。

**排查**：

1. 确认 MCP Server 已启动（Web Server 随 MCP Server 一同启动）
2. 确认端口配置一致（默认 3333）
3. 浏览器访问 `http://localhost:3333` 是否能打开 Web 面板
4. 检查防火墙是否阻止了本地端口访问

---

### 7.4 DSH 作为 Worker 时找不到命令

**现象**：`run_dsh` 报 `spawn dsh ENOENT`。

**排查**：

1. 终端执行 `dsh --version` 确认 CLI 可用
2. 如果不可用，设置 `DSH_BIN` 环境变量指向 DSH 入口：
   - npm 全局安装的 CLI：`dsh`（PATH 中）
   - DSH Desktop 自带：设为 `desktop-cli.js` 的完整路径
3. 调用 `agent_scan` 确认 `dsh.available` 为 `true`

---

### 7.5 工作区目录权限问题

**现象**：任务执行时报权限错误，或无法写入文件。

**解决**：

1. 确认 `BRIDGE_WORK_ROOT` 指向的目录存在且有写入权限
2. 确认 DSH 的 patch 模式配置正确（`workspace-write+never`）
3. Windows 下检查是否被杀毒软件拦截

---

### 7.6 更多问题

其他派发失败、执行异常、结果上报等问题，参见：
- [主控派发任务流故障排查指南](./master-dispatch-troubleshooting.md)
- [故障排查手册](./troubleshooting.md)

---

## 8. 卸载与重置

### 8.1 卸载 dsh-panel

删除插件目录：

```bash
# Windows
Remove-Item -Recurse "$env:USERPROFILE\.dsh\plugins\dsh-bridge-panel"

# macOS / Linux
rm -rf ~/.dsh/plugins/dsh-bridge-panel
```

重启 DSH Desktop 即可。

### 8.2 移除 MCP 配置

从 DSH 配置文件的 `mcpServers` 中删除 `shared-context` 条目，然后重启 DSH。

### 8.3 清除数据

如需完全清除所有任务数据和记忆：

```bash
# 删除状态数据（默认路径）
rm -rf ~/.agents/state/

# 或找到 BRIDGE_STATE_DIR 配置的目录，删除其中的 memory.json
```

> **注意**：此操作不可逆，所有任务记录和共享记忆将被清除。

---

> 本文档随项目版本同步更新。如发现内容有误或有补充建议，欢迎提交 PR。
