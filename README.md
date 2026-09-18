<div align="center">

# multi-agent-bridge

**把多个 Agent CLI 桥接成一支可编排的协作团队 —— 一个零三方依赖的 MCP Server。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#要求)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](#为什么)
[![MCP](https://img.shields.io/badge/MCP-Server-6e40c9.svg)](#什么是-mcp)
[![Version](https://img.shields.io/badge/version-v1.0.0-informational.svg)](CHANGELOG.md)

*共享任务队列 · 共享记忆 · 消息总线 · 跨 Agent 编排*

</div>

---

## 这是什么（What）

`multi-agent-bridge` 是一个**纯 Node.js 标准库实现的 MCP Server**，它的职责是把多个相互独立的 Agent CLI —— **Claude Code、Codex、Qwen、opencode、DSH** —— 接进同一张协作网络。

它们本来各自为政、互不通信。这个项目给它们装上三样「公共设施」：

| 设施 | 解决的问题 |
|------|-----------|
| 🗂️ **任务队列** | 把大目标拆成有依赖关系的任务 DAG，由多个 Agent 认领、接力完成 |
| 🧠 **共享记忆** | KV 存储 + 交接笔记 + 向量语义检索，知识在 Agent 之间真正流动 |
| ✉️ **消息总线** | 持久化收件箱 + 实时唤醒，Agent 之间可以互相发消息、传信号 |

在它之上，你还能得到：**429 限流自动绕避、多 worker 并行派发、Web 可视化面板、长任务的暂停/续跑**，以及一套让「多个 AI 协作完成一个目标」真正落地的编排原语。

## 为什么（Why）

多 Agent 协作通常意味着「自己写胶水代码」——拼 shell 脚本、粘数据库、手写轮询、手动处理限流。这套桥接器把所有这些收拢成一个标准化的 MCP Server：

- **零三方依赖**：只用 Node.js 内置模块（`child_process` / `fs` / `readline` …），`npm install` 拉 0 个包，部署即拷文件。
- **统一协议**：所有 Agent 通过同一套 MCP 工具交流，而不是 N 套私有格式。
- **可观测**：任务状态、心跳、统计、面板一览无余，协作不再是一团黑箱。
- **抗压**：限流（429）、超时、假成功、进程卡死，这些「长任务现实问题」都被内置机制兜住。

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

### 🔁 429 限流自动规避 + 指数退避重试
- 遇到限流 / 超时自动按 `Retry-After` 指数退避重试（默认 2 次、共 3 次尝试）。
- 支持**模型轮换**：单模型持续 429 时切换到备用模型/上游，绕过单点瓶颈。
- **假成功检测**：识别「exit 0 但正文实为上游 5xx」的静默失败，走重试而非误判成功。

### 🧠 跨 Agent 共享记忆（KV + 笔记 + 向量语义检索）
- **KV 存储**（`shared_memory_*`）：跨进程共享键值，与独立插件 `shared-memory` 共用同一份存储，简单直接。
- **交接笔记**（`shared_notes_*`）：append-only 带时间戳与 tag，天然适合 `handoff:<id>`。
- **向量语义检索**（`memory_*`）：ONNX + sqlite-vec，`memory_search` 按「意思」而非「关键词」跨 Agent 召回；记忆可沉淀（`task_sediment`）、可提级（`memory_promote`）。模型按需下载，不进 git。

### ✉️ 消息总线（持久化收件箱 + 实时唤醒）
- 消息持久化落盘，FIFO + 60s 租约防并发双处理。
- **实时唤醒**：接收端 `inbox_wait` 挂起时，发送端发消息即被**即时唤醒**，不靠轮询。
- 支持 `topic` 分组、`priority` 分级、`memory` 自动沉淀、`to="*"` 广播。

### 📊 Web 面板可视化
- 工作流按「卡片 / 聚焦图」展示，任务状态、依赖链、质量分、心跳一目了然。

### ⏱️ 长任务管理（中断 / 续跑 / 状态机）
- `task_interrupt`：人工叫停卡死/跑偏的任务（Windows `taskkill /T /F`，Unix `SIGTERM→SIGKILL`），保留部分输出与 `session_id`。
- `task_resume`：复用 `session_id` 真·续跑（保留上下文），中断/失败/替代态均可恢复。
- 任务状态机完备：`pending → running → interrupted / escalating / awaiting_approval / completed / failed / superseded`。

### 🔎 Worker CLI 自动探测挂载（`agent_scan`）
- 自动识别本机已安装的 worker CLI（claude / codex / qwen / opencode / dsh），检测可用性并挂载到注册表；缺失给出引导。

---

## 快速开始（30 秒）

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

### 第 3 步：启动并挂载到 MCP 客户端

把桥接器注册为你的 Agent CLI 的 MCP Server（模板：`config/claude-mcp-config.json.tmpl` / `config/codex-mcp-config.toml.tmpl`），然后启动即可：

```bash
node bridge/mcp/shared-context-server.mjs   # 启动桥接服务
node bridge/mcp/bridge-web-panel.mjs        # （可选）启动 Web 面板
```

安装向导也已备好（自动替换路径占位并写入配置）：

```bash
bash launchers/install.sh      # Windows 用 launchers/install-win.bat
```

挂载后，主控 Agent 就能通过工具看到并调用整套协作能力了。

---

## 架构

```
┌───────────────────────────────────────────────────────────────┐
│                    你 / 主控 Agent (Claude Code)               │
│                    以 MCP 协议调用协作工具                       │
└──────────────────────────────┬────────────────────────────────┘
                               │ stdio (MCP)
                               ▼
┌───────────────────────────────────────────────────────────────┐
│          shared-context-server.mjs  (MCP Server)               │
│      纯 Node.js 标准库 · 零三方依赖 · 57 个协作工具              │
├─────────────────┬─────────────────┬───────────────────────────┤
│   🗂️ 任务队列     │   🧠 共享记忆     │      ✉️ 消息总线           │
│   (DAG 编排)    │  KV/笔记/向量    │   (收件箱 + 实时唤醒)        │
├─────────────────┴─────────────────┴───────────────────────────┤
│              Worker 派发层（Agent Registry / agent_scan）       │
└───────┬───────────┬───────────┬───────────┬───────────┬────────┘
        ▼           ▼           ▼           ▼           ▼
   Claude Code   Codex       Qwen      opencode      DSH
   推理/架构    批量代码    文档/PPT    备路/并发    多后端执行
```

---

## 工具全览（57 个工具 · 5 大类）

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

### 🔀 Worker 派发
| 工具 | 用途 |
|------|------|
| `run_claude` / `run_codex` / `run_qwen` / `run_dsh` | 异步调用各 CLI Agent（自动限流重试） |
| `agent_list` / `agent_invoke` | 列出注册 Agent / 按名派发（忙时备路改派） |
| `agent_scan` | 探测本机已安装 worker 并挂载可用性 |
| `agent_eval` | 按 Agent 聚合完成率/质量分/时长/重试/满意度 |
| `run_verify` | LLM-as-judge 质量门禁（按标准打分 0–100） |
| `workflow_plan` / `workflow_start` / `workflow_evolve` | 编排：自动拆解 / 落 DAG / 自适应重规划 |
| `result_arbitrate` | 多 worker 冲突结果自动仲裁 |

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

### ⚙️ 运维与观测
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

## 目录结构

```
multi-agent-bridge/
├── bridge/mcp/              # 核心 MCP Server（9 个文件：8 个 .mjs + 1 个 package.json，零三方依赖）
├── config/                  # 配置模板（env / claude / codex）
├── launchers/               # 安装 / 启动脚本（install-win.bat / install.sh）
├── scripts/                 # 探测 / 冒烟 / 压测脚本
├── assets-optional/         # 可选向量层（模型按需下载，不入 git）
├── docs/                    # 文档（cookbook / releases）
├── public-install/          # 公网安装指引（INSTALL / ENV_SETUP / .env.example）
└── .github/                 # CI（三平台冒烟）与 Release 工作流
```

## 文档

- 📦 [安装指引](public-install/INSTALL.md) — 从零开始的分步安装
- 🔧 [环境变量配置](public-install/ENV_SETUP.md) — 各端点 / 密钥 / 模型配置
- 🖼️ [图像分析说明](public-install/VISION_ANALYZE.md) — `vision_analyze` 用法
- 🧭 [异常处理 Cookbook](docs/cookbook/exception-handling.md) — 限流 / 超时 / 卡死应对
- 📝 [变更日志](CHANGELOG.md) · [协作指南](AGENTS.md) · [English README](README_EN.md)

## 许可证

[MIT](LICENSE) © multi-agent-bridge contributors