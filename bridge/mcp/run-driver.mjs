// run-driver.mjs — Agent 执行驱动（runOnce 单次 spawn + runAgent 重试编排）
// 从 shared-context-server.mjs 拆出（ 模块拆分第四步，2026-08-28）。
// 依赖单向：agents-registry(AGENTS) + retry-safety(重试/安全) + state-store(状态/任务ID)。
// 导出 runAgent；runOnce 为内部函数不导出（仅 runAgent 调用）。
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, envStrip, execOnPath, cleanProcessEnv } from "./agents-registry.mjs";
import { isRetryableExit, isFakeSuccess, safetyScan, parseRetryAfter, sleep } from "./retry-safety.mjs";
import { updateMem, loadMem, BRIDGE_WORK_ROOT, resolveInWorkDir, generateTaskId } from "./state-store.mjs";

const IS_WIN = process.platform === "win32";

// One spawn attempt. Resolves to { code, out, sessionId, timedOut, spawnError }.
// Does NOT touch the task record — the orchestrator (runAgent) does that. Keeps the
// exit/timeout/error race guard (settled) local to a single attempt.
function runOnce(agent, args, timeoutMs) {
  return new Promise((res) => {
    const cmd = args.session_id ? agent.buildResume(args) : agent.buildFresh(args);
    const usesStdin = !!agent.needsStdin;
    // v1.0.1+：opts.env 在两种情形下必须剥 QODER_AGENT_SDK_*（宿主污染）：
    //  a) agent.env 非空 → 用 cleanProcessEnv() 替换 process.env 作基底层 + envStrip(agent.env) 覆盖
    //  b) agent.env 为空（codex / qoder/qoder_cn / dsh 无 auth env）→ Node 默认用 process.env，
    //     仍含宿主污染键，会原样传给子进程 → 同样需替换为 cleanProcessEnv()
    // 统一处理：始终设 opts.env = cleanProcessEnv()（agent.env 时再叠加）。
    const opts = { stdio: usesStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"], timeout: timeoutMs, shell: IS_WIN };
    if (agent.env) {
      // v1.0.1+ 二次清洗：agent.env 在 agents-registry.mjs 构造时已 envStrip，但提供第二道闸
      // ——防御未来给 AGENTS[name].env 动态 mutate 的场景（如自定义 agent descriptor）。
      // envStrip 内部已剥空串/占位符/非字符串，spread 进 process.env 后子进程拿到的 env
      // 是干净的：claude SDK 不会因为 ANTHROPIC_AUTH_TOKEN="" 报 "Not logged in"，
      // 也不会拿到 "<X>" 这种占位串调远端（401/403 而非明确失败）。
      //
      // 基底层 cleanProcessEnv() 已把 QODER_AGENT_SDK_* 宿主污染键从 process.env 剥掉，
      // 再 spread envStrip(agent.env) 覆盖。整套 env 注入子进程前无任何宿主 SDK 入口。
      opts.env = { ...cleanProcessEnv(), ...envStrip(agent.env) };
      // 2026-08-31 修复：claude 内部 SDK 分层调用（title-gen/SDK 自动选模型）读 ANTHROPIC_MODEL /
      // ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL env，不跟随 --model。模型轮换时把被选中的
      // model 同步进这些 env，使 title-gen 与 SDK 用同一已解析模型，避免 "<PROVIDER>-Auto 常 429 时 claude
      // 内部仍用 Auto 无法换 → 视图评估全部超时失败"（某次评估任务超时即此因）。对 claude 之外的 agent
      // （env 无 ANTHROPIC_DEFAULT_* 键）此同步是空操作，不影响 codex/qwen/opencode。
      //
      // v1.0.1+ 修正：原写法 `args.model && opts.env.ANTHROPIC_MODEL` 只在 ANTHROPIC_MODEL
      // 键存在时同步，但 envStrip 后占位符被剥掉可能让键不存在 → 同步失效。改成：
      // 仅当 args.model 是合法（已过 isPlaceholderModel 守卫）的非占位符模型时才同步。
      // 这条 model 占位符守卫在 buildFresh 已有，但这里同步是 SDK 内部分层调用，
      // 不能因 SDK 同步阶段传占位符让 SDK 走不通的端点。
      if (args.model && !/[<>]/.test(String(args.model)) && opts.env.ANTHROPIC_MODEL !== undefined) {
        opts.env.ANTHROPIC_MODEL = args.model;
        opts.env.ANTHROPIC_DEFAULT_OPUS_MODEL = args.model;
        opts.env.ANTHROPIC_DEFAULT_SONNET_MODEL = args.model;
        opts.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = args.model;
      }
    } else {
      // agent.env 为 null（codex/qoder/qoder_cn/dsh 无 auth env）→ Node spawn 默认
      // 用 process.env 作子进程 env，里面仍可能含 QODER_AGENT_SDK_* 宿主污染键 → 必须
      // 显式替换为 cleanProcessEnv()。否则 qoder/qoder_cn 子进程拿到宿主 SDK entrypoint
      // 报 "sdk_invalid_args"（实测 2026-09-23）。
      opts.env = cleanProcessEnv();
    }
    //  + ⑬：强制 workdir 落 BRIDGE_WORK_ROOT 内；未传 workdir 时若带 task_id 则按任务
    // 自动派生独立隔离目录（per-task 沙箱,任务互不覆写）。同 task 复用同目录（含重试/resume）。
    if (args.workdir) {
      opts.cwd = resolveInWorkDir(null, args.workdir);
      // 显式 workdir 也可能尚不存在（如 run_dsh 传一个待建目录）——先建再 spawn，否则 spawn ENOENT(exit=-1)。
      // 与下方 task_id 沙箱同样：mkdirSync recursive 幂等，安全。
      mkdirSync(opts.cwd, { recursive: true });
    }
    else if (args.task_id) {
      const sandbox = join(BRIDGE_WORK_ROOT, `task-${args.task_id.replace(/[^A-Za-z0-9_-]/g, "_")}`);
      mkdirSync(sandbox, { recursive: true });
      opts.cwd = sandbox;
    }
    const child = spawn(cmd[0], cmd.slice(1), opts);
    // 服务端被动心跳（）：spawn 起即每 ~60s 刷新 task.last_heartbeat_at + heartbeat_n（进程活着就跳，
    // 与 stdout 输出无关，长 LLM 推理不误判）。仅写入 running 任务（escalating/awaiting_approval 停跳）。
    // 三条 settle 路（exit/timeout/error）都经 settled 守卫 clearInterval。
    let hb = null;
    //  实时状态：spawn 起即标 busy，exit 后清 idle（写进任务记录，面板据此判 worker 忙闲）
    if (args.task_id) {
      try { updateMem((m) => { if (m.tasks[args.task_id]) m.tasks[args.task_id].agent_live = { state: "busy", pid: child.pid, started_at: Date.now() }; }); } catch {}
      const hbMs = parseInt(process.env.BRIDGE_HEARTBEAT_MS, 10) || 60000;
      hb = setInterval(() => {
        try { updateMem((m) => {
          const t = m.tasks[args.task_id];
          if (!t || t.status !== "running") return;
          t.last_heartbeat_at = Date.now();
          t.heartbeat_n = (t.heartbeat_n || 0) + 1;
        }); } catch {}
      }, hbMs);
      if (hb.unref) hb.unref(); // 不阻止进程退出
    }
    let out = "";
    let settled = false;
    const KEEP_RECENT = 1_000_000; //  长任务上下文压缩：单次 capture 输出上限 1MB，保留最近窗口，防超长流撑爆内存
    //  worker 里程碑：worker stdout/stderr 打 `§MILESTONE:xxx` 标记 → append 流里实时解析，
    // 写 progress_log + 刷 last_heartbeat_at（无需 worker 挂 MCP）。进程活着就跳（ 服务端心跳）已兜底，
    // 这里是对  的补充：把 stdout 里的里程碑/进度落进 progress_log，监控/面板可读。
    let mileBuf = ""; // 跨 chunk 缓冲：标记可能被一次 data 事件切半，保留尾部到解析出完整标记或确认无残留
    const MILESTONE_RE = /§MILESTONE\s*[:：]\s*([^\r\n]*)/g;
    const noteMilestone = (note) => {
      const n = String(note || "").slice(0, 500);
      if (!n || !args.task_id) return;
      try { updateMem((m) => {
        const t = m.tasks[args.task_id];
        if (!t || t.status !== "running") return; // 只在 running 态记录里程碑（终态不写）
        if (!Array.isArray(t.progress_log)) t.progress_log = [];
        t.progress_log.push({ ts: new Date().toISOString(), note: n, source: "stdout" });
        if (t.progress_log.length > 50) t.progress_log = t.progress_log.slice(-50); // 上限：只留最近 50 条
        t.last_heartbeat_at = Date.now();      // 里程碑也算一次活跳
        t.heartbeat_n = (t.heartbeat_n || 0) + 1;
      }); } catch {}
    };
    const scanMilestones = (s) => {
      MILESTONE_RE.lastIndex = 0;
      let m;
      while ((m = MILESTONE_RE.exec(s))) noteMilestone(m[1].trim());
    };
    let lastOutputAt = Date.now();  // 心跳停滞检测：stdout 最后更新时间
    const append = (d) => {
      const s = d.toString();
      out += s;
      lastOutputAt = Date.now();
      if (out.length > KEEP_RECENT) out = out.slice(-KEEP_RECENT); // keepRecent：只留尾部，中间历史压缩丢弃
      //  里程碑解析：把新块与上一块尾部拼接再扫（避免标记被 chunk 边界切半）。
      // mileBuf 保留可能含未完成标记的尾部最多 ~2KB；无 `§MILESTONE`/`` 开头片段则清空。
      scanMilestones(mileBuf + s);
      const idx = (mileBuf + s).lastIndexOf("");
      if (idx >= 0 && (mileBuf + s).length - idx < 2048) mileBuf = (mileBuf + s).slice(idx);
      else mileBuf = "";
    };
    if (usesStdin) {
      // 长 prompt（首个参数可能被 Windows argv 拆分）写 stdin，让 CLI 从 stdin 读完整 prompt。
      try { child.stdin.write(args.prompt); } catch {}
      try { child.stdin.end(); } catch {}
    }
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (hb) clearInterval(hb);
      try { child.kill(); } catch {}
      res({ code: null, out, sessionId: null, timedOut: true, spawnError: null });
    }, timeoutMs);
    // 假卡提前收口：进程已输出完整结果但静默 QUIET_MS 仍不退出 → 判定"答完 hang"，
    // 主动按当前 out settle（code=0），避免任务卡 running 到 timeout（codex 曾 2s 答完却 hang 满 timeout）。
    const QUIET_MS = parseInt(process.env.BRIDGE_QUIET_MS, 10) || 20000;
    const quietTimer = setInterval(() => {
      if (settled) { clearInterval(quietTimer); return; }
      if (Date.now() - lastOutputAt < QUIET_MS) return;
      const p = agent.parse ? agent.parse(out) : { text: out, sessionId: null };
      if (!p.text || !String(p.text).trim()) return;   // 无实质结果不误收口（仍在思考）
      settled = true;
      clearInterval(quietTimer);
      clearTimeout(timer);
      if (hb) clearInterval(hb);
      try { child.kill(); } catch {}
      res({ code: 0, out, sessionId: p.sessionId, timedOut: false, spawnError: null });
    }, 5000);
    if (quietTimer.unref) quietTimer.unref();
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hb) clearInterval(hb);
      res({ code: -1, out, sessionId: null, timedOut: false, spawnError: err.message });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hb) clearInterval(hb);
      // /① 实时状态：进程退出清 idle
      if (args.task_id) {
        try { updateMem((m) => { if (m.tasks[args.task_id] && m.tasks[args.task_id].agent_live) delete m.tasks[args.task_id].agent_live; }); } catch {}
      }
      const parsed = agent.parse(out);
      res({ code, out, sessionId: parsed.sessionId, timedOut: false, spawnError: null });
    });
  });
}

// Generic agent driver: the shared skeleton the three old run_* handlers duplicated.
// Spawns the agent, settles the task with the exit/timeout/error race guard, and retries
// on 429/timeout with exponential backoff (11). Returns null for an unknown agent so the
// caller (handleAsync) can fall through to the unknown-tool error.
export function runAgent(name, args, opts = {}) {
  const agent = AGENTS[name];
  if (!agent) return null;
  // agent_scan 探测到的不可用 worker（CLI 未安装/端点未配置）拒绝派发，返回结构化报错（非 null，
  // 避免落到 unknown-tool 误导）。available===undefined(未探测) 放行，保留旧行为；调用方可先 agent_scan 识别本地 CLI。
  if (agent.available === false) {
    const hint = (agent.probe && agent.probe.hint) || "见 public-install/INSTALL.md";
    return (async () => ({
      content: [{ type: "text", text: `agent "${name}" 不可用：本地未检测到其 CLI/端点配置。${hint}。先跑 agent_scan 识别本地已装的 worker，安装后再派发。` }],
      isError: true,
    }))();
  }
  // v1.0.1+ auto-probe gate：agent.available===undefined 表示从未探测（agent_scan 未被调用
  // 或新 worker descriptor 未挂 probe 元数据）。这里做一次 fast-fail：bin 类用 execOnPath 探
  // 一次 CLI 是否在 PATH 上（<100ms）。不存在则立即返回结构化报错，不再 spawn 后才暴露
  // ENOENT —— spawn ENOENT 会让 task 落成 failed（exit_code=null, spawn_error），还要等
  // 用户查任务记录才知道是 CLI 没装。fast-fail 让错误点前移到派发入口。
  if (agent.available === undefined && agent.probe && agent.probe.kind === "bin" && agent.probe.cmd) {
    if (!execOnPath(agent.probe.cmd)) {
      return (async () => ({
        content: [{ type: "text", text: `agent "${name}" 不可用：CLI 未在本机 PATH 上（auto-probe fail-fast）。${agent.probe.hint || "见 public-install/INSTALL.md"}。先跑 agent_scan 识别本地已装的 worker。` }],
        isError: true,
      }))();
    }
  }
  const taskId = args.task_id || generateTaskId();
  const nowIso = new Date().toISOString();
  const timeoutMs = (args.timeout_sec || 300) * 1000; // computed here: runAgent is module-scoped, not inside handleAsync where timeoutMs lived
  // Retry config: explicit arg > env > default. max_retries is the number of RETRIES after
  // the first attempt, so total attempts = max_retries + 1. Default 2 (3 total) — enough to
  // ride out a brief <PROVIDER> hiccup without making a genuinely-failing task hang for minutes.
  // NOTE: use || not ?? for the env fallback — parseInt(undefined) is NaN, and NaN ?? 2 is NaN
  // (?? only catches null/undefined). || coerces NaN to the default.
  const maxRetries = Math.max(0, Math.min(args.max_retries ?? (parseInt(process.env.BRIDGE_MAX_RETRIES, 10) || 2), 5));
  const baseDelayMs = Math.max(0, args.retry_base_ms ?? (parseInt(process.env.BRIDGE_RETRY_BASE_MS, 10) || 2000));
  const maxDelayMs = Math.max(baseDelayMs, args.retry_max_ms ?? (parseInt(process.env.BRIDGE_RETRY_MAX_MS, 10) || 30000));
  updateMem((m) => {
    //  A 失败自动 fork：workflow 任务被 run_* 重跑时若整条覆盖会把 DAG 挂链（workflow/
    // dependencies/deliverable/acceptance_criteria/require_approval 等）洗掉，导致父任务失联、
    // 失败后 auto-fork 无从判断归属而静默不 fork。此处跨重跑保留既有任务的「工作流/审点」字段，
    // 只覆盖运行态字段。非 workflow 任务 prev 无这些字段，行为不变。
    const prev = m.tasks[taskId] || {};
    m.tasks[taskId] = {
      id: taskId,               // 落库带 id：消除外部 t.id 依赖
      title: args.prompt.slice(0, 80) + (args.prompt.length > 80 ? "..." : ""),
      description: args.prompt,
      priority: prev.priority || "medium",     // 保留工作流优先级，不强制 medium
      status: "running",
      assigned_to: name,
      claimed_by: name,
      created_by: prev.created_by || "claude-or-codex", // 保留 ywriter（workflow 创建者）链
      created_at: prev.created_at || nowIso,   // 保留首次创建时间，不随重跑刷新
      claimed_at: nowIso,
      completed_at: null,
      exit_code: null,
      result: null,
      session_id: args.session_id || null, // prior session being resumed, if any
      retries: [], // 11: per-attempt record { attempt, code, reason, waited_ms }
      last_heartbeat_at: Date.now(),   // runAgent 建的记录直接在 running 态起跳
      heartbeat_n: 0,
      heartbeat_interval_ms: null,     // 用全局默认 BRIDGE_HEARTBEAT_MS
      timeout_sec: args.timeout_sec || 300,  // 短任务卡顿阈值分层用（sweepStaleRunning 据此缩短 stale 阈值）
      progress_log: prev.progress_log || [],  // 保留既有进度留痕
      escalation: null,
      // 跨重跑保留工作流/审点挂链（auto-fork 判断归属 + DAG 面板不丢边）：
      workflow: prev.workflow || null,
      dependencies: prev.dependencies || [],
      deliverable: prev.deliverable || null,
      acceptance_criteria: prev.acceptance_criteria || null,
      require_approval: prev.require_approval || false,
      approvals: prev.approvals || null
    };
  });

  // 后台执行体：worker 在后台跑（await runOnce 在此 IIFE 内）。opts.wait=true 时同步等待完整结果
  // （内部工具 workflow_plan/result_arbitrate/run_verify/独立审闸用）；否则立即返回 task_id（run_*/agent_invoke，
  // 避免长任务撞 MCP 客户端 -32001 Request timed out）。最终结果落 task.result，经 task_list / 面板 /api/state 取。
  const run = (async () => {
    const attempts = [];
    let lastOut = "";
    let lastCode = null;
    let lastSessionId = args.session_id || null;
    let lastSpawnError = null;
    let timedOut = false;

    // 429 限流自动切换 model：429 时按 agent.fallbackModels 轮转 model。
    // 不同 model 走 <PROVIDER> 不同限流路由，切换可绕过单 model 的 429（实测 <PROVIDER>-Auto 429 时
    // <PROVIDER>-Flash/Qwen3-Coder-Flash 仍可用）。modelQueue = [首次model, ...fallbackModels]；
    // 429 的下一 attempt 用队列下一个 model。非 429（timeout）仍用同 model 退避重试。
    // 总尝试受 maxRetries 约束；model 轮转不额外增加尝试次数，只在 429 重试时换 model。
    const fallbackModels = (Array.isArray(agent.fallbackModels) ? agent.fallbackModels : []).filter((m) => m && !/[<>]/.test(String(m)));
    const firstModel = args.model || null; // null = 用 agent 默认（buildFresh 内部处理）
    const modelQueue = [firstModel, ...fallbackModels];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Carry forward any session_id captured on a prior failed attempt so a retry resumes
      // the same session (preserves whatever context the failed attempt did establish).
      const attemptArgs = { ...args };
      // ★ runOnce 按 args.task_id 写 agent_live/心跳：必须把本 task 的 id 灌进 attemptArgs，
      // 否则调用方未传 task_id（run_* 常见，auto-generate）时 runOnce 拿不到 id，agent_live/心跳全失。
      attemptArgs.task_id = taskId;
      // ★ 2026-09-01 workdir 继承：调用方未显式传 workdir（run_*/agent_invoke 常见）时，
      // 从本任务持久化记录读取 workdir（workflow_start compete 视角可声明源码根）。有则注入
      // attemptArgs → runOnce 用它做 cwd（resolveInWorkDir + mkdir），避免落进 BRIDGE_WORK_ROOT\task-<id>
      // 空沙箱而看不到工作区源码目录（只读核对任务即因此失败）。
      // 显式 args.workdir 优先（调用方手传 > 任务字段）。
      if (!attemptArgs.workdir && args.task_id) {
        try {
          const tk = loadMem().tasks[args.task_id];
          if (tk && tk.workdir) attemptArgs.workdir = tk.workdir;
        } catch {}
      }
      if (lastSessionId) attemptArgs.session_id = lastSessionId;
      //  Plan 模式：只读研究，不落盘。强制 auto 关（防自主写写盘）+ 往 prompt 头部注入只读指令
      // （worker CLI 无真只读沙箱开关,靠指令 + 关闭 auto 双保险；产出即方案文本,由调用方审批后再执行）。
      if (args.plan_mode) {
        attemptArgs.auto = false;
        const directive = "[PLAN MODE] 仅做只读调研与方案设计，严禁写文件/执行写操作。输出：目标、发现的关键点、推荐的实施步骤（方案），不含任何执行动作。";
        attemptArgs.prompt = directive + "\n\n" + (attemptArgs.prompt || "");
      }
      // 429 model 轮转：本 attempt 用队列里对应位置的 model（超出队列长度则用最后一个 fallback）。
      // attempt 0 用 firstModel（args.model 或 agent 默认）；429 后 attempt N 用 fallbackModels[N-1]。
      if (attempt < modelQueue.length) {
        if (modelQueue[attempt] !== null) attemptArgs.model = modelQueue[attempt];
        else delete attemptArgs.model; // null = 回退 agent 默认
      } else if (fallbackModels.length) {
        attemptArgs.model = fallbackModels[fallbackModels.length - 1];
      }

      const r = await runOnce(agent, attemptArgs, timeoutMs);
      lastOut = r.out;
      lastCode = r.code;
      lastSpawnError = r.spawnError;
      timedOut = r.timedOut;
      if (r.sessionId) lastSessionId = r.sessionId;

      // Parse the attempt's output now so the fake-success check can run on the PARSED
      // text (CLI log noise stripped), not raw out. Cheap: parse is a regex/slice, no I/O.
      const attemptText = agent.parse(r.out).text;

      const reason = r.spawnError != null ? "spawn_error"
        : r.timedOut ? "timeout"
        : r.code === 0 ? (isFakeSuccess(r.code, attemptText) ? "fake_success" : "ok")
        : (isRetryableExit(r.code, r.out) ? "retryable_429" : "nonzero_exit");
      attempts.push({ attempt, code: r.code, reason, model: attemptArgs.model || "(default)", spawn_error: r.spawnError || null });

      // Success — stop. (fake_success falls through to the retry path below.)
      if (r.code === 0 && reason === "ok") break;

      // Spawn error (ENOENT etc.) — misconfig, retrying won't help. Stop.
      if (r.spawnError != null) break;

      // Non-retryable non-zero exit (real task failure, not rate-limit). Stop.
      // fake_success (exit 0 + API-error text) is retryable — it's an upstream hiccup the
      // model-rotation path can ride out, not a real task failure. Excluded here so it
      // falls through to the backoff/retry block instead of breaking.
      if (!r.timedOut && !isRetryableExit(r.code, r.out) && reason !== "fake_success") break;

      // No retries left — stop (loop will exit).
      if (attempt >= maxRetries) break;

      // Backoff: honor Retry-After if present, else exponential with cap.
      // 429/网关5xx/假成功 都会换 model（换 model 即换限流池/上游，用短退避快速试下一个）。
      // timeout 也换 model：<PROVIDER> 网关卡死时，重试同 model 只会再等满一轮 timeout；换 fallback
      // model（不同路由）更可能在窗口恢复前命中可用上游。仍保留指数退避（非 429 用正常退避）。
      const willSwitchModel = (reason === "retryable_429" || reason === "fake_success" || reason === "timeout") && (attempt + 1) < modelQueue.length;
      const retryAfterSec = parseRetryAfter(r.out);
      let delayMs;
      if (retryAfterSec != null) delayMs = retryAfterSec * 1000;
      else if (willSwitchModel) delayMs = Math.min(baseDelayMs, 1000); // 换 model：最多 1s，快速试下一个
      else delayMs = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      attempts[attempts.length - 1].waited_ms = delayMs;

      // Record the retry plan so callers/task_list can see we're backing off.
      updateMem((m) => {
        if (!m.tasks[taskId]) return;
        if (!m.tasks[taskId].retries) m.tasks[taskId].retries = [];
        m.tasks[taskId].retries.push({ attempt, code: r.code, reason, model: attemptArgs.model || "(default)", waited_ms: delayMs });
      });
      await sleep(delayMs);
    }

    // Settle the task record with the final outcome + the retry trace.
    const parsed = agent.parse(lastOut);
    const finalSessionId = parsed.sessionId || lastSessionId;
    //  失败可读化：spawn error（CLI 命令不存在/无法启动，如 "qwen 不是内部或外部命令"）时，
    // stdout 常是 Windows cmd 的 GBK 乱码，面板/主控读不懂真实原因。用可读 spawnError 覆盖。
    const display = lastSpawnError != null
      ? `[spawn_error] ${lastSpawnError} · worker CLI 未找到或无法启动，请先 agent_scan 核对本机安装`
      : parsed.text.slice(0, 200000);
    // success requires exit 0 AND the last attempt was not a fake_success (exit 0 with an
    // API-error body that exhausted retries). A final fake_success means every fallback
    // also failed — mark failed so the caller sees the error instead of a silent "completed".
    const lastReason = attempts.length ? attempts[attempts.length - 1].reason : "ok";
    const success = lastCode === 0 && lastReason !== "fake_success";
    //  自动审批硬拦：仅当调用方要 auto_approval（自动放行该任务)才启用——成功时对产物正文
    // 跑 blocklist 硬扫，命中危险模式即不可自动放行，标 failed + auto_refused=true（供人工回落），
    // 而非静默把危险产物标 completed。小结果/路径由调用方手中的 safe_scan + 人工回落接手。
    let autoRefused = false;
    if (success && args.auto_approval) {
      autoRefused = safetyScan(parsed.text).blocked;
    }
    const retryCount = attempts.length - 1;
    //  中断支持：task_interrupt 已 kill 子进程并在任务记录置 interrupted=true。runOnce 的 child exit
    //   走到本 settle；检测到 interrupted → 保留 interrupted 态（不覆盖成 failed/completed），
    //   只落 exit_code + 中断前部分输出 + 最终 session_id，供 task_resume 续接。
    let wasInterrupted = false;
    updateMem((m) => {
      if (!m.tasks[taskId]) return;
      if (m.tasks[taskId].interrupted) {
        wasInterrupted = true;
        m.tasks[taskId].status = "interrupted";
        m.tasks[taskId].completed_at = new Date().toISOString();
        m.tasks[taskId].exit_code = lastCode;
        m.tasks[taskId].result = display;
        if (finalSessionId) m.tasks[taskId].session_id = finalSessionId;
        m.tasks[taskId].retries = attempts;
        delete m.tasks[taskId].agent_live;
        return;
      }
      m.tasks[taskId].status = (success && !autoRefused) ? "completed" : "failed";
      m.tasks[taskId].completed_at = new Date().toISOString();
      m.tasks[taskId].exit_code = lastCode;
      // Result cap raised 500→200000 so multi-TB/perspective eval texts are preserved intact.
      // (500 chars truncated the claude/codex perspective assessments and lost the body.)
      m.tasks[taskId].result = display;
      if (autoRefused) m.tasks[taskId].auto_refused = safetyScan(parsed.text).hits;
      else delete m.tasks[taskId].auto_refused;
      //  推理轨迹捕获：capture_trace=true 时把完整推理 step 流（含中间日志/思考）存进
      // trace 字段（不截断），供事后审计/回放。注意未截断,可能很大;默认关闭。
      if (args.capture_trace) m.tasks[taskId].trace = lastOut;
      if (finalSessionId) m.tasks[taskId].session_id = finalSessionId;
      m.tasks[taskId].retries = attempts;
    });
    //  自适应重规划 A：失败自动 fork（机械触发）。真失败（非 auto_refused，后者需人工回落）
    // 且调用方显式 fork_on_fail=<备选agent> 时，把失败任务父标记 superseded、生成备选子任务承接，
    // 让工作流不中断。仅对【属于工作流】的任务生效（须有 m.workflows[wfId].evolve 计数，≤3 上限对齐引擎）。
    // 审计：仅在显式要求时才触发，绝不静默改 DAG；无工作流任务/未显式要求一律不 fork。
    let forkedId = null;
    let forkNote = "";
    if (!success && !autoRefused && !wasInterrupted && typeof args.fork_on_fail === "string" && AGENTS[args.fork_on_fail]) {
      updateMem((m) => {
        const t = m.tasks[taskId];
        if (!t) return;
        const wfId = t.workflow && t.workflow.id;
        if (!wfId) return;                                  // 非工作流任务：不见 DAG，不 fork
        const wf = m.workflows && m.workflows[wfId];
        const ev = (wf && wf.evolve) || null;
        if (ev && ev.count >= 3) return;                    // ≤3 硬上限：超限停，交人工
        const childId = generateTaskId();
        const ts = new Date().toISOString();
        m.tasks[childId] = {
          id: childId, title: `${t.title} (fork→${args.fork_on_fail})`,
          description: t.description || "", priority: t.priority || "medium",
          status: "pending", assigned_to: args.fork_on_fail,
          deliverable: t.deliverable || null, acceptance_criteria: t.acceptance_criteria || null,
          require_approval: !!t.require_approval, approved_at: null, approver: null, approval_note: null,
          dependencies: Array.isArray(t.dependencies) ? [...t.dependencies] : [],
          attempt_id: null, stale_attempt_ids: [], reassigning: false,
          created_by: "auto-fork", created_at: ts,
          claimed_at: null, claimed_by: null, completed_at: null, completed_by: null,
          superseded_by: null, superseded_reason: null, result: null,
          last_heartbeat_at: null, heartbeat_n: 0, heartbeat_interval_ms: null, progress_log: [],
          escalation: null,
          evolve: { kind: "fork", of: taskId, at: ts, reason: "auto-fork on failure", auto: true },
          workflow: (t.workflow || { id: wfId })
        };
        t.status = "superseded";
        t.superseded_by = childId;
        t.superseded_reason = "auto-fork on failure";
        t.completed_at = ts;
        (t.progress_log = t.progress_log || []).push({ at: ts, by: "runAgent:auto-fork", action: `失败自动 fork→${args.fork_on_fail}`, reason: attempts.map((a) => a.reason).join(",") });
        if (wf) {
          if (!ev) wf.evolve = { count: 0, evolutions: [], reviews: [] };
          wf.evolve.count += 1;
          wf.evolve.evolutions.push({ at: ts, action: "fork", task_id: childId, of: taskId, reason: "auto-fork on failure", auto: true });
        }
        forkedId = childId;
        forkNote = `\n[auto-fork] 失败自动演进：${taskId} → ${childId}(→${args.fork_on_fail})，父 superseded（工作流 ${wfId}，演进 ${wf ? wf.evolve.count : "?"}/3）`;
      });
    }
    const retryLine = retryCount > 0 ? `\n[retries: ${retryCount} (${attempts.map((a) => `#${a.attempt + 1} ${a.reason}`).join(", ")})]` : "";
    const sessionLine = finalSessionId ? `\n[session_id: ${finalSessionId}]` : "";
    const autoLine = autoRefused ? `\n[auto_approval: REFUSED，命中危险模式,已标失败待人工回落]` : "";
    return { content: [{ type: "text", text: `exit=${lastCode}\n${display}\n\n[task_id: ${taskId}]${retryLine}${sessionLine}${autoLine}${forkNote}` }] };
  })();

  // 同步等待模式：内部工具（workflow_plan/result_arbitrate/run_verify/独立审闸）需 await 完整结果。
  if (opts.wait === true) return run;

  run.catch((e) => {
    // 后台异常兜底：runOnce 通常不 reject；防 bug 让任务卡 running（僵尸）。settle 已把结果落库，
    // 这里只兜住 fire-and-forget IIFE 自身抛错，避免无声挂起。
    updateMem((m) => {
      if (m.tasks[taskId] && m.tasks[taskId].status === "running") {
        m.tasks[taskId].status = "failed";
        m.tasks[taskId].completed_at = new Date().toISOString();
        m.tasks[taskId].exit_code = null;
        m.tasks[taskId].result = `orchestrator error: ${String(e)}`;
        delete m.tasks[taskId].agent_live;
      }
    });
  });

  // 立即返回派发确认（非阻塞）：不 await 子进程。调用方经 task_list 轮询 status/result。
  return { content: [{ type: "text", text: `dispatched task ${taskId} (agent=${name}, background)\n[task_id: ${taskId}] — 用 task_list 查 status / result / exit_code` }], task_id: taskId, dispatched: true };
}
