// state-store.mjs — 状态持久化 + 并发锁 + 消息总线 + 向量记忆懒加载
// 从 shared-context-server.mjs 拆出（ 模块拆分第三步，2026-08-28）。
// 这是所有 handler 的公共基础设施层：memory.json 读写锁、loadMem/saveMem/updateMem、
// 心跳超时扫描、消息总线（进程内事件表 + 实时唤醒）、向量记忆懒加载。
// 单向依赖：本模块不依赖主文件，主文件 handler 层依赖本模块。
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, rmSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// ---- 向量记忆层（路线 B，3.7.0）----
// 懒加载模块：memory_search/memory_add 首次调用才 import + 初始化 ONNX/sqlite-vec，
// 避免无向量调用时占内存 + 拖慢启动。需 LD_PRELOAD 定制 librt（见启动 env）。
let vecMemory = null;
export async function getVecMemory() {
  if (!vecMemory) vecMemory = await import("./vec_memory.mjs");
  return vecMemory;
}

// ---- Shared state: persistent path (~/.multi-agent-bridge/state/) ----
export const STATE_DIR = process.env.BRIDGE_STATE_DIR ||
  join(homedir(), ".multi-agent-bridge", "state");
mkdirSync(STATE_DIR, { recursive: true });

// ---- resolveInWorkDir：每 worker 路径隔离 ----
// 所有 file 工具（read_file/list_dir/project_search）及 runAgent 的 workdir 统一强制根目录，
// 防止跨 worker 覆写（无 worktree 隔离，靠强制根路径 + per-worker 独立 WC 隔离）。
// BRIDGE_WORK_ROOT 可选覆盖（默认 ~/.multi-agent-bridge/workroot）。
export const BRIDGE_WORK_ROOT = process.env.BRIDGE_WORK_ROOT ||
  join(STATE_DIR, "workroot");
mkdirSync(BRIDGE_WORK_ROOT, { recursive: true });
// 传入相对或绝对路径，返回规范化的"落在 BRIDGE_WORK_ROOT 内"的绝对路径；越界则抛错。
export function resolveInWorkDir(wd, p) {
  // 2026-08-25 去 workroot 强制越界锁（用户定稿）。
  //  隔离改"主控任务流分发"负责：写=串行/隔离块并行，派活前查 task_list 对账；
  //       读=并发自由。server 不再强制根，显式 workdir 可直指主仓源码目录。
  // 未传 workdir 时仍回落 BRIDGE_WORK_ROOT 作安全 cwd 默认（防 worker 挂根目录乱跑）。
  const absP = resolve(wd || BRIDGE_WORK_ROOT, p || ".");
  return absP;
}
export const MEM_FILE = join(STATE_DIR, "memory.json");
const LOCK_FILE = join(STATE_DIR, "memory.lock");
// ---- 跨进程共享记忆层（bridge 与 shared-memory 插件共用同一份 KV/笔记）----
// 根统一到 ~/.agents/shared-memory/（与向量层 ~/.agents/vector/ 同根）；env 与插件同名可覆盖。
// 历史：桥的 KV 曾平铺在 memory.json 根、笔记用 notes.md（在 STATE_DIR），现外置到本目录。
export const SHARED_MEM_DIR = process.env.SHARED_MEMORY_DIR ||
  join(homedir(), ".agents", "shared-memory");
mkdirSync(SHARED_MEM_DIR, { recursive: true });
export const KV_FILE = process.env.SHARED_MEMORY_FILE || join(SHARED_MEM_DIR, "kv.json");
export const NOTES_FILE = process.env.SHARED_NOTES_FILE || join(SHARED_MEM_DIR, "notes.log");
const KV_LOCK_FILE = join(SHARED_MEM_DIR, "kv.lock");
// memory.json 根上的任务编排内部键，KV 回退读时排除，避免内部对象（mailbox/fileLocks 等）泄漏进共享 KV。
export const INTERNAL_MEM_KEYS = new Set(["tasks", "mailbox", "fileLocks", "workflow"]);

// Initialize memory.json if not exists
if (!existsSync(MEM_FILE)) {
  writeFileSync(MEM_FILE, JSON.stringify({ tasks: {} }, null, 2));
}

// ---- Concurrency control: atomic lock file creation + atomic rename ----
// Node.js fs has no flockSync, so we use O_EXCL (flag "wx") atomic file creation
// as the lock primitive: only one process can create the lock file; others get
// EEXIST and must retry. This avoids the TOCTOU race of existsSync+writeFileSync.
export function withLock(fn, maxWaitMs = 10000) {
  return withLockFile(LOCK_FILE, fn, maxWaitMs);
}
// 支持指定锁文件（KV 用独立的 kv.lock，与 memory.lock 的并发域分离，避免 KV 读写与编排读写相互阻塞）。
export function withLockFile(lockFile, fn, maxWaitMs = 10000) {
  const startTime = Date.now();
  const sleepMs = 20;
  while (true) {
    let fd;
    try {
      // Atomic exclusive create — throws EEXIST if lock already held
      fd = openSync(lockFile, "wx");
      // Got the lock. Write our PID for diagnostics (best-effort, not read back).
      try { writeFileSync(fd, `${process.pid}\n${Date.now()}`); } catch {}
      try {
        return fn();
      } finally {
        // Release: close fd then unlink. Order matters — unlink first can leave
        // a stale fd, but close-then-unlink is safe because we own the lock.
        try { closeSync(fd); } catch {}
        try { rmSync(lockFile); } catch {}
      }
    } catch (e) {
      const code = e.code;
      if (code === "EEXIST" || code === "EPERM") {
        // Lock held by someone else — check for a stale lock.
        // If the lock file is older than 30s, force-acquire by removing it.
        try {
          const stat = readFileSync(lockFile, "utf8");
          const lockTime = parseInt(stat.split("\n")[1] || stat, 10) || 0;
          if (lockTime && Date.now() - lockTime > 30000) {
            try { rmSync(lockFile); } catch {}
          }
        } catch {}
        if (Date.now() - startTime > maxWaitMs) {
          throw new Error(`Lock timeout after ${maxWaitMs}ms waiting for ${lockFile}`);
        }
        // Busy-wait sleep (no timers in this sync context)
        const s = Date.now();
        while (Date.now() - s < sleepMs) { /* spin */ }
        continue;
      }
      // Unexpected error — propagate
      throw e;
    }
  }
}

export function loadMem() {
  return withLock(() => {
    try {
      return JSON.parse(readFileSync(MEM_FILE, "utf8"));
    } catch {
      return { tasks: {} };
    }
  });
}

export function saveMem(m) {
  withLock(() => {
    const tmp = MEM_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(m, null, 2));
    renameSync(tmp, MEM_FILE); // atomic replace
  });
}

// Read-modify-write under a SINGLE lock span. Use this for any handler that
// both reads and writes memory — calling loadMem() then saveMem() separately
// leaves a gap between the two locks where another process can clobber the
// write (lost-update). updateMem closes that gap by holding the lock across
// the whole RMW cycle.
export function updateMem(mutator) {
  return withLock(() => {
    let m;
    try {
      m = JSON.parse(readFileSync(MEM_FILE, "utf8"));
    } catch {
      m = { tasks: {} };
    }
    if (!m.tasks) m.tasks = {};
    const result = mutator(m);
    const tmp = MEM_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(m, null, 2));
    renameSync(tmp, MEM_FILE); // atomic replace
    return result;
  });
}

// ---- 跨进程共享 KV（bridge + shared-memory 插件共用 kv.json，独立 kv.lock）----
export function loadKV() {
  return withLockFile(KV_LOCK_FILE, () => {
    try {
      return JSON.parse(readFileSync(KV_FILE, "utf8"));
    } catch {
      return {};
    }
  });
}
export function updateKV(mutator) {
  return withLockFile(KV_LOCK_FILE, () => {
    let kv;
    try {
      kv = JSON.parse(readFileSync(KV_FILE, "utf8"));
    } catch {
      kv = {};
    }
    const result = mutator(kv);
    const tmp = KV_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(kv, null, 2));
    renameSync(tmp, KV_FILE); // atomic replace
    return result;
  });
}

// ---- 任务超时自动失败（速赢 ，2026-08-28）----
// 问题：running 任务若 worker 进程崩溃/网络断/卡死，last_heartbeat_at 停滞，但无自动清理 →
//   任务永远卡 running，DAG 后续阶段无法解锁，面板显示"连接断开"假象。
// 设计：心跳每 ~60s 跳一次（runOnce 被动心跳）。阈值 10 分钟（600s）远大于心跳间隔，
//   不会误杀长任务（长时间运行的任务也持续跳心跳），只抓真正停滞的卡死任务。
//   扫描挂在 task_list 入口（高频调用，自然触发清理），无需独立定时器（stdio 无后台循环）。
//   返回被清理的 task_id 列表，供调用方/日志感知。
const HEARTBEAT_STALE_MS = 10 * 60 * 1000; // 心跳停滞阈值：10 分钟
export function sweepStaleRunning(m) {
  const swept = [];
  const now = Date.now();
  // 每个任务的 stale 阈值：任务可显式放宽（heartbeat_interval_ms 为长只读评估/长任务调大的心跳间隔，
  // 阈值随之放大 = interval × 20 跳过数），否则回落全局默认（HEARTBEAT_STALE_MS=10min，可用 env BRIDGE_HEARTBEAT_STALE_MS 覆盖）。
  const envOverride = Number.isFinite(+process.env.BRIDGE_HEARTBEAT_STALE_MS) ? +process.env.BRIDGE_HEARTBEAT_STALE_MS : 0;
  const globalStale = envOverride > 0 ? envOverride : HEARTBEAT_STALE_MS;
  for (const id in m.tasks) {
    const t = m.tasks[id];
    if (t.status !== "running") continue;
    const last = t.last_heartbeat_at || (t.created_at ? Date.parse(t.created_at) : 0);
    if (!last) continue; // 无心跳无创建时间，跳过（不靠猜）
    // 长任务放宽：heartbeat_interval_ms（worker 主动设的心跳周期）→ stale 阈值按 20× 间隔放大，
    // 防"纯只读/慢评估任务 10min 无里程碑被打点"被误杀（2026-08-31 修复长任务误判）。
    const staleMs = (t.heartbeat_interval_ms > 0) ? Math.max(globalStale, t.heartbeat_interval_ms * 20) : globalStale;
    if (now - last > staleMs) {
      t.status = "failed";
      t.completed_at = new Date().toISOString();
      t.result = `timeout: heartbeat stale ${Math.round((now - last) / 1000)}s (no heartbeat since ${new Date(last).toISOString()}; staleness=0)`; // staleness 保留原字段兼容
      t.progress_log = t.progress_log || [];
      t.progress_log.push({ ts: t.completed_at, note: `auto-failed: heartbeat stale > ${Math.round(staleMs / 1000)}s` });
      swept.push(id);
    }
  }
  return swept;
}

// ---- 消息总线：进程内事件注册表（消息总线实时唤醒视角, 2026-08-27）----
// 桥的所有 agent（主控/worker）都挂到同一常驻 shared-context 服务器进程 → 进程内事件即总线通道。
// sender 在该进程内 enqueue,waiter 的 inbox_wait 请求也挂在同一进程 → 用一张进程内 waiter 表即可实现
// 跨 CLI 进程的【实时唤醒】(sender 发 → 仍在等待的接收端立即被 resolve, 无需等下一轮 poll)。
// key: "<agent>" 或 "<agent>|<topic>"(topic 过滤订阅) 或 "*"(广播)；value: Set<resolveFn>。
// 注意:inbox_wait 走异步工具路径(handleAsync 返回 Promise), 不占 withLock 忙等锁、不阻塞事件循环，
// 其它 agent 的工具调用照常处理 —— 这正是与"在 handleSync 里 blocking 长轮询"(会冻死服务器) 的根本区别。
const busWaiters = new Map();
export const BUS_LEASE_MS = 60000;           // 与 inbox_read 的 60s 租约对齐
const BUS_LEASE_OPTS = { leaseMs: BUS_LEASE_MS };
function busWaitKey(agent, topic) { return topic ? `${agent}|${topic}` : agent; }
// 命中并 resolve 某 agent(+可选 topic) 的所有等待者；返回命中数。广播("*")等待者对所有新消息都唤醒。
export function fireBusWaiters(agent, msg, seenKeySet) {
  const keys = [agent, "*"];
  if (msg && msg.topic) keys.push(busWaitKey(agent, msg.topic), busWaitKey("*", msg.topic));
  let fired = 0;
  for (const k of keys) {
    if (!seenKeySet) seenKeySet = new Set();
    if (seenKeySet.has(k)) continue;
    seenKeySet.add(k);
    const set = busWaiters.get(k);
    if (!set) continue;
    for (const fn of [...set]) { set.delete(fn); try { fn(msg); fired++; } catch {} }
  }
  return fired;
}
// 供 inbox_wait 用：把等待者注册到表里（可选 topic 订阅）。返回取消函数。
export function registerBusWaiter(agent, topic, resolveFn) {
  const keys = new Set();
  if (topic) {
    // 带 topic 过滤 → 只订阅 "<agent>|<topic>" 键, 仅当 sender 发来同 topic 消息才被命中(避免无关消息空唤醒)。
    keys.add(busWaitKey(agent, topic));
    keys.add(busWaitKey("*", topic));   // 广播(to="*")带同 topic 也命中
  } else {
    // 无过滤 → 订阅裸 agent 键 + 广播键"*"（bus_send to="*" 的广播订阅者也能被实时唤醒）。
    keys.add(agent);
    keys.add("*");
  }
  for (const k of keys) {
    if (!busWaiters.has(k)) busWaiters.set(k, new Set());
    busWaiters.get(k).add(resolveFn);
  }
  return () => { for (const k of keys) { const s = busWaiters.get(k); if (s) { s.delete(resolveFn); if (s.size === 0) busWaiters.delete(k); } } };
}

// ---- 消息入队（bus_send / agent_send_message 共享, 含实时唤醒 fire + 内存信号关联）----
// 在单次 updateMem 锁内完成: 建信封(msg) + 入队到 m.mailbox[to]。enqueue 后交给调用方 fire waiters,
// 由它再决定是否异步沉淀进向量记忆(memory:true)。
// 返回 { ok, id, msg }；msg 带完整信封（kind/topic/priority/memory 默认值补齐），供 fire + 沉淀用。
export function busEnqueue(args) {
  const to = args.to;
  let result;
  updateMem((m) => {
    if (!m.mailbox) m.mailbox = {};
    if (!m.mailbox[to]) m.mailbox[to] = { lastNdx: 0, msgs: [] };
    const box = m.mailbox[to];
    const ndx = ++box.lastNdx;
    const id = `${to}:${ndx}`;
    const msg = {
      id,
      from: args.from || "unknown",
      to,
      kind: args.kind || "message",            // message | signal
      topic: args.topic || null,               // 可选分组键 workflow:<id>/task:<id>/handoff:<id>
      priority: args.priority || "normal",     // low|normal|high|critical
      body: args.body || "",
      memory: !!args.memory,                   // true → 入队后异步沉淀进向量记忆
      created_at: new Date().toISOString(),
      consumed: false, lease: null, lease_by: null
    };
    box.msgs.push(msg);
    result = { ok: true, id, msg };
  });
  return result;
}
// 消息异步沉淀进向量记忆（内存信号: bus → brain）。失败静默降级, 不影响投递。幂等(按 source=bus:<id>)。
export async function sedimentBusMessage(msg) {
  try {
    const vm = await getVecMemory();
    const body = `[bus ${msg.kind}${msg.topic ? ` @${msg.topic}` : ""} ${msg.priority}] ` +
                 `${msg.from}→${msg.to}: ${msg.body}`;
    await vm.memoryAdd({ content: body, category: "global:bridge:bus", source: `bus:${msg.id}`, scope: "global" });
    return true;
  } catch { return false; }
}

// ---- Task ID generator ----
// 从主文件迁入（ 模块拆分第四步）：run-driver 与 handler 层共用，放 state-store 避免循环依赖。
export function generateTaskId() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `task-${date}-${time}-${rand}`;
}
