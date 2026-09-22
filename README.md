<div align="center">

# 多智能体协作系统
## Multi-Agent Bridge

**把多个 Agent CLI 编排成一支可协作的团队 —— 零三方依赖的 MCP Server + 多端可视化面板。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#要求)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](#为什么)
[![MCP](https://img.shields.io/badge/MCP-Server-6e40c9.svg)](#什么是-mcp)
[![Version](https://img.shields.io/badge/version-v1.0.1-informational.svg)](CHANGELOG.md)

*任务 DAG 编排 · 共享记忆 · 消息总线 · 多端面板 · 跨 Agent 协作*

</div>

<p align="center">
  <img src="docs/assets/screenshots/web-panel-dark.png" alt="Web 控制台（暗色主题）" width="90%" style="border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.35);" />
</p>

---

## 这是什么（What）

`multi-agent-bridge` 是一个**多智能体协作系统**，核心是一个纯 Node.js 标准库实现的 MCP Server，它把多个相互独立的 Agent CLI —— **Claude Code、Codex、Qwen、opencode、DSH** —— 接进同一张协作网络。

它们本来各自为政、互不通信。这个系统给它们装上「公共设施」和「可视化指挥中心」：

| 设施 | 解决的问题 |
|------|-----------|
| 🗂️ **任务队列** | 把大目标拆成有依赖关系的任务 DAG，由多个 Agent 认领、接力完成 |
| 🧠 **共享记忆** | KV 存储 + 交接笔记 + 向量语义检索，知识在 Agent 之间真正流动 |
| ✉️ **消息总线** | 持久化收件箱 + 实时唤醒，Agent 之间可以互相发消息、传信号 |
| 🖥️ **多端面板** | Web 控制台 / IDE 侧边栏 / Qoder 插件，三套界面共享同一套组件 |

在它之上，你还能得到：**429 限流自动绕避、多 worker 并行派发、工作流生命周期管理、长任务暂停/续跑**，以及一套让「多个 AI 协作完成一个目标」真正落地的编排原语。

## 为什么（Why）

多 Agent 协作通常意味着「自己写胶水代码」——拼 shell 脚本、粘数据库、手写轮询、手动处理限流。这套系统把所有这些收拢成一个标准化的 MCP Server + 可视化面板：

- **零三方依赖**：只用 Node.js 内置模块（`child_process` / `fs` / `readline` …），`npm install` 拉 0 个包，部署即拷文件。
- **统一协议**：所有 Agent 通过同一套 MCP 工具交流，而不是 N 套私有格式。
- **可观测**：任务状态、心跳、统计、面板一览无余，协作不再是一团黑箱。
- **抗压**：限流（429）、超时、假成功、进程卡死，这些「长任务现实问题」都被内置机制兜住。
- **多端一致**：Web 面板、DSH 侧边栏、Qoder 插件共享同一套 React 组件库，体验统一。

---

## 多端面板生态

<div style="display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap;">

### 🖥️ Web 控制台（React 版）

三栏布局的完整协作控制台，适合桌面端全局监控和深度操作。

- **左栏**：任务列表（进行中 / 已完成 / 待开始 / 已归档 分段式分区）
- **中栏**：任务依赖 DAG 图 + 任务详情面板 + 派发新任务按钮
- **右栏**：工作流列表（卡片式，进度条 + Agent 标签）
- 六套主题：暗夜 / 白昼 / 护眼绿 / 海洋蓝 / 日落橙 / 典雅紫
- 实时 SSE 推送 + 轮询兜底

### 📋 DSH Panel（IDE 侧边栏）

嵌入 DSH 编辑器的侧边栏面板，紧凑高效，编码时随时查看协作状态。

<p align="center">
  <img src="docs/assets/screenshots/dsh-panel-dark.jpg" alt="DSH Panel（侧边栏面板）" width="280" style="border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,.15);" />
</p>

- StickyHeader 连接状态 + 全局统计
- 工作流卡片（分段进度条 + 任务展开 + DAG 内联查看）
- 归档 / 历史可折叠分区
- FAB 悬浮按钮 + 派发任务面板
- 与 Web 面板共享 `bridge-ui` 组件库，体验一致

### 🔌 Qoder Panel（Qoder CN 插件）

Qoder 国产 IDE 的面板插件，适配国内开发环境。

- 基于 `bridge-ui` 内联样式系统，绕过 webview CSP 限制
- 同样支持全部协作功能和六套主题

</div>

---

## 核心特性（Highlights）

### 🗂️ 任务队列 + DAG 依赖编排
- 任务带 `deliverable`（产物路径）与 `acceptance_criteria`（验收标准），下游 Agent 不用猜「做到哪算完」。
- 支持 **依赖图（dependency DAG）**：任务在全部前置终结前不可被认领。
- 完整的生命周期原语：`claim / complete / fail / supersede / reassign / fork / depend`。
- **自带演进能力**：失败自动换备选 Agent（`fork`）、遗漏前置反向插入（`insert`）、已完成段打回重做（`rollback`）、条件分支（`branch`），且全部受服务端护栏约束（演进次数上限 + 独立审闸）。

### ⚡ 多 worker 并行派发 + 备路改派
- 一个目标可并行派给 ≥2 个视角，产出后经**结果仲裁**（多数一致优先 → 专家加权 → LLM 仲裁者兜底）收敛出最优解。
- `agent_invoke` 支持**忙时自动改派**到空闲备路 worker，主控永不空转、也不被长任务压垮。
- 竞争式 / 合作式 / 动态路由三种协作范式一键起。

### 🔁 429 限流自动规避 + 模型轮换 + 指数退避重试
- 遇到限流 / 超时自动按 `Retry-After` 指数退避重试（默认 2 次、共 3 次尝试）。
- **模型轮换池**：单模型持续 429 时自动切换到备用模型（每个 Agent 内置 fallback 列表），绕过单点限流瓶颈。
- **假成功检测**：识别「exit 0 但正文实为上游 5xx」的静默失败，走重试而非误判成功。

### 🧠 跨 Agent 共享记忆（KV + 笔记 + 向量语义检索）
- **KV 存储**（`shared_memory_*`）：跨进程共享键值，与独立插件 `shared-memory` 共用同一份存储，简单直接。
- **交接笔记**（`shared_notes_*`）：append-only 带时间戳与 tag，天然适合 `handoff:<id>`。
- **向量语义检索**（`memory_*`）：ONNX + sqlite-vec，`memory_search` 按「意思」而非「关键词」跨 Agent 召回；记忆可沉淀（`task_sediment`）、可提级（`memory_promote`）。模型按需下载，不进 git。

### ✉️ 消息总线（持久化收件箱 + 实时唤醒）
- 消息持久化落盘，FIFO + 60s 租约防并发双处理。
- **实时唤醒**：接收端 `inbox_wait` 挂起时，发送端发消息即被**即时唤醒**，不靠轮询。
- 支持 `topic` 分组、`priority` 分级、`memory` 自动沉淀、`to="*"` 广播。

### 🎨 六套主题 + 统一组件库

<p align="center">
  <img src="docs/assets/screenshots/theme-showcase.jpg" alt="六套主题展示" width="85%" style="border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.2);" />
</p>

- **bridge-ui**：共享 React 组件库，DSH Panel / Qoder Panel / Web Panel 三端复用
- 六套主题：暗夜 Dark / 白昼 Light / 护眼绿 Eye Care / 海洋蓝 Ocean / 日落橙 Sunset / 典雅紫 Elegant
- CSS 变量驱动，一键切换，带 anti-flash 防闪烁

### 🔌 可扩展 Agent Registry（即插即用新 CLI）
- **开箱即用 7 个 Agent**：Claude Code、Codex、Qwen、opencode、DSH、Qoder、Qoder CN，均已内置描述子，零配置自动识别。
- **`agent_scan` 一键探测**：扫描本机已安装的所有 Agent CLI，自动检测可用性、写入注册表；缺失项给出安装引导链接。
- **统一抽象层**：所有 Worker 通过统一的 `run_<agent>` / `agent_invoke` 接口调用，上层编排不关心底层是哪个 CLI。
- **轻松接入新 Agent**：新增一个 CLI 只需在 `agents-registry.mjs` 中加一个描述子（启动命令、环境变量映射、限流策略、能力标签），无需改业务代码。
- **能力标签 + 自动选型**：每个 Agent 带 `capabilities` 标签和 `strengths` 描述，`agent_list` 供主控按需选型，`agent_eval` 出质量/时长/满意度量化指标。
- **自动注册共享记忆**：新接入的 Agent 自动获得任务队列、共享记忆、消息总线全部能力，无需逐个对接。

### ⏱️ 长任务管理（中断 / 续跑 / 状态机）
- `task_interrupt`：人工叫停卡死/跑偏的任务（Windows `taskkill /T /F`，Unix `SIGTERM→SIGKILL`），保留部分输出与 `session_id`。
- `task_resume`：复用 `session_id` 真·续跑（保留上下文），中断/失败/替代态均可恢复。
- 任务状态机完备：`pending → running → interrupted / escalating / awaiting_approval / completed / failed / superseded`。

---

## 快速开始（3 步）

> 要求：Node.js ≥ 18，已安装至少一个 Agent CLI（建议从 Claude Code 开始作主控）。

### 第 1 步：克隆仓库

```bash
git clone https://github.com/songzhifei512/multi-agent-bridge.git
cd multi-agent-bridge
```

### 第 2 步：配置环境变量

复制模板并按注释填入你的端点与密钥（所有 `<占位>` 都是示例，替换成你自己的值）：

```bash
cp config/env.tmpl .env        # 或手动抄到 ~/.agents/.env
```

`.env` 核心项（端点一律用占位符示意，实填你的供应商）：

```bash
# 主控（必填）
ANTHROPIC_BASE_URL=<PROVIDER_ANTHROPIC_BASE_URL>
ANTHROPIC_AUTH_TOKEN=<YOUR_ANTHROPIC_API_KEY>
BRIDGE_CONTROLLER=claude

# 可选 worker：OpenAI / Qwen / DSH / opencode（按需开启）
# OPENAI_BASE_URL=<PROVIDER_OPENAI_BASE_URL>
# OPENAI_API_KEY=<YOUR_OPENAI_API_KEY>
# QWEN_BASE_URL=<PROVIDER_QWEN_BASE_URL>
# QWEN_API_KEY=<YOUR_QWEN_API_KEY>
# DSH_BASE_URL=<PROVIDER_DSH_BASE_URL>
# DSH_API_KEY=<YOUR_DSH_API_KEY>
```

> 完整说明见 [`public-install/ENV_SETUP.md`](public-install/ENV_SETUP.md)，配置示例见 [`public-install/agents-config-example/.env.example`](public-install/agents-config-example/.env.example)。

### 第 3 步：挂载到 MCP 客户端

把桥接器注册为你的 Agent CLI 的 MCP Server（模板：`config/claude-mcp-config.json.tmpl` / `config/codex-mcp-config.toml.tmpl`）。

以 Claude Code 为例，在配置中加入：

```json
{
  "mcpServers": {
    "multi-agent-bridge": {
      "command": "node",
      "args": ["E:/path/to/multi-agent-bridge/bridge/mcp/shared-context-server.mjs"],
      "env": {
        "BRIDGE_WORK_ROOT": "E:/your/project"
      }
    }
  }
}
```

> 安装向导也已备好（自动替换路径占位并写入配置）：
> ```bash
> bash launchers/install.sh      # Windows 用 launchers/install-win.bat
> ```

挂载后，主控 Agent 就能通过工具看到并调用整套协作能力了。

---

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    你 / 主控 Agent (Claude Code)                 │
│                    以 MCP 协议调用协作工具                         │
└──────────────────────────────┬──────────────────────────────────┘
                               │ stdio (MCP)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│          shared-context-server.mjs  (MCP Server)                 │
│      纯 Node.js 标准库 · 零三方依赖 · 59 个协作工具                │
├───────────────────┬─────────────────┬───────────────────────────┤
│   🗂️ 任务队列       │   🧠 共享记忆     │      ✉️ 消息总线             │
│   (DAG 编排)      │  KV/笔记/向量    │   (收件箱 + 实时唤醒)        │
├───────────────────┴─────────────────┴───────────────────────────┤
│              Worker 派发层（Agent Registry / agent_scan）         │
└───────┬───────────┬───────────┬───────────┬───────────┬───────────┬───────────┐
        ▼           ▼           ▼           ▼           ▼           ▼           ▼
   Claude Code   Codex       Qwen      opencode      DSH        Qoder      Qoder CN
   推理/架构    批量代码    文档/PPT    备路/并发    多后端执行  全栈编程   国内通义
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
          ┌─────────────────┐   ┌─────────────────┐
          │   🌐 Web 面板    │   │  📋 DSH 侧边栏   │
          │  (React/Vite)   │   │  (DSH Plugin)   │
          └─────────────────┘   └─────────────────┘
                    │                     │
                    └──────────┬──────────┘
                               ▼
                   ┌──────────────────────┐
                   │  bridge-ui 组件库      │
                   │  (12+ 共享组件)        │
                   │  · 6 套主题            │
                   │  · 双样式系统           │
                   └──────────────────────┘
```

---

## 工具全览（59 个工具 · 5 大类）

### 🗂️ 任务编排
| 工具 | 用途 |
|------|------|
| `task_create` / `task_list` | 创建 / 查询任务（支持状态/搜索/排序/分页/批量操作） |
| `task_claim` / `task_complete` / `task_fail` | 认领 / 完成 / 失败生命周期 |
| `task_supersede` / `task_reassign` | 标记被替代 / 解锁退回待认领（安全交接） |
| `task_approve` | 人工验收门（`require_approval` 任务完成后阻塞下游，待放行） |
| `task_interrupt` / `task_resume` | 中断长任务 / 复用 session 续跑 |
| `task_fork` / `task_depend` | 分叉子任务 / 动态重算依赖 |
| `task_escalate` / `task_decide` / `task_heartbeat` | 决策上浮 / 决策下放 / 里程碑心跳 |
| `task_sediment` | 完成任务自动沉淀为可检索知识点 |

### 🧠 共享记忆
| 工具 | 用途 |
|------|------|
| `shared_memory_set` / `get` / `list` | 跨进程共享 KV 存储（与 `shared-memory` 插件共用） |
| `shared_notes_append` / `read` | append-only 交接笔记（带 tag） |
| `memory_add` / `memory_search` | 写入 / 向量语义检索记忆 |
| `memory_list` / `memory_delete` / `memory_stats` | 记忆库管理 |
| `memory_promote` | 把项目级记忆提级为平台/全局 |

### ✉️ 消息总线
| 工具 | 用途 |
|------|------|
| `bus_send` / `agent_send_message` | 发消息（含广播 `to="*"`、自动沉淀向量记忆） |
| `inbox_read` / `inbox_wait` | 同步读 / 实时唤醒读（事件驱动，不阻塞服务器） |
| `inbox_ack` | 确认消费（释放 60s 租约） |
| `bus_history` | 信号/消息流只读回放 |

### 🤖 Worker 管理
| 工具 | 用途 |
|------|------|
| `run_claude` / `run_codex` / `run_qwen` / `run_dsh` / `run_qoder` / `run_qoder_cn` | 异步调用各 CLI Agent（自动限流重试 + 模型轮换） |
| `agent_list` / `agent_invoke` | 列出注册 Agent / 按名派发（忙时备路改派到空闲 worker） |
| `agent_scan` | 探测本机已安装的 7 个 worker CLI 并挂载可用性标记 |
| `agent_eval` | 按 Agent 聚合完成率/质量分/时长/重试/满意度（5 维评估） |
| `run_verify` | LLM-as-judge 质量门禁（按标准打分 0–100，支持降级放行） |
| `workflow_plan` / `workflow_start` / `workflow_evolve` | 编排：自动拆解 / 落 DAG / 自适应重规划 |
| `result_arbitrate` | 多 worker 冲突结果自动仲裁（多数一致 → 专家加权 → LLM 兜底） |

### 👁️ 可观测性
| 工具 | 用途 |
|------|------|
| `bridge_stats` | 运行时可观测（按 Agent 聚合调用/成败/重试/耗时） |
| `bridge_checkpoint` | 状态快照：存 / 列 / 恢复（审计与回滚） |
| `file_lock_acquire` / `release` / `list` | 跨进程文件锁（防两 Agent 同修一文件） |
| `project_search` / `read_file` / `list_dir` | 共享只读文件访问 |
| `safe_scan` | 产物安全硬拦（自动审批前把关） |
| `vision_analyze` | 图像理解（场景/文字识别，非条码解码） |
| `dsh_read` | 只读读取 DSH 历史会话 |

---

## 项目结构

```
multi-agent-bridge/
├── bridge/
│   └── mcp/                        # 核心 MCP Server（纯 Node stdlib）
│       ├── shared-context-server.mjs   # 主服务入口（59 个工具）
│       ├── bridge-web-panel.mjs        # Web 面板 HTTP 服务
│       ├── run-driver.mjs              # Worker 派发与执行引擎
│       ├── state-store.mjs             # 状态持久化
│       ├── vec_memory.mjs              # 向量记忆层（可选）
│       ├── agents-registry.mjs         # Agent 注册表
│       └── ...
├── bridge-ui/                      # 共享 React 组件库
│   ├── src/
│   │   ├── components/              # StickyHeader / WorkflowCard / TaskRow 等
│   │   ├── hooks/                   # useBridgeState / useTheme / useOfflineState
│   │   ├── styles.ts                # CSS 样式（class 模式）
│   │   ├── inlineStyles.ts          # 内联样式（CSP 兼容模式）
│   │   └── index.ts
│   └── preview/                     # 组件预览与截图
├── bridge-web/                     # Web 控制台（React + Vite）
│   ├── src/
│   │   ├── components/              # LeftColumn / MiddleColumn / RightColumn
│   │   ├── App.tsx
│   │   └── main.tsx
│   └── dist/index.html              # 单文件构建产物
├── dsh-panel/                      # DSH 侧边栏插件
│   └── src/client/index.tsx
├── qoder-panel/                    # Qoder CN 插件
│   └── src/browser/BridgeConsole.tsx
├── config/                         # 配置模板
├── launchers/                      # 安装/启动脚本
├── scripts/                        # 测试与探测脚本
├── public-install/                 # 公开安装文档
├── docs/                           # 文档与发布说明
│   ├── guides/                     # 指南文档
│   │   ├── troubleshooting.md      # 故障排查手册（主手册，13 章全范围覆盖）
│   │   └── dsh-integration-guide.md  # DSH 安装与接入指南
│   ├── cookbook/                   # 经验食谱
│   │   └── exception-handling.md   # 异常处理 Cookbook（设计原则与工程经验）
│   └── releases/                   # 版本发布说明
├── skills/                         # MCP Skill 定义
├── README.md
├── README_EN.md
├── CHANGELOG.md
├── AGENTS.md
└── package.json
```

---

## 什么是 MCP

Model Context Protocol（MCP）是 Anthropic 提出的开放协议，让 AI 助手能以标准方式连接外部数据源和工具。本项目以 MCP Server 形态存在，任何支持 MCP 的 Agent CLI 都可以直接挂载使用。

> 更多信息：[Model Context Protocol 官方文档](https://modelcontextprotocol.io/)

---

## 文档资源

| 类别 | 文档 | 说明 |
|------|------|------|
| 🚀 快速开始 | [public-install/](public-install/) | 公网安装与环境配置指引 |
| 🐛 故障排查 | [故障排查手册](docs/guides/troubleshooting.md) | 13 章全范围覆盖：环境/连接/派发/执行/上报/面板/数据/并发/Windows |
| 📋 派发排障 | 已并入故障排查手册第 5-6 章 | 派发链路逐级定位 + 各主控特有问题 |
| 🔧 部署接入 | [DSH 安装与接入指南](docs/guides/dsh-integration-guide.md) | DSH CLI 安装、MCP Server 接入、dsh-panel 侧边栏安装完整流程 |
| 🧑‍🍳 经验食谱 | [异常处理 Cookbook](docs/cookbook/exception-handling.md) | 跨项目普适的多 Agent 协作工程经验与设计原则 |
| 📝 版本变更 | [CHANGELOG.md](CHANGELOG.md) | 各版本功能变更记录 |
| 🤝 协作规范 | [AGENTS.md](AGENTS.md) | AI 协作者仓库契约与提交规范 |

---

## 许可证

[MIT](LICENSE) © multi-agent-bridge contributors
