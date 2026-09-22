---
name: multi-agent
description: 用 multi-agent-bridge（58 个协作工具）把多个 Agent CLI（claude / codex / qwen / opencode / dsh / qoder / qoder_cn）编排成协作团队。核心两条主线：(1) 按竞争式(compete) / 合作式(collaborate) / 动态路由(dynamic)三种协作范式搭建工作流 DAG（workflow_plan → workflow_start → workflow_evolve）；(2) 自动把每个挂载 Agent 的工作记忆回写到 shared-memory（向量语义记忆 memory_* + 键值 shared_memory_* + 交接笔记 shared_notes_*），供主控与任意 Agent 做记忆召回、复用他人工作记忆。当用户要「多个 Agent 协作完成一个目标」「多视角选型/评审后再收敛」「自动沉淀各 Agent 产出到共享记忆」「跨 Agent 交接知识」时使用本技能。
---

# multi-agent 多 Agent 协作技能

把多个独立 Agent CLI 接到同一张协作网络：共享任务队列（DAG 编排）+ 共享记忆（KV / 笔记 / 向量语义召回）+ 消息总线（收件箱 / 实时唤醒）。本技能只讲两件事：**怎么按三种范式起工作流**、**怎么把每个 Agent 的记忆自动回写进 shared-memory 并被复用**。

> 所有工具名与参数以当前挂载的 bridge 实际 `tool` 列表为准；桥内 57 个协作工具，独立插件 `shared-memory` 另提供 12 个记忆工具（两者 `memory_*` 同源，默认共用 `~/.agents/vector/vec.db`）。

## 0. 开工前置：确认「挂载了哪些 Agent」

任何编排前先探明 roster，否则 `workflow_start` / `run_*` 会因 worker 未安装被拒。

| 步骤 | 工具 | 说明 |
| --- | --- | --- |
| 探测本机 worker 可用性 | `agent_scan` | 识别 claude/codex/qwen/opencode/dsh/qoder 是否可加入，`available=false` 会被派发拒绝 |
| 列出注册表与能力 | `agent_list` | 每行 name + `(auto: yes)` + 能力/强弱项，用于选型 |
| 读历史战绩 | `agent_eval` | 按 agent 聚合完成率/平均质量分/平均时长/重试/满意度，用于任务路由决策 |

选型经验：推理/架构 → claude；批量代码/补丁 → codex；文档/PPT/图像 → qwen；全栈编程+中文场景/代码审查 → qoder；国内合规+低延迟 → qoder_cn；备路/并发 → opencode/dsh。不要把主控（`BRIDGE_CONTROLLER`）压给重活——长任务用 `agent_invoke` 派给空闲 worker。

## 1. 三种协作范式总览

| 范式 | 何时选它 | 关键传参 | 收敛方式 |
| --- | --- | --- | --- |
| **竞争式 `compete`** | 同一问题要 ≥2 个独立视角、再择优（方案选型、根因定位、架构评审、需求理解有分歧） | `competitors:[{agent,view}]` + `converge_title/converge_agent` | 主控 `result_arbitrate` 三层裁决（多数一致 → 专家加权 → LLM 仲裁者兜底） |
| **合作式 `collaborate`** | 从零产出、需要「设计→实施→审核」单链且实施者与审核者分离 | `designer` / `implementer` / `reviewer`（implementer ≠ reviewer） | 审核段 `run_verify`（LLM-as-judge 0–100 打分门禁） |
| **动态路由 `dynamic`** | 目标混合/模糊，让引擎自动判 compete 还是 collaborate | 只给 `goal`（可先用 `workflow_plan` 预览） | 引擎写路由理由进 workflow meta + 各 task description「上墙」 |
| （补充）线性链 `bmad` 等 | 需求→架构→实现→评审的固定流水线 | `template:'bmad'`（`'_list'` 查清单） | 逐段依赖链 |

三种范式统一走同一条编排主干：`workflow_plan`（自动拆解）→ `workflow_start`（落 DAG）→ `task_list`（观测）→ `workflow_evolve`（自适应重规划）→ 每段完成后 `task_sediment`（记忆回写）。

## 2. 范式一：竞争式 compete（多视角并行 → 主控收敛）

适用于「同一个问题，想要多份独立答案，再仲裁出最优」。步骤：

1. `agent_list` / `agent_eval` 选定参与视角（2–3 个，覆盖不同强弱项）。
2. `workflow_start` 一键起竞争式：

```json
{
  "title": "移动端崩溃根因定位",
  "goal": "定位线上崩溃 top1 的根因并给出修复方案",
  "paradigm": "compete",
  "competitors": [
    { "agent": "claude", "view": "从崩溃堆栈、内存与并发模型角度分析" },
    { "agent": "codex", "view": "从代码路径、边界条件与资源释放角度审查" },
    { "agent": "qwen", "view": "从日志时序、设备差异与回归范围角度补边界" }
  ],
  "converge_title": "主控收敛根因结论",
  "converge_agent": "claude"
}
```

3. 各视角产出后，主控用 `result_arbitrate` 收敛（输入 ≥2 份候选）：

```json
{
  "question": "崩溃 top1 的根因是什么？",
  "candidates": [
    { "answer": "<claude 结论>", "agent": "claude", "confidence": 88 },
    { "answer": "<codex 结论>", "agent": "codex", "confidence": 90 },
    { "answer": "<qwen 结论>", "agent": "qwen", "confidence": 85 }
  ],
  "criteria": "根因须可复现、可修复、可验证"
}
```

`result_arbitrate` 返回 `winner + 裁决层 + 各候选权重 + 仲裁理由`。**只裁决不建任务**——拿 winner 落成最终结论并回写记忆（见 §5）。

## 3. 范式二：合作式 collaborate（设计→实施→审核，评审分离）

适用于「从零实现一个功能/产物」，评审者与实施者必须分离（防自我背书）。步骤：

```json
{
  "title": "实现数据导出模块",
  "goal": "新增开放平台数据导出的后端接口与权限校验",
  "paradigm": "collaborate",
  "designer": "claude",
  "implementer": "codex",
  "reviewer": "qwen"
}
```

默认分配：claude 设计 → codex 实施 → qwen 审核。三个约束：

- `implementer` 不得等于 `reviewer`（服务端强制）；
- 审核段用 `run_verify` 做质量门禁：`{ "artifact": "<产物>", "criteria": "<验收标准>", "threshold": 80 }`；低于 80 但在 `degrade_band`（默认 10）内可降级放行，否则回退重做；
- 需要人工把关时对段级任务用 `task_create({ require_approval: true })` 或 `workflow_start({ approve_each_phase: true })`，完成后停在 `awaiting_approval`，等 `task_approve` 放行再释放下游。

## 4. 范式三：动态路由 dynamic + 自动拆解

适用于「目标是句话、还没想清楚用哪种范式」。两条路：

**A. 先预览再落**（推荐，可控）：

```json
{ "goal": "给订单服务加幂等与限流保护", "context": "技术栈 Spring Boot + Redis", "decomposer": "qwen" }
```

`workflow_plan` 返回结构化的 `stages[]`（每段 title/description/criteria/agent/depends_on），复杂时会标 `approval_required=true` 交主控审；可改 `stages` 后再调 `workflow_start`。

**B. 直接让引擎路由**：

```json
{ "title": "给订单服务加幂等与限流保护", "goal": "给订单服务加幂等与限流保护", "paradigm": "dynamic" }
```

引擎自动分析 goal 选 compete 或 collaborate，并把**路由理由**写进 workflow meta、各任务 description「上墙」。缺省 agent 分配：compete=claude/codex/qwen 三视角，collaborate=claude 设计 / codex 实施 / qwen 审核。

## 5. 记忆回写闭环（自动把 Agent 记忆写入 shared-memory）

这是本技能第二条主线：**不让任何 Agent 的产出丢在任务记录里**，而是自动沉淀成可被召回、可被其他 Agent 复用的共享记忆。桥已自动追踪每个 `run_*` / `agent_invoke` / workflow 任务的 `task_id`、`result`、`session_id`，主控只需要在任务完成后做「回写」。

### 5.1 回写四件套（按粒度选）

| 粒度 | 工具 | 用途 | 示例 |
| --- | --- | --- | --- |
| 向量语义记忆 | `task_sediment` / `memory_add` | 跨 Agent 按「含义」召回结论、经验、坑 | `memory_add { content:"并发写 SQLite 用 WAL+busy_timeout 解锁", source:"agent:codex" }` |
| KV 键值 | `shared_memory_set` / `get` / `list` | 轻量共享变量、决策常量、feature flag | `shared_memory_set { key:"decided.api.level", value:"34" }` |
| 时间线笔记 | `shared_notes_append` / `read` | handoff、决策流水、事件记录（append-only） | `shared_notes_append { note:"根因已定位，交给复现 Agent", tag:"handoff:crash-9f" }` |
| 消息（可自动入向量） | `bus_send` / `agent_send_message` | 实时唤醒 + `memory:true` 自动沉淀 | `agent_send_message { to:"codex", from:"claude", body:"...", memory:true }` |

### 5.2 标准回写 SOP（主控在每个 worker 任务完成时执行）

1. **拿结果**：`task_list { status:"completed" }`（或按 `task_id` 查），读该任务的 `result` 与 `session_id`。
2. **自动沉淀**（最快路径）：`task_sediment { task_id:"<id>" }` —— 把「标题+描述+结果」提炼成知识点写入向量记忆（底层就是 `memory_add`）。
3. **显式补结论**（可选，精确控制 source）：`memory_add { content:"<该 Agent 的关键结论/决策/坑>", source:"agent:<name>", scope:"project:<name>", cwd:"<path>" }`。`source` 统一用 `agent:<name>` 便于追溯是哪位 Agent 的记忆。
4. **写 KV / 笔记交接**：需要下游立即可用的小变量用 `shared_memory_set`；需要留痕的用 `shared_notes_append`（tag 用 `handoff:<id>`）。
5. **消息带记忆**：跨进程通知且希望这句话也能被语义召回时，用 `bus_send { memory:true }`。

### 5.3 召回与复用（任何 Agent 开始新任务前）

- 主控开工先 `memory_search { query:"<当前问题>", top_k:5 }` —— 语义召回历史结论（默认按 current project + platform + global 分层过滤；跨项目知识用 `scope:"global"`）。
- 取别人留下的共享变量：`shared_memory_get { key:"..." }`；读交接记录：`shared_notes_read { tag:"handoff:<id>" }`。
- 把召回到的记忆**注入到下一个 worker 的 prompt** 里，让新 Agent 直接站在别人的成果上，而不是重新发明轮子。
- 发现某项目经验其实是跨项目公共知识时：`memory_promote { id, to_scope:"global" }`（默认 `dry_run:true` 先预览，确认后 `dry_run:false` 真改）。

### 5.4 记忆作用域分层（写好 category 的关键）

category 形如 `<scope>:<platform>:<domain>`，如 `global:general`、`project:<name>:general`、`platform:spreadtrum:general`。回写时若明确属于某项目，传 `scope:"project:<name>"`（或 `cwd` 让其自动推断）；跨项目公共结论传 `scope:"global"`。检索时分层保底配额会自动避免跨项目噪声。

## 6. 主控标准操作序列（推荐拷走当模板）

1. `agent_scan`（探测可挂载 worker）→ `agent_list`（能力）→ `agent_eval`（战绩）。
2. `memory_search` 先召回既往相关记忆，拼进新任务的上下文。
3. `workflow_plan` 拆解（复杂会标 `approval_required`），审定 `stages`。
4. `workflow_start` 落 DAG（按 §2/§3/§4 选范式），拿到阶段 `task_id` 链。
5. 循环观测：`task_list` 看进度；不阻塞等长任务——`agent_invoke`/`run_*` 是后台契约，结果落 `task.result`，随时用 `task_list` 或面板 `/api/state` 取。
6. 每段 `completed` 立即回写记忆（§5.2）；遇失败用 `workflow_evolve` 自适应：`fork`（换备选 worker）、`append`（追加实现段）、`insert`（反向插前置）、`rollback`（已完成段打回重做，推翻已完成段）、`branch`（条件分支）。
7. 竞争式产出用 `result_arbitrate` 收敛；关键产物过 `run_verify` 门禁。
8. 收尾：`bridge_checkpoint` 存快照留审计，`task_sediment` 把终态结论沉淀，`shared_notes_append` 写 handoff 收尾记录。

## 7. 关键注意与反模式

- **长任务必须传 `timeout_sec`（600–900）**：评估/设计/重构、`prompt>2000` 字时防误杀。
- **429 由桥自动退避重试**（默认 2 次共 3 次尝试）：遇到高失败/高重试先看 `bridge_stats` 判断是上游过载还是任务 bug，别盲目重试。
- **不阻塞等后台任务**：`agent_invoke`/`run_*` 立即返回 `task_id`，结果落 `task.result`；主控用 `task_list` 轮询，不 sleep。
- **`workflow_evolve` 有服务端护栏**：演进计数 ≤3，≥2 次强制独立审闸（`independent_review`/`gate_bypass`），不破坏已完成段（`rollback` 是显式豁免）。别手动拼 `task_fork`/`task_depend` 绕护栏。
- **KV/笔记与向量记忆的分工**：桥的 `shared_memory_*` 与独立插件 `shared-memory` 的 KV/笔记**共用同一份存储**，落在 `~/.agents/shared-memory/`（`kv.json` + `notes.log`）；`memory_*` 向量语义记忆二者同源，默认共用 `~/.agents/vector/vec.db`（模型按需下载）。**要「跨 Agent 语义召回」走 `memory_*`，要「轻量共享变量」走 `shared_memory_*`。**
- **实施/审核分离**：`collaborate` 里 `implementer ≠ reviewer` 是服务端强制，别把两者写成一个。
- **删记忆必须给条件**：`memory_delete` 只按 id / category / category_prefix 删，空参是 no-op（防全表误删）。
- **删记忆必须给条件**（同上，独立插件版另有 `shared_memory_delete`，桥内 KV 无 delete，只能用 set 覆盖）。

## 8. 快速参考：派发与收敛工具卡

| 工具 | 你要做的动作 |
| --- | --- |
| `agent_invoke` | 按名派活（name 可省略→空闲池轮询，忙时自动备路改派；`same_worker:true` 精确同名、`auto_fallback:false` 关备路） |
| `run_claude` / `run_codex` / `run_qwen` / `run_dsh` | 直连某 CLI；`plan_mode:true` 只读调研不落盘 |
| `run_verify` | LLM-as-judge 打分门禁（threshold 默认 80，degrade_band 默认 10） |
| `result_arbitrate` | 多 worker 冲突结果自动仲裁（三层裁决） |
| `workflow_evolve` | 六动作自适应重规划（fork/append/insert/degrade/rollback/branch） |
| `task_interrupt` / `task_resume` | 卡死叫停 / 复用 `session_id` 真续跑；`task_reassign` 安全交接给新主 |

## 9. 快速记忆回写速查

| 你要做的动作 | 工具 |
| --- | --- |
| 一个任务完成了，自动沉淀成知识点 | `task_sediment { task_id }` |
| 手动写一条可语义召回的结论 | `memory_add { content, source, scope?, cwd? }` |
| 开始新任务前先召回历史 | `memory_search { query, top_k?, scope? }` |
| 给下游留一个共享变量 | `shared_memory_set { key, value }` |
| 留一条带时间戳的交接记录 | `shared_notes_append { note, tag:"handoff:<id>" }` |
| 通知某 Agent 并顺手入记忆 | `agent_send_message { to, from, body, memory:true }` |