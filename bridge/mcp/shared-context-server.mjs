#!/usr/bin/env node
// shared-context-server.mjs — stdio MCP server shared by Codex and Claude.
//
// Fused v3: Optimization 2026-07-31
// - STATE_DIR: ~/.multi-agent-bridge/state/ (persistent, not /tmp)
// - Concurrency: flock + atomic rename for memory.json
// - Security: No hardcoded auth token, env-only
// - Task tracking: tasks object in memory.json, task_list tool
//
// Tools (34 total):
//   shared_memory_set/get/list   — KV context store
//   shared_notes_append/read     — append-only handoff notes
//   task_create/list             — task queue management (deliverable + acceptance_criteria)
//                                  + dependency DAG (optional dependencies[], claim-before-check gate)
//   task_claim/complete/fail      — task claim/completion lifecycle
//                                  + attempt 能力令牌 / 迟到覆盖防护
//   task_supersede               — mark task overtaken by another (no zombie pending)
//   task_reassign                — unlock task back to unclaimed for uncontended take-over (invalidates stale attempt)
//   agent_send_message/inbox_read/inbox_ack — 邮箱降级版 FIFO + 60s 租约 + 消息总线
//   bus_send/inbox_wait/bus_history        — 完整消息总线（消息总线实时唤醒+内存信号视角, 2026-08-27）：
//                                            实时唤醒（进程内事件表 fireBusWaiters → inbox_wait 异步挂起即时命中，
//                                            不阻塞服务器）+ 内存信号（kind/topic/priority 信封 + memory 自动沉淀向量记忆）
//   file_lock_acquire/release/list — advisory cross-process file locks (3.2)
//   project_search               — ripgrep (fallback grep)
//   read_file                    — file content with line numbers
//   list_dir                     — directory listing
//   run_codex/run_claude/run_qwen/run_qoder — async call a CLI agent (thin wrappers over the Agent Registry)
//   agent_list                   — list registered agents with capability tags
//   agent_invoke                 — invoke any registered agent by name
//   memory_search                — semantic vector search over shared memories (3.7.0, 路线B)
//   memory_add                   — add a memory with embedding to vector store (3.7.0, 路线B)
//   memory_list/delete/stats     — vector store management: list/delete/stats
//   memory_promote               — manually promote a memory to wider scope (usage-based promotion 手动版)
//   bridge_stats                 — runtime observability: per-agent call/success/retry aggregates
//   bridge_checkpoint            — save/list/restore named state snapshots for audit/rollback
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, renameSync, rmSync, openSync, closeSync, copyFileSync } from "node:fs";
import { join, resolve, extname, sep, dirname } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { AGENTS, extractJsonObject, parseClaudeOut, probeAgents } from "./agents-registry.mjs";
import { isRetryableExit, isFakeSuccess, safetyScan, parseRetryAfter, sleep } from "./retry-safety.mjs";
import { getVecMemory, STATE_DIR, BRIDGE_WORK_ROOT, resolveInWorkDir, NOTES_FILE, MEM_FILE, withLock, loadMem, saveMem, updateMem, loadKV, updateKV, INTERNAL_MEM_KEYS, sweepStaleRunning, BUS_LEASE_MS, fireBusWaiters, registerBusWaiter, busEnqueue, sedimentBusMessage, generateTaskId } from "./state-store.mjs";
import { runAgent } from "./run-driver.mjs";

// ---- 跨平台适配（Windows .cmd shim / POSIX 直接跑 PATH；备路 worker、429 自动切换 model、bridge_checkpoint 快照、假成功检测、DSH 接入等均已实现）----
// Windows 下 npm 安装的 CLI 是 .cmd shim（claude.cmd / codex.cmd / qwen.cmd），spawn 直接跑 .cmd 需 shell:true。
// Linux/macOS 直接跑 PATH 里的可执行文件，shell:false（避免注入/引号问题）。
// opencode 独立描述子（备路 worker）+ qwen 描述子（6 轴全配：--auth-type openai + QWEN_ENV qwen 端点 + --approval-mode
//   auto-edit 落盘 + 真 resume + parseQwenOut），作 opencode 写文档互补 + vision_analyze 图像互补。
// 假成功检测。qwen CLI 把上游 5xx（qwen 端点 500）塞进 result 文本、自己 exit=0 退出，桥接器原只看
//   exit code 判成败（code===0→success），对这种"假成功"盲区——标 completed 不重试，静默吞错。新增 isFakeSuccess：
//   exit=0 但解析后正文含 [API Error: ... status code (no body)] 时判 fake_success，走 model 轮转重试（换
//   fallbackModels/不同上游绕过 5xx），全池穷尽才标 failed。检测基于解析后正文（非原始 out），避免 CLI 日志噪声误判。
// DSH 接入 + qwen 默认模型坑。DSH（DeepSeek DSH）注册第 5 个 worker：run_dsh 工具 + agent_invoke
// name="dsh"，模型中立多后端执行者（同一套 agent 逻辑换 <BACKEND_1>/<BACKEND_2>/<BACKEND_3> provider 轮换/对比）；workdir 必传
// 隔离沙箱（真实写文件/bash/pwsh 边界）、无 resume、假成功/网关5xx/timeout 处理同 qwen（isFakeSuccess + willSwitchModel 已纳入）。另修 qwen 默认模型坑：用户报"qwen 启动失败 No auth type is selected"，实测复现后真因不是 auth——
//   --auth-type openai + QWEN_ENV 正常（chat 记录 auth_type=openai 全程），而是 qwen CLI 内置默认 model=
//   qwen CLI 内置默认 model 在 qwen 端点 /v1/models 不存在 → HTTP 500 (no body) 假成功。调用方未传 model 时 buildFresh 不再
//   省略 --model，显式钉 QWEN_DEFAULT_MODEL（Qwen3.6-35B-A3B-FP8，稳）。fallbackModels 同步刷新为 qwen 端点
//   当前真实模型（旧 Qwen3-VL-235B-A22B-Instruct 已下线，同样会 500）。
// serverInfo.version 随功能升级同步（initialize 握手返回当前包版本）。
const IS_WIN = process.platform === "win32";

// ---- Auth env for run_claude (env-only, no hardcoded fallback) ----
const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;

if (!ANTHROPIC_AUTH_TOKEN || !ANTHROPIC_BASE_URL) {
  console.error("ERROR: ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL env vars are required");
  console.error("Set them in ~/.codex/config.toml [mcp_servers.shared-context.env]");
  console.error("and ~/.claude.json mcpServers.shared-context.env");
  process.exit(1);
}

// ---- 主控自动识别（桥启动时写入 control.json，供 bridge-web-panel 读取）----
// 约定：每个 agent 的 MCP 配置里给 shared-context 加 BRIDGE_CONTROLLER=<agent 名>，
// 谁作为主控启动 shared-context，面板就自动跟随该主控。手动覆盖（source:manual）
// 优先，不被自动识别覆盖。
function applyAutoController() {
  const auto = process.env.BRIDGE_CONTROLLER;
  if (!auto) return; // 未显式声明主控，跳过
  const ctlFile = join(STATE_DIR, "control.json");
  try {
    if (existsSync(ctlFile)) {
      const ctl = JSON.parse(readFileSync(ctlFile, "utf8"));
      // 已有手动选择则尊重手动，不覆盖
      if (ctl && ctl.source === "manual") return;
    }
    writeFileSync(ctlFile, JSON.stringify({ controller: auto.trim().toLowerCase(), source: "auto" }, null, 2), "utf8");
  } catch {}
}
applyAutoController();

// ---- Tool definitions ----
const tools = [
  { name: "shared_memory_set", description: "Store a key/value pair in shared memory visible to both Codex and Claude.",
    inputSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } },
  { name: "shared_memory_get", description: "Read a value from shared memory by key. Returns empty string if missing.",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "shared_memory_list", description: "List all keys currently stored in shared memory.",
    inputSchema: { type: "object", properties: {} } },
  { name: "shared_notes_append", description: "Append a timestamped note to shared notes (append-only). Use tag like handoff:<id>.",
    inputSchema: { type: "object", properties: { note: { type: "string" }, tag: { type: "string" } }, required: ["note"] } },
  { name: "shared_notes_read", description: "Read shared notes. Optional tag filter.",
    inputSchema: { type: "object", properties: { tag: { type: "string" } } } },
  { name: "task_create", description: "Create a new task in the task queue. Returns task_id. Optional deliverable (artifact path) and acceptance_criteria (how to verify done) let the next agent check completion without guessing. Optional dependencies (array of task ids) builds; a dependency DAG: the task stays non-claimable until every dependency is terminal. Explicitly new approval-criteria + require_approval: if require_approval=true, the task is a human-approved approval gate — its completion (task_complete by the implementer) lands in `awaiting_approval` and stays there, blocking any downstream dependent DAG node, until a human calls `task_approve`. That's the block-until-ack approval gate.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, priority: { type: "string", enum: ["low", "medium", "high", "critical"] }, assigned_to: { type: "string" }, deliverable: { type: "string" }, acceptance_criteria: { type: "string" }, require_approval: { type: "boolean", description: "true → human approval gate: implementer's complete goes to awaiting_approval; downstream stays blocked; approve_accept → completed & releases downstream, or reject → back to running" }, dependencies: { type: "array", items: { type: "string" } } }, required: ["title"] } },
  { name: "task_approve", description: " DAG acceptance gate. Act on a task currently in `awaiting_approval`: decision=approve (…→completed, releases dependents) or decision=reject (→back to running for redo). Rejects a non-awaiting task. Records approver.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, decision: { type: "string", enum: ["approve", "reject"] }, approver: { type: "string" }, note: { type: "string" }, attempt_id: { type: "string" } }, required: ["task_id", "decision"] } },
  { name: "task_list", description: "List tasks. Filters: status / search(标题+描述+id 模糊) / task_ids(限定集合,批量查询). 排序: sort=priority(按优先级 high>medium>low)|created(创建时间)|status(状态分组). 分页: limit/offset. 批量操作: batch_action=reassign|fail|supersede 配合 task_ids + batch_agent/batch_reason 一次性对多个任务施效(原子). 不带参数=返回全部(兼容旧行为).",
    inputSchema: { type: "object", properties: {
      status: { type: "string", enum: ["pending", "running", "interrupted", "escalating", "awaiting_approval", "completed", "failed", "superseded"] },
      search: { type: "string", description: "模糊匹配 title/description/id（不区分大小写）" },
      task_ids: { type: "array", items: { type: "string" }, description: "限定返回这些 task_id（批量查询/批量操作的目标集）" },
      sort: { type: "string", enum: ["priority", "created", "status"], description: "排序键：priority(高→低,默认)/created(新→旧)/status(分组)" },
      limit: { type: "number", description: "最多返回条数（分页）" },
      offset: { type: "number", description: "跳过前 N 条（分页，默认 0）" },
      batch_action: { type: "string", enum: ["reassign", "fail", "supersede"], description: "批量操作：对 task_ids 集合一次性 reassign(改 assigned_to)/fail(标失败)/supersede(标记替代)。需配合 task_ids" },
      batch_agent: { type: "string", description: "batch_action=reassign 时的目标 agent" },
      batch_reason: { type: "string", description: "batch_action=fail/supersede 时的原因" }
    } } },
  { name: "safe_scan", description: " 自动安全硬拦：对一段文本/产物按 blocklist(默认内建危险模式)预扫描。命中即 blocked → 不可自动放行,清单返回命中模式。用于自动审批前的把关; 小模型/人工兜底据此再判断。blocklist 可选传(字符串或正则)。",
    inputSchema: { type: "object", properties: { content: { type: "string", description: "待扫描文本（呈现产物正文）" }, blocklist: { type: "array", items: { type: "string" }, description: "可选自定义正则/子串黑名单,缺省用内建" } }, required: ["content"] } },
  { name: "workflow_start", description: "把一次多Agent工作流落成阶段依赖链任务 DAG，供面板「当前工作流」按卡片/聚焦图展示。支持四种范式：①线性链模板 'bmad'(需求→架构→实现→评审) 或 args.stages 自定义任意阶段；②竞争式范式 args.paradigm='compete'（同一问题派 ≥2 个视角并行各出方案 → 主控收敛最优，传 args.competitors:[{agent,view}]，可 args.converge_title/args.converge_agent）；③合作式范式 args.paradigm='collaborate'（设计→实施→审核 三段链且实施者与审核者分离，传 args.designer/args.implementer/args.reviewer，默认 claude→codex→claude）；④动态路由范式 args.paradigm='dynamic'（自动分析 goal 选 compete 或 collaborate，路由理由写进工作流 meta + 各 task description「上墙」，参数缺省时用默认 agent 分配：compete=claude/codex/qwen 三视角，collaborate=claude设计/codex实施/qwen审核）。 模板库：template 可选 bmad/bmad-lite/review-only/fix-flow，或 '_list' 返回清单； 并行阶段：args.stages[i].agents=[a,b,c] 或 parallel:true → 该阶段铺 N 个同深度并行任务（共享前置，下一阶段依赖该阶段全部）。args.workflow_id 稳定 id + args.title 让多次调用归并成同一张工作流卡；可选 args.approve_each_phase 每阶段人工门。返回阶段 task_id 链。",
    inputSchema: { type: "object", properties: { template: { type: "string", description: "线性链工作流模板名（bmad/bmad-lite/review-only/fix-flow，默认 bmad；'_list' 返回清单；paradigm 非 null 时可省略）" }, paradigm: { type: "string", enum: ["compete", "collaborate", "dynamic"], description: "协作范式：compete=竞争式(多视角并行评+主控收敛)｜collaborate=合作式(设计→实施→审核，评审分离)｜dynamic=动态路由(自动选 compete/collaborate + 理由上墙)" }, competitors: { type: "array", items: { type: "object", properties: { agent: { type: "string" }, view: { type: "string" } } }, description: "竞争式必填：≥2 个视角，如 [{agent:'claude',view:'方案A'},{agent:'codex',view:'方案B'},{agent:'qwen',view:'边界补充'}]" }, converge_title: { type: "string", description: "竞争式收敛阶段标题" }, converge_agent: { type: "string", description: "竞争式收敛/主控 Agent（默认 null，主控自行认领）" }, designer: { type: "string", description: "合作式：方案设计 Agent（默认 claude）" }, implementer: { type: "string", description: "合作式：代码实施 Agent（默认 codex，不得=reviewer）" }, reviewer: { type: "string", description: "合作式：最终审核 Agent（默认 claude，不得=implementer）" }, title: { type: "string", description: "工作流标题前缀（每个 phase 任务标题带上）" }, goal: { type: "string", description: "产出目标,会写进所有阶段；dynamic 据此自动选范式" }, stages: { type: "array", items: { type: "object", properties: { t: { type: "string" }, title: { type: "string" }, desc: { type: "string" }, th: { type: "number" }, parallel: { type: "boolean", description: "true→该阶段并行（配合 agents 多 Agent，或单 agent 仅标记）" }, agents: { type: "array", items: { type: "string" }, description: "该阶段并行执行的 Agent 列表（>1 个触发并行阶段）" } } }, description: "自定义阶段链；每项可带 agents:[a,b,c] 实现同阶段并行多 Agent" }, approve_each_phase: { type: "boolean", description: "true → 每阶段 require_approval(人工分批)" } } } },
  { name: "task_sediment", description: " 任务完成自动沉淀：把一条已完成/已有结果的任务(标题+描述+结果)提炼成知识点写进向量记忆(memory_add)。供后续任务 memory_search 复用。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, category: { type: "string", description: "记忆 category，默认 global:bridge" }, scope: { type: "string" }, source: { type: "string" }, cwd: { type: "string" } }, required: ["task_id"] } },
  { name: "task_claim", description: "Claim a pending task by id. Transitions pending→running, records claimant. Rejects if not pending (blackboard auto-claim).",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, agent_name: { type: "string" } }, required: ["task_id"] } },
  { name: "task_complete", description: "Mark a running task completed with result. Transitions running→completed. Optional agent_name records who completed (useful if handoff mid-task: A claims, B completes).",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, result: { type: "string" }, agent_name: { type: "string" } }, required: ["task_id"] } },
  { name: "task_fail", description: "Mark a task failed with reason (e.g. could not complete).",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, result: { type: "string" } }, required: ["task_id"] } },
  { name: "task_heartbeat", description: "心跳 worker/主控里程碑汇报：给一个 running 任务刷 last_heartbeat_at + heartbeat_n，并把 note 追加进 progress_log（里程碑）。注意：服务端已对每个 run_* 子进程自动心跳（进程活着就跳，无需调用），本工具供能调 MCP 的主控/worker 在生产阶段主动上报里程碑（如『方案已出，等决策』），或手动续活一个进程仍活着但长期无 stdout 的长任务。需持当前 attempt_id（claim 签发；旧/伪造令牌拒绝），防迟到覆盖。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, attempt_id: { type: "string", description: "当前能力令牌（claim 签发）；交接后被撤权者用旧令牌被拒" }, note: { type: "string", description: "里程碑说明，追加到 progress_log" } }, required: ["task_id"] } },
  { name: "task_escalate", description: "决策上浮（）worker 遇方案选择/疑问时向队长/用户上浮：把任务转 `escalating` 态（运行中阻塞，等人类决策），存 question + options。需持当前 attempt_id（claim 签发；交接/伪造令牌拒绝，防迟到）。escalating 是非终态：监控每周期向用户聚合上报（带 raised_at 年龄），用户回答后由队长 task_decide 下发决策、任务回 running。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, attempt_id: { type: "string", description: "当前能力令牌（claim 签发）；交接后被撤权者用旧令牌被拒" }, question: { type: "string", description: "要用户/队长裁决的问题" }, options: { type: "array", items: { type: "string" }, description: "候选方案（≥1 个，人类据此选择）" } }, required: ["task_id", "question"] } },
  { name: "task_decide", description: "决策下浮（）队长/用户在任务 escalating 时下发裁决：写 escalation.decision + decider + decided_at，任务回 `running`（worker 续跑）。仅对 escalating 态生效；幂等——已决策任务再 decide 拒绝。记录 decider 供审计。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, choice: { type: "string", description: "用户/队长选定的方案或裁决文本" }, decider: { type: "string", description: "裁决者标识（如 'user-alice' / 'captain'），默认 'captain-for-user'" } }, required: ["task_id", "choice"] } },
  { name: "task_supersede", description: "Mark a task superseded by another (decision changed: implementer swapped or a step cut). Transitions any non-terminal status→superseded, records superseded_by (task id) + reason. Use this instead of completed/failed when a task didn't finish but was overtaken — keeps the task log honest (no zombie pending tasks).",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, superseded_by: { type: "string" }, reason: { type: "string" } }, required: ["task_id", "reason"] } },
  { name: "task_depend", description: " 前置插入核心原语⚠：动态重算任务依赖（覆盖式修改已有任务的 dependencies）。用于前置插入——fork 出补丁分支 S3' 后，把 S3' 的 dependencies 改为指向新插入的前置 S2.5（set=[原依赖…, S2.5]），实现『反向插入硬性前置 + 重算依赖链』。内置【无环校验】——若 set 引入环（目标任务成为自己的直接/间接依赖）则拒绝；已 terminal（completed/superseded）任务不可改（遵守『不破坏已完成段』演进约束）。不改变状态、不派单，纯依赖图调整。",
    inputSchema: { type: "object", properties: { task_id: { type: "string", description: "目标任务 id（S3'）" }, set: { type: "array", items: { type: "string" }, description: "覆盖后的完整 dependencies 数组（含原依赖 + 新插入的前置 id）" }, reason: { type: "string", description: "改动原因（记入 task.progress_log 供审计，如 前置插入 S2.5）" } }, required: ["task_id", "set"] } },
  { name: "task_fork", description: " Session 分叉：从 running 任务派生子任务（继承 deliverable/dependencies/acceptance_criteria），原子地把原任务标记 superseded→子任务 id。父任务不 rewrite history。用于探索不同执行路径/决策变更。返回新子任务 id。",
    inputSchema: { type: "object", properties: { task_id: { type: "string", description: "要分叉的 running 父任务 id" }, fork_title: { type: "string" }, reason: { type: "string", description: "分叉原因（记到父 task）" } }, required: ["task_id", "reason"] } },
  { name: "workflow_evolve", description: " 【自适应重规划引擎】总入口：封装六个 DAG 演进动作（fork 备选 agent / append 后置追加 / insert 前置插入 / degrade 降级验收 / rollback 阶段回退 / branch 条件分支），并【服务端强制】演进护栏——演进计数 ≤3（超限拒）、演进 ≥2 次强制独立审闸（未过审 gate_required 拒执行）、不破坏已完成段（rollback 是显式豁免：授权推翻已完成段）、留痕统一记进 workflow 元数据。调用方只要给 action+目标任务+理由，护栏/计数/留痕/面板标记引擎代管，不必手动拼 task_fork/task_depend/task_create。",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["fork", "append", "insert", "degrade", "rollback", "branch"], description: "演进动作：fork=连续失败换备选 agent；append=评审产出新需求追加实现段；insert=发现遗漏前置决策反向插入前置；degrade=质量分<th 但接近时降级验收放行；rollback=已完成段打回重做并失效其后所有下游段（显式推翻已完成段）；branch=决策点产出后分支出条件子路径（不删已有已完成段，锚点 superseded 到分支路径）" }, workflow_id: { type: "string", description: "目标工作流 id（task.workflow.id，多段共享同一演进计数/留痕）" }, task_id: { type: "string", description: "锚点任务 id（fork/insert/rollback/branch 的目标；append 的完成后承接段；degrade 的评审任务）" }, reason: { type: "string", description: "演进理由（必填，进留痕/审计）" }, fork_to: { type: "string", description: "fork 备选 agent 名（如 opencode/dsh/qwen）" }, append_title: { type: "string", description: "append 新段标题" }, prepend_task_desc: { type: "string", description: "insert 前置段描述（插在锚点任务依赖链最前）" }, branch_condition: { type: "string", description: "branch 条件：决策点判据描述（如 '验收未达标 → 转人工复审路径'），进留痕；true 时由决策方据产出判定走哪条" }, branch_to: { type: "string", description: "branch 分支任务 id（可选，决策方已建好分支段则连它；缺省引擎自建 pending 分支承接锚点" }, score: { type: "number", description: "degrade 实际质量分（<threshold 但在带宽内）" }, threshold: { type: "number", description: "degrade 验收阈值" }, independent_review: { type: "string", description: "独立审背书凭据：当演进累计≥2 时必传（如 'qwen:已独立审通过' 或人工放行标记），否则返回 gate_required" }, gate_bypass: { type: "boolean", description: "跳过独立审闸直接执行（仅队长人工放行时置 true）" }, auto_review: { type: "boolean", description: "演进独立权审·引擎自动落：true 时审闸命中（演进≥2 且无 manual 背书/无 gate_bypass）由引擎自动派 qwen 独立视角背书（复用 run_verify qwen judge）——通过自动执行、驳回停止当前演进路线交人工、qwen 未决退回手动。默认 false=保持手动派审（SKILL 派 qwen）路径，不隐含 token 成本" } }, required: ["action", "workflow_id", "reason"] } },
  { name: "workflow_plan", description: " Orchestrator 自动拆解（L1）：给一句话目标, 自动产结构化的多段 DAG 计划。调用拆解器模型把 goal 拆成 stages[]（每段 title/description/criteria/agent/depends_on），做结构自检（数组非空/每段可验收 criteria/agent 已注册/依赖引用合法/无环反向DFS/≤8段），并按复杂度定 L3 人审闸：复杂(段数或跨 agent 并行超阈值)→approval_required=true 交主控审核；小任务→auto-approve 可直接接 workflow_start。不直接建任务, 返回可执行计划供人审/改造。拆解器经 runAgent（继承 429 退避/多模型轮转）。",
    inputSchema: { type: "object", properties: { goal: { type: "string", description: "一句话目标任务（如 '给 <服务> 加 <能力>'）；有 stages 手填时可选" }, stages: { type: "array", items: { type: "object", properties: { title: { type: "string" }, t: { type: "string" }, description: { type: "string" }, desc: { type: "string" }, criteria: { type: "string" }, agent: { type: "string" }, depends_on: { type: "array", items: { type: "string" } } } }, description: "主控/测试手填计划（跳过拆解器），直接 L2 自检 + L4 落地" }, decomposer: { type: "string", description: "拆解器 agent 名, 默认 qwen（返回干净 JSON 稳定）。可换 claude" }, context: { type: "string", description: "可选补充上下文（仓库路径/既有代码/约束/技术栈）" }, approve_threshold: { type: "number", description: "L3 人审闸阈值：stages 数 > 此值视为复杂需人工审（默认 3；含跨 agent 并行也触发）" }, auto_land: { type: "boolean", description: "L4 自动落地：true 且拆解过自检且非 L3 需人审 → 直接落成真实任务 DAG（工作流卡），返回 task_id 链；需人审时忽略" }, workflow_id: { type: "string", description: "auto_land 时工作流稳定 id（默认由 goal 派生），多次调用归并同卡" }, title: { type: "string", description: "auto_land 时工作流标题（默认 goal 前 40 字）" } } } },
  { name: "result_arbitrate", description: "  结果冲突仲裁：多 worker 对同一问题给出不同答案时自动裁决。输入 ≥2 份候选结果，三层裁决：①多数一致优先（结论相同直接过）→ ②专家加权（claude 推理 3 / codex 执行 2 / 其它 1，confidence 可选加权）→ ③仍无胜者时派 LLM 仲裁者（从空闲 worker 池轮询选，排控制主控防自我指涉，全忙回退 qwen）背书。返回 winner + 裁决层 + 各候选权重明细 + 仲裁理由。只裁决不建任务，供 Orchestrator 合并多 worker 并行产出时调用（ 配套）。",
    inputSchema: { type: "object", properties: {
      question: { type: "string", description: "被裁决的问题/目标（仲裁者据此判）" },
      candidates: { type: "array", items: { type: "object", properties: {
        agent: { type: "string", description: "产出该候选的 worker 名（决定专家权重：claude=3/codex=2/其它=1）" },
        answer: { type: "string", description: "候选结果正文/结论" },
        confidence: { type: "number", description: "可选自报置信度 0-100（缺省按专家权重）" },
        task_id: { type: "string", description: "可选来源任务 id（留痕）" }
      }, required: ["answer"] }, description: "≥2 份候选结果" },
      criteria: { type: "string", description: "可选裁决依据（验收标准/约束）" },
      arbiter: { type: "string", description: "可选指定仲裁者 agent 名（缺省空闲池轮询，全忙回退 qwen）" }
    }, required: ["question", "candidates"] } },
  { name: "task_reassign", description: "Release a pending OR running task back to unclaimed so another agent can take it over. Transitions running→pending (or keeps pending), clears claimant, and revokes the attempt token while sealing it into a handoff generation (stale_attempt_ids + reassigning=true, ≈dsh handoffId): any later complete/fail/approve by the old implementer — with its old token OR even tokenless during the reassignment window — is rejected by staleAttemptRejected. The new owner claims it to start a fresh attempt and clear the handoff state. Use when the current implementer is stuck/lost/gave up and you want an uncontested take-over. Terminal tasks refuse (can't resurrect).",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, note: { type: "string", description: "why the assignment changed (optional, recorded for audit)" } }, required: ["task_id"] } },
  { name: "task_interrupt", description: "中断一个 running 任务：kill 其 worker 子进程树（Windows 走 taskkill /T /F，Unix 走 SIGTERM→SIGKILL），并把任务置 interrupted 态（保留中断前部分输出 + session_id，供 task_resume 续接）。仅 running 态可中断；终态任务拒绝。适合长任务卡死/跑偏时人工叫停。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, by: { type: "string", description: "发起中断者标识（默认 user）" } }, required: ["task_id"] } },
  { name: "task_resume", description: "恢复一个 interrupted/failed/superseded 任务：复用原任务的描述(prompt)+session_id(若有)+workdir+agent，重新派发给同一 worker 续跑。session_id 复用实现真 resume（claude/codex/qwen 保留上下文）；DSH/opencode 无 resume 则全新跑。复用原 task_id，保留 workflow/dependencies 挂链。可用 args.prompt/session_id/workdir/model 覆盖。终态 completed 不可恢复。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, agent: { type: "string", description: "覆盖执行 agent（缺省用任务原 assigned_to/claimed_by，再缺省 claude）" }, prompt: { type: "string", description: "覆盖原 prompt（缺省用任务原描述）" }, session_id: { type: "string", description: "覆盖续接会话（缺省用任务记录的 session_id）" }, workdir: { type: "string" }, model: { type: "string" }, timeout_sec: { type: "number" }, max_retries: { type: "number" }, plan_mode: { type: "boolean" } }, required: ["task_id"] } },
  { name: "agent_send_message", description: "消息总线（兼容保留）: 发一条消息到某 agent 收件箱。持久化落 memory.json mailbox。含【实时唤醒】——若接收端此刻正用 inbox_wait 挂起等待, 立即被唤醒拿到该消息(不等下一轮 poll); 若不在 wait, 消息留存待其下次读。可选 kind/topic/priority/memory(自动沉淀进向量记忆)。返回消息 id。",
    inputSchema: { type: "object", properties: { to: { type: "string" }, from: { type: "string" }, body: { type: "string" }, kind: { type: "string", description: "message=直接消息(默认) | signal=机器/大脑衍生信号" }, topic: { type: "string", description: "可选分组键, 如 workflow:<id>/task:<id>/handoff:<id>" }, priority: { type: "string", description: "low|normal|high|critical (default normal)" }, memory: { type: "boolean", description: "true → 入队后异步沉淀进向量记忆(memory_search 可召回), 即内存信号" } }, required: ["to", "from", "body"] } },
  { name: "bus_send", description: "消息总线【全能力发送】: to/from/body + kind/topic/priority + memory(自动沉淀向量记忆) + 广播(to=\"*\" 唤醒所有广播订阅者)。含实时唤醒——若接收端正 inbox_wait 挂起则即时命中。返回消息 id。",
    inputSchema: { type: "object", properties: { to: { type: "string", description: "接收 agent 名; 传 \"*\" 表示广播(所有 inbox_wait 无 topic 订阅者唤醒)" }, from: { type: "string" }, body: { type: "string" }, kind: { type: "string", description: "message=直接消息(默认) | signal=机器/大脑衍生信号" }, topic: { type: "string", description: "可选分组键, 如 workflow:<id>/task:<id>/handoff:<id>" }, priority: { type: "string", description: "low|normal|high|critical (default normal)" }, memory: { type: "boolean", description: "true → 入队后异步沉淀进向量记忆(bus → brain), memory_search 可语义召回" } }, required: ["to", "body"] } },
  { name: "inbox_read", description: "消息总线读(同步, 兼容保留): 列某 agent 未消费(unconsumed)且未被他人租约占用的消息, FIFO 序, 各带 id + 信封(kind/topic/priority)。不消费——读后须 inbox_ack {agent, ids} 确认, 授予/续 60s 租约防并发双处理。实时唤醒用 inbox_wait。",
    inputSchema: { type: "object", properties: { agent: { type: "string" } }, required: ["agent"] } },
  { name: "inbox_wait", description: "消息总线【实时唤醒读】(异步阻塞, 事件驱动不阻塞服务器): 读某 agent 消息; 有已 pending → 立即返回(授 60s 租约可 ack); 无 → 挂起等待, 当 bus_send/agent_send_message 发来即被【即时唤醒】返回, 或超时(wait_ms 默认30s 上限120s 返回 {items:[], timed_out:true})。可选 kind/topic 过滤订阅。返回 { items:[{id,from,to,kind,topic,priority,body,created_at}], timed_out }。消费用 inbox_ack。",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, wait_ms: { type: "number", description: "最长等待 ms, 默认30000, 上限120000" }, kind: { type: "string", description: "仅唤醒/返回此 kind 的消息(message/signal)" }, topic: { type: "string", description: "仅订阅/返回此 topic 的消息" } }, required: ["agent"] } },
  { name: "inbox_ack", description: "消息总线消费: 把某 agent 的 id(数组)标记 consumed, 释放租约。只有赢得租约的读者可 ack(幂等——ack 已消费/非己有/未过租约期的是 no-op 非错)。消费后不再出现在 inbox_read/inbox_wait。",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, ids: { type: "array", items: { type: "string" } } }, required: ["agent", "ids"] } },
  { name: "bus_history", description: "消息总线【只读信号/消息流回放】: 列某 agent / topic / kind 最近 N 条(含已 consume), 供面板展示/订阅者审计/历史回放。默认 agent 必填; limit≤200。",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, topic: { type: "string" }, kind: { type: "string" }, limit: { type: "number" } }, required: ["agent"] } },
  { name: "file_lock_acquire", description: "Acquire an advisory file lock to prevent two agents editing the same file concurrently. Returns ok:true on success, or ok:false with the current holder if already locked. Locks auto-expire (default 30min) so a crashed agent can't hold a lock forever. Path is normalized to absolute.",
    inputSchema: { type: "object", properties: { file_path: { type: "string" }, agent_name: { type: "string" }, ttl_sec: { type: "number" } }, required: ["file_path"] } },
  { name: "file_lock_release", description: "Release a previously acquired file lock. Returns the holder that was released. Advisory lock — cooperative, not enforced.",
    inputSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
  { name: "file_lock_list", description: "List all currently held (non-expired) file locks. For diagnostics.",
    inputSchema: { type: "object", properties: {} } },
  // 2026-09-23 fix：worker_* 工具给被 agent_invoke/run_* spawn 的 worker session 用，
  //   路径边界 = 主控传入的 args.workdir（主控已授权），不受 BRIDGE_WORK_ROOT 限制。
  //   让 worker 能读主仓库文件，弥补 run-driver 把 worker cwd 锁在 sandbox 的隔离过度。
  //   仍受路径遍历保护（拒绝含 ../ 或绝对路径越权）。
  { name: "worker_read_file", description: "Read a file the worker is authorized to access (bounded by its workdir, NOT BRIDGE_WORK_ROOT). For spawned worker sessions only. Worker passes file_path relative to its workdir, or absolute within workdir parent tree.",
    inputSchema: { type: "object", properties: { file_path: { type: "string", description: "相对 worker workdir 的路径，或 workdir 父树内的绝对路径" }, workdir: { type: "string", description: "worker 的授权 workdir（主控传入 args.workdir）" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path", "workdir"] } },
  { name: "worker_list_dir", description: "List directory entries (one level) within worker's authorized workdir parent tree.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, workdir: { type: "string" } }, required: ["workdir"] } },
  { name: "worker_glob", description: "Glob files within worker's authorized workdir parent tree.",
    inputSchema: { type: "object", properties: { pattern: { type: "string" }, workdir: { type: "string" } }, required: ["workdir", "pattern"] } },
  { name: "worker_grep", description: "Search file contents (ripgrep) within worker's authorized workdir parent tree. Returns file:line:match.",
    inputSchema: { type: "object", properties: { pattern: { type: "string" }, workdir: { type: "string" }, glob: { type: "string" }, max: { type: "number" } }, required: ["workdir", "pattern"] } },
  { name: "project_search", description: "Search project with ripgrep (fallback grep). Returns file:line:match.",
    inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, max: { type: "number" } }, required: ["pattern"] } },
  { name: "read_file", description: "Read file content with line numbers. For letting the other agent inspect a file. Path is confined to BRIDGE_WORK_ROOT (or the caller's workdir) per  path isolation — out-of-root paths are rejected.",
    inputSchema: { type: "object", properties: { file_path: { type: "string" }, workdir: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path"] } },
  { name: "list_dir", description: "List directory entries (one level). Path confine to BRIDGE_WORK_ROOT per .",
    inputSchema: { type: "object", properties: { path: { type: "string" }, workdir: { type: "string" } } } },
  { name: "run_codex", description: "Async call Codex CLI (codex exec) to run a task. For batch codegen/patches. Non-blocking. Auto-tracks task. Pass session_id to resume a prior Codex session (preserves context); the new session id is captured from output and returned for later resumption. Retries automatically on 429/rate-limit/timeout with exponential backoff (default 2 retries, 3 total attempts); set max_retries=0 to disable.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, workdir: { type: "string" }, model: { type: "string" }, auto: { type: "boolean" }, reasoning: { type: "string", description: "codex reasoning effort override, e.g. 'low' (default) / 'medium' / 'high'. low suppresses <PROVIDER> 429 for real long tasks." }, timeout_sec: { type: "number" }, task_id: { type: "string" }, session_id: { type: "string" }, max_retries: { type: "number", description: "Max retries after the first attempt on 429/timeout (0-5, default 2). 0 = fail on first error." }, retry_base_ms: { type: "number", description: "Base backoff delay in ms (default 2000). Honors Retry-After if the CLI surfaces one." }, retry_max_ms: { type: "number", description: "Cap on backoff delay in ms (default 30000)." }, capture_trace: { type: "boolean", description: " 捕获本次任务的完整推理 step 流（含中间日志/思考）存 task.trace。默认 false（省存储）。" }, fork_on_fail: { type: "string", description: " A 失败自动 fork：真失败时把任务父标记 superseded 并生成备选子任务给此 agent 承接（仅对属于工作流的任务，≤3 演进上限）。传备选 agent 名（codex/claude/qwen/dsh/opencode）即启用；不传则不自动 fork。" } }, required: ["prompt"] } },
  { name: "run_dsh", description: "Async call DeepSeek DSH CLI (dsh --profile headless) to run a task. Provider-rotatable across the configurable <BACKEND_1>/<BACKEND_2>/<BACKEND_3> backends (same agent loop; pick backend via ~/.dsh settings/patch). Runs with cwd = workdir, which is the workspace-write sandbox boundary: it can REALLY write files and run bash/pwsh inside workdir, non-interactive (no approval stall). Non-blocking. Auto-tracks task. NOTE: no resume (session_id is accepted but starts a fresh run, like opencode). Retries on 429/timeout with exponential backoff (default 2, 3 attempts total); set max_retries=0 to disable. Pass a bounded isolated workdir, never the main repo / a sensitive volume.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, workdir: { type: "string", description: "隔离工作目录 = workspace-write 沙箱边界。DSH 会在其中写文件/执行工具，务必传受限的独立目录，勿指向主仓库/敏感盘。" }, timeout_sec: { type: "number" }, task_id: { type: "string" }, session_id: { type: "string", description: "仅接受、实际全新运行（DSH 无 --resume）" }, max_retries: { type: "number", description: "Max retries after first attempt on 429/timeout (0-5, default 2). 0 = fail on first error." }, retry_base_ms: { type: "number" }, retry_max_ms: { type: "number" }, capture_trace: { type: "boolean", description: " 捕获完整推理 step 流存 task.trace，默认 false" }, plan_mode: { type: "boolean", description: " Plan 模式:只读调研,强制关 auto,产出方案不落盘" }, fork_on_fail: { type: "string", description: " A 失败自动 fork：真失败时父 superseded + 生成备选子任务给此 agent 承接（仅工作流任务，≤3 上限）。不传不自动 fork。" } }, required: ["prompt"] } },
  { name: "run_claude", description: "Async call Claude CLI (claude -p headless) to run a task. For reasoning/architecture. Injects auth env. Non-blocking. Auto-tracks task. Pass session_id to resume a prior Claude session (preserves context); the new session id is captured from output and returned for later resumption. Retries automatically on 429/rate-limit/timeout with exponential backoff (default 2 retries, 3 total attempts); set max_retries=0 to disable.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, workdir: { type: "string" }, model: { type: "string" }, timeout_sec: { type: "number" }, task_id: { type: "string" }, session_id: { type: "string" }, max_retries: { type: "number" }, retry_base_ms: { type: "number" }, retry_max_ms: { type: "number" }, capture_trace: { type: "boolean", description: " 捕获完整推理 step 流存 task.trace，默认 false" }, plan_mode: { type: "boolean", description: " Plan 模式:只读调研,强制关 auto,产出方案不落盘" }, fork_on_fail: { type: "string", description: " A 失败自动 fork：真失败时父 superseded + 生成备选子任务给此 agent 承接（仅工作流任务，≤3 上限）。不传不自动 fork。" } }, required: ["prompt"] } },
  { name: "run_qwen", description: "Async call Qwen CLI (qwen --auth-type openai, Qwen Code) to run a task. For writing/iterating docs & PPT (complements opencode) and image analysis (complements vision_analyze). Uses the qwen 端点 OpenAI-compatible endpoint via QWEN_ENV. --approval-mode auto-edit lets write_file land to disk (auto). Non-blocking. Auto-tracks task. Pass session_id to resume a prior Qwen session (preserves context — qwen has real resume via --resume, unlike opencode); the new session id is captured from JSON output and returned for later resumption. Retries automatically on 429/rate-limit/timeout with exponential backoff (default 2 retries, 3 total attempts); set max_retries=0 to disable.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, workdir: { type: "string" }, model: { type: "string" }, auto: { type: "boolean", description: "qwen honors auto via --approval-mode auto-edit (write_file lands to disk). Default true." }, timeout_sec: { type: "number" }, task_id: { type: "string" }, session_id: { type: "string" }, max_retries: { type: "number" }, retry_base_ms: { type: "number" }, retry_max_ms: { type: "number" }, capture_trace: { type: "boolean", description: " 捕获完整推理 step 流存 task.trace，默认 false" }, plan_mode: { type: "boolean", description: " Plan 模式:只读调研,强制关 auto,产出方案不落盘" }, fork_on_fail: { type: "string", description: " A 失败自动 fork：真失败时父 superseded + 生成备选子任务给此 agent 承接（仅工作流任务，≤3 上限）。不传不自动 fork。" } }, required: ["prompt"] } },
  { name: "run_qoder", description: "Async call Qoder CLI (qodercli -p -o json) to run a task. Alibaba Qwen ecosystem full-stack coding agent — for Chinese-optimized software engineering, code review (/review), and /goal long-task mode. Independent rate-limit pool from ByteDance/Anthropic. Real resume via -r (--resume), auto via --permission-mode auto, JSON output. Non-blocking. Auto-tracks task. Pass session_id to resume a prior Qoder session. Retries automatically on 429/rate-limit/timeout with exponential backoff (default 2 retries).",
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, workdir: { type: "string" }, model: { type: "string" }, auto: { type: "boolean", description: "qoder honors auto via --permission-mode auto (write_file lands to disk). Default true." }, timeout_sec: { type: "number" }, task_id: { type: "string" }, session_id: { type: "string" }, max_retries: { type: "number" }, retry_base_ms: { type: "number" }, retry_max_ms: { type: "number" }, capture_trace: { type: "boolean", description: "捕获完整推理 step 流存 task.trace，默认 false" }, plan_mode: { type: "boolean", description: "Plan 模式:只读调研,强制关 auto,产出方案不落盘" }, fork_on_fail: { type: "string", description: "失败自动 fork：真失败时父 superseded + 备选子任务给此 agent 承接（仅工作流任务，≤3 上限）。不传不自动 fork。" } }, required: ["prompt"] } },
  { name: "run_qoder_cn", description: "Async call Qoder CN CLI (qoderclicn -p -o json) to run a task. Qoder 国内版（原通义灵码），阿里云通义大模型国内部署 — 合规数据不出境、国内低延迟、中文原生优化。独立于国际版 Qoder 的账号/模型/限流池，国内网络环境下访问更稳定。Real resume via -r, auto via --permission-mode accept_edits + --no-session-persistence, JSON output. Non-blocking. Auto-tracks task. Retries automatically on 429 with exponential backoff.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, workdir: { type: "string" }, model: { type: "string" }, auto: { type: "boolean", description: "qoder_cn honors auto via --permission-mode accept_edits + --no-session-persistence. Default true." }, timeout_sec: { type: "number" }, task_id: { type: "string" }, session_id: { type: "string" }, max_retries: { type: "number" }, retry_base_ms: { type: "number" }, retry_max_ms: { type: "number" }, capture_trace: { type: "boolean", description: "捕获完整推理 step 流存 task.trace，默认 false" }, plan_mode: { type: "boolean", description: "Plan 模式:只读调研,强制关 auto,产出方案不落盘" }, fork_on_fail: { type: "string", description: "失败自动 fork：真失败时父 superseded + 备选子任务给此 agent 承接（仅工作流任务，≤3 上限）。不传不自动 fork。" } }, required: ["prompt"] } },
  { name: "agent_list", description: "List all registered agents (run_* workers) available to agent_invoke. One agent per line: name + (auto: yes) if it honors the auto param (only codex) + [capabilities] + strengths. Use it to pick the right worker for a task. 不自动派单——只备齐选型数据。",
    inputSchema: { type: "object", properties: {} } },
  { name: "agent_eval", description: "Agent 能力评估体系：按 agent 聚合任务记录出 完成率/平均质量分/平均时长/平均重试/满意度 (五等)。只读,供任务路由与选型建议。",
    inputSchema: { type: "object", properties: {} } },
  { name: "agent_scan", description: "识别本地已安装的 worker CLI（claude/codex/qwen/opencode/dsh），检测是否可加入 multi-agent，并把可用性挂载到 registry（AGENTS[name].available）。返回每个 agent 的 available + 缺失引导。bin 类型检测 PATH/绝对路径可执行；qwen 属端点类型，检测 QWEN_BASE_URL/OPENAI_BASE_URL 是否配置。available=false 的 worker 被 run_*/agent_invoke 派发时会被拒绝（提示未安装）。",
    inputSchema: { type: "object", properties: { refresh: { type: "boolean", description: "强制重扫（默认每次调用都会重扫 PATH，此参数仅为语义清晰保留）" } } } },
  { name: "agent_invoke", description: "Invoke any registered agent by name to run a task. Generic path over the Agent Registry — same driver as the run_* tools but name-driven, so new agents (e.g. qwen) need no per-agent tool. Non-blocking. Auto-tracks task. Pass session_id to resume a prior session (the captured id is returned for reuse). `auto` is honored by agents that support it (codex, qwen); others ignore it. Use agent_list to see available names. Retries automatically on 429/rate-limit/timeout with exponential backoff (default 2 retries, 3 total attempts); set max_retries=0 to disable. 【后台契约】调用可立即返回/被调用方撤回:server 端 Promise 不会因调用方撤回而终止,worker 继续在后台跑到完成,结果落 task.result(及 trace,若 capture_trace);调用方随时可用返回的 task_id 经 task_list 或面板 /api/state 取最终产物,无需阻塞等本次调用返回。给长任务(评估/设计/重构, prompt>2000字)显式传 timeout_sec 600~900 防误杀;传 plan_mode 只读调研不落盘。【默认worker】name 可选：省略 或 指定==控制主控(BRIDGE_CONTROLLER) 时，改从空闲 worker 池轮询派一个（排主控，不压 main；全忙回退主控/或 qwen），返回文案标注实际 worker。【备路】name 明确且该 worker 已忙(agent_live busy/有 running 任务)时自动改派空闲备路 worker(排控制主控,不压 main),返回文案标注改派;same_worker:true 强制精确同名、auto_fallback:false 关备路。",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "agent_invoke 默认worker:可选,省略或==BRIDGE_CONTROLLER 时从空闲 worker 池轮询派一个(排主控)而非固定压主控" }, prompt: { type: "string" }, workdir: { type: "string" }, model: { type: "string" }, auto: { type: "boolean" }, timeout_sec: { type: "number" }, task_id: { type: "string" }, session_id: { type: "string" }, max_retries: { type: "number" }, retry_base_ms: { type: "number" }, retry_max_ms: { type: "number" }, capture_trace: { type: "boolean", description: " 捕获完整推理 step 流存 task.trace，默认 false" }, plan_mode: { type: "boolean", description: " Plan 模式:只读调研,强制关 auto,产出方案不落盘" }, auto_approval: { type: "boolean", description: " 成功时对产物跑 blocklist 硬扫,命中即自动放行被拒(auto_refused)。默认关。" }, fork_on_fail: { type: "string", description: " A 失败自动 fork：真失败时父 superseded + 生成备选子任务给此 agent 承接（仅工作流任务，≤3 上限）。不传不自动 fork。" }, same_worker: { type: "boolean", description: "agent_invoke 备路:true 强制精确同名,不自动改派" }, auto_fallback: { type: "boolean", description: "agent_invoke 备路:false 关闭忙时自动改派" } }, required: ["prompt"] } },
  // ---- 质量门禁 run_verify ----
  // LLM-as-judge：复用 runAgent 驱动，让校验 agent（默认 claude，可换 qwen）按验收标准打分(0-100)。
  // 低于 threshold(默认80) 判不通过（可迭代打回）。打分写回任务 quality_score 供 bridge_stats(⑰) 聚合。
  { name: "run_verify", description: " 质量门禁：LLM-as-judge 对产物按 criteria 打分(0-100)。低于 threshold(默认80) 判不通过；但在带宽 degrade_band(默认10) 内(score∈[th-band,th)) 判降级放行(pass + degraded 标记 + verify_degraded 留痕)。打分写回任务 quality_score。默认 evaluator=qwen，可换 claude。可作任务下游 gate。",
    inputSchema: { type: "object", properties: { artifact: { type: "string", description: "要评审的产物文本/路径/内容" }, criteria: { type: "string", description: "打分验收标准" }, threshold: { type: "number", description: "通过阈值，默认80" }, degrade_band: { type: "number", description: "降级验收带宽，默认10：score 落 [th-band, th) 判降级放行而非硬失败" }, evaluator: { type: "string", description: "评审 agent 名，默认 qwen（可 claude）" }, task_id: { type: "string", description: "可选：打分后写回该任务 quality_score" } }, required: ["artifact", "criteria"] } },
  // ---- 向量记忆层（路线 B，3.7.0）----
  // 语义检索/写入共享记忆库，懒加载 ONNX+sqlite-vec，首次调用才初始化。
  // 需要 LD_PRELOAD 定制 librt（见 server 启动 env），否则 onnxruntime 加载崩。
  { name: "memory_search", description: "Semantic search over the shared vector memory store (paraphrase-multilingual-MiniLM-L12-v2, 384-dim embeddings + sqlite-vec KNN). Returns top-k memories by cosine similarity. By default filters by scope (current project + guessed platform + global) to avoid cross-project noise — pass scope='global' to search only global knowledge, or pass an explicit category for exact-match filtering. Optional min_length filters out short structural segments (e.g. 40). Lazy-loads the ONNX model + sqlite-vec on first call. Complements keyword search (project_search) for 'have I seen something like this before' recall across agents.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, top_k: { type: "number" }, category: { type: "string" }, scope: { type: "string", description: "Search scope: 'global' for global-only, 'project:<name>' to search that project + its platform + global. Omit and pass cwd to auto-infer project from working directory." }, cwd: { type: "string", description: "Caller working directory, used to infer current project name when scope is omitted." }, min_length: { type: "number", description: "Optional: filter out memories shorter than this many chars (default 0 = no filter). Use e.g. 40 to drop short structural segments." } }, required: ["query"] } },
  { name: "memory_add", description: "Add a memory to the shared vector store with an embedding (paraphrase-multilingual-MiniLM-L12-v2, 384-dim). Stores content + category + source for later semantic recall via memory_search. Category is auto-constructed as layered '<scope>:<platform>:general' from scope/cwd + content platform hints, unless an explicit category is given. Use to sediment cross-agent knowledge (learnings, gotchas, decisions) that should be findable by meaning, not just keywords.",
    inputSchema: { type: "object", properties: { content: { type: "string" }, category: { type: "string" }, source: { type: "string" }, scope: { type: "string", description: "Write scope: 'global' or 'project:<name>'. Omit and pass cwd to auto-infer project from working directory; omit both to default to global." }, cwd: { type: "string", description: "Caller working directory, used to infer current project name when scope is omitted." } }, required: ["content"] } },
  // ---- 向量记忆层管理工具----
  // memory_list/memory_delete/memory_stats：从 MCP 层列/删/统计记忆库，不再手开 sqlite。
  { name: "memory_list", description: "List memories in the vector store (no embeddings returned, only metadata + content preview). Filter by exact category or category prefix (e.g. 'project:<PROJECT>:' to list one project's memories); paginate with limit/offset. Returns id + category + source + content preview per row. Use memory_stats for counts/breakdown.",
    inputSchema: { type: "object", properties: { category: { type: "string", description: "Exact category match." }, category_prefix: { type: "string", description: "Category prefix match (appends %). e.g. 'global:', 'project:<PROJECT>:'." }, limit: { type: "number", description: "Max rows (default 50, capped 200)." }, offset: { type: "number", description: "Skip rows for pagination (default 0)." } } } },
  { name: "memory_delete", description: "Delete memories from the vector store. Mutually exclusive modes (priority id > category > category_prefix): by id (single row), by exact category (all rows in that category), or by category prefix (batch, e.g. 'test:' to clean test entries, or 'project:oldname:' after migration). Returns count deleted + mode. Idempotent — 0 deleted if no match. Passing no args is a no-op (never full-table delete).",
    inputSchema: { type: "object", properties: { id: { type: "number", description: "Delete one row by its rowid (safest, precise)." }, category: { type: "string", description: "Delete all rows with this exact category." }, category_prefix: { type: "string", description: "Delete all rows whose category starts with this prefix (appends %)." } } } },
  { name: "memory_stats", description: "Vector memory store stats: total count, per-category breakdown, embedding dim, model path. For diagnostics and before/after bulk operations. Lazy-loads ONNX+sqlite-vec on first call.",
    inputSchema: { type: "object", properties: {} } },
  // memory_promote：手动提级记忆 category（usage-based promotion 的手动版）。
  // 把一条 project 记忆的 category 改成更宽 scope（platform/global），下次检索按新 scope 走。
  // 默认 dry_run=true（只预览不改），确认后传 dry_run=false 真改。
  { name: "memory_promote", description: "Manually promote a memory to a wider scope (usage-based promotion, manual edition). Changes one memory's category from project:X to platform:Y or global, so future searches find it under the wider scope. Use when an Agent/user judges a project-specific memory is actually cross-project common knowledge. Find the id via memory_list first. Default dry_run=true (preview only, no change) — pass dry_run=false to actually update. to_scope: 'global' | 'platform:<name>' | 'platform:auto' (guess platform from content, fall back to global) | 'project:<name>'. Returns old/new category + whether promoted.",
    inputSchema: { type: "object", properties: { id: { type: "number", description: "rowid of the memory to promote (find via memory_list)." }, to_scope: { type: "string", description: "Target scope: 'global', 'platform:<name>' (e.g. 'platform:spreadtrum'), 'platform:auto' (guess from content), or 'project:<name>'." }, dry_run: { type: "boolean", description: "If true (default), only preview the new category without writing. Pass false to actually update." } }, required: ["id", "to_scope"] } },
  // ---- 运行时可观测----
  // bridge_stats：聚合 mem.tasks 已有记录，按 callee 出跨任务统计报表。零依赖、只读。
  { name: "bridge_stats", description: "Aggregate runtime stats over the task queue (mem.tasks) — per agent (callee): total calls, success (exit=0), failed, timeout, total retries, avg duration ms. Read-only aggregation of data already in memory.json (run_* / agent_invoke write retries + exit_code + timestamps). For diagnosing rate-limit (429) vs sustained overload: a high failure/timeout rate with many retries signals <PROVIDER> overload, not a task bug. No args.",
    inputSchema: { type: "object", properties: {} } },
  // bridge_checkpoint：手动存/列/恢复 memory.json 命名快照。
  // 现状 memory.json 全量覆盖无历史——O_EXCL 锁已防丢数据，checkpoint 价值在审计追溯 + 误操作回滚。
  // 手动工具（非 saveMem 自动 rotate）：审计是按需行为，命名快照语义清晰，零常规写开销。
  // 用法：name="pre-big-refactor" 存；name="list" 列；name=<existing> restore=true 恢复（覆盖当前，慎用）。
  { name: "bridge_checkpoint", description: "Save / list / restore named snapshots of the bridge state (memory.json: task queue + file locks + mailbox; 共享 KV/笔记已外置到 ~/.agents/shared-memory/，不随 checkpoint 回滚). For audit trail and rollback before risky bulk operations. Save: pass name (e.g. 'pre-promotion-batch'). List: pass name='list'. Restore (DANGER: overwrites current state): pass name=<existing checkpoint> + restore=true. Snapshots stored as memory.json.checkpoint.<name> alongside memory.json; do not collide with the live file.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Checkpoint name (alphanumeric/dash/underscore). 'list' to list existing checkpoints." }, restore: { type: "boolean", description: "If true, restore memory.json FROM the checkpoint <name> (overwrites current state). Default false = save a new snapshot." } }, required: ["name"] } },
  // ---- 视觉识别 Agent（2026-08-12）----
  // vision_analyze：裸 API 图像理解（Qwen3-VL on <LLM_ENDPOINT_QWEN>）。
  // 供任意 Agent 直接调用做图像识别/分析。密钥运行时读 opencode.json 的 qwen provider，不落盘。
  // 用法：传 image_path(本地图片) 或 image_data_url(base64 data URL) 之一；可选 model/prompt。
  { name: "vision_analyze", description: "Bare-API vision analysis of an image via vision-LLM (Qwen3-VL-235B-A22B-Instruct on <LLM_ENDPOINT_QWEN>). For image recognition / scene analysis / reading legible text identifiers. Pass either image_path (local file) or image_data_url (data:...;base64) — not both. Returns a Chinese analysis report. NOTE: this is a scene/text-visibility analyzer, NOT a barcode decoder — high-density barcode VALUES must be decoded by a real decoder (ZXing/Dynamsoft), the VLM cannot. Key read at runtime from opencode.json qwen provider.",
    inputSchema: { type: "object", properties: { image_path: { type: "string", description: "Absolute path to a local image (.jpg/.png/.jpeg/.webp). Pass this OR image_data_url (one of the two required)." }, image_data_url: { type: "string", description: "Data URL: data:image/jpeg;base64,<...>. Pass this OR image_path (one of the two required)." }, prompt: { type: "string", description: "Custom analysis prompt. Default asks for a 5-part Chinese report (scene / objects / lighting-composition / clarity-occlusion / text, transliterate any visible text)." }, model: { type: "string", description: "Vision model. Default Qwen3-VL-235B-A22B-Instruct." }, timeout_sec: { type: "number", description: "Request timeout. Default 60." } } } },
  // ---- DSH 会话读取（2026-08-21）----
  // dsh_read：委派到 ~/.agents/bin/dsh-read.mjs（独立 fzstd，只读，不改任何 DSH 数据）。
  // 当用户/其它 agent 需要查看 DSH 做过什么的历史会话时用：按 id/标题读取、或列出全部会话。
  { name: "dsh_read", description: "Read DeepSeek Harness (DSH) historical sessions. Read-only, delegates to ~/.agents/bin/dsh-read.mjs (zstd-inflate; never mutates DSH data). action='list' lists all sessions (optional keyword filters by title); 'grep <keyword>' finds sessions whose title contains keyword; 'get <session_id>' prints the session's condensed [user→assistant→tool] dialogue (pass raw=true for original JSONL). Use when asked to recall/show what a DSH chat session did.",
    inputSchema: { type: "object", properties: { action: { type: "string", description: "list | grep | get" }, keyword: { type: "string", description: "for list: title filter; for grep: keyword to match in titles; for get: ignored" }, session_id: { type: "string", description: "target session id, required when action=get" }, raw: { type: "boolean", description: "for get: output raw JSONL instead of condensed flow (default false)" } }, required: ["action"] } },
];

// ---- Tool handlers ----
// 交接代校验：调用方带 attempt_id 时，若既非当前令牌、又落在 stale 名单里（task_reassign
// 撤权后旧令牌被挪进这里），说明是"撤权后迟到的旧持证者"→ 拒绝（≈DSH handoffId 语义）。
// 旧持证者的 complete/fail/approve 即使撞上 t.attempt_id=null（已清令牌），仍会被此命中。
function staleAttemptRejected(t, attemptId) {
  if (!attemptId || !t.stale_attempt_ids) {
    // 无 attempt_id 的调用本就信任（主控直调）；无 stale 名单的旧 task 记录也放行。
    return false;
  }
  if (t.attempt_id && attemptId === t.attempt_id) return false;   // 当前令牌正常
  return t.stale_attempt_ids.includes(attemptId);                 // 命中旧令牌 → 迟到覆盖
}

function handleSync(name, args) {
  args = args || {};
  switch (name) {
    case "shared_memory_set": {
      updateKV((kv) => { kv[args.key] = args.value; });
      return { content: [{ type: "text", text: `stored key="${args.key}" (${args.value.length} chars)` }] };
    }
    case "shared_memory_get": {
      const kv = loadKV();
      if (args.key in kv) return { content: [{ type: "text", text: kv[args.key] ?? "" }] };
      // 惰性回退：KV 从 memory.json 迁出前的旧键（只读兜底，不删除）；排除内部键避免泄漏 raw 对象。
      const m = loadMem();
      const v = INTERNAL_MEM_KEYS.has(args.key) ? "" : (m[args.key] ?? "");
      return { content: [{ type: "text", text: v }] };
    }
    case "shared_memory_list": {
      const kv = loadKV();
      // kv.json 只存共享 KV，天然不含内部编排键（顺带修复旧实现把 mailbox/fileLocks 泄漏进列表的 bug）。
      const keys = Object.keys(kv);
      return { content: [{ type: "text", text: keys.join("\n") || "(empty)" }] };
    }
    case "shared_notes_append": {
      const ts = new Date().toISOString();
      const tag = args.tag ? `[${args.tag}]` : "";
      appendFileSync(NOTES_FILE, `- ${ts} ${tag} ${args.note}\n`);
      return { content: [{ type: "text", text: `appended note (${args.note.length} chars)` }] };
    }
    case "shared_notes_read": {
      if (!existsSync(NOTES_FILE)) return { content: [{ type: "text", text: "(no notes yet)" }] };
      let lines = readFileSync(NOTES_FILE, "utf8").split("\n").filter(Boolean);
      if (args.tag) lines = lines.filter((l) => l.includes(`[${args.tag}]`));
      return { content: [{ type: "text", text: lines.join("\n") || "(none)" }] };
    }
    case "task_create": {
      const taskId = generateTaskId();
      updateMem((m) => {
        m.tasks[taskId] = {
          id: taskId,                // 落库即带上 id 字段：memory.json 以键为 id，任务对象内补 id 消除外部 t.id 假设（面板/直读方统一）
          title: args.title,
          description: args.description || "",
          priority: args.priority || "medium",
          status: "pending",
          assigned_to: args.assigned_to || null,
          workdir: args.workdir || null,             // 2026-09-01：工作区根（只读核对/评估任务指向源码根，run-driver 派发时用它做 cwd，避免落空沙箱看不到工作区源码目录）
          deliverable: args.deliverable || null,
          acceptance_criteria: args.acceptance_criteria || null,
          require_approval: !!args.require_approval,             //  人工审批门：complete→awaiting_approval，待 task_approve
          approved_at: null, approver: null, approval_note: null,
          dependencies: Array.isArray(args.dependencies) ? [...args.dependencies] : [],
          attempt_id: null,          // attempt 幂等：claim 时签发的能力令牌；complete/fail 校验，防迟到覆盖
          stale_attempt_ids: [],     // 交接代：task_reassign 把旧令牌挪进这里，旧持证者 complete/fail/approve 仍被拒，防"撤权后旧 worker 迟到覆盖"
          reassigning: false,        // 是否存在未清算的交接（pending 态新主认领后清 false）
          created_by: "unknown",
          created_at: new Date().toISOString(),
          claimed_at: null,
          claimed_by: null,
          completed_at: null,
          completed_by: null,
          superseded_by: null,
          superseded_reason: null,
          result: null,
          last_heartbeat_at: null,    // 心跳：服务端 runOnce tick / worker task_heartbeat 刷新；监控据此判卡死
          heartbeat_n: 0,
          heartbeat_interval_ms: null, // null=用全局默认 BRIDGE_HEARTBEAT_MS(60s)；任务可 override（长任务调大）
          progress_log: [],            // worker 主动里程碑日志（）
          escalation: null             // 决策上浮（）
        };
      });
      return { content: [{ type: "text", text: `created task ${taskId}` }] };
    }
    case "task_list": {
      // 入口扫描：清理心跳停滞 > 10min 的 running 任务（速赢 ）。updateMem 原子 RMW。
      let _swept = [];
      updateMem((m) => { if (m.tasks) _swept = sweepStaleRunning(m); });
      if (_swept.length) console.error(`[sweep] auto-failed ${_swept.length} stale task(s): ${_swept.join(", ")}`);
      // 2026-09-23 fix：task_list 顺便触发"dep 满足即派发"全 workflow sweep —
      //   bridge 重启 / 视角 stage 刚完成 / 任何工具调用后，pending 收敛 task 都可能 dep 已
      //   满足但没人 trigger。把 dispatch 挂到 task_list 上保证 task_list 一定可见即可触发。
      try {
        const allWfIds = Object.keys(loadMem().workflows || {});
        for (const wfId2 of allWfIds) autoDispatchWorkflowStages(wfId2);
      } catch {}
      const m = loadMem();
      if (!m.tasks) return { content: [{ type: "text", text: "(no tasks)" }] };
      const tasks = Object.entries(m.tasks).map(([id, t]) => ({
        id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        assigned_to: t.assigned_to,
        workdir: t.workdir || null,                      // 2026-09-01：任务工作区根（只读核对→源码根；run-driver 派发 cwd）
        dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
        require_approval: !!t.require_approval,                    //  人工审批门标记
        approver: t.approver || null, approved_at: t.approved_at || null,
        attempt_id: t.attempt_id || null,
        reassigning: !!t.reassigning,                // 交接代：true=pending 待新主认领（旧持证者已失效）
        stale_attempt_ids: Array.isArray(t.stale_attempt_ids) ? t.stale_attempt_ids : [],
        deliverable: t.deliverable || null,
        accepted_criteria: t.acceptance_criteria || null,
        claimed_by: t.claimed_by,
        completed_by: t.completed_by || null,
        superseded_by: t.superseded_by || null,
        evolve: t.evolve || null,            //  演进标记：fork/repoint 节点区分"原规划"，面板/编排据此打徽标
        quality_score: t.quality_score ?? null,   //  run_verify 打分回写
        verify_iterations: t.verify_iterations ?? null,   //  已累计质量门迭代次数
        escalation_needed: !!t.escalation_needed,         //  连败≥3 升级待人工
        trace: t.trace ? (t.trace.length > 2000 ? t.trace.slice(0, 2000) + "…[truncated]" : t.trace) : null,   //  capture_trace 捕获的推理流（截断展示）
        session_id: t.session_id || null,   // worker 运行会话 id（DSH/opencode/codex/claude），供续接/取证
        created_at: t.created_at,
        completed_at: t.completed_at,
        result: t.result ? t.result.slice(0, 20000) : null,
        last_heartbeat_at: t.last_heartbeat_at ?? null,     // 心跳：监控据此判卡死
        heartbeat_n: t.heartbeat_n ?? 0,
        agent_live: t.agent_live || null,                    // 进程 busy/idle + pid + started_at
        interrupted: !!t.interrupted,                        //  中断标记（task_interrupt 置位）
        interrupted_at: t.interrupted_at || null,
        interrupted_by: t.interrupted_by || null,
        runtime_ms: (t.status === "running" && t.agent_live && t.agent_live.started_at) ? (Date.now() - t.agent_live.started_at) : null,   //  长任务已运行时长
        interruptible: t.status === "running" && !!(t.agent_live && t.agent_live.pid),   //  可中断：running 且有子进程 PID
        resumable: ["interrupted", "failed", "superseded"].includes(t.status),          //  可恢复：中断/失败/替代态
        workflow: t.workflow || null,   // 2026-09-23 fix：必须返回 workflow 字段，面板「工作流卡」才能按 workflow.id 分组渲染（之前丢字段导致 DSH 派发后子任务不出现在工作流卡里）
        progress_log: Array.isArray(t.progress_log) ? t.progress_log.slice(-10) : [],  // 里程碑（末10条）
        escalation: t.escalation ? { status: t.status, question: t.escalation.question, options: t.escalation.options, raised_at: t.escalation.raised_at, raised_by: t.escalation.raised_by, decided_at: t.escalation.decided_at, decision: t.escalation.decision, decider: t.escalation.decider } : null   //  决策上浮
      }));
      const filtered = args.status ? tasks.filter(t => t.status === args.status) : tasks;
      // ──  查询增强：search 模糊 / task_ids 限定 / sort 排序 / limit+offset 分页 ──
      let out = filtered;
      if (args.search) {
        const q = String(args.search).toLowerCase();
        out = out.filter(t => {
          const hay = [t.id, t.title, t.assigned_to, t.claimed_by].filter(Boolean).join(" ").toLowerCase();
          return hay.includes(q);
        });
      }
      if (Array.isArray(args.task_ids) && args.task_ids.length) {
        const idset = new Set(args.task_ids);
        out = out.filter(t => idset.has(t.id));
      }
      const PRIO_RANK = { high: 0, medium: 1, low: 2 };
      const ST_RANK = { running: 0, interrupted: 1, pending: 2, escalating: 3, awaiting_approval: 4, failed: 5, completed: 6, superseded: 7 };
      if (args.sort === "created") {
        out = out.slice().sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
      } else if (args.sort === "status") {
        out = out.slice().sort((a, b) => (ST_RANK[a.status] ?? 9) - (ST_RANK[b.status] ?? 9));
      } else {
        // 默认 priority（高→低），同级按创建时间新→旧
        out = out.slice().sort((a, b) => {
          const r = (PRIO_RANK[a.priority] ?? 1) - (PRIO_RANK[b.priority] ?? 1);
          return r !== 0 ? r : (b.created_at || "").localeCompare(a.created_at || "");
        });
      }
      const total = out.length;
      const offset = Math.max(0, parseInt(args.offset, 10) || 0);
      if (args.limit != null) out = out.slice(offset, offset + Math.max(1, parseInt(args.limit, 10)));
      else if (offset) out = out.slice(offset);

      // ──  批量操作：对 task_ids 集合一次性 reassign/fail/supersede（单锁原子）──
      if (args.batch_action && Array.isArray(args.task_ids) && args.task_ids.length) {
        const acted = [], skipped = [];
        updateMem((m) => {
          for (const tid of args.task_ids) {
            const t = m.tasks[tid];
            if (!t) { skipped.push(`${tid}:not_found`); continue; }
            if (["completed", "failed", "superseded"].includes(t.status)) { skipped.push(`${tid}:terminal(${t.status})`); continue; }
            if (args.batch_action === "reassign") {
              t.status = "pending"; t.claimed_by = null; t.claimed_at = null;
              if (t.attempt_id) (t.stale_attempt_ids = t.stale_attempt_ids || []).push(t.attempt_id);
              t.attempt_id = null; t.reassigning = true; t.assigned_to = args.batch_agent || null;
              t.reassignedAt = new Date().toISOString(); t.reassignNote = args.batch_reason || "batch reassign";
              acted.push(`${tid}->reassign(${args.batch_agent || "any"})`);
            } else if (args.batch_action === "fail") {
              t.status = "failed"; t.result = args.batch_reason || "batch fail"; t.completed_at = new Date().toISOString();
              acted.push(`${tid}->failed`);
            } else if (args.batch_action === "supersede") {
              t.status = "superseded"; t.superseded_reason = args.batch_reason || "batch supersede"; t.completed_at = new Date().toISOString();
              acted.push(`${tid}->superseded`);
            }
          }
        });
        return { content: [{ type: "text", text: `batch ${args.batch_action}: ${acted.length} acted, ${skipped.length} skipped\nacted: ${acted.join(", ") || "(none)"}\nskipped: ${skipped.join(", ") || "(none)"}` }] };
      }

      if (out.length === 0) return { content: [{ type: "text", text: `(no matching tasks${total ? ` (filtered from ${total})` : ""})` }] };
      const header = (args.sort || args.search || args.limit != null || offset) ? `(${out.length}/${total} tasks` + (args.sort ? `, sort=${args.sort}` : "") + (args.search ? `, q="${args.search}"` : "") + ")\n" : "";
      return { content: [{ type: "text", text: header + JSON.stringify(out, null, 2) }] };
    }
    case "task_claim": {
      // Blackboard auto-claim: only a pending task can be claimed. The status check
      // and the move must be atomic (single lock span) so two agents can't claim the
      // same task concurrently — both read via updateMem.
      let result;
      updateMem((m) => {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; return; }
        if (t.status !== "pending") { result = { ok: false, error: `cannot claim task in status "${t.status}"` }; return; }
        // Dependency DAG gate: a task with unmet dependencies must not run before them.
        // Terminal = completed or superseded. A dep id that doesn't exist (yet) counts as
        // unmet, so upstream tasks created later still gate correctly.
        // failed 依赖放行：已尝试但失败的视角/环节不应永久阻塞由其派生的收敛/兜底任务，
        // 否则 (某次评估) 收敛节点 fork 后继承 failed 依赖 → 依赖门永久拒，协作僵死。
        const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
        if (deps.length) {
          const unmet = deps.filter(did => {
            const d = m.tasks[did];
            return !d || !(["completed", "superseded", "failed"].includes(d.status));
          });
          if (unmet.length) {
            result = { ok: false, error: `cannot claim task ${args.task_id}: unmet dependencies [${unmet.join(", ")}] (must be completed, superseded, or failed first)` };
            return;
          }
        }
        t.status = "running";
        t.claimed_by = args.agent_name || "unknown";
        t.claimed_at = new Date().toISOString();
        // 签发新 attempt 能力令牌：本次 claim 的唯一身份。持有者用它 complete/fail。
        // 旧的令牌（另一 agent 迟到/被抢）持证 complete/fail 会被拒——防迟到覆盖。
        const attempt = `at-${args.task_id}-${Math.floor(Math.random() * 1e9)}`;
        t.attempt_id = attempt;
        // 新代开始：清交接态。旧的 stale 名单随令牌轮换作废（换新令牌后旧令牌天然失效）。
        t.stale_attempt_ids = [];
        t.reassigning = false;
        // 新代开始：重置心跳代。上一位实现者的心跳不延续到新主。
        t.last_heartbeat_at = Date.now();
        t.heartbeat_n = 0;
        t.progress_log = [];
        t.escalation = null;
        result = { ok: true, attempt_id: attempt };
      });
      if (result.ok) return { content: [{ type: "text", text: `claimed task ${args.task_id} | attempt_id ${result.attempt_id}` }] };
      return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
    }
    case "task_complete": {
      let result;
      updateMem((m) => {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; return; }
        if (t.status !== "running") { result = { ok: false, error: `cannot complete task in status "${t.status}"` }; return; }
        // attempt 幂等：若调用方带 attempt_id,须匹配当前能力令牌,否则是迟到/被抢的旧持证者 → 拒绝。
        // 交接代：撤权后旧令牌也在 stale 名单（reassign 清除当前令牌时挪入），旧持证者即使撞上
        // attempt_id=null 也被认旧令牌拒绝（≈DSH handoffId）。
        if (staleAttemptRejected(t, args.attempt_id)) {
          result = { ok: false, error: `stale attempt_id ${args.attempt_id} (current ${t.attempt_id || "none"}) — task was re-assigned or re-claimed` };
          return;
        }
        // 反向：调用方未带 attempt_id、但任务正处于交接态（pending+reassigning）且仍持旧令牌，
        // 说明是旧实现者在"撤权窗口"用无令牌调用试图收尾 → 拒绝，等新主认领。
        if (!args.attempt_id && t.reassigning && t.stale_attempt_ids && t.stale_attempt_ids.length) {
          result = { ok: false, error: `task is under reassignment (attempt ${t.attempt_id || "revoked"}) — complete requires the current attempt_id` };
          return;
        }
        //  规格持久化：若任务声明了 deliverable（artifact 绝对路径），complete 时须存在，
        // 否则走过失败路径（规格可审计 + 防"空 deliverable 过关"）。
        // 注意：workflow_start 创建的任务 deliverable 可能是描述性文本（如"设计方案"）而非文件路径，
        // 此时跳过 existsSync 检查——只有看起来像路径（含 : \ /）才做存在性校验。
        if (t.deliverable && (t.deliverable.includes(':') || t.deliverable.includes('\\') || t.deliverable.includes('/')) && !existsSync(t.deliverable)) {
          result = { ok: false, error: `completed 时 deliverable 不存在: ${t.deliverable}` };
          return;
        }
        //  人工审批门：require_approval 的任务，implementer 的 complete 不直接 completed，
        // 落地 `awaiting_approval` 等待人类 task_approve（approve→completed 放行下游，reject→回 running 重做）。
        // 下游因 DAG 依赖只认 terminal（completed/superseded）→ awaiting_approval 非终止态 → 天然 block-until-ack。
        if (t.require_approval) {
          t.status = "awaiting_approval";
          t.approved_at = null;          // 清空历史审批态，重新等批
          t.approver = null;
          t.approval_note = null;
          t.completed_at = null;         // 尚未真正完成，等 approve
          t.result = args.result || "";
          result = { ok: true, awaiting_approval: true, hint: "需要人工 task_approve 审批通过后才视为完成" };
          return;
        }
        t.status = "completed";
        t.completed_at = new Date().toISOString();
        t.completed_by = args.agent_name || t.claimed_by || "unknown";
        t.result = args.result || "";
        result = { ok: true };
      });
      // 2026-09-23 fix：task 完成时触发跨 workflow 的"dep 满足即派发"扫一遍——
      //   收敛/中段 task 因为 dep 未满足留到 caller，task_complete 后 deps 可能刚满足，
      //   但没人 trigger 它们。让 bridge 自动扫所有 workflow 的 pending task 派发可执行的。
      //   必须在 updateMem 回调外：loadMem() 读的是磁盘最新值，回调内 m 还没 saveMem 落盘。
      if (result.ok) {
        try {
          const allWfIds = Object.keys(loadMem().workflows || {});
          for (const wfId2 of allWfIds) autoDispatchWorkflowStages(wfId2);
        } catch (e) { /* fire-and-forget；dispatch 失败不影响 complete 返回 */ }
      }
      if (result.ok) return { content: [{ type: "text", text: `completed task ${args.task_id}` }] };
      return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
    }
    case "task_approve": {
      //  DAG 人工审批门：对一个 awaiting_approval 任务做人工裁决。
      //   approve → completed（terminate，释放依赖它的下游 DAG 节点）
      //   reject  → 回到 running（可重做），要求 implementer 重新 task_complete
      let result;
      updateMem((m) => {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; return; }
        if (t.status !== "awaiting_approval") {
          result = { ok: false, error: `cannot approve task in status "${t.status}" (must be awaiting_approval)` };
          return;
        }
        // attempt 幂等：approve 也须持当前令牌，防迟到持旧令牌审批旧版本。交接代:旧令牌在 stale 名单也拒。
        if (staleAttemptRejected(t, args.attempt_id)) {
          result = { ok: false, error: `stale attempt_id ${args.attempt_id} (current ${t.attempt_id || "none"}) — re-claimed after approval` };
          return;
        }
        if (args.decision === "approve") {
          t.status = "completed";
          t.completed_at = t.completed_at || new Date().toISOString();   // 保留原 complete 时间
          t.completed_by = args.approver || (t.completed_by || t.claimed_by || "unknown");
          t.approved_at = new Date().toISOString();
          t.approver = args.approver || "unknown";
          t.approval_note = args.note || "";
          result = { ok: true, decision: "approve", approved: true };
        } else {   // reject → 打回重做
          t.status = "running";
          t.approved_at = null;          // 清审批态
          t.approver = null;
          t.approval_note = args.note || "";
          // 重做需要新一轮 complete：attempt 令牌不变（同一 implementation），仅状态回 running
          result = { ok: true, decision: "reject", back_to: "running", note: args.note || "rejected by human" };
        }
      });
      if (result.ok) return { content: [{ type: "text", text: result.decision === "approve"
        ? `approved task ${args.task_id} → completed${result.approver ? " by "+result.approver : ""}`
        : `rejected task ${args.task_id} → back to running (rejected by ${args.approver || "unknown"})` }] };
      return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
    }
    case "task_fail": {
      let result;
      updateMem((m) => {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; return; }
        // attempt 幂等校验：与 task_complete 同源,防迟到持旧令牌覆盖。交接代:旧令牌在 stale 名单也拒。
        if (staleAttemptRejected(t, args.attempt_id)) {
          result = { ok: false, error: `stale attempt_id ${args.attempt_id} (current ${t.attempt_id || "none"}) — task was re-assigned or re-claimed` };
          return;
        }
        t.status = "failed";
        t.completed_at = new Date().toISOString();
        t.result = args.result || "failed";
        result = { ok: true };
      });
      if (result.ok) return { content: [{ type: "text", text: `marked task ${args.task_id} failed` }] };
      return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
    }
    case "task_interrupt": {
      // 长任务人工叫停：置 interrupted 标记 + kill worker 子进程树。
      // run-driver 的 runOnce exit 触发 settle 时检测到 interrupted → 保留 interrupted 态（不覆盖 failed）。
      // Windows 下 spawn 走 shell:true，child.pid 是 cmd.exe，须 taskkill /T /F 连带子进程一起杀。
      let result;
      updateMem((m) => {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; return; }
        if (t.status !== "running") { result = { ok: false, error: `cannot interrupt task in status "${t.status}" (only running)` }; return; }
        t.interrupted = true;
        t.interrupted_at = new Date().toISOString();
        t.interrupted_by = args.by || "user";
        (t.progress_log = t.progress_log || []).push({ ts: t.interrupted_at, note: `interrupt requested by ${args.by || "user"}`, source: "interrupt" });
        result = { ok: true, pid: (t.agent_live && t.agent_live.pid) || null };
      });
      if (!result.ok) return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
      const pid = result.pid;
      if (pid) {
        if (process.platform === "win32") {
          try { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", shell: false }); } catch {}
        } else {
          try { process.kill(pid, "SIGTERM"); } catch {}
          setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch {} }, 3000);
        }
      }
      return { content: [{ type: "text", text: `interrupt sent to task ${args.task_id}${pid ? ` (pid ${pid})` : ""} — child process killed, task → interrupted` }] };
    }
    case "task_heartbeat": {
      // 主动心跳/里程碑汇报。校验 attempt_id（与 complete/fail 同源，防迟到覆盖）；
      // 服务端被动心跳已在 runOnce 做，本工具额外语义=worker 主动报里程碑（note 进 progress_log）。
      let result;
      updateMem((m) => {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; return; }
        if (t.status !== "running") { result = { ok: false, error: `cannot heartbeat task in status "${t.status}" (only running)` }; return; }
        // 心跳是"当前实现者"对自身的带外写，须持当前能力令牌（交接后旧誓证者/伪造令牌都被拒）。
        // 与 complete/fail 的 staleAttemptRejected 不同：那只拦 stale 名单，这里要求令牌精确匹配当前。
        if (!t.attempt_id || !args.attempt_id || args.attempt_id !== t.attempt_id) {
          result = { ok: false, error: `heartbeat requires the CURRENT attempt_id (have ${t.attempt_id || "none"}, got ${args.attempt_id || "none"}) — stale/forged token rejected` };
          return;
        }
        t.last_heartbeat_at = Date.now();
        t.heartbeat_n = (t.heartbeat_n || 0) + 1;
        if (args.note) {
          if (!Array.isArray(t.progress_log)) t.progress_log = [];
          t.progress_log.push({ ts: new Date().toISOString(), note: args.note.slice(0, 500) });
        }
        result = { ok: true, heartbeat_n: t.heartbeat_n };
      });
      if (result.ok) return { content: [{ type: "text", text: `heartbeat task ${args.task_id} (heartbeat_n ${result.heartbeat_n}${args.note ? ", note recorded" : ""})` }] };
      return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
    }
    case "task_escalate": {
      // 决策上浮（）：worker 遇方案选择/疑问 → 把任务从 running 转 escalating，存 question + options，
      // 等人类/队长裁决。attempt_id 须精确匹配当前（交接后旧持证者/伪造令牌拒绝，同 heartbeat 语义）。
      // escalating 是非终态：监控聚合上报（带 raised_at 年龄），队长 task_decide 下发决策后回 running。
      let result;
      updateMem((m) => {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; return; }
        if (t.status !== "running") { result = { ok: false, error: `cannot escalate task in status "${t.status}" (only running)` }; return; }
        if (!t.attempt_id || !args.attempt_id || args.attempt_id !== t.attempt_id) {
          result = { ok: false, error: `escalate requires the CURRENT attempt_id (have ${t.attempt_id || "none"}, got ${args.attempt_id || "none"})` };
          return;
        }
        t.status = "escalating";
        t.escalation = {
          question: String(args.question || "").slice(0, 1000),
          options: Array.isArray(args.options) ? args.options.slice(0, 20).map((o) => String(o).slice(0, 200)) : [],
          raised_at: new Date().toISOString(),
          raised_by: t.claimed_by || "worker",
          decided_at: null,
          decision: null,
          decider: null,
        };
        result = { ok: true };
      });
      if (result.ok) return { content: [{ type: "text", text: `escalated task ${args.task_id} to escalating (awaiting decision: ${(args.question || "").slice(0, 60)})` }] };
      return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
    }
    case "task_decide": {
      // 决策下浮（）：队长/用户对 escalating 任务下发裁决 → 写 decision + decider + decided_at，回 running。
      // 幂等：已决策（decided_at 已设）再 decide 拒绝，防重复/迟到裁决覆盖。
      let result;
      updateMem((m) => {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; return; }
        if (t.status !== "escalating") { result = { ok: false, error: `cannot decide task in status "${t.status}" (only escalating)` }; return; }
        if (t.escalation && t.escalation.decided_at) {
          result = { ok: false, error: `task already decided at ${t.escalation.decided_at} (decision: ${t.escalation.decision})` };
          return;
        }
        const decision = String(args.choice || "").slice(0, 1000);
        const decider = args.decider || "captain-for-user";
        // 逐期存历史，worker 续跑可读 escalation.decision
        t.escalation = {
          ...(t.escalation || {}),
          decided_at: new Date().toISOString(),
          decision: decision || "(no choice)",
          decider,
        };
        t.status = "running";          // 决策下发 → worker 回到运行态续跑
        result = { ok: true, decision };
      });
      if (result.ok) return { content: [{ type: "text", text: `decided task ${args.task_id} by ${args.decider || "captain-for-user"}: ${result.decision} (task back to running)` }] };
      return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
    }
    case "task_supersede": {
      // Mark a task superseded by another — for when a collaboration decision changes
      // (implementer swapped, a step cut). Unlike completed/failed, the task didn't
      // finish; superseded keeps the task log honest instead of leaving zombie pending
      // tasks. Any non-terminal status (pending/running) may be superseded; terminal
      // statuses (completed/failed/superseded) reject to prevent rewriting history.
      let result;
      updateMem((m) => {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; return; }
        if (["completed", "failed", "superseded"].includes(t.status)) {
          result = { ok: false, error: `cannot supersede task already in terminal status "${t.status}"` };
          return;
        }
        t.status = "superseded";
        t.superseded_by = args.superseded_by || null;
        t.superseded_reason = args.reason || "";
        t.completed_at = new Date().toISOString();
        result = { ok: true };
      });
      if (result.ok) return { content: [{ type: "text", text: `superseded task ${args.task_id}${args.superseded_by ? " -> " + args.superseded_by : ""}` }] };
      return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
    }
    case "task_fork": {
      //  Session 分叉：从 running 任务派生子任务，父任务标记 superseded→子任务 id。
      // 单锁周期原子：读父 → 建子 → 父转 superseded，全在 updateMem 锁内。
      let result;
      updateMem((m) => {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; return; }
        if (!["running", "pending"].includes(t.status)) {
          result = { ok: false, error: `cannot fork task in terminal status "${t.status}"` }; return;
        }
        const childId = generateTaskId();
        m.tasks[childId] = {
          id: childId,              // 落库带 id：消除外部 t.id 依赖
          title: args.fork_title || `${t.title} (fork)`,
          description: t.description || "",
          priority: t.priority || "medium",
          status: "pending",
          assigned_to: t.assigned_to || null,
          deliverable: t.deliverable || null,
          acceptance_criteria: t.acceptance_criteria || null,
          require_approval: !!t.require_approval,                 // 子任务继承父的审批门标记
          approved_at: null, approver: null, approval_note: null,
          dependencies: Array.isArray(t.dependencies) ? [...t.dependencies] : [],
          attempt_id: null,
          stale_attempt_ids: [],     // fork 子任务全新，无交接代
          reassigning: false,
          created_by: t.created_by || "unknown",
          created_at: new Date().toISOString(),
          claimed_at: null,
          claimed_by: null,
          completed_at: null,
          completed_by: null,
          superseded_by: null,
          superseded_reason: null,
          result: null,
          last_heartbeat_at: null,
          heartbeat_n: 0,
          heartbeat_interval_ms: t.heartbeat_interval_ms || (/\b（仅评估|评估视角|仅评估|只读|read-?only|review(-only)?\b/i.test(String(t.title) + " " + String(t.description)) ? 5 * 60 * 1000 : null),
          progress_log: [],
          escalation: null,
          //  演进标记：区分「原规划节点」与「DAG 运行时演进插入/改动节点」。
          // fork=从 running/pending 父分叉出的备选分支；面板据此给节点打视觉徽标(subclass)。
          evolve: { kind: "fork", of: args.task_id, at: new Date().toISOString(), reason: args.reason || "备选 fork" }
        };
        t.status = "superseded";
        t.superseded_by = childId;
        t.superseded_reason = args.reason || "";
        t.completed_at = new Date().toISOString();
        result = { ok: true, forked_id: childId };
      });
      if (result.ok) return { content: [{ type: "text", text: `forked task ${args.task_id} -> ${result.forked_id}` }] };
      return { content: [{ type: "text", text: `error: ${result.error}` }] };
    }
    case "task_depend": {
      //  前置插入：动态重算某任务 dependencies（覆盖式），内置无环校验。
      // 用于反向插入硬性前置——fork 新分支后把其 dependencies 指向插入的前置，重算依赖链。
      // 约束：任务必须非 terminal（已完成段不可改，守「不破坏已完成段」演进约束）；set 不得成环。
      let result;
      updateMem((m) => {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; return; }
        if (["completed", "failed", "superseded"].includes(t.status)) {
          result = { ok: false, error: `cannot change dependencies of task in terminal status "${t.status}"` };
          return;
        }
        const newDeps = Array.isArray(args.set) ? [...new Set(args.set)] : [];
        // 无环校验：从逗留依赖反向 DFS，若回到 task_id 自身即成环。DAG 段数 ≤8，遍历成本可忽略。
        const visit = (id, seen) => {
          if (id === args.task_id) return true;               // 上游链回指自身 → 环
          if (seen.has(id)) return false;                      // 已访问，非环分支
          seen.add(id);
          const d = m.tasks[id];
          if (!d) return false;                                // 不存在的依赖（允许：上游后建仍 gate）
          return (d.dependencies || []).some((x) => visit(x, seen));
        };
        if (newDeps.some((did) => visit(did, new Set()))) {
          result = { ok: false, error: `cyclic dependency: ${args.task_id} would form a cycle with set [${newDeps.join(", ")}]` };
          return;
        }
        // 记录改动（审计）到 progress_log，reason 必填便于追溯
        (t.progress_log = t.progress_log || []).push({
          at: new Date().toISOString(), by: "task_depend",
          action: `dependencies: [${(t.dependencies || []).join(", ")}] -> [${newDeps.join(", ")}]`,
          reason: args.reason || "",
        });
        t.dependencies = newDeps;
        //  演进标记：依赖被动态重算 → 面板打 repoint 徽标（区分于原规划节点）。
        // 叠加式：若节点本就是 fork 演进分支(fork 时已打 evolve.kind=fork)，保留其 fork 本相、
        // 只追加 repoint 到 sub（一个 fork 分支经前置插入重连是常见二次演进，不应掩盖"这是分支"）。
        // 真实依赖以 t.dependencies 为准。
        if (t.evolve && t.evolve.kind === "fork") {
          t.evolve.sub = { kind: "repoint", at: new Date().toISOString(), reason: args.reason || "前置插入重算依赖" };
        } else {
          t.evolve = { kind: "repoint", at: new Date().toISOString(), reason: args.reason || "前置插入重算依赖" };
        }
        result = { ok: true, dependencies: newDeps };
      });
      if (result.ok) return { content: [{ type: "text", text: `task ${args.task_id} dependencies -> [${result.dependencies.join(", ")}]` }] };
      return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
    }
    case "task_reassign": {
      // task reassignment: unlock a pending/running task back to unclaimed so a different
      // agent can take it over (uncontended). 交接代：
      // 清当前 attempt 令牌时把它挪进 stale_attempt_ids 并置 reassigning=true —— 旧实现者在
      // 撤权窗口用旧令牌（或无令牌冒充新主）complete/fail/approve 都会被 staleAttemptRejected 拒，
      // 杜绝"撤权后旧 worker 迟到覆盖"竞态。新主 task_claim 认领后清交接态、开新代。
      // Terminal tasks refuse — don't resurrect finished work.
      let result;
      updateMem((m) => {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; return; }
        if (["completed", "failed", "superseded"].includes(t.status)) {
          result = { ok: false, error: `cannot reassign task already in terminal status "${t.status}"` };
          return;
        }
        const was = t.status;
        t.status = "pending";
        t.claimed_by = null;
        t.claimed_at = null;
        // 旧 attempt 令牌作废：挪进 stale 名单（交接代），而非直接丢弃。旧持证者仍被拒。
        if (t.attempt_id) (t.stale_attempt_ids = t.stale_attempt_ids || []).push(t.attempt_id);
        t.attempt_id = null;
        t.reassigning = true;                       // 存在未清算交接；新主认领后清 false
        t.reassignedAt = new Date().toISOString();
        t.reassignNote = args.note || "";
        result = { ok: true, was, reassigning: true };
      });
      if (result.ok) return { content: [{ type: "text", text: `reassigned task ${args.task_id} (${result.was}->pending), attempt token revoked & handoff-sealed, awaiting a new claim` }] };
      return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
    }
    case "agent_send_message": {
      // Mailbox → 消息总线（兼容保留, 消息总线实时唤醒视角, 2026-08-27）。
      // 旧语义: 持久化跨进程投递到 memory.json mailbox, 无实时唤醒 → 接收端下一轮 poll 才见。
      // 新语义: 入队后 fireBusWaiters() —— 若接收端此刻正用 inbox_wait 挂起, 立即被 resolve (实时唤醒);
      //         若不在 wait, 消息照常落 mailbox, 接收端下次 inbox_wait/inbox_read 取到 (退化 = 最近一次激活)。
      const args0 = { ...args, kind: args.kind || "message" };
      const result = busEnqueue(args0);
      if (!result.ok) return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
      const msg = result.msg;
      fireBusWaiters(msg.to, msg);                       // 实时唤醒：让在 wait 的接收端立即拿到
      if (msg.memory) void sedimentBusMessage(msg);      // 内存信号: 异步沉淀(fire-and-forget, 失败静默)
      return { content: [{ type: "text", text: `sent message ${result.id}${msg.memory ? " (memory: queued)" : ""}` }] };
    }
    case "bus_send": {
      // 消息总线全能力发送：to/from/body + kind/topic/priority + memory(自动沉淀) + 广播 to:"*"。
      // 实时唤醒语义同 agent_send_message。广播: to="*" 会把消息写入一个 "*" 收件箱并唤醒所有广播订阅者。
      const result = busEnqueue(args);
      if (!result.ok) return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
      const msg = result.msg;
      const fired = fireBusWaiters(msg.to, msg);          // 实时唤醒（含 topic 订阅 + 广播 "*"）
      if (msg.memory) void sedimentBusMessage(msg);       // 内存信号: 只在 memory:true 时异步沉淀(fire-and-forget, 失败静默)
      return { content: [{ type: "text", text: `bus_sent ${result.id} (kind=${msg.kind}, topic=${msg.topic || "-"}, pri=${msg.priority})${msg.memory ? " [memory: async sediment]" : ""}` }] };
    }
    case "bus_history": {
      // 消息总线只读流：列某 agent / topic / kind 最近 N 条(含已 consume), 供面板/订阅者审计/信号回放。
      if (!args.agent) return { content: [{ type: "text", text: "agent required" }], isError: true };
      const m = loadMem();
      const limit = Math.max(1, Math.min(parseInt(args.limit, 10) || 50, 200));   // 下界1 上界200，防负数/0 的 slice 异常
      let msgs = (m.mailbox && m.mailbox[args.agent] ? m.mailbox[args.agent].msgs : []);
      if (args.topic) msgs = msgs.filter((x) => x.topic === args.topic);
      if (args.kind) msgs = msgs.filter((x) => x.kind === args.kind);
      const rows = msgs.slice(-limit).reverse().map((x) => (
        `[${x.consumed ? "✔" : "•"}] ${x.id} kind=${x.kind} pri=${x.priority || "normal"}${x.topic ? ` @${x.topic}` : ""} ${x.from}→${x.to}: ${String(x.body).slice(0, 160)}`
      ));
      return { content: [{ type: "text", text: rows.length ? `${rows.length} msg(s)\n` + rows.join("\n") : "(no messages)" }] };
    }
    case "inbox_read": {
      // Read unconsumed + unleased messages for `agent`. Grant/refresh the 60s lease on
      // the ones this reader gets so a concurrent reader can't double-process within the
      // window (cross-process mutual exclusion via memory.json lock). Consumed via inbox_ack.
      const LEASE_MS = 60000;
      const now = Date.now();
      let result;
      updateMem((m) => {
        if (!m.mailbox || !m.mailbox[args.agent]) { result = { ok: true, items: [] }; return; }
        const box = m.mailbox[args.agent];
        const yours = box.msgs.filter(msg => {
          if (msg.consumed) return false;
          const leasedToOther = msg.lease_by && msg.lease_by !== args.agent && msg.lease > now;
          return !leasedToOther;
        });
        for (const msg of yours) { msg.lease = now + LEASE_MS; msg.lease_by = args.agent; }
        result = { ok: true, items: yours.map(msg => ({ id: msg.id, from: msg.from, to: msg.to, kind: msg.kind || "message", topic: msg.topic || null, priority: msg.priority || "normal", body: msg.body, created_at: msg.created_at })) };
      });
      return { content: [{ type: "text", text: JSON.stringify({ items: result.items }) }] };
    }
    case "inbox_ack": {
      // Consume messages (release lease). Idempotent: acking already-consumed or a message
      // still leased to another reader (within its window) is a no-op, not an error.
      let result = { ok: true, consumed: 0, skipped: 0 };
      updateMem((m) => {
        if (!m.mailbox || !m.mailbox[args.agent]) return;
        const box = m.mailbox[args.agent];
        const now = Date.now();
        for (const id of args.ids) {
          const msg = box.msgs.find(x => x.id === id);
          if (!msg || msg.consumed) { result.skipped++; continue; }
          const stillHeldElsewhere = msg.lease_by && msg.lease_by !== args.agent && msg.lease > now;
          if (stillHeldElsewhere) { result.skipped++; continue; }
          msg.consumed = true; msg.lease = null; msg.lease_by = null;
          result.consumed++;
        }
      });
      return { content: [{ type: "text", text: `acked ${result.consumed}, skipped ${result.skipped}` }] };
    }
    case "file_lock_acquire": {
      // Advisory cross-process file lock. Stored in memory.json under fileLocks keyed by
      // normalized absolute path. The check-and-set is atomic (single updateMem lock span),
      // so two agents racing to lock the same file can never both win — exactly one gets
      // ok:true, the other gets ok:false with the holder. Locks carry a TTL so a crashed
      // agent can't hold a lock forever; expired locks are reaped on read.
      const abs = resolve(args.file_path);
      const ttl = args.ttl_sec || 1800; // default 30 min
      const now = Date.now();
      let result;
      updateMem((m) => {
        if (!m.fileLocks) m.fileLocks = {};
        const existing = m.fileLocks[abs];
        if (existing && now - existing.acquired_at < existing.ttl_sec * 1000) {
          result = { ok: false, holder: existing.agent, acquired_at: existing.acquired_at };
          return;
        }
        m.fileLocks[abs] = {
          agent: args.agent_name || "unknown",
          acquired_at: now,
          ttl_sec: ttl
        };
        result = { ok: true };
      });
      if (result.ok) return { content: [{ type: "text", text: `locked ${abs}` }] };
      return { content: [{ type: "text", text: `already locked by ${result.holder} (acquired ${new Date(result.acquired_at).toISOString()})` }] };
    }
    case "file_lock_release": {
      const abs = resolve(args.file_path);
      let result;
      updateMem((m) => {
        if (!m.fileLocks) { result = { ok: false, released: null }; return; }
        const existing = m.fileLocks[abs];
        if (!existing) { result = { ok: false, released: null }; return; }
        delete m.fileLocks[abs];
        result = { ok: true, released: existing.agent };
      });
      if (result.ok) return { content: [{ type: "text", text: `released lock on ${abs} (was held by ${result.released})` }] };
      return { content: [{ type: "text", text: `no lock to release for ${abs}` }] };
    }
    case "file_lock_list": {
      const m = loadMem();
      const now = Date.now();
      const locks = m.fileLocks ? Object.entries(m.fileLocks)
        .filter(([, v]) => now - v.acquired_at < v.ttl_sec * 1000)
        .map(([path, v]) => ({ path, agent: v.agent, acquired_at: new Date(v.acquired_at).toISOString(), ttl_sec: v.ttl_sec }))
        : [];
      if (locks.length === 0) return { content: [{ type: "text", text: "(no active file locks)" }] };
      return { content: [{ type: "text", text: JSON.stringify(locks, null, 2) }] };
    }
    case "read_file": {
      //  路径隔离：默认强制落在 BRIDGE_WORK_ROOT 内；显式 workdir 时在该目录内。
      let abs;
      try {
        abs = resolveInWorkDir(args.workdir, args.file_path);
      } catch (e) {
        return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
      }
      if (!existsSync(abs)) return { content: [{ type: "text", text: `error: file not found: ${abs}` }], isError: true };
      const lines = readFileSync(abs, "utf8").split("\n");
      const start = Math.max(1, args.offset || 1);
      const limit = args.limit || 2000;
      const end = Math.min(lines.length, start + limit - 1);
      const out = [];
      for (let i = start - 1; i < end; i++) out.push(`${i + 1}\t${lines[i] ?? ""}`);
      return { content: [{ type: "text", text: out.join("\n") }] };
    }
    case "list_dir": {
      let dir;
      try {
        dir = resolveInWorkDir(null, args.path || ".");
      } catch (e) {
        return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
      }
      try {
        const entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
        return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
      }
    }
    // 2026-09-23 fix：worker_* 工具给被 spawn 的 worker session 用，
    //   路径边界 = 主控传入的 args.workdir 父树（不强制 BRIDGE_WORK_ROOT）。
    //   主控已用 agent_invoke({workdir:"..."}) 显式授权，worker 不再被 sandbox 锁住。
    case "worker_read_file": {
      try {
        const abs = resolveWorkerAuthorizedPath(args.workdir, args.file_path);
        if (!existsSync(abs)) return { content: [{ type: "text", text: `error: file not found: ${abs}` }], isError: true };
        const lines = readFileSync(abs, "utf8").split("\n");
        const start = Math.max(1, args.offset || 1);
        const limit = args.limit || 2000;
        const end = Math.min(lines.length, start + limit - 1);
        const out = [];
        for (let i = start - 1; i < end; i++) out.push(`${i + 1}\t${lines[i] ?? ""}`);
        return { content: [{ type: "text", text: out.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
      }
    }
    case "worker_list_dir": {
      try {
        const dir = resolveWorkerAuthorizedPath(args.workdir, args.path || ".");
        const entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
        return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
      }
    }
    case "worker_glob": {
      try {
        const root = resolveWorkerAuthorizedPath(args.workdir, ".");
        // 自实现：基于 glob pattern 正则扫 root（轻量、零依赖）
        const re = globToRegex(args.pattern);
        const out = [];
        const walk = (dir, prefix) => {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, e.name);
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) walk(full, rel);
            else if (re.test(rel)) out.push(full);
          }
        };
        walk(root, "");
        return { content: [{ type: "text", text: out.join("\n") || "(no matches)" }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
      }
    }
    case "worker_grep": {
      try {
        const root = resolveWorkerAuthorizedPath(args.workdir, ".");
        const max = args.max ?? 50;
        const out = [];
        let count = 0;
        const walk = (dir) => {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (count >= max) return;
            const full = join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.isFile()) {
              try {
                const text = readFileSync(full, "utf8");
                const re = new RegExp(args.pattern);
                const lines = text.split("\n");
                for (let i = 0; i < lines.length; i++) {
                  if (count >= max) break;
                  if (re.test(lines[i])) { out.push(`${full}:${i + 1}:${lines[i]}`); count++; }
                }
              } catch {}
            }
          }
        };
        walk(root);
        return { content: [{ type: "text", text: out.join("\n") || "(no matches)" }] };
      } catch (e) {
        return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
      }
    }
    case "agent_list": {
      // List every registered agent available to agent_invoke. 起带能力标签：
      // name + auto + capabilities + strengths，让调用方（或未来 Orchestrator）有选型依据。
      // 不自动派单——那是  的事，这里只把"选型的数据"备齐。新 registry 条目自动出现。
      // 惰性探测本地 CLI（首次调用扫一次，几十 ms）：识别可用的 worker 并挂载 available 标记，
      // 之后 agent_scan 可强制重扫。未探测过的自定义 agent 视为可用（不显示 ✖）。
      if (!Object.values(AGENTS).some((a) => "available" in a)) {
        const _scan = probeAgents();
        for (const [n, r] of Object.entries(_scan)) if (AGENTS[n]) AGENTS[n].available = r.available;
      }
      const _m = loadMem();
      const _tasks = (_m.tasks ? Object.values(_m.tasks) : []).filter((t) => t.assigned_to);
      const lines = Object.values(AGENTS).map((a) => {
        const caps = (a.capabilities || []).join(", ");
        const auto = a.hasAuto ? " (auto: yes)" : "";
        const strengths = a.strengths ? ` — ${a.strengths}` : "";
        // 能力评估五维：完成率/平均质量分/平均时长/平均重试/满意度（对全 assign 该 agent 的任务记录聚合）
        const mine = _tasks.filter((t) => t.assigned_to === a.name);
        const total = mine.length;
        let stat5 = "";
        if (total > 0) {
          const done = mine.filter((t) => t.status === "completed").length;
          const scores = mine.map((t) => (typeof t.quality_score === "number" ? t.quality_score : null)).filter((v) => v !== null);
          const times = mine.filter((t) => t.completed_at && t.created_at).map((t) => new Date(t.completed_at) - new Date(t.created_at));
          const retries = mine.map((t) => (Array.isArray(t.retries) ? t.retries.length - 1 : 0)).reduce((x, y) => x + y, 0);
          const completionRate = done / total;
          const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
          const avgMs = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
          const avgRetries = retries / total;
          const satisfaction = avgScore != null ? (avgScore / 100) * 100 : null;
          stat5 = ` |完成率${Math.round(completionRate * 100)}% 质量${avgScore != null ? Math.round(avgScore) : "n/a"} 均时${avgMs != null ? Math.round(avgMs / 1000) + "s" : "—"} 均重试${avgRetries.toFixed(2)} 满意度${satisfaction != null ? Math.round(satisfaction) + "%" : "—"}`;
        }
        const availMark = a.available === true ? "✔" : (a.available === false ? "✖" : "?");
        return `${availMark} ${a.name}${auto}${caps ? ` [${caps}]` : ""}${strengths}${stat5}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") || "(no agents)" }] };
    }
    case "agent_scan": {
      // 识别本地 worker CLI → 检测可加入（bin：PATH/绝对路径可执行；env：QWEN_BASE_URL 配置）→
      // 挂载 available 标记到 registry。available=false 的 worker 被 run_*/agent_invoke 派发时会被拒绝。
      const res = probeAgents();
      for (const [n, r] of Object.entries(res)) if (AGENTS[n]) AGENTS[n].available = r.available;
      const lines = Object.entries(res).map(([n, r]) => {
        const mark = r.available ? "✔已装" : "✖缺失";
        const extra = r.available ? "" : ` — 补充: ${r.hint || "见 public-install/INSTALL.md"}`;
        return `[${mark}] ${n}${extra}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    case "agent_eval": {
      // 评估体系：agent_list 之上出表格格式（含多列:完成/质量/时长/重试/满意）
      const m = loadMem();
      const tasks = m.tasks ? Object.values(m.tasks) : [];
      const names = new Set([...Object.keys(AGENTS), "unassigned"]);
      const out = [];
      for (const n of names) {
        const mine = tasks.filter((t) => t.assigned_to === n);
        const total = mine.length;
        if (total === 0) continue;
        const done = mine.filter((t) => t.status === "completed").length;
        const scores = mine.filter((t) => typeof t.quality_score === "number").map((t) => t.quality_score);
        const times = mine.filter((t) => t.completed_at && t.created_at).map((t) => new Date(t.completed_at) - new Date(t.created_at));
        const retries = mine.reduce((x, t) => x + (Array.isArray(t.retries) ? t.retries.length - 1 : 0), 0);
        out.push({
          agent: n, total, completed: done,
          completion_rate: total ? Math.round((done / total) * 100) : 0,
          avg_quality: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
          avg_dur_ms: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
          avg_retries: (retries / total).toFixed(2),
          // 满意度暂无独立数据源（无用户星级/ thumbs 字段），暂以质量分 0-100 直接透传，
          // 避免与 avg_quality 冗余双份：仅当有 quality_score 才给，否则 null。
          satisfaction: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null
        });
      }
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
    case "bridge_stats": {
      // 运行时可观测：遍历 mem.tasks 按 callee（assigned_to）聚合。
      // 数据已在 memory.json——run_* / agent_invoke 写入 exit_code/retries/created_at/
      // completed_at。只读聚合，不写状态。用于量化"瞬时故障 vs 持续过载"——高失败率 +
      // 多重试 = <PROVIDER> 限流，而非任务 bug。
      const m = loadMem();
      const tasks = m.tasks ? Object.values(m.tasks) : [];
      if (tasks.length === 0) return { content: [{ type: "text", text: "(no tasks recorded)" }] };

      // 按 callee 聚合。runAgent 写 assigned_to = name（agent 名）；task_create 手建任务
      // 的 assigned_to 可能是别的值或 null——归到 "(unassigned)"。
      const buckets = {};
      for (const t of tasks) {
        const callee = t.assigned_to || "(unassigned)";
        if (!buckets[callee]) {
          buckets[callee] = { total: 0, success: 0, failed: 0, timeout: 0, retries: 0, durations: [] };
        }
        const b = buckets[callee];
        b.total++;
        // 只统计已终结的任务（completed/failed 有 completed_at）算成功/失败/耗时；
        // running 中的不计入成功率分母，避免拉低统计。
        if (t.status === "completed") {
          b.success++;
        } else if (t.status === "failed") {
          b.failed++;
          // 超时判定：exit_code === null 且失败（runAgent 超时分支 exit=null）。
          if (t.exit_code === null) b.timeout++;
        }
        // retries 是 per-attempt 数组（runAgent 写），长度-1 = 重试次数。
        const retryArr = Array.isArray(t.retries) ? t.retries : [];
        b.retries += Math.max(0, retryArr.length - 1);
        // 耗时：completed_at - created_at，只对两者都有的任务算。
        if (t.created_at && t.completed_at) {
          const ms = Date.parse(t.completed_at) - Date.parse(t.created_at);
          if (!Number.isNaN(ms) && ms >= 0) b.durations.push(ms);
        }
      }

      const stats = {};
      for (const [callee, b] of Object.entries(buckets)) {
        const settled = b.success + b.failed; // 已终结任务数
        const avgMs = b.durations.length > 0
          ? Math.round(b.durations.reduce((s, x) => s + x, 0) / b.durations.length)
          : null;
        stats[callee] = {
          total: b.total,
          success: b.success,
          failed: b.failed,
          timeout: b.timeout,
          retries: b.retries,
          success_rate: settled > 0 ? `${Math.round((b.success / settled) * 100)}%` : "n/a",
          avg_ms: avgMs,
        };
      }
      // 顶层汇总 + 按 callee 明细。success_rate 分母用已终结任务（不含 running）。
      const summary = {
        total_tasks: tasks.length,
        running: tasks.filter((t) => t.status === "running").length,
        per_agent: stats,
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
    case "bridge_checkpoint": {
      // 状态 checkpoint：手动存/列/恢复 memory.json 命名快照。
      // 快照文件名 memory.json.checkpoint.<name>，与 memory.json 同目录，不碰活文件。
      const ckptName = (args.name || "").trim();
      if (!ckptName) return { content: [{ type: "text", text: "name required" }] };
      // name 只允许字母数字/下划线/连字符，防路径穿越（.. / / 等）
      if (!/^[A-Za-z0-9_-]+$/.test(ckptName)) {
        return { content: [{ type: "text", text: `invalid name '${ckptName}': only [A-Za-z0-9_-] allowed` }] };
      }
      const restore = args.restore === true;
      // list：列已有快照
      if (ckptName === "list") {
        const baks = readdirSync(STATE_DIR)
          .filter((f) => f.startsWith("memory.json.checkpoint."))
          .map((f) => f.slice("memory.json.checkpoint.".length))
          .sort();
        return { content: [{ type: "text", text: baks.length ? `checkpoints (${baks.length}):\n${baks.map((b) => `  ${b}`).join("\n")}` : "(no checkpoints)" }] };
      }
      const ckptFile = join(STATE_DIR, `memory.json.checkpoint.${ckptName}`);
      if (restore) {
        // 恢复：快照 → memory.json（覆盖当前，在锁内做，原子替换）
        if (!existsSync(ckptFile)) {
          return { content: [{ type: "text", text: `checkpoint '${ckptName}' not found` }] };
        }
        withLock(() => {
          const tmp = MEM_FILE + ".tmp";
          copyFileSync(ckptFile, tmp);
          renameSync(tmp, MEM_FILE); // atomic replace（修复非原子 copyFileSync 半写崩溃）
        });
        return { content: [{ type: "text", text: `restored memory.json from checkpoint '${ckptName}'` }] };
      }
      // 存快照：memory.json → memory.json.checkpoint.<name>（在锁内读，确保一致性）
      withLock(() => {
        copyFileSync(MEM_FILE, ckptFile);
      });
      return { content: [{ type: "text", text: `saved checkpoint '${ckptName}'` }] };
    }
  }
  return null;
}

// ----  run_verify handler：LLM-as-judge 质量门禁（2026-08-25）----
// 复用 runAgent 驱动跑评审 agent（默认 claude），让它按 criteria 对 artifact 打分，返回 JSON。
// 分数写回 task.quality_score（供 bridge_stats 聚合，⑰）。低于 threshold 判不通过。
function handleRunVerify(args) {
  // 默认 qwen：-o json 结构化输出，judge 回裸 JSON 稳定；claude -p 常返纯文本/多轮，score 解析不可靠。
  const evaluator = args.evaluator || "qwen";
  const threshold = (typeof args.threshold === "number" && args.threshold >= 0 && args.threshold <= 100) ? args.threshold : 80;
  //  降级验收：判分 < th 但在带内(th-band ≤ score < th) → 降级放行（pass=true + degraded 标记，
  // 记 verify_degraded 理由供追溯/面板）；只有 < th-band 的硬失败才进「重试/升级」状态机。默认带宽 10。
  const degradeBand = (typeof args.degrade_band === "number" && args.degrade_band >= 0 && args.degrade_band <= 50) ? args.degrade_band : 10;
  const prompt = [
    "你是代码质量评审员（LLM-as-judge）。产出物内容和验收标准已经作为数据完整提供给你，请直接据此评审打分。",
    "===== 产出物（待评审内容，已提供，勿再索要）=====",
    "```",
    String(args.artifact || "").slice(0, 12000),
    "```",
    "===== 验收标准 =====",
    String(args.criteria || "").trim(),
    `通过判定：score >= ${threshold}。`,
    "直接开始评分，不要输出任何说明、不要编造、不要反问。只输出一行 JSON，不要用 Markdown 代码块包裹：",
    `{"score": <0-100整数>, "pass": true/false, "feedback": "改进建议"}`,
  ].join("\n");
  const agentName = args.evaluator || "qwen";
  // 默认 300s 对齐 runAgent 全局（原 120s 会掐断长 artifact 的评审，尤其 classifier 限流时）。
  const r = runAgent(agentName, { prompt, task_id: args.task_id, timeout_sec: args.timeout_sec || 300, max_retries: 1 }, { wait: true });
  return Promise.resolve(r).then((resL) => {
    const out = resL.content && resL.content[0] ? resL.content[0].text : "";
    // 提取评审得分：judge(CLI) 会把它要的 {"score":…} 包在外层 wrapper(如 claude -p 的 result/reply 字段)里，
    // 直接锚定文本首个 { 会命中外层包装而非 score 对象。先解出正文再在其内找 score。
    let subject = out;
    try {
      const pc = parseClaudeOut(out);
      if (pc.text && pc.text !== out) subject = pc.text;
    } catch {}
    // 在(reply)正文里找首个 {"score": N…} JSON 对象。
    let score = null, reason = "";
    const sobj = extractJsonObject(subject);
    if (sobj) {
      try {
        const d = JSON.parse(sobj);
        if (d && typeof d.score === "number") score = d.score;
        if (d && typeof d.feedback === "string") reason = d.feedback;
      } catch {}
    }
    // 兜底：① 原输出里直接抓 {"score": N / "feedback"；② 退而求其次——评审文本里形如 "score[:：]?\s*<n>" 也采（judge 偶以 prose 带分数）
    if (score === null) {
      const sm = out.match(/\{\s*"score"\s*:\s*(\d+)/);
      if (sm) score = parseInt(sm[1], 10);
      else {
        const psm = out.match(/score[\s:：]*(\d{1,3})/i);
        if (psm) score = parseInt(psm[1], 10);
      }
      const rm = out.match(/"feedback"\s*:\s*"([^"]*)"/);
      if (rm && rm[1]) reason = rm[1];
    }
    const passed = score !== null && score >= threshold;
    //  降级验收：带内未达标(score ∈ [th-band, th)) → 不判硬失败，降级放行。
    const degraded = score !== null && !passed && score >= threshold - degradeBand;
    const accepted = passed || degraded;
    //  评审重试/升级状态机：非静默循环。累计失败迭代次数，≥3 次仍未过 → 升级（标 escalation_needed）。
    // 防"打回重做"无限静默循环：升级后调用方应知道该人工介入 / 换方案 / 升门，而非再自动重做。
    // 降级放行不算失败：accepted 后清零迭代并写 verify_degraded，不进升级。
    const MAX_VERIFY_ITER = 3;
    let escalated = false;
    if (args.task_id) {
      try {
        const rid = args.task_id;
        updateMem((mq) => {
          const t = mq.tasks[rid];
          if (!t) return;
          const iters = (t.verify_iterations || 0) + 1;
          t.verify_iterations = iters;
          t.last_verify_score = score;
          t.last_verify_pass = accepted;
          if (degraded) {
            // 带内降级验收：放行但如实留痕，供审计/面板打降级徽标。
            t.verify_degraded = { score, threshold, band: degradeBand, reason: reason || "", at: new Date().toISOString() };
            t.verify_iterations = 0;          // 视为通过，重置失败计数
            t.escalation_needed = false;
          } else if (score !== null && !passed && iters >= MAX_VERIFY_ITER) {
            t.escalation_needed = true;              // 升级状态机：硬失败达到阈值还不过 → 升级待人工
            t.escalation_note = `已连续 ${iters} 次未过质量门(最近 ${score}/${threshold})`;
            escalated = true;
          } else if (passed) {
            t.escalation_needed = false;
          }
        });
      } catch {}
    }
    const escLine = escalated ? ` [ESCALATED] 连续多次未过, 需人工/换方案` : "";
    const degLine = degraded ? ` [DEGRADED] 带内降级放行 (score ${score} < th ${threshold}, 带 ${degradeBand})` : "";
    return { content: [{ type: "text", text: `evaluator=${evaluator} score=${score ?? "n/a"}/${threshold} pass=${accepted}${degraded ? " (degraded)" : ""}${reason ? "\nreason: " + reason : ""}${escLine}${degLine}` }] };
  });
}

// ----  演进独立权审·引擎自动落（从空闲 worker 轮询派审，默认 qwen 兜底） ----
// 审闸命中（同工作流演进 ≥2）且 workflow_evolve 传 auto_review:true 时，由引擎从空闲 worker 池
// 轮询派独立第三方视角背书（排除与控制主控同名自我指涉的 worker），而非让主控手打背书串。
// approve=认可继续；decided=false 表示审 worker 未产出明确结论（不可达/parse 失败）→ 上层退回
// 手动审闸，绝不误判为驳回停路线。背书 worker 名经 verdict.by 回传并在结果文案中标注。
function parseReviewVerdict(out) {
  let subject = out;
  try { const pc = parseClaudeOut(out); if (pc.text && pc.text !== out) subject = pc.text; } catch {}
  const obj = extractJsonObject(subject);
  let approve = false, reason = "", decided = false;
  if (obj) {
    try {
      const d = JSON.parse(obj);
      if (typeof d.approve === "boolean") { approve = d.approve; decided = true; }
      if (typeof d.reason === "string") reason = d.reason;
    } catch {}
  }
  if (!decided) {
    const m = out.match(/"approve"\s*:\s*(true|false)/);
    if (m) { approve = m[1] === "true"; decided = true; }
    const rm = out.match(/"reason"\s*:\s*"([^"]*)"/);
    if (rm && rm[1]) reason = rm[1];
  }
  return { approve, reason, decided, by: (arguments[1] || "qwen") }; // by 由调用方传真实审 worker，默认 qwen
}

//  独立权审 worker 轮询选取（用户约定：可从空闲 worker 轮询而非固定死 qwen）。
// 轮询语义：① 排除与控制主控同名的 worker（防自我指涉，保「独立第三方视角」）；
//  ② 排除当前 busy 的 worker（loadMem 判 agent_live 存在即忙）；
//  ③ 从剩余空闲池按模块级指针轮转（round-robin，多次 auto_review 不重复压同一 worker）；
//  ④ 空池/全忙回退 qwen（原默认，保证审闸兜底不因选人失败而卡）。
let reviewPoolIdx = 0;
function currentControllerAgent() {
  try { return JSON.parse(readFileSync(join(STATE_DIR, "control.json"), "utf8"))?.controller?.toLowerCase(); } catch { return null; }
}
function busyWorkerSet() {
  const busy = new Set();
  try {
    const m = loadMem();
    for (const t of Object.values(m.tasks || {})) {
      // 2026-09-23 fix：只看 status==='running' 的 task；agent_live.state 仅作 info。
      //   之前只看 agent_live.state，导致已完成/failed 的 task 残留 busy=true 让 worker 永久卡死。
      if (t?.status === "running" && t?.assigned_to) {
        busy.add(String(t.assigned_to).toLowerCase());
      }
    }
  } catch {}
  return busy;
}
// 2026-09-23 fix：单派发 task（agent_invoke / run_* 直派）默认在面板是「孤儿 task」——
//   task.workflow=null 导致「当前工作流」视图看不到它，等于工作流卡空空而 task 全跑了。
//   修法：单派发入口（agent_invoke / run_*/run_dsh 直调路径）自动给 task 造一张「ad-hoc workflow」
//   卡挂上，让面板按工作流卡聚合显示。caller 可显式传 args.workflow_id / args.workflow_title /
//   args.workflow_tpl 复用同名工作流卡（多次单派归并），缺省则按 (agent + 日期) 派生稳定 id。
//
//   返回 { workflow, workflow_meta }：
//   - workflow     : 要写进 m.workflows[wfId] 的 meta 卡对象（调用方再 updateMem 落库）
//   - workflow_meta: 直接挂到 task.workflow 的精简 meta（id/tpl/step/seq/sub）
function ensureAdHocWorkflow(args, agentName) {
  const wfId = args.workflow_id || `adhoc-${agentName}-${new Date().toISOString().slice(0, 10)}`;
  const title = args.workflow_title || args.title || (String(args.prompt || "").slice(0, 40) + (args.prompt && args.prompt.length > 40 ? "..." : ""));
  const tpl = args.workflow_tpl || "adhoc";
  const nowIso = new Date().toISOString();
  const workflow = {
    id: wfId,
    tpl,
    paradigm: tpl === "adhoc" ? "adhoc" : tpl,
    title,
    agent: agentName,
    created_at: nowIso,
    source: "ad-hoc-agent_invoke",  // 面板可识别为单派发自动造的卡
  };
  const seqN = (typeof args.workflow_seq === "number") ? args.workflow_seq : 0;
  const workflow_meta = {
    id: wfId,
    tpl,
    step: args.workflow_step || `单派发(${agentName})`,
    base: title,
    quality_threshold: 80,
    parallel: false,
    seq: seqN,
    sub: 0,
  };
  return { wfId, workflow, workflow_meta };
}

// 把 ad-hoc workflow 卡落库（m.workflows[wfId]）并把 workflow_meta 塞到 args.workflow_meta 供 runAgent 用。
// 调用方在 dispatch 之前调用一次，runAgent 内部会读 args.workflow_meta 挂到 task.workflow。
function attachAdHocWorkflow(args, agentName) {
  if (args.workflow_meta && args.workflow_meta.id) return;  // caller 已挂，跳过
  const { wfId, workflow, workflow_meta } = ensureAdHocWorkflow(args, agentName);
  updateMem((m) => {
    // 已存在则只补 created_at，保留原 tpl/title（多次单派归并同名卡）。
    if (!m.workflows[wfId]) {
      m.workflows[wfId] = { ...workflow, created_at: m.workflows[wfId]?.created_at || workflow.created_at };
    }
  });
  args.workflow_meta = workflow_meta;
  return { wfId, workflow_meta };
}
// 共享的空闲 worker 选取核心：从注册 worker 池里，排除 exclusions（不含要求名）+ 当前 busy + 轮转指针，
// 返回下一个空闲 worker；池空返回 null（调用方自定兜底）。
function pickIdleWorker(exclusions, busy) {
  const excl = new Set((exclusions || []).filter(Boolean).map((n) => String(n).toLowerCase()));
  const busySet = busy || busyWorkerSet();
  const pool = Object.keys(AGENTS).filter((n) => !excl.has(n.toLowerCase()) && !busySet.has(n.toLowerCase()));
  if (!pool.length) return null;
  const pick = pool[reviewPoolIdx % pool.length];
  reviewPoolIdx = (reviewPoolIdx + 1) % pool.length; // 轮转，避免连续命中同一 worker
  return pick;
}
function pickReviewWorker() {
  const ctl = currentControllerAgent();
  const busy = busyWorkerSet();
  // 空池回退原默认 qwen（审闸兜底，不因选人失败而卡）
  return pickIdleWorker(ctl ? [ctl] : [], busy) || "qwen";
}
// 2026-09-23 fix：worker_* 工具的路径解析——让 worker session 能读主仓库文件，
//   不再被 BRIDGE_WORK_ROOT 锁死。安全模型：
//   · worker 必须传 workdir（主控在 agent_invoke 时已显式授权）
//   · 解析路径必须在 workdir 父树内（不逃逸）
//   · 拒绝 ../ / 绝对路径越权（必须落在 workdir 父树内）
function resolveWorkerAuthorizedPath(workdir, filePath) {
  if (!workdir) throw new Error("workdir required（worker session 必须传授权工作目录）");
  if (!filePath) throw new Error("file_path required");
  const wdAbs = resolve(workdir);
  let target = filePath;
  if (filePath.startsWith("~")) target = join(homedir(), filePath.slice(1));
  const abs = resolve(isAbsolute(filePath) ? target : join(wdAbs, target));
  // 安全检查：abs 必须在 wdAbs 父树内（允许兄弟目录，但不允许逃到祖父以上）
  const wdParent = dirname(wdAbs);
  if (!abs.startsWith(wdParent + sep) && abs !== wdAbs) {
    throw new Error(`path traversal blocked: ${abs} 超出授权 workdir ${wdAbs} 的父树`);
  }
  return abs;
}
function isAbsolute(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\");
}
// 简单 glob → 正则（仅支持 * ? ** 不带方括号字符类，足够 read/grep 用）
function globToRegex(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") { re += ".*"; i++; }
      else re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^$()|{}[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}
// 2026-09-23 fix：workflow_start 落 DAG 后【自动派发】——
//   历史行为：落完 task 后 task.workflow / 依赖都建好但 caller 必须再调 agent_invoke
//   才能让 worker claim/run，导致面板"卡在那不动"被误判为 bug。新行为：
//   workflow_start 返回前自动扫一遍「当前 workflow 涉及的、有 assigned_to 的、依赖已
//   满足（无 dep 或 dep 全 completed）的 pending task」，给它们 spawn worker。
//   收敛/中段 task 因为 dep 未满足留到 caller 用 workflow_evolve 或主控后续触发。
//
//   workdir 默认走 workflow.workdir（调用方在 workflow_start({workdir:"..."}) 时可指定），
//   否则 fallback BRIDGE_WORK_ROOT。
//   fire-and-forget，return 不阻塞。
// 2026-09-23：函数已搬到独立模块 ./workflow-dispatch.mjs（解 run-driver ↔ shared-context-server 循环依赖），
//   这里只是 re-export + 调用入口。
import { autoDispatchWorkflowStages as _autoDispatchWorkflowStages } from "./workflow-dispatch.mjs";
const autoDispatchWorkflowStages = _autoDispatchWorkflowStages;
export { _autoDispatchWorkflowStages as autoDispatchWorkflowStages };
// agent_invoke 自动备路：命名 worker busy 时从空闲池轮询一个备路（排控制主控=不压 main），
// 无空闲则回退到「任何已知工作的 worker」（包括原 requested 自已；调用方传 same_worker:true 才必须精确同名）。
function pickInvokeWorker(requested) {
  const ctl = currentControllerAgent();
  const busy = busyWorkerSet();
  const exclusions = ctl ? [ctl] : []; // 也不选主控（不压 main）
  // 2026-09-23 fix：原实现「exclusions 包含 requested」导致 requested busy 时永远轮不上自己。
  // 改为：如果 requested 不在 busy 里，优先派回它本身（用户意图最准），否则从空闲池挑。
  const requestedBusy = busy.has(String(requested).toLowerCase());
  if (!requestedBusy) return requested;
  return pickIdleWorker(exclusions, busy) || requested;
}

async function runIndependentReview(reviewData) {
  const snap = reviewData || {};
  const prompt = [
    "你是多 Agent 工作流 DAG 演进的【独立第三方评审员】。主控要对同一条演进路线继续前进，把这次的演进合理性交给你独立背书。",
    "请以与主控无利益关系的独立视角评定：「已做的演进是否合理、本次拟处理是否应继续该方向、有无更优路线」。",
    "===== 本次拟处理 =====",
    `action=${snap.action || "?"} task_id=${snap.task_id || "?"} reason=${snap.reason || ""}`,
    "===== 该工作流既有演进留痕 =====",
    JSON.stringify(snap.evolutions || null),
    "===== 当前 DAG 快照 =====",
    snap.dag_snapshot || "(无)",
    "直接输出结论，不要反问、不要编造、不要 Markdown 代码块包裹，只输出一行 JSON：",
    `{"approve": true/false, "reason": "简短理由（approved 说明是否继续该方向；rejected 说明更优路线/为何停）"}`,
  ].join("\n");
  const worker = pickReviewWorker();
  const r = await runAgent(worker, { prompt, timeout_sec: 120, max_retries: 1 }, { wait: true });
  const out = r && r.content && r.content[0] ? r.content[0].text : "";
  const verdict = parseReviewVerdict(out, worker);
  verdict.by = worker; // 记录真实背书 worker（替换 parseReviewVerdict 里写死的 "qwen"）
  return verdict;
}

async function handleAsync(name, args) {
  args = args || {};
  const timeoutMs = (args.timeout_sec || 300) * 1000;

  // ---- 消息总线·实时唤醒读（inbox_wait）——走异步路径，返回 pending Promise，不阻塞服务器 ----
  // 事件驱动：有已 pending 消息 → 立即 resolve(授 60s 租约)；无 → 挂起等 bus_send/agent_send_message
  // fireBusWaiters() 即时唤醒，或超时(wait_ms 默认30s 上限120s)返回 {items:[], timed_out:true}。
  // 因此发送方在"仍等待的接收端"上真正实时唤醒它，无需等下一轮 poll。
  if (name === "inbox_wait") {
    const agent = args.agent;
    const WAIT_MS = Math.min(parseInt(args.wait_ms, 10) || 30000, 120000);
    const filterKind = args.kind || null;
    const filterTopic = args.topic || null;
    // MCP 结果须包成 {content:[{type:"text",text:JSON}]}，否则客户端的 .content[0] 读不到（返回形态即协议契约）。
    const wrap = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
    return new Promise((resolveOut) => {
      // 先取已 pending + 未租他人 + 命中过滤 的消息。有 → 立即 resolve（不空等）。
      // 与 done 的唤醒捞取一致：同时看本 agent 信箱 + 广播信箱("*")，广播消息也能被无过滤订阅者同步取到。
      let grant = null;
      updateMem((m) => {
        if (!m.mailbox) { grant = { items: [], timed_out: false }; return; }
        const now = Date.now();
        const boxes = [m.mailbox[agent], m.mailbox["*"]].filter(Boolean);
        const seen = new Set();
        const yours = [];
        for (const box of boxes) {
          for (const msg of box.msgs) {
            if (seen.has(msg.id)) continue;
            seen.add(msg.id);
            if (msg.consumed) continue;
            const leasedToOther = msg.lease_by && msg.lease_by !== agent && msg.lease > now;
            if (leasedToOther) continue;
            if (filterKind && msg.kind !== filterKind) continue;
            if (filterTopic && msg.topic !== filterTopic) continue;
            yours.push({ msg, box });
          }
        }
        for (const { msg } of yours) { msg.lease = now + BUS_LEASE_MS; msg.lease_by = agent; }
        grant = { items: yours
          .sort((a, b) => (a.msg.created_at || "").localeCompare(b.msg.created_at || ""))
          .map(({ msg }) => ({ id: msg.id, from: msg.from, to: msg.to, kind: msg.kind, topic: msg.topic, priority: msg.priority, body: msg.body, created_at: msg.created_at })), timed_out: false };
      });
      if (grant && grant.items.length > 0) { resolveOut(wrap(grant)); return; }
      // 无 pending：挂起等 send 唤醒。注册 waiter + 超时兜底。
      let settled = false;
      let cancel = () => {};
      const done = (msg, timedOut) => {
        if (settled) return;
        // fire 唤醒：先用触发的 msessage 复判 kind/topic 是否真匹配——不匹配就不 settle,
        // 继续挂起等真正匹配的消息或超时（避免被无关 kind/topic 消息"空唤醒"返回 misleading 空结果）。
        if (!timedOut && msg) {
          if (filterKind && msg.kind !== filterKind) return;
          if (filterTopic && msg.topic !== filterTopic) return;
        }
        settled = true;
        cancel();
        if (timedOut) resolveOut(wrap({ items: [], timed_out: true }));
        else {
          // 被唤醒：把此刻命中过滤的 pending 消息取出（授租约）。同时看本 agent 信箱 + 广播信箱("*")——
          // Fix1 让广播(to="*")能唤醒无过滤订阅者，这里须把广播消息也捞回来，避免"醒了却空"。
          let woke = { items: [] };
          updateMem((m) => {
            if (!m.mailbox) return;
            const now = Date.now();
            const boxes = [m.mailbox[agent], m.mailbox["*"]].filter(Boolean);
            const seen = new Set();
            const yours = [];
            for (const box of boxes) {
              for (const msg of box.msgs) {
                if (seen.has(msg.id)) continue;
                seen.add(msg.id);
                if (msg.consumed) continue;
                const leasedToOther = msg.lease_by && msg.lease_by !== agent && msg.lease > now;
                if (leasedToOther) continue;
                if (filterKind && msg.kind !== filterKind) continue;
                if (filterTopic && msg.topic !== filterTopic) continue;
                yours.push({ msg, box });
              }
            }
            for (const { msg } of yours) { msg.lease = now + BUS_LEASE_MS; msg.lease_by = agent; }
            woke.items = yours
              .sort((a, b) => (a.msg.created_at || "").localeCompare(b.msg.created_at || ""))
              .map(({ msg }) => ({ id: msg.id, from: msg.from, to: msg.to, kind: msg.kind, topic: msg.topic, priority: msg.priority, body: msg.body, created_at: msg.created_at }));
          });
          resolveOut(wrap({ items: woke.items, timed_out: false }));
        }
      };
      cancel = registerBusWaiter(agent, filterTopic, (msg) => done(msg, false));
      setTimeout(() => done(null, true), WAIT_MS);
    });
  }

  if (name === "project_search") {
    return new Promise((res) => {
      const max = args.max ?? 50;
      const searchRoot = args.path ? resolve(args.path) : process.cwd();
      // 跨平台：优先 rg；Linux 兜底 grep；Windows 兜底 findstr /s（含子目录）。
      // 用 child_process.exec + spawn shell 以免 rg 不存在时 ENOENT 处理复杂。命令入参按平台拼。
      const runOne = (argsArr) => new Promise((resolveOut) => {
        const ch = spawn(argsArr[0], argsArr.slice(1), { cwd: process.cwd(), shell: IS_WIN });
        let o = "";
        ch.stdout.on("data", (d) => (o += d.toString()));
        ch.stderr.on("data", (d) => (o += d.toString()));
        ch.on("error", () => resolveOut({ ok: false, cmd: argsArr[0] }));
        ch.on("exit", () => resolveOut({ ok: true, out: o }));
        setTimeout(() => { try { ch.kill(); } catch {} }, timeoutMs);
      });
      (async () => {
        // 1) rg（无 glob 或支持 -g 的）——Linux/Windows 若有 rg 用它
        const rgArgs = ["-n", "--no-heading", "-m", String(max)];
        if (args.glob) rgArgs.push("-g", args.glob);
        rgArgs.push("--", args.pattern, searchRoot);
        const r1 = await runOne(["rg", ...rgArgs]);
        if (r1.ok) return res({ content: [{ type: "text", text: r1.out || "(no matches)" }] });
        // 2) Windows 兜底：findstr /s /n（递归，incl. subdir）
        if (IS_WIN) {
          // findstr 无正则全程 -R，用引号包 pattern；glob 简单透传给 /D 不便，跳过 glob 精确。
          const fArgs = ["/s", "/n", "/r", `/c:"${args.pattern}"`, searchRoot + (args.glob ? `\\${args.glob.replace(/[*?]/g, "*")}` : "\\*")];
          const r2 = await runOne(["findstr", ...fArgs]);
          return res({ content: [{ type: "text", text: r2.ok ? (r2.out || "(no matches)") : "(rg/findstr 均不可用)" }] });
        }
        // 3) Linux 兜底：grep
        const gArgs = ["-rn", "--include=" + (args.glob || "*"), "--", args.pattern, searchRoot];
        const r3 = await runOne(["grep", ...gArgs]);
        return res({ content: [{ type: "text", text: r3.ok ? (r3.out || "(no matches)") : "(rg/grep 均不可用)" }] });
      })();
    });
  }

  // run_* are thin wrappers over the Agent Registry: schemas are unchanged
  // (incl. codex's `auto`), the handler body just delegates to the generic runAgent driver.
  // 2026-09-23 fix：run_* 单派发也挂 ad-hoc workflow 卡，否则 task.workflow=null 不进工作流视图。
  // 同样的 args.workflow_id / args.workflow_title 可让多次 run_* 归并到一张卡。
  if (name === "run_codex") { attachAdHocWorkflow(args, "codex"); return runAgent("codex", args); }
  if (name === "run_claude") { attachAdHocWorkflow(args, "claude"); return runAgent("claude", args); }
  if (name === "run_qwen") { attachAdHocWorkflow(args, "qwen"); return runAgent("qwen", args); }
  if (name === "run_dsh") { attachAdHocWorkflow(args, "dsh"); return runAgent("dsh", args); }
  if (name === "run_qoder") { attachAdHocWorkflow(args, "qoder"); return runAgent("qoder", args); }
  if (name === "run_qoder_cn") { attachAdHocWorkflow(args, "qoder_cn"); return runAgent("qoder_cn", args); }

  //  task_resume：恢复 interrupted/failed/superseded 任务 —— 复用原任务描述 + session_id + workdir，
  //   重新派发给原 worker 续跑（复用原 task_id → runAgent 保留 workflow/dependencies/审点挂链）。
  if (name === "task_resume") return (async () => {
    const t = loadMem().tasks[args.task_id];
    if (!t) return { content: [{ type: "text", text: `task not found: ${args.task_id}` }], isError: true };
    if (!["interrupted", "failed", "superseded"].includes(t.status)) {
      return { content: [{ type: "text", text: `cannot resume task in status "${t.status}"（可恢复态：interrupted / failed / superseded）` }], isError: true };
    }
    const agent = args.agent || t.assigned_to || t.claimed_by || "claude";
    if (!AGENTS[agent]) return { content: [{ type: "text", text: `unknown agent: ${agent}` }], isError: true };
    const sessionId = args.session_id !== undefined ? args.session_id : (t.session_id || null);
    const resumeArgs = { prompt: args.prompt || t.description || t.title || "", task_id: args.task_id };
    if (sessionId) resumeArgs.session_id = sessionId;
    if (args.workdir !== undefined) resumeArgs.workdir = args.workdir; else if (t.workdir) resumeArgs.workdir = t.workdir;
    if (args.model) resumeArgs.model = args.model;
    if (args.timeout_sec) resumeArgs.timeout_sec = args.timeout_sec;
    if (args.max_retries !== undefined) resumeArgs.max_retries = args.max_retries;
    if (args.plan_mode) resumeArgs.plan_mode = args.plan_mode;
    const r = await runAgent(agent, resumeArgs);
    if (r && r.content && r.content[0]) {
      r.content[0].text = `[task_resume] ${args.task_id} → ${agent}${sessionId ? ` (session ${sessionId})` : ""}\n${r.content[0].text}`;
    }
    return r;
  })();

  //  run_verify：LLM-as-judge 质量门禁
  if (name === "run_verify") return handleRunVerify(args);

  //  自动安全硬拦：safe_scan 预扫描，命中→不可自动放行
  if (name === "safe_scan") {
    const s = safetyScan(args.content, args.blocklist);
    if (s.blocked) return { content: [{ type: "text", text: `SAFE=false blocked=true\n命中危险模式 ${s.hits.length} 个: ${s.hits.map((h) => h.slice(0, 40)).join(", ")}\n→ 建议人工回落,勿自动放行本次产物` }] };
    return { content: [{ type: "text", text: `SAFE ok (未命中 blocklist) 可自动放行` }] };
  }

  //  预置工作流模板 DSL：按阶段依赖链把"一次多Agent工作流"落成任务 DAG。
  //   默认模板 bmad（需求→架构→实现→评审）。可用 args.stages 自定义任意阶段链
  //   （如某个组件化重构的拆解），用稳定 args.workflow_id + args.title 让多次扩展共享一张面板卡片。
  //  工作流模板库：预定义 stages 链，template="bmad-lite|review-only|fix-flow|..." 直接复用；
  //   template="_list" 返回全部模板清单。stages 每项可带 agents:[...]（同阶段并行多 Agent）与 parallel:true。
  const WORKFLOW_TEMPLATES = {
    "bmad": [
      { t: "01需求分析", desc: "澄清并明确需求范围/验收标准/约束", th: 70 },
      { t: "02架构设计", desc: "根据需求做架构与模块设计产出方案", th: 75 },
      { t: "03实现", desc: "按设计落地，产出可交付物并达成验收", th: 80 },
      { t: "04质量评审", desc: "对照需求/设计做质量评审收尾", th: 80 },
    ],
    // bmad-lite：精简三段（需求→实现→评审），适合中小任务快速走查
    "bmad-lite": [
      { t: "01需求", desc: "明确需求范围与验收标准", th: 70 },
      { t: "02实现", desc: "按需求落地可交付物", th: 80 },
      { t: "03评审", desc: "对照需求做质量评审收尾", th: 80 },
    ],
    // review-only：仅评审收口（已有产物做质量门）
    "review-only": [
      { t: "01自检", desc: "实现者对照验收标准自检产出", th: 75 },
      { t: "02交叉评审", desc: "独立审核者交叉评审产出", th: 80 },
      { t: "03收敛", desc: "收敛评审意见给出放行/打回结论", th: 80 },
    ],
    // fix-flow：缺陷修复流（复现→定位→修复→验证）
    "fix-flow": [
      { t: "01复现", desc: "复现并确认缺陷触发条件", th: 70 },
      { t: "02定位", desc: "定位根因并给出修复方案", th: 75 },
      { t: "03修复", desc: "落地修复补丁", th: 80 },
      { t: "04验证", desc: "回归验证修复有效且无副作用", th: 80 },
    ],
  };
  if (name === "workflow_start") {
    const tmp = args.template || "bmad";
    //  模板库：template="_list" 返回清单（供面板/编排层枚举可用模板）
    if (tmp === "_list") {
      const list = Object.entries(WORKFLOW_TEMPLATES).map(([k, v]) => `${k}: ${v.length} 阶段 [${v.map((s) => s.t).join("→")}]`).join("\n");
      return { content: [{ type: "text", text: `工作流模板库（template="<name>" 复用，或传 args.stages 自定义）：\n${list}` }] };
    }
    let paradigm = args.paradigm || null;            // "compete"竞争式｜"collaborate"合作式｜"dynamic"动态路由｜null线性链
    const title = (args.title || (tmp === "bmad" ? "bmad 工作流" : "ad-hoc 工作流")).trim();
    let goal = args.goal || "";
    const wfId = args.workflow_id || title || null;    // 稳定 id：同名/同 id 的调用归并成同一工作流卡片
    let routeReason = null;                            // dynamic 路由理由（上墙进 meta + task description）
    // 2026-09-23 fix：workflow_start 接受 args.workdir（主仓库绝对路径），
    //   落到 m.workflows[wfId].workdir，autoDispatchWorkflowStages 用它作为 worker 的授权 read root。
    //   不传则 fallback BRIDGE_WORK_ROOT（worker 仍锁在 sandbox，但至少能跑）。
    const wfWorkdir = args.workdir || BRIDGE_WORK_ROOT;

    // ── 范式任务编排：把「竞争式/合作式」落成带范式语义的 task DAG ──
    //   每个 task 的 workflow 里多带 paradigm + mode/role 字面量：面板据此分组染色
    //   （竞争式「评」= 并行多视角产出 + 主控收敛；合作式「做」= 设计→实施→审核，实施与审核人分离）。
    const makeTask = (m, base) => ({ ...base, id: base.id, title: base.title, dependencies: base.dependencies || [], attempt_id: null, created_by: "workflow_start", created_at: new Date().toISOString(), claimed_at: null, claimed_by: null, completed_at: null, completed_by: null, superseded_by: null, superseded_reason: null, result: null });
    let WF_META = { id: wfId, base: title, quality_threshold: args.threshold || 80 };

    // ⓪ 动态路由「dynamic」：分析 goal 自动选 compete/collaborate，理由上墙，参数缺省填默认。
    //   判据基于 goal 文本特征（无需外部依赖）：评估/对比/择优/选型/评审 → compete；实现/落地/开发/修复/重构 → collaborate；
    //   兜底 collaborate（做比评更通用）。参数缺省时：compete=claude/codex/qwen 三视角，collaborate=claude设计/codex实施/qwen审核。
    if (paradigm === "dynamic") {
      const g = goal.toLowerCase();
      const competeHits = ["评估", "对比", "择优", "多方案", "评审", "选型", "权衡", "比对", "比较", "evaluate", "compare", "assess", "review", "choose"];
      const collabHits = ["实现", "落地", "开发", "修复", "重构", "编码", "实施", "编写", "修改", "implement", "build", "fix", "refactor", "develop", "code"];
      const cScore = competeHits.reduce((n, k) => n + (g.includes(k) ? 1 : 0), 0);
      const bScore = collabHits.reduce((n, k) => n + (g.includes(k) ? 1 : 0), 0);
      const chosen = cScore > bScore ? "compete" : "collaborate";
      routeReason = `动态路由：goal 命中「${chosen === "compete" ? "评估/对比/择优" : "实现/落地/开发"}」类关键词 ${chosen === "compete" ? cScore : bScore} 个（compete=${cScore}, collaborate=${bScore}）→ 选 ${chosen} 范式`;
      // 参数缺省填充默认 agent 分配，再 fall through 到对应分支
      if (chosen === "compete") {
        if (!Array.isArray(args.competitors) || args.competitors.length < 2) {
          args.competitors = [
            { agent: "claude", view: "方案A（推理/架构视角）" },
            { agent: "codex", view: "方案B（实现/工程视角）" },
            { agent: "qwen", view: "方案C（边界/文档视角）" },
          ];
        }
      } else {
        args.designer = args.designer || "claude";
        args.implementer = args.implementer || "codex";
        args.reviewer = args.reviewer || "qwen";
      }
      paradigm = chosen; // 改写后 fall through 到 compete/collaborate 分支
    }

    // ① 竞争式「评」：N 个视角并行独立产出 → 1 个主控收敛
    if (paradigm === "compete") {
      const comps = Array.isArray(args.competitors) ? args.competitors : [];
      if (comps.length < 2) return { content: [{ type: "text", text: `竞争式需 ≥2 个视角: 传 args.competitors:[{agent,view},...]（如 Claude 方案 / Codex 方案 / qwen 边界）` }], isError: true };
      const approveEach = !!args.approve_each_phase;
      const fanIds = [], allIds = [];
      updateMem((m) => {
        m.workflows = m.workflows || {};
        const meta = m.workflows[wfId] || (m.workflows[wfId] = { id: wfId, tpl: "compete", paradigm: "compete", title, workdir: wfWorkdir, created_at: m.workflows[wfId]?.created_at || new Date().toISOString() });
        if (routeReason) meta.route_reason = routeReason;   // dynamic 路由理由上墙
        meta.stages = comps.map((c, i) => `#${i + 1} ${c.agent}·${c.view || "方案"}`).concat(["收敛最优"]);
        meta.updated_at = new Date().toISOString();
        const descPrefix = routeReason ? `${routeReason}\n` : "";
        comps.forEach((c, i) => {
          const pid = generateTaskId();
          m.tasks[pid] = makeTask(m, {
            id: pid,          // 落库带 id：消除外部 t.id 依赖
            title: `${title} · 视角${i + 1}(${c.agent})：${c.view || "独立产出方案"}`,
            description: `${descPrefix}${goal}\n（竞争式#${i + 1}）请以 ${c.agent} 的独立视角产出方案：${c.view || ""}`,
            priority: "high", status: "pending", assigned_to: c.agent || null,
            workdir: c.workdir || null,              // 2026-09-01：只读核对视角可声明源码根，run-driver 派发时落该 cwd（防空沙箱看不到工作区源码目录）
            deliverable: null, acceptance_criteria: null,
            require_approval: approveEach, approved_at: null, approver: null, approval_note: null,
            workflow: { ...WF_META, tpl: "compete", paradigm: "compete", mode: "fanout", seq: i, step: `视角${i + 1}(` + (c.agent || "?") + `)` },
          });
          fanIds.push(pid); allIds.push(pid);
        });
        // 收敛「评」节：依赖全部视角，可指定主控（review by controller）
        const cid = generateTaskId();
        m.tasks[cid] = makeTask(m, {
          id: cid,          // 落库带 id
          title: `${title} · ${args.converge_title || "主控交叉比对·收敛最优方案"}`,
          description: `${descPrefix}${goal}\n（竞争式收敛）属于多 Agent 联合评估的最终步骤：交叉比对上面 ${comps.length} 个视角产出，补盲、去重，收敛出唯一最优方案并给出择优理由。`,
          priority: "high", status: "pending", assigned_to: args.controller || args.converge_agent || (currentControllerAgent && currentControllerAgent()) || "claude",
          deliverable: "收敛方案", acceptance_criteria: "给出一份择优方案 + 落选视角对照",
          require_approval: approveEach, approved_at: null, approver: null, approval_note: null,
          dependencies: fanIds.slice(),
          workflow: { ...WF_META, tpl: "compete", paradigm: "compete", mode: "converge", seq: comps.length, step: "收敛" },
        });
        allIds.push(cid);
      });
      // 2026-09-23 fix：workflow_start 返回前自动派发有 assigned_to 的可执行 stage，
      //   fire-and-forget 让 worker claim/run，不再让 caller 手动调 agent_invoke。
      const dInfo = autoDispatchWorkflowStages(wfId);
      return { content: [{ type: "text", text: `workflow_start(竞争式「评」) [${wfId}] "${title}"\n${comps.map((c, i) => `  ⓘ 视角${i + 1} ${c.agent}="${c.view || "方案"}" (并行)`).join("\n")}\n  ➜ 主控收敛 "${args.converge_title || "收敛最优方案"}"（依赖全部视角）\n面板将展示「评」并行簇 + 收敛汇聚。范式=compete(竞争式)${routeReason ? "\n🧭 " + routeReason : ""}\n自动派发: ${dInfo.dispatched} 个 stage 已 spawn worker${dInfo.skipped ? `（${dInfo.skipped} 个因依赖未满足留待）` : ""}` }] };
    }

    // ② 合作式「做」：设计→实施→审核，审核者与实施者分离（写的人≠查的人）
    if (paradigm === "collaborate") {
      const designer = args.designer || args.stage_agent || "claude";
      const implementer = args.implementer || args.action_agent || "codex";
      const reviewer = args.reviewer || args.check_agent || "claude";
      if (implementer && reviewer && String(implementer).trim().toLowerCase() === String(reviewer).trim().toLowerCase()) {
        return { content: [{ type: "text", text: `合作式约束违例：实施者与审核者不能是同一 Agent（"写的人不正是查的人"）。implementer=${implementer} reviewer=${reviewer}` }], isError: true };
      }
      const approveEach = !!args.approve_each_phase;
      const steps = [
        { key: "design", label: `${args.design_step || "方案设计"}`, who: designer, desc: args.design_desc || "推理/架构/planning：产出方案设计与验收标准", th: args.design_th || 75, deliverable: "设计方案" },
        { key: "implement", label: `${args.implement_step || "代码实施"}`, who: implementer, desc: args.implement_desc || "execution/批量代码生成/补丁：按设计落地", th: args.implement_th || 80, deliverable: "可交付物" },
        { key: "review", label: `${args.review_step || "最终审核"}`, who: reviewer, desc: args.review_desc || "review 强项：验证实施产出、对照设计/验收", th: args.review_th || 80, deliverable: "审核结论" },
      ];
      const ids = [];
      updateMem((m) => {
        m.workflows = m.workflows || {};
        const meta = m.workflows[wfId] || (m.workflows[wfId] = { id: wfId, tpl: "collaborate", paradigm: "collaborate", title, workdir: wfWorkdir, created_at: m.workflows[wfId]?.created_at || new Date().toISOString() });
        if (routeReason) meta.route_reason = routeReason;   // dynamic 路由理由上墙
        meta.stages = steps.map((s) => `${s.label}（${s.who}）`);
        meta.updated_at = new Date().toISOString();
        const descPrefix = routeReason ? `${routeReason}\n` : "";
        for (let i = 0; i < steps.length; i++) {
          const pid = generateTaskId();
          m.tasks[pid] = makeTask(m, {
            id: pid,          // 落库带 id
            title: `${title} · ${steps[i].label}（${steps[i].who}）`,
            description: `${descPrefix}${goal}\n（${paradigm}范式·合作式#${i + 1} ${steps[i].key}）${steps[i].desc}`,
            priority: "high", status: "pending", assigned_to: steps[i].who,
            deliverable: steps[i].deliverable, acceptance_criteria: null,
            require_approval: approveEach, approved_at: null, approver: null, approval_note: null,
            dependencies: i === 0 ? [] : [ids[i - 1]],
            workflow: { ...WF_META, tpl: "collaborate", paradigm: "collaborate", role: steps[i].key, seq: i, step: steps[i].label },
          });
          ids.push(pid);
        }
      });
      // 2026-09-23 fix：自动派发有 assigned_to 的可执行 stage（同步版返回计数）。
      const dInfo = autoDispatchWorkflowStages(wfId);
      return { content: [{ type: "text", text: `workflow_start(合作式「做」) [${wfId}] "${title}"\n  ${steps.map((s, i) => `→ ${s.label}（${s.who}）`).join(" ")}\n设计-实施-审核 三段链，实施与审核分离。面板展示「做」三明治步进器。${routeReason ? "\n🧭 " + routeReason : ""}\n自动派发: ${dInfo.dispatched} 个 stage 已 spawn worker${dInfo.skipped ? `（${dInfo.skipped} 个因依赖未满足留待）` : ""}` }] };
    }

    // ③ 线性阶段链（默认）：bmad / 模板库 / 自定义 stages
    //    并行阶段：stages[i].agents=[a,b,c] 或 parallel:true → 该阶段铺 N 个并行任务，
    //   共享同一前置依赖（同深度），下一阶段依赖该阶段全部任务。单 agent 阶段保持原线性行为。
    const stages = Array.isArray(args.stages) && args.stages.length
      ? args.stages.map((s, i) => {
          const st = typeof s === "string" ? { t: s } : s || {};
          const agents = Array.isArray(st.agents) ? st.agents.filter(Boolean) : null;
          const isParallel = !!(st.parallel || (agents && agents.length > 1));
          return { t: st.title || st.t || `阶段${String(i + 1).padStart(2, "0")}`, desc: st.desc || "", th: st.th || 80, agents, parallel: isParallel };
        })
      : (WORKFLOW_TEMPLATES[tmp]
          ? WORKFLOW_TEMPLATES[tmp].map((s) => ({ ...s, agents: null, parallel: false }))
          : null);
    if (!stages) return { content: [{ type: "text", text: `未知模板: ${tmp}（内置: ${Object.keys(WORKFLOW_TEMPLATES).join(", ")}；或传 args.stages 自定义；template="_list" 列清单）` }], isError: true };
    const ids = [];   // 每个元素是该阶段全部任务 id 的数组（并行阶段=多 id，线性=单 id）
    updateMem((m) => {
      m.workflows = m.workflows || {};
      // 注册工作流元信息（供面板/桥接消费）
      const meta = m.workflows[wfId] || (m.workflows[wfId] = { id: wfId, tpl: tmp, title, workdir: wfWorkdir, created_at: m.workflows[wfId]?.created_at || new Date().toISOString() });
      meta.stages = stages.map((s) => s.t + (s.parallel ? ` ×${(s.agents || [null]).length}` : ""));
      meta.updated_at = new Date().toISOString();
      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        const prevIds = i === 0 ? [] : ids[i - 1];     // 依赖上一阶段全部任务（并行阶段=多前置）
        // agents 数组：显式传 agents（哪怕单个）就按它派发；否则单任务 null（待派发）。并行阶段=多任务。
        const agents = stage.agents && stage.agents.length ? stage.agents : [null];
        const isPar = stage.parallel && agents.length > 1;
        const stageIds = [];
        for (let k = 0; k < agents.length; k++) {
          const pid = generateTaskId();
          const ag = agents[k];
          const suffix = agents.length > 1 ? `·${ag || ("#" + (k + 1))}` : "";
          m.tasks[pid] = {
            id: pid,                   // 落库带 id：消除外部 t.id 依赖（workflow_start 铺的 stage 同理）
            title: `${title} · ${stage.t}${suffix}`,
            description: goal ? `${goal}\n阶段：${stage.desc}` : (stage.desc ? `阶段：${stage.desc}` : null),
            priority: "high",
            status: "pending",
            assigned_to: ag || null,
            deliverable: null,
            acceptance_criteria: null,
            require_approval: !!args.approve_each_phase,
            approved_at: null, approver: null, approval_note: null,
            dependencies: prevIds.slice(),
            attempt_id: null,
            created_by: "workflow_start",
            created_at: new Date().toISOString(),
            claimed_at: null, claimed_by: null,
            completed_at: null, completed_by: null,
            superseded_by: null, superseded_reason: null,
            workflow: { id: wfId, tpl: wfId ? "custom" : tmp, step: stage.t + (suffix ? `(${suffix})` : ""), base: title, quality_threshold: stage.th, parallel: !!isPar, seq: i, sub: k },
            result: null
          };
          stageIds.push(pid);
        }
        ids.push(stageIds);
      }
    });
    const flatIds = ids.flat();
    const parallelStages = stages.filter((s) => s.parallel && s.agents && s.agents.length > 1).length;
    const stageSummary = stages.map((s, i) => s.t + (s.parallel && s.agents ? `×${s.agents.length}` : "") + "=" + ids[i].join("|")).join(", ");
    // 2026-09-23 fix：自动派发可执行 stage（首段没有 dep，自动满足）。
    const dInfo = autoDispatchWorkflowStages(wfId);
    return { content: [{ type: "text", text: `workflow_start [${wfId || tmp}] "${title}" → ${flatIds.length} 任务 / ${stages.length} 阶段${parallelStages ? `（含 ${parallelStages} 个并行阶段）` : ""}: ${stageSummary}\n依赖: 每阶段依赖上一阶段全部任务; 末阶段即终产物${parallelStages ? "；并行阶段同深度多任务共享前置" : ""}。面板「当前工作流」会展示此卡。\n自动派发: ${dInfo.dispatched} 个 stage 已 spawn worker${dInfo.skipped ? `（${dInfo.skipped} 个因依赖未满足留待）` : ""}` }] };
  }

  //  【自适应重规划引擎】（2026-08-28）：单一入口封装四演进 + 服务端强制护栏。
  // 演进护栏从 SKILL「留痕计数」升级为【服务端强制执行】：
  //   · 演进计数 ≤3 —— 存在 m.workflows[wfId].evolve.count，超限拒绝（不再靠主控数笔记）
  //   · 演进 ≥2 独立审 —— 当本次会让 count 达到 ≥2 且未带独立审背书时返回 gate_required（不执行），
  //     调用方须先派 qwen 独立视角背书或人工放行（gate_bypass）再携 independent_review 重试。
  //     独立审本身记进 evolve.reviews（不占 count）。count 只记 DAG 实际改动（append/insert/fork/degrade 各 +1）。
  //   · 不破坏已完成段 —— terminal 任务不可作动作锚点/目标（复用既有 terminal 语义）。
  //   · 统一留痕 —— 每次演进写入 m.workflows[wfId].evolve.evolutions[] + 任务 progress_log
  //   · 面板标记 —— 复用既有 evolve.{kind:fork|append|insert|degrade} 徽标语义
  // 编排层（SKILL）据此把"手调 task_fork/task_depend/task_create + 数笔记记次数"收敛为单个 workflow_evolve 调用。
  if (name === "workflow_evolve") {
    //  演进独立权审·引擎自动落：auto_review===true 时（复用 run_verify 同款 qwen judge 派发 runIndependentReview）
    // —— 审闸命中（同工作流演进 ≥2、无 manual 背书、无 gate_bypass）由引擎自动派 qwen 独立第三方视角背书，
    // 通过携结论重入执行、驳回停当前路线交人工、未决退回手动审闸。默认 false=保持既有手动审闸路径
    // （编排层 SKILL 派 qwen），不隐含 token 成本。调用方显式要自动独立审才开。
    const autoReview = args.auto_review === true;
    // evolveBody：执行一次演进（endorse=预置的独立审背书串）。非审路径一次跑通；审闸命中 + autoReview 时
    // 首次 evolveBody(null) 返回 gate_required，再由 runIndependentReview(qwen) 背书后携结论二次重入执行。
    const evolveBody = (endorse) => {
      const EVOLVE_MAX = 3;
      const REVIEW_THRESHOLD = 2;
      // 提交结果（闭包填入，单锁周期内原子）
      let result;
      updateMem((m) => {
      m.workflows = m.workflows || {};
      const wf = m.workflows[args.workflow_id];
      if (!wf) { result = { ok: false, error: `workflow not found: ${args.workflow_id}（须先 workflow_start 或已有该 id 的卡）` }; return; }
      const ev = wf.evolve = wf.evolve || { count: 0, evolutions: [], reviews: [] };
      const tasks = m.tasks || {};
      const anchor = args.task_id ? tasks[args.task_id] : null;
      if (args.task_id && !anchor) { result = { ok: false, error: `task not found: ${args.task_id}` }; return; }
      const action = args.action;
      const wfId = args.workflow_id;

      // ---- 护栏 3(前置)：terminal 保护 —— 须先于计数/审闸。terminal(已 superseded/failed/
      // completed) 是硬性不合法锚点，先拦；否则会被计数闸或审闸的报错遮住（如对已 superseded
      // 的父再 fork，先该报 "terminal 不可演进" 而非 "须独立审"）。下方动作执行块仍保留各自终态校验。
      const anchorTerminal = !anchor || (action === "fork"
        ? !["running", "pending", "failed"].includes(anchor.status)
        : action === "append" ? anchor.status !== "completed"
        : action === "rollback" ? anchor.status !== "completed"
        : action === "branch" ? ["completed", "failed", "superseded"].includes(anchor.status)
        : ["completed", "failed", "superseded"].includes(anchor.status));
      if (action === "fork" || action === "append" || action === "insert" || action === "degrade" || action === "rollback" || action === "branch") {
        if (anchorTerminal) {
          const msg = action === "fork" ? `fork 锚点须 running/pending，当前 "${anchor?.status}"（terminal 不可演进）`
            : action === "append" ? `append 锚点须 completed（连接新段的尾端完成段），当前 "${anchor?.status}"`
            : action === "rollback" ? `rollback 锚点须 completed（只打回已完成的段重做），当前 "${anchor?.status}"`
            : action === "branch" ? `branch 锚点须非 terminal，当前 "${anchor?.status}"（决策点须有产出）`
            : action === "insert" ? `insert 锚点须非 terminal，当前 "${anchor?.status}"（不可破坏已完成段）`
            : `degrade 锚点须未终态，当前 "${anchor?.status}"`;
          result = { ok: false, error: msg };
          return;
        }
      }

      // ---- 护栏 1：演进计数 ≤3（做任何真实 DAG 改动前先查） ----
      // insert 可能一次既 fork 又 repoint（两步），但计数算「一次演进行动」，只 +1。
      if (ev.count >= EVOLVE_MAX) { result = { ok: false, error: `演进超限：该工作流已演进 ${ev.count}/${EVOLVE_MAX} 次，停工作流交回人工（gate_bypass 也不能破上限）` }; return; }

      // ---- 护栏 2：演进 ≥2 强制独立审（禁自我指涉） ----
      // 本次动作会让 count 达到 ≥2（即当前 count 已 ≥1）时，须独立审背书或人工放行。
      // 记录一条 reviews（计时审次数，供排查"审了几次"），但不计入 count。
      const needReview = ev.count + 1 >= REVIEW_THRESHOLD && ev.count > 0;
      if (needReview) {
        const hasEndorse = (typeof args.independent_review === "string" && args.independent_review.trim().length > 0)
          || (typeof endorse === "string" && endorse.trim().length > 0);
        if (!hasEndorse && !args.gate_bypass) {
          ev.reviews.push({ at: new Date().toISOString(), action, task_id: args.task_id, status: "gate_required", auto_review: autoReview });
          // 自动独立审（qwen）用的评审数据：该工作流 DAG 快照 + 既有演进留痕 + 拟处理动作，供独立视角完整自洽判断
          const dagSnapshot = Object.keys(tasks || {}).filter((id) => tasks[id].workflow && tasks[id].workflow.id === wfId).map((id) => {
            const t = tasks[id];
            return `${t.title} [${t.status}] deps=${JSON.stringify(t.dependencies || [])} by=${t.assigned_to || ""}`;
          }).join("\n");
          result = { ok: false, gate_required: true, auto_review: autoReview, review_data: { workflow_id: wfId, action, task_id: args.task_id, reason: args.reason || "", evolutions: ev.evolutions, dag_snapshot: dagSnapshot }, error: `演进门槛：同工作流累计将达 ${ev.count + 1} 次（≥${REVIEW_THRESHOLD}）须独立审。${autoReview ? "引擎将自动派 qwen 独立视角背书" : "请派 qwen 等独立视角背书写该演进合理性（或人工放行 gate_bypass），再携 independent_review 重试"}。此闸不计入演进计数。` };
          return;
        }
        ev.reviews.push({ at: new Date().toISOString(), action, task_id: args.task_id, status: "reviewed", by: (typeof endorse === "string" && endorse.trim()) ? "qwen_auto" : (args.independent_review ? "manual" : "human_gate_bypass"), note: args.independent_review || endorse || "human_gate_bypass" });
      }

      // ---- 护栏 3：terminal 保护（不破坏已完成段） ----
      if (action === "fork") {
        if (!anchor || !["running", "pending"].includes(anchor.status)) { result = { ok: false, error: `fork 锚点须 running/pending，当前 "${anchor?.status}"（terminal 不可演进）` }; return; }
      } else if (action === "insert") {
        if (!anchor || ["completed", "failed", "superseded"].includes(anchor.status)) { result = { ok: false, error: `insert 锚点须非 terminal，当前 "${anchor?.status}"（不可破坏已完成段）` }; return; }
      } else if (action === "append") {
        // append 锚点指"承接的新段应连到哪个已完成段"——须 completed 才可作依赖尾端锚
        if (!anchor || anchor.status !== "completed") { result = { ok: false, error: `append 锚点须 completed（连接新段的尾端完成段），当前 "${anchor?.status}"` }; return; }
      } else if (action === "degrade") {
        // degrade 锚点 = 评审任务；须非 terminal 且已有 last_verify_score（说明跑过 run_verify）
        if (!anchor || ["completed", "failed", "superseded"].includes(anchor.status)) { result = { ok: false, error: `degrade 锚点须未终态，当前 "${anchor?.status}"` }; return; }

        // ---- 护栏 4：degrade 必须"分数接近但 <th"（否则叫硬失败，须重做/升级非降级） ----
        const th = (typeof args.threshold === "number" && args.threshold > 0) ? args.threshold : (anchor.last_verify ? anchor.last_verify.threshold : 80);
        const sc = (typeof args.score === "number") ? args.score : anchor.last_verify_score;
        if (sc === null || sc === undefined) { result = { ok: false, error: `degrade 缺分数：传 score 或先对该任务跑 run_verify（写入 last_verify_score）` }; return; }
        if (sc >= th) { result = { ok: false, error: `degrade 误用：score ${sc} ≥ th ${th}，属正常通过，无需降级` }; return; }
        if (th - sc > (args.degrade_band || 10)) { result = { ok: false, error: `degrade 越带：score ${sc} 距 th ${th} 超过 degrade_band=${args.degrade_band || 10}，属硬失败，应重做或升级而非降级` }; return; }
        const reason = args.reason || "";
        // 降级放行：标 completed + verify_degraded 留痕 + quality_score 记分。清零 verify_iterations（视为通过）。
        anchor.status = "completed";
        anchor.completed_at = new Date().toISOString();
        anchor.completed_by = anchor.completed_by || "workflow_evolve";
        anchor.quality_score = sc;
        anchor.verify_degraded = { score: sc, threshold: th, band: (args.degrade_band || 10), reason, at: new Date().toISOString(), by: "workflow_evolve" };
        anchor.verify_iterations = 0;
        anchor.escalation_needed = false;
        (anchor.progress_log = anchor.progress_log || []).push({ at: new Date().toISOString(), by: "workflow_evolve:degrade", action: `降级验收放行 score=${sc} / th=${th}（带 ${args.degrade_band || 10}）`, reason });
        ev.count += 1;
        ev.evolutions.push({ at: new Date().toISOString(), action, task_id: args.task_id, wf: wfId, reason });
        result = { ok: true, action, count: ev.count, note: `degrade 降级放行 ${args.task_id} score=${sc}/${th}（带内），已标 completed + verify_degraded。累计演进 ${ev.count}/${EVOLVE_MAX}` };
        return;
      } else if (action === "rollback") {
        // rollback = 阶段回退：只允许打回【已完成】段（锚点 completed）。其余终态(部分完成/failed/superseded)
        // 都不是"回退已完成段"的合法目标——failed 已有 fork 承接，superseded 是被更替父，均不该再回退。
        if (!anchor || anchor.status !== "completed") { result = { ok: false, error: `rollback 锚点须 completed（只回退已完成的段重做），当前 "${anchor?.status}"` }; return; }
      } else if (action === "branch") {
        // branch = 条件分支：决策点锚点须未终态（running/pending——产出未定，尚可据其分歧出分支），
        // 已完成/failed/superseded 均不可作决策点（已完成无分歧，failed 走 fork、superseded 已被更替）。
        // 分支是【增补】新路径、不改动锚点自身与既有已完成段 → 不违反"不破坏已完成段"护栏。
        if (!anchor || ["completed", "failed", "superseded"].includes(anchor.status)) { result = { ok: false, error: `branch 锚点须 running/pending，当前 "${anchor?.status}"（决策点须未终态可分歧）` }; return; }
      }

      // ---- 动作执行 fork / append / insert / rollback / branch（复用既有原语的原子模式，护栏已在上方拦 terminal/超限/审闸） ----
      const ts = new Date().toISOString();
      const reason = args.reason || "";
      if (action === "fork") {
        // 复刻 task_fork：父 running/pending → superseded，子 pending 承接（换备选 agent）。
        const childId = generateTaskId();
        const childAgent = args.fork_to || anchor.assigned_to;
        m.tasks[childId] = {
          id: childId, title: args.fork_title || `${anchor.title} (fork→${childAgent})`,
          description: anchor.description || "", priority: anchor.priority || "medium",
          status: "pending", assigned_to: childAgent,
          deliverable: anchor.deliverable || null, acceptance_criteria: anchor.acceptance_criteria || null,
          require_approval: !!anchor.require_approval,
          approved_at: null, approver: null, approval_note: null,
          dependencies: Array.isArray(anchor.dependencies) ? [...anchor.dependencies] : [],
          attempt_id: null, stale_attempt_ids: [], reassigning: false,
          created_by: "workflow_evolve", created_at: ts,
          claimed_at: null, claimed_by: null, completed_at: null, completed_by: null,
          superseded_by: null, superseded_reason: null, result: null,
          last_heartbeat_at: null, heartbeat_n: 0, heartbeat_interval_ms: null, progress_log: [],
          escalation: null,
          evolve: { kind: "fork", of: args.task_id, at: ts, reason },
          workflow: (anchor.workflow || { id: wfId })
        };
        anchor.status = "superseded";
        anchor.superseded_by = childId;
        anchor.superseded_reason = reason;
        anchor.completed_at = ts;
        (anchor.progress_log = anchor.progress_log || []).push({ at: ts, by: "workflow_evolve:fork", action: `衍生备选子任务 ${childId}→${childAgent}`, reason });
        ev.count += 1;
        ev.evolutions.push({ at: ts, action, task_id: args.task_id, child_id: childId, wf: wfId, reason });
        result = { ok: true, action, count: ev.count, forked_id: childId, note: `fork 备选：${args.task_id}→${childId} 换 ${childAgent} 承接，父已 superseded。累计演进 ${ev.count}/${EVOLVE_MAX}` };
        return;
      }
      if (action === "append") {
        // 后置追加：新段任务连到锚点（已完成段尾端），不另起工作流、不动旧段。
        const newId = generateTaskId();
        m.tasks[newId] = {
          id: newId, title: args.append_title || `${wf.base || wf.title || wfId} · 追加段`,
          description: args.prepend_task_desc || "", priority: "high", status: "pending",
          assigned_to: args.fork_to || null, deliverable: null, acceptance_criteria: null,
          require_approval: false, approved_at: null, approver: null, approval_note: null,
          dependencies: [args.task_id],           // 连锚点（更新完成的段），继承其后
          attempt_id: null, stale_attempt_ids: [], reassigning: false,
          created_by: "workflow_evolve", created_at: ts,
          claimed_at: null, claimed_by: null, completed_at: null, completed_by: null,
          superseded_by: null, superseded_reason: null, result: null,
          last_heartbeat_at: null, heartbeat_n: 0, heartbeat_interval_ms: null, progress_log: [],
          escalation: null,
          evolve: { kind: "append", of: args.task_id, at: ts, reason },
          workflow: { ...(anchor.workflow || { id: wfId }), step: "追加:" + (args.append_title || "新段") }
        };
        if (wf.stages) wf.stages.push(`＋ ${args.append_title || "追加段"}`);
        ev.count += 1;
        ev.evolutions.push({ at: ts, action, task_id: newId, linked_to: args.task_id, wf: wfId, reason });
        result = { ok: true, action, count: ev.count, appended_id: newId, note: `append 追加段 ${newId}，依赖锚点 ${args.task_id}（已完成段未动）。累计演进 ${ev.count}/${EVOLVE_MAX}` };
        return;
      }
      if (action === "insert") {
        // 前置插入：fork 出补丁分支 + 用 task_depend 语义重算锚点依赖插入该前置，还原原设计。
        // 反链无环校验（锚点不能间接依赖新前置，否则成环）。
        const patchId = generateTaskId();
        const patchAgent = args.fork_to || null;
        m.tasks[patchId] = {
          id: patchId, title: args.append_title || `前置:${args.prepend_task_desc || "补决策"}`,
          description: args.prepend_task_desc || "", priority: "high", status: "pending",
          assigned_to: patchAgent, deliverable: null, acceptance_criteria: null, require_approval: false,
          approved_at: null, approver: null, approval_note: null,
          dependencies: Array.isArray(anchor.dependencies) ? [...anchor.dependencies].filter((d) => d !== args.task_id) : [],
          attempt_id: null, stale_attempt_ids: [], reassigning: false,
          created_by: "workflow_evolve", created_at: ts,
          claimed_at: null, claimed_by: null, completed_at: null, completed_by: null,
          superseded_by: null, superseded_reason: null, result: null,
          last_heartbeat_at: null, heartbeat_n: 0, heartbeat_interval_ms: null, progress_log: [],
          escalation: null,
          evolve: { kind: "insert", of: args.task_id, at: ts, reason },
          workflow: (anchor.workflow || { id: wfId })
        };
        // 无环校验：锚点不能反过来依赖到 patchId（patchId 已依赖锚点原依赖，若锚点再依赖 patch 即回环）。
        const kn = anchor.dependencies || [];
        if (kn.includes(patchId)) { delete m.tasks[patchId]; result = { ok: false, error: `insert 成环：锚点依赖含新前置` }; return; }
        // 锚点原依赖保留，追加新前置在首位？原设计是"在 S3 前插 S2.5"→ 锚点依赖改为 [patchId](+原依赖)。
        anchor.dependencies = [patchId, ...kn.filter((d) => d !== patchId)];
        (anchor.progress_log = anchor.progress_log || []).push({ at: ts, by: "workflow_evolve:insert", action: `前置插入 ${patchId}，锚点依赖 → [${anchor.dependencies.join(", ")}]`, reason });
        if (anchor.evolve) anchor.evolve.sub = { kind: "insert", at: ts, reason }; else anchor.evolve = { kind: "insert", at: ts, reason };
        if (wf.stages) wf.stages.unshift(`⟳ ${args.prepend_task_desc || "补决策"}`);
        ev.count += 1;
        ev.evolutions.push({ at: ts, action, task_id: patchId, into: args.task_id, wf: wfId, reason });
        result = { ok: true, action, count: ev.count, inserted_id: patchId, note: `insert 前置 ${patchId} 插入 ${args.task_id} 依赖链，已完成段不动，无环。累计演进 ${ev.count}/${EVOLVE_MAX}` };
        return;
      }
      if (action === "rollback") {
        // 阶段回退：把锚点（已完成段）打回 running 重做，并沿依赖链失效其后所有下游段（superseded）。
        // 语义要点：若只回退锚点而下游仍是 completed，会造成"下游依赖一个已废弃产出"的悬空——下游必须跟着失效重跑。
        // 这是对"不破坏已完成段"护栏的显式豁免：rollback 即授权推翻已完成段。下游逐段留 superseded_reason +
        // rollback_from 溯源链（本体→被谁回退→回退到哪），审计可循。锚点与下游均置 running/pending 前先清完成态。
        const toRoll = [];                      // 将被回退的锚点
        const down = [];                        // 将失效的下游（BFS，含依赖锚点的直接/间接段）
        const depBt = new Map();                // id -> [依赖它的任务ids]（反查下游）
        Object.values(m.tasks).forEach((lt) => {
          (Array.isArray(lt.dependencies) ? lt.dependencies : []).forEach((d) => {
            if (m.tasks[d]) { if (!depBt.has(d)) depBt.set(d, []); depBt.get(d).push(lt.id); }
          });
        });
        // BFS 收集锚点下游
        const q = [args.task_id];
        while (q.length) {
          const cur = q.shift();
          (depBt.get(cur) || []).forEach((nxt) => {
            if (!down.includes(nxt) && m.tasks[nxt]) { down.push(nxt); q.push(nxt); }
          });
        }
        // 打回锚点
        toRoll.push(args.task_id);
        m.tasks[args.task_id].status = "running";
        m.tasks[args.task_id].claimed_by = null;
        m.tasks[args.task_id].completed_at = null;
        m.tasks[args.task_id].completed_by = null;
        m.tasks[args.task_id].exit_code = null;
        m.tasks[args.task_id].result = null;
        m.tasks[args.task_id].quality_score = null;
        m.tasks[args.task_id].verify_degraded = null;
        (m.tasks[args.task_id].progress_log = m.tasks[args.task_id].progress_log || []).push({ at: ts, by: "workflow_evolve:rollback", action: `打回重做 ${args.task_id}`, reason });
        // 失效下游（去重锚点，若下游 === 锚点本身则跳过）
        [...new Set(down)].filter((id) => id !== args.task_id).forEach((id) => {
          const dt = m.tasks[id];
          if (!dt || ["superseded"].includes(dt.status)) return; // 已 superseded 不再覆盖
          dt.status = "superseded";
          dt.superseded_by = args.task_id;                // 指出被谁回退影响
          dt.superseded_reason = `rollback 失效（回退 ${args.task_id} 后下游重跑）: ${reason}`;
          dt.completed_at = dt.completed_at || ts;
          (dt.progress_log = dt.progress_log || []).push({ at: ts, by: "workflow_evolve:rollback", action: `下游失效 ${id}`, reason });
          if (dt.evolve) dt.evolve.sub = { kind: "rollback", at: ts, reason }; else dt.evolve = { kind: "rollback", at: ts, reason };
        });
        if (wf.stages) wf.stages.push(`↩ 回退:${args.task_id} → ${down.length} 下游失效`);
        ev.count += 1;
        ev.evolutions.push({ at: ts, action, task_id: args.task_id, invalidated: down.filter((id) => id !== args.task_id), wf: wfId, reason });
        result = { ok: true, action, count: ev.count, rolled_back: args.task_id, invalidated_downstream: down.filter((id) => id !== args.task_id), note: `rollback 阶段回退 ${args.task_id}（completed→running 重做）+ ${down.filter((id) => id !== args.task_id).length} 个下游段 superseded 失效重跑。累计演进 ${ev.count}/${EVOLVE_MAX}` };
        return;
      }
      if (action === "branch") {
        // 条件分支：决策点锚点未终态（产出尚在动荡）→ 引擎自建一个 pending 分支段承接，依赖锚点。
        // 语义：锚点自身不改动（不 supersede、不删已完成段），分支任务作为其延续路径挂 depend on 决策点
        // （决策点完成后分支才可执行——即"据产出决定是否走此分支"）。分支任务带 evolve.kind=branch + branch_condition 留痕。
        // 若决策方已预建好分支任务（branch_to），则连到它而非新建（避免重复建）。
        const branchId = args.branch_to && m.tasks[args.branch_to] ? args.branch_to : generateTaskId();
        if (!m.tasks[branchId]) {
          m.tasks[branchId] = {
            id: branchId, title: args.append_title || `${anchor.title} → (条件分支:${args.branch_condition || "按产出分歧"})`,
            description: args.prepend_task_desc || "", priority: anchor.priority || "medium", status: "pending",
            assigned_to: args.fork_to || anchor.assigned_to, deliverable: null, acceptance_criteria: null,
            require_approval: !!anchor.require_approval, approved_at: null, approver: null, approval_note: null,
            dependencies: [args.task_id], attempt_id: null, stale_attempt_ids: [], reassigning: false,
            created_by: "workflow_evolve", created_at: ts, claimed_at: null, claimed_by: null,
            completed_at: null, completed_by: null, superseded_by: null, superseded_reason: null, result: null,
            last_heartbeat_at: null, heartbeat_n: 0, heartbeat_interval_ms: null, progress_log: [],
            escalation: null,
            evolve: { kind: "branch", of: args.task_id, at: ts, reason, condition: args.branch_condition || null },
            workflow: (anchor.workflow || { id: wfId })
          };
        }
        (anchor.progress_log = anchor.progress_log || []).push({ at: ts, by: "workflow_evolve:branch", action: `决策点分歧 → 分支 ${branchId}（条件:${args.branch_condition || "无"}）`, reason });
        if (anchor.evolve) anchor.evolve.sub = { kind: "branch", at: ts, reason, condition: args.branch_condition || null }; else anchor.evolve = { kind: "branch", at: ts, reason, condition: args.branch_condition || null };
        if (wf.stages) wf.stages.push(`⎇ 分支:${args.branch_condition || "按产出分歧"} → ${branchId}`);
        ev.count += 1;
        ev.evolutions.push({ at: ts, action, task_id: branchId, of: args.task_id, wf: wfId, reason, condition: args.branch_condition || null });
        result = { ok: true, action, count: ev.count, branch_id: branchId, note: `branch 条件分支：${args.task_id} 决策点分歧 → 分支段 ${branchId}（${args.branch_condition || "按产出分歧"}，依赖锚点）。累计演进 ${ev.count}/${EVOLVE_MAX}` };
        return;
      }
      result = { ok: false, error: `未知 action: ${action}` };
      });
      return result;
    };
    const first = evolveBody(typeof args.independent_review === "string" ? args.independent_review : undefined);
    // 审闸命中且开自动独立审 → 引擎从空闲 worker 池轮询派独立视角背书（默认 qwen，非固定死）
    if (first && first.gate_required && autoReview) {
      return runIndependentReview(first.review_data).then((verdict) => {
        const by = verdict.by || "qwen";
        if (!verdict.decided) {
          return { content: [{ type: "text", text: `[GATE_REQUIRED] ${first.error}\n（引擎自动 ${by} 独立审未得明确结论，退回人工派审或 gate_bypass 放行）` }], isError: false };
        }
        if (!verdict.approve) {
          return { content: [{ type: "text", text: `[REVIEW_REJECTED] 演进独立权审（${by}）驳回：${verdict.reason || "未说明"}。停当前演进路线交回人工。` }], isError: true };
        }
        const second = evolveBody(verdict.reason || `${by} 独立审通过`);
        if (!second.ok) return { content: [{ type: "text", text: `error: ${second.error}` }], isError: true };
        return { content: [{ type: "text", text: `${second.note}\n（独立权审 ${by} 背书：${verdict.reason || ""}）` }] };
      });
    }
    if (!first.ok) return { content: [{ type: "text", text: first.gate_required ? `[GATE_REQUIRED] ${first.error}` : `error: ${first.error}` }], isError: true };
    return { content: [{ type: "text", text: `${first.note}` }] };
  }

  // ----  Orchestrator 自动拆解（L1 拆解生成 + L2 结构自检 + L3 人审闸标记） ----
  // 给一句话 goal → 拆解器模型产 stages[]（title/description/criteria/agent/depends_on）
  // → 结构自检（非空/每段可有验收 criteria/agent 注册/依赖引用合法/无环反向DFS/≤8段）
  // → 复杂度判 L3 审闸（段数>阈值 或 跨 agent 并行 或 criteria 缺失不过审）→ approval_required。
  // 拆解器经 runAgent：自动继承 429 退避/多模型轮转/isFakeSuccess（L0 环境保障）。
  if (name === "workflow_plan") {
    if (!args.goal && !args.stages) return { content: [{ type: "text", text: "error: goal（或 stages 手填计划）必填" }], isError: true };
    // 拆解器选型：调用方显式传 decomposer 则用；否则从空闲 worker 池轮询选（排控制主控，自拆会自我指涉），
    // 全忙回退 qwen（原默认）。不固定死某 worker，多人并发拆解不叠压。
    const ctlDec = currentControllerAgent();
    const decomposer = args.decomposer || pickIdleWorker(ctlDec ? [ctlDec] : [], busyWorkerSet()) || "qwen";
    const agentNames = Object.keys(AGENTS || {});   // 从注册表取可用 worker 名供拆解器选与校验
    const approveThreshold = (typeof args.approve_threshold === "number" && args.approve_threshold > 0) ? args.approve_threshold : 3;
    // stages 手填覆盖（供主控直接喂已知良好计划 / 测试落地）：跳过拆解器，直接进 L2 自检 + L4 落地
    const hasHandStages = Array.isArray(args.stages) && args.stages.length > 0;
    let stages = [];
    if (hasHandStages) {
      // 主控手填：把 {stage 结构} 归一成 {title/description/criteria/agent/depends_on}，agent 缺省空闲池轮询
      // （排控制主控，各未指定段按轮转指针分摊到不同空闲 worker；全忙回退 claude 原默认）。
      const ctlHs = currentControllerAgent();
      const busyHs = busyWorkerSet();
      stages = args.stages.map((s) => ({
        title: s.title || s.t || "阶段",
        description: s.desc || s.description || "",
        criteria: s.criteria || s.acceptance_criteria || "",
        agent: s.agent || s.who || (pickIdleWorker(ctlHs ? [ctlHs] : [], busyHs) || "claude"),
        depends_on: Array.isArray(s.depends_on) ? s.depends_on : []
      }));
    } else {
    const prompt = [
      "你是多 Agent 工作流编排的【任务拆解器】。把一句话目标拆成可派发给多个 worker 的多段 DAG 计划。",
      "拆解原则：每段单一职责、有可验收的验收标准(criteria)、段间依赖正确（先调研才能实现）、按段性质选 worker（推理/决策派 claude，批量代码/实现派 codex，多方案评竞派 qwen/opencode）。",
      "【铁律】这是纯拆解规划任务，你只负责输出计划文本：禁止调用任何工具/函数/MCP/agent，禁止探索/调研/读文件，禁止 `<function>`/`<mcp_>`/`<parameter>` 标签或 XML 包裹。不要反问、不要解释，直接给 一行 JSON。",
      `可用 worker（agent）名：${agentNames.join(", ")}。`,
      "===== 目标任务 =====",
      String(args.goal || ""),
      args.context ? `===== 补充上下文 =====\n${String(args.context)}` : "",
      "直接输出结论，不要 Markdown 代码块包裹，只输出一行纯 JSON（数组 stages）：",
      `{"stages":[{"title":"段标题","description":"这段做什么","criteria":"可验收标准(具体、可判过/不过)","agent":"ser one worker 名","depends_on":["上一段 title"]}]}`,
      "要求：depends_on 只引用同计划其它段的 title；每段必须同时给出 criteria；段数 1-8 段；依赖必须无环（先做前置再做后置）。若任务很小单段可完成，只给 1 段。",
    ].join("\n");
    const r = await runAgent(decomposer, { prompt, timeout_sec: args.timeout_sec || 120, max_retries: 2 }, { wait: true });
    const out = r && r.content && r.content[0] ? r.content[0].text : "";
    if (!out) return { content: [{ type: "text", text: `error: 拆解器 ${decomposer} 无输出（429/未知，可换 decomposer 或重试）` }], isError: true };
    // 解出 stages 数组（复用 run_verify 的解析辅助）
    let subject = out;
    try { const pc = parseClaudeOut(out); if (pc.text && pc.text !== out) subject = pc.text; } catch {}
    stages = [];
    const obj = extractJsonObject(subject);
    if (obj) { try { const d = JSON.parse(obj); if (Array.isArray(d.stages)) stages = d.stages; else if (Array.isArray(d)) stages = d; } catch {} }
    if (!stages.length) { const m = out.match(/"stages"\s*:\s*\[/); if (m) { const arr = extractJsonObject(subject.slice(m.index)); if (arr) { try { const d = JSON.parse(arr); if (Array.isArray(d.stages)) stages = d.stages; } catch {} } } }
    if (!stages.length) return { content: [{ type: "text", text: `error: 无法从拆解器输出解出 stages 数组：\n${String(out).slice(0, 800)}` }], isError: true };
    }  // end else (model decompose)

    // ---- L2 结构自检 ----
    const errors = [];
    if (stages.length > 8) errors.push(`段数 ${stages.length} 超 8 上限`);
    const byTitle = new Map();
    stages.forEach((s, i) => { if (s && s.title) byTitle.set(String(s.title), i); });
    let acyclic = true;
    const visited = new Set(), inStack = new Set();
    const visit = (i) => {
      if (inStack.has(i)) { acyclic = false; return; }
      if (visited.has(i)) return;
      inStack.add(i); visited.add(i);
      const deps = Array.isArray(stages[i]?.depends_on) ? stages[i].depends_on : [];
      for (const d of deps) {
        const j = byTitle.get(String(d));
        if (j === undefined) { errors.push(`段 ${stages[i]?.title} 的依赖 "${d}" 未引用同计划其它段`); continue; }
        visit(j);
      }
      inStack.delete(i);
    };
    for (let i = 0; i < stages.length; i++) visit(i);
    if (!acyclic) errors.push("依赖成环");
    stages.forEach((s, i) => {
      if (!s || typeof s !== "object") { errors.push(`第 ${i + 1} 段非对象`); return; }
      if (!s.title || !String(s.title).trim()) errors.push(`第 ${i + 1} 段缺 title`);
      if (!s.description || !String(s.description).trim()) errors.push(`段 "${s.title || i}" 缺 description`);
      if (!s.criteria || !String(s.criteria).trim()) errors.push(`段 "${s.title || i}" 缺 criteria（无验收标准）`);
      if (s.agent && !agentNames.includes(s.agent)) errors.push(`段 "${s.title}" 的 agent "${s.agent}" 未注册（可用 ${agentNames.join(", ")}）`);
    });

    // ---- L3 人审闸：复杂度判 ----
    const hasCrossAgent = new Set(stages.filter((s) => s && s.agent).map((s) => s.agent)).size > 1;
    const approvalRequired = errors.length === 0 && (stages.length > approveThreshold || (hasCrossAgent && stages.length > 1));
    const cleanStages = stages.map((s, i) => ({
      idx: i + 1, title: s.title || `段${i + 1}`, description: s.description || "", criteria: s.criteria || "",
      agent: s.agent || "claude", depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
    }));
    const planText = cleanStages.map((s) => `#${s.idx} [${s.agent}] ${s.title}\n  做: ${s.description.replace(/\n/g, " ")}\n  验收: ${s.criteria.replace(/\n/g, " ")}${s.depends_on.length ? `\n  依赖: ${s.depends_on.join(", ")}` : ""}`).join("\n");

    // ---- L4 自动落地（可选 auto_land=true 且 L2 通过 且 非 L3 人审闸）----
    // 把已 approved/small 的灵活计划直接落成真实 task DAG（工作流卡），免主控手动再 workflow_start 一次。
    // 依赖按 title→idx 解析成前置 task_id；无环已由 L2 反向 DFS 保证。
    if (args.auto_land === true && errors.length === 0 && !approvalRequired) {
      const goalStr = args.goal || args.title || "工作流";
      const wfId = args.workflow_id || goalStr.slice(0, 24).replace(/[^\w一-龥-]+/g, "-");
      const title = args.title || goalStr.slice(0, 40);
      const idxByTitle = new Map(cleanStages.map((s, i) => [s.title, i]));
      const resolvedDep = (s) => {
        const out = [];
        if (Array.isArray(s.depends_on)) for (const d of s.depends_on) { const j = idxByTitle.get(String(d)); if (j !== undefined) out.push(j); }
        return out;
      };
      const taskIdsByIdx = cleanStages.map(() => generateTaskId());
      updateMem((m) => {
        m.workflows = m.workflows || {};
        const meta = m.workflows[wfId] || (m.workflows[wfId] = { id: wfId, tpl: "custom", title, created_at: new Date().toISOString() });
        meta.stages = cleanStages.map((s) => s.title);
        meta.updated_at = new Date().toISOString();
        cleanStages.forEach((s, i) => {
          const pid = taskIdsByIdx[i];
          const prev = resolvedDep(s);
          m.tasks[pid] = {
            id: pid, title: `${title} · ${s.title}`, description: `${goalStr}\n阶段：${s.description}\n验收：${s.criteria}`,
            priority: "high", status: "pending", assigned_to: s.agent || null,
            deliverable: null, acceptance_criteria: s.criteria || null, require_approval: false,
            approved_at: null, approver: null, approval_note: null,
            dependencies: prev.map((p) => taskIdsByIdx[p]), attempt_id: null,
            created_by: "workflow_plan", created_at: new Date().toISOString(),
            claimed_at: null, claimed_by: null, completed_at: null, completed_by: null,
            superseded_by: null, superseded_reason: null,
            workflow: { id: wfId, tpl: "custom", step: s.title, base: title, quality_threshold: 80, parallel: false, seq: i, sub: 0 },
            result: null,
          };
        });
      });
      return { content: [{ type: "text", text: `workflow_plan→auto_land ✓ [${wfId}] "${title}" 已落成 ${cleanStages.length} 段真实任务 DAG。\n${cleanStages.map((s) => `  #${s.idx} [${s.agent}] ${s.title} = ${taskIdsByIdx[s.idx - 1]}`).join("\n")}\n面板「当前工作流」出卡；段按 depends_on 已连前置。"` }] };
    }

    return { content: [{ type: "text", text: `${errors.length ? "自检未过（见下）" : "拆解可执行"} · ${cleanStages.length} 段 · 跨agent=${hasCrossAgent} · ${approvalRequired ? "【L3 需人审】" : "【auto-approve 可直跑】"}\n${planText}${errors.length ? "\n\n[自检错误]\n" + errors.join("\n") : ""}` }] };
  }

  // ----   结果冲突仲裁：多 worker 对同一问题不同答案时自动裁决 ----
  // 三层：①多数一致（结论相同直接过）→ ②专家加权（claude 推理 3 / codex 执行 2 / 其它 1，
  // confidence 可选加权）→ ③仍无胜者派 LLM 仲裁者（空闲池轮询，排控制主控防自我指涉，全忙回退 qwen）。
  // 只裁决不建任务；供 Orchestrator 合并多 worker 并行产出（ 配套）。
  if (name === "result_arbitrate") return (async () => {
    const cands = Array.isArray(args.candidates) ? args.candidates.filter((c) => c && typeof c.answer === "string" && c.answer.trim()) : [];
    if (cands.length < 2) return { content: [{ type: "text", text: "error: candidates 需 ≥2 份非空候选结果" }], isError: true };
    const question = String(args.question || "").trim();
    if (!question) return { content: [{ type: "text", text: "error: question（被裁决的问题）必填" }], isError: true };

    // 专家权重：claude 推理 3 / codex 执行 2 / 其它 1（ 设计输入）
    const expertWeight = (a) => ({ claude: 3, codex: 2 }[String(a || "").toLowerCase()] ?? 1);
    const detail = cands.map((c, i) => ({
      idx: i + 1, agent: c.agent || "(unknown)", task_id: c.task_id || null,
      weight: expertWeight(c.agent), confidence: typeof c.confidence === "number" ? c.confidence : null,
      answer_head: String(c.answer).slice(0, 120),
    }));

    // ---- 层① 多数一致：答案归一（去首尾空白/小写）后完全相同即视为同一结论 ----
    const norm = (s) => String(s).trim().toLowerCase();
    const groups = new Map();
    cands.forEach((c, i) => { const k = norm(c.answer); (groups.get(k) || groups.set(k, []).get(k)).push(i); });
    let winner = null, layer = null, reason = "";
    for (const [k, idxs] of groups) {
      if (idxs.length > 1 && idxs.length > (cands.length / 2)) { winner = idxs[0]; layer = "majority"; reason = `${idxs.length}/${cands.length} 候选结论一致（多数一致优先）`; break; }
    }

    // ---- 层② 专家加权（+可选 confidence 归一 0-1 加成）：最高分唯一胜出 ----
    if (winner === null) {
      const scores = cands.map((c) => {
        let s = expertWeight(c.agent);
        if (typeof c.confidence === "number" && c.confidence >= 0 && c.confidence <= 100) s += c.confidence / 100; // 置信度最多 +1
        return s;
      });
      const max = Math.max(...scores);
      const topIdxs = scores.map((s, i) => (s === max ? i : -1)).filter((i) => i >= 0);
      if (topIdxs.length === 1) { winner = topIdxs[0]; layer = "weighted"; reason = `专家加权最高分 ${max.toFixed(2)}（claude=3/codex=2/其它=1${typeof cands[winner].confidence === "number" ? " + confidence" : ""}）唯一胜出`; }
    }

    // ---- 层③ LLM 仲裁：仍无胜者（平局/全异）→ 空闲池轮询派仲裁者背书 ----
    if (winner === null) {
      const arbiter = args.arbiter || pickReviewWorker();
      const prompt = [
        "你是多 Agent 结果冲突的【独立仲裁者】。多个 worker 对同一问题给出了不同答案，请独立裁决哪个最优。",
        "【铁律】这是纯裁决任务，你只负责输出裁决文本：禁止调用任何工具/函数/MCP/agent，禁止探索/调研/读文件，禁止 <function>/<mcp_>/<parameter> 标签。不要反问、不要解释，直接给一行 JSON。",
        "===== 问题 =====",
        question,
        args.criteria ? `===== 裁决依据 =====\n${String(args.criteria)}` : "",
        "===== 候选 =====",
        cands.map((c, i) => `#候选${i + 1} [${c.agent || "unknown"}]\n${String(c.answer).slice(0, 6000)}`).join("\n---\n"),
        "直接输出结论，不要 Markdown 代码块包裹，只输出一行纯 JSON：",
        `{"winner": 候选编号(1-N 的数字), "reason": "简短裁决理由"}`,
      ].join("\n");
      const r = await runAgent(arbiter, { prompt, timeout_sec: 120, max_retries: 1 }, { wait: true });
      const out = r && r.content && r.content[0] ? r.content[0].text : "";
      let subject = out;
      try { const pc = parseClaudeOut(out); if (pc.text && pc.text !== out) subject = pc.text; } catch {}
      const obj = extractJsonObject(subject);
      let pick = null, why = "";
      if (obj) { try { const d = JSON.parse(obj); if (typeof d.winner === "number" && d.winner >= 1 && d.winner <= cands.length) pick = d.winner - 1; if (typeof d.reason === "string") why = d.reason; } catch {} }
      if (pick === null) { const m = out.match(/"winner"\s*:\s*(\d+)/); if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= cands.length) pick = n - 1; } const rm = out.match(/"reason"\s*:\s*"([^"]*)"/); if (rm && rm[1]) why = rm[1]; }
      if (pick === null) {
        return { content: [{ type: "text", text: `error: 仲裁者 ${arbiter} 未决（无有效 winner JSON，可换 arbiter 或重试）\n原始输出前 400 字：\n${String(out).slice(0, 400)}` }], isError: true };
      }
      winner = pick; layer = "arbiter"; reason = `LLM 仲裁者 ${arbiter} 裁决${why ? `：${why}` : ""}`;
    }

    const w = cands[winner];
    const report = [
      `result_arbitrate ✓ [${layer}层] winner=候选${winner + 1} [${w.agent || "unknown"}]${w.task_id ? ` (${w.task_id})` : ""}`,
      `问题: ${question}`,
      `裁决: ${reason}`,
      "----- 候选权重明细 -----",
      detail.map((d) => `#${d.idx} [${d.agent}] weight=${d.weight}${d.confidence !== null ? ` confidence=${d.confidence}` : ""} :: ${d.answer_head}`).join("\n"),
      "----- 胜出答案 -----",
      String(w.answer),
    ].join("\n");
    return { content: [{ type: "text", text: report }] };
  })();

  // Generic name-driven path over the Agent Registry. Same driver as run_*; `name` picks
  // the agent, so new registry entries (e.g. qwen) need no per-agent tool.
  // agent_invoke 自动备路 + 默认 worker 空闲轮询：请求的 worker 已忙（agent_live busy / 有 running 任务）时自动改派
  // 空闲备路 worker（排控制主控，不压 main），避免并发叠压同一 worker（429）或压主控；未指定 worker 或指定==主控
  // 时默认也从空闲池轮询（主控=主脑，不自派干杂活）。返回文案显式标注改派；传 same_worker:true 强制精确同名、
  // auto_fallback:false 关闭备路。
  if (name === "agent_invoke") return (async () => {
    const ctl = currentControllerAgent();
    let wanted = args.name;
    // 2026-09-23 fix: 「指定 name==主控」≠ 「未指定」—— 用户明确要主控干，就该派主控，
    // 不再被默认 worker 池顶替（之前会改派给空闲 dsh/opencode，造成「明明传了 claude 却派 dsh」）。
    // 只有完全没传 name 才走默认 worker 池。same_worker:true 仍可强制同名（原有语义不变）。
    const isControllerDefault = !wanted && args.same_worker !== true;
    if (isControllerDefault) {
      // 未指定 worker：不压 main，从空闲池轮询一个（排主控），全忙回退主控（尽力）。
      const target = pickIdleWorker(ctl ? [ctl] : [], busyWorkerSet()) || ctl || "qwen";
      attachAdHocWorkflow(args, target); // 2026-09-23：单派发也挂 ad-hoc workflow 卡
      const r = await runAgent(target, args);
      if (r && r.content && r.content[0]) {
        r.content[0].text = `[agent_invoke 默认worker] 未指定 → 空闲 ${target}\n${r.content[0].text}`;
      }
      return r;
    }
    if (!AGENTS[wanted]) {
      attachAdHocWorkflow(args, wanted); // 未知 agent 也建卡（失败也有面板痕迹）
      return runAgent(wanted, args); // 未知 agent → 原样派发（保留原有报错路径）
    }
    const allowFallback = args.same_worker !== true && args.auto_fallback !== false;
    const wantedLower = String(wanted).toLowerCase();
    if (allowFallback && busyWorkerSet().has(wantedLower)) {
      const target = pickInvokeWorker(wanted);
      if (target && target !== wanted) {
        attachAdHocWorkflow(args, target); // 备路改派也建卡（target 名落库）
        const r = await runAgent(target, args);
        if (r && r.content && r.content[0]) {
          r.content[0].text = `[agent_invoke 备路] ${wanted} busy → 改派空闲 ${target}\n${r.content[0].text}`;
        }
        return r;
      }
    }
    attachAdHocWorkflow(args, wanted); // 主路径：caller 要哪个就建哪个 agent 的卡
    return runAgent(wanted, args);
  })();

  // ---- 向量记忆层（3.7.0/3.7.1）：语义检索/写入，懒加载 ONNX+sqlite-vec ----
  if (name === "memory_search") {
    return (async () => {
      const vm = await getVecMemory();
      const results = await vm.memorySearch({ query: args.query, top_k: args.top_k, category: args.category, scope: args.scope, cwd: args.cwd, min_length: args.min_length });
      if (results.length === 0) return { content: [{ type: "text", text: "(no memories found)" }] };
      const lines = results.map((r) =>
        `[${r.category}] d=${r.distance.toFixed(3)} (src:${r.source})\n  ${r.content}`
      );
      return { content: [{ type: "text", text: lines.join("\n---\n") }] };
    })();
  }
  if (name === "memory_add") {
    return (async () => {
      const vm = await getVecMemory();
      const res = await vm.memoryAdd({ content: args.content, category: args.category, source: args.source, scope: args.scope, cwd: args.cwd });
      return { content: [{ type: "text", text: `stored memory id=${res.id} (${res.dims}-dim, category=${res.category})` }] };
    })();
  }
  // ---- 向量记忆层管理工具：列/删/统计 ----
  if (name === "memory_list") {
    return (async () => {
      const vm = await getVecMemory();
      const rows = await vm.memoryList({ category: args.category, category_prefix: args.category_prefix, limit: args.limit, offset: args.offset });
      if (rows.length === 0) return { content: [{ type: "text", text: "(no memories)" }] };
      const lines = rows.map((r) => `[${r.id}] ${r.category} (src:${r.source}) ${r.content_preview}`);
      return { content: [{ type: "text", text: `${rows.length} rows\n` + lines.join("\n") }] };
    })();
  }
  if (name === "memory_delete") {
    return (async () => {
      const vm = await getVecMemory();
      const res = await vm.memoryDelete({ id: args.id, category: args.category, category_prefix: args.category_prefix });
      return { content: [{ type: "text", text: `deleted ${res.deleted} (mode=${res.mode})` }] };
    })();
  }
  if (name === "memory_stats") {
    return (async () => {
      const vm = await getVecMemory();
      const s = await vm.memoryStats();
      if (!s.initialized) return { content: [{ type: "text", text: "(not initialized)" }] };
      const cats = s.categories.map((c) => `${c.category}: ${c.n}`).join("\n");
      return { content: [{ type: "text", text: `count=${s.count} dim=${s.dim}\ncategories:\n${cats}` }] };
    })();
  }
  if (name === "memory_promote") {
    return (async () => {
      const vm = await getVecMemory();
      const r = await vm.memoryPromote({ id: args.id, to_scope: args.to_scope, dry_run: args.dry_run !== false });
      const tag = r.dry_run ? "[DRY RUN] " : "";
      if (r.error) return { content: [{ type: "text", text: `${tag}promote failed: ${r.error}` }] };
      const note = r.note ? ` (${r.note})` : "";
      return { content: [{ type: "text", text: `${tag}id=${r.id}: ${r.old_category} → ${r.new_category}${note}\npromoted=${r.promoted} dry_run=${r.dry_run}` }] };
    })();
  }
  // ----  任务完成自动沉淀记忆：task_info 抽取完成的任务结果/描述 → memory_add（可审计知识点）。----
  // 会话末尾可调用（或 hook 配）、把"这个任务教会了我们什么"沉淀进向量库，供后续任务 memory_search 复用。
  if (name === "task_sediment") {
    return (async () => {
      const m = loadMem();
      const t = m.tasks && m.tasks[args.task_id];
      if (!t) return { content: [{ type: "text", text: `task not found: ${args.task_id}` }], isError: true };
      const body = [t.title, t.description, t.result].filter(Boolean).join("\n").trim();
      if (!body) return { content: [{ type: "text", text: `任务 ${args.task_id} 无可用正文,跳过沉淀` }] };
      const vm = await getVecMemory();
      // 沉淀一条：任务标题 + 结果摘要为中心的"完成任务经验"。category 默认 global:bridge。
      const content = `[task ${args.task_id}] ${t.title}\n目标: ${t.description}\n结果: ${t.result}`;
      const res = await vm.memoryAdd({ content, category: args.category || "global:bridge", source: args.source || `task:${args.task_id}`, scope: args.scope, cwd: args.cwd });
      return { content: [{ type: "text", text: `sedimented task ${args.task_id} → memory id=${res.id} cat=${res.category}` }] };
    })();
  }

  // ---- 视觉识别 Agent（2026-08-12）：裸 API 图像理解 ----
  // 密钥运行时从 opencode.json 的 qwen provider 读取（不硬编码）。
  if (name === "vision_analyze") {
    return (async () => {
      const MODEL = args.model || "Qwen3-VL-235B-A22B-Instruct";
      const DEFAULT_PROMPT = `请分析这张图像，用中文给出报告：(1)整体场景 (2)主要物体/主体 (3)光线与构图 (4)是否清晰/遮挡/模糊（对可读性/识别度影响）(5)若含文字/二维码请尽量转述其内容。逐项列出，简洁专业。`;
      const PROMPT = args.prompt || DEFAULT_PROMPT;
      const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

      let dataUrl = args.image_data_url;
      if (args.image_path) {
        const p = args.image_path;
        const ext = extname(p).toLowerCase();
        const mime = MIME[ext];
        if (!mime) return { content: [{ type: "text", text: `不支持的图片扩展名: ${ext}（支持 .jpg/.jpeg/.png/.webp）` }] };
        if (!existsSync(p)) return { content: [{ type: "text", text: `图片不存在: ${p}` }] };
        const b64 = readFileSync(p).toString("base64");
        dataUrl = `data:${mime};base64,${b64}`;
      }
      if (!dataUrl) return { content: [{ type: "text", text: "需要 image_path 或 image_data_url 参数" }] };

      // 运行时读取 qwen provider（baseURL + apiKey），不硬编码密钥
      let base, key;
      try {
        const CFG = JSON.parse(readFileSync(join(homedir(), ".config", "opencode", "opencode.json"), "utf8"));
        const prov = CFG.provider.qwen;
        if (!prov?.options?.baseURL || !prov?.options?.apiKey) throw new Error("opencode.json qwen provider 缺 baseURL/apiKey");
        base = prov.options.baseURL.replace(/\/$/, "");
        key = prov.options.apiKey;
      } catch (e) {
        return { content: [{ type: "text", text: `读取视觉端点配置失败: ${e.message}` }] };
      }

      const body = {
        model: MODEL,
        messages: [{ role: "user", content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ] }],
        max_tokens: 2000,
        temperature: 0,
      };
      const timeoutMs = (args.timeout_sec || 60) * 1000;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let r;
        try {
          r = await fetch(base + "/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
        } finally { clearTimeout(timer); }
        if (!r.ok) {
          const t = await r.text();
          return { content: [{ type: "text", text: `HTTP ${r.status}: ${t.slice(0, 400)}` }] };
        }
        const j = await r.json();
        const text = j.choices?.[0]?.message?.content ?? "(无内容)";
        return { content: [{ type: "text", text: `[model=${MODEL}]\n${text}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `图像分析失败: ${e.message}` }] };
      }
    })();
  }

  // ---- DSH 会话读取（2026-08-21）----
  // 委派到 ~/.agents/bin/dsh-read.mjs（独立只读 CLI，自带 fzstd；绝不改 DSH 数据）。
  if (name === "dsh_read") {
    const bin = join(homedir(), ".agents", "bin", "dsh-read.mjs");
    const argv = ["dsh-read.mjs"];
    if (args.action === "list") argv.push("list", ...(args.keyword ? [args.keyword] : []));
    else if (args.action === "grep") argv.push("grep", args.keyword || "");
    else if (args.action === "get") { argv.push("get", args.session_id || ""); if (args.raw) argv.push("--raw"); }
    else return { content: [{ type: "text", text: "dsh_read action 应为 list | grep | get" }] };
    return new Promise((resolveOut) => {
      const ch = spawn(process.execPath, argv, { cwd: join(homedir(), ".agents", "bin"), shell: false });
      let o = "";
      ch.stdout.on("data", (d) => (o += d.toString()));
      ch.stderr.on("data", (d) => (o += d.toString()));
      ch.on("error", (e) => resolveOut({ content: [{ type: "text", text: `dsh_read 启动失败: ${e.message}` }] }));
      ch.on("exit", (code) => resolveOut({ content: [{ type: "text", text: o || `(exit ${code})` }] }));
      setTimeout(() => { try { ch.kill(); } catch {} }, timeoutMs);
    });
  }

  return null;
}

// ---- MCP stdio protocol ----
const rl = createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

let pending = 0;
rl.on("close", () => { if (pending === 0) process.exit(0); });
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const id = req.id;
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "shared-context", version: "1.0.0" } } });
  } else if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
  } else if (req.method === "tools/call") {
    const name = req.params.name;
    const args = req.params.arguments;
    const syncResult = handleSync(name, args);
    if (syncResult) { send({ jsonrpc: "2.0", id, result: syncResult }); return; }
    const asyncResult = handleAsync(name, args);
    if (asyncResult) {
      pending++;
      Promise.resolve(asyncResult).then((result) => { send({ jsonrpc: "2.0", id, result }); }).catch((e) => send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e) } })).finally(() => { pending--; if (pending === 0 && rl.readableEnded) process.exit(0); });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } });
    }
  } else if (req.method === "notifications/initialized" || req.method === "initialized") {
    // no-op
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } });
  }
});
