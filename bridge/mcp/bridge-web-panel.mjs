#!/usr/bin/env node
/**
 * Bridge Web Panel — multi-agent 协作实时监控面板
 *
 * 可视化 multi-agent bridge 状态：
 *  - 队长（claude）+ 成员卡片（角色头像 / 状态 / 进度，可点击查看详情）
 *  - 任务依赖 DAG（SVG 三次曲线，深度分列，hover 聚焦上下游链，点击查看详情）
 *  - 队长收件箱预览（可点击查看详情）
 *  - 共享记忆 KV（可点击查看详情）
 *
 * 数据源：~/.multi-agent-bridge/state/memory.json（只读）
 *   - tasks:    { id: { title, status, assigned_to, claimed_by, dependencies, created_at, exit_code, ... } }
 *   - mailbox:  { agent: { lastNdx, msgs: [{ id, from, body, created_at, consumed, lease, lease_by }] } }
 *   - 共享记忆:  ~/.agents/shared-memory/kv.json（shared_memory_set 写入，与 shared-memory 插件共用）
 *   - 共享笔记:  ~/.agents/shared-memory/notes.log（append-only，shared_notes_append）
 *
 * 启动：node bridge-web-panel.mjs [--port 3000]
 * 访问：http://127.0.0.1:3000   （仅本机，不暴露局域网）
 */

import { readFileSync, writeFileSync, existsSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { updateMem, KV_FILE, NOTES_FILE } from './state-store.mjs';

const PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1], 10) || 3000
  : 3000;
const STATE_DIR = process.env.BRIDGE_STATE_DIR || join(homedir(), '.multi-agent-bridge', 'state');
const MEM_FILE = join(STATE_DIR, 'memory.json');
// NOTES_FILE / KV_FILE 来自 state-store（与 bridge/插件共用 ~/.agents/shared-memory/）
const CONTROL_FILE = join(STATE_DIR, 'control.json');

/* ── DAG 几何 ───────────── */
const NODE_W = 150, NODE_H = 34, COL_GAP = 30, ROW_GAP = 10;

/* ── 角色映射（按 agent 名兜底） ─────────── */
const AGENT_ROLE = {
  claude: { role: 'captain', label: '队长 · 主控', grad: ['#6366f1', '#4338ca'] },
  codex: { role: 'engineer', label: '工程师 · 实现', grad: ['#0ea5e9', '#0369a1'] },
  opencode: { role: 'engineer', label: '工程师 · 兜底', grad: ['#14b8a6', '#0f766e'] },
  qwen: { role: 'docs', label: '文档 · 写作', grad: ['#f59e0b', '#b45309'] },
  dsh: { role: 'coordinator', label: '编排 · 多后端', grad: ['#8b5cf6', '#6d28d9'] },
  'verify-agent': { role: 'qa', label: 'QA · 验证', grad: ['#10b981', '#047857'] },
};
const DEFAULT_ROLE = { role: 'member', label: '成员', grad: ['#64748b', '#334155'] };

function roleOf(agent) {
  return AGENT_ROLE[agent] || DEFAULT_ROLE;
}

/* ── 读取 memory.json ─────────────────────────────────────────────── */
function readMemory() {
  try {
    return JSON.parse(readFileSync(MEM_FILE, 'utf8'));
  } catch (e) {
    return { tasks: {}, mailbox: {} };
  }
}

/* ── 主控识别（面板侧选择，持久化到 control.json）─────────────────── */
const CONTROLLER_CANDIDATES = ['claude', 'codex', 'dsh', 'qwen', 'opencode'];
function readController() {
  try {
    if (!existsSync(CONTROL_FILE)) return 'claude';
    const c = JSON.parse(readFileSync(CONTROL_FILE, 'utf8'));
    const name = c.controller;
    // 主控候选取自当前静态表；自动识别写入的如已在候选内则采纳
    // （候选=『可作为主控』的 agent：claude/codex/dsh/qwen/opencode）
    return CONTROLLER_CANDIDATES.includes(name) ? name : 'claude';
  } catch (e) {
    return 'claude';
  }
}
function saveController(name) {
  if (!CONTROLLER_CANDIDATES.includes(name)) return false;
  try {
    writeFileSync(CONTROL_FILE, JSON.stringify({ controller: name, source: 'manual' }, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

/* ── 可编辑动作写端（可操作）─────────────────────────────────────
 * 面板从"只读监控"升级为"可操作"：经 /api/action 落写任务状态机，以 updateMem（与 MCP server 同一把
 * O_EXCL 锁）与 server handleSync 语义**逐条对齐**，避免面板写坏状态机。
 * 动作：reassign / claim / complete / fail / approve(reject) / send(msg)。
 */
function staleAttemptRejectedFor(t, attemptId) {
  if (!attemptId || !t.stale_attempt_ids) return false;   // 无令牌调用本就信任（主控直调）；无 stale 名单放行
  if (t.attempt_id && attemptId === t.attempt_id) return false;  // 当前令牌正常
  return t.stale_attempt_ids.includes(attemptId);          // 命中旧令牌 → 迟到覆盖
}

function panelDoAction(action, args) {
  args = args || {};
  let result = { ok: false, error: 'unknown action' };
  updateMem((m) => {
    switch (action) {
      case 'reassign': {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; break; }
        if (['completed', 'failed', 'superseded'].includes(t.status)) {
          result = { ok: false, error: `cannot reassign task already in terminal status "${t.status}"` }; break;
        }
        const was = t.status;
        t.status = 'pending';
        t.claimed_by = null; t.claimed_at = null;
        if (t.attempt_id) (t.stale_attempt_ids = t.stale_attempt_ids || []).push(t.attempt_id);
        t.attempt_id = null;
        t.reassigning = true;
        t.reassignedAt = new Date().toISOString();
        t.reassignNote = args.note || '';
        result = { ok: true, was, reassigning: true };
        break;
      }
      case 'claim': {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; break; }
        if (t.status !== 'pending') { result = { ok: false, error: `cannot claim task in status "${t.status}"` }; break; }
        const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
        if (deps.length) {
          const unmet = deps.filter(did => {
            const d = m.tasks[did];
            return !d || !['completed', 'superseded', 'failed'].includes(d.status); // failed 放行：失败的视角/环节不阻塞其派生的收敛任务(2026-08-31)
          });
          if (unmet.length) {
            result = { ok: false, error: `cannot claim task ${args.task_id}: unmet dependencies [${unmet.join(', ')}] (must be completed, superseded, or failed first)` }; break;
          }
        }
        t.status = 'running';
        t.claimed_by = args.agent_name || 'unknown';
        t.claimed_at = new Date().toISOString();
        const attempt = `at-${args.task_id}-${Math.floor(Math.random() * 1e9)}`;
        t.attempt_id = attempt;
        t.stale_attempt_ids = [];
        t.reassigning = false;
        t.last_heartbeat_at = Date.now();
        t.heartbeat_n = 0;
        t.progress_log = [];
        t.escalation = null;
        result = { ok: true, attempt_id: attempt };
        break;
      }
      case 'complete': {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; break; }
        if (t.status !== 'running') { result = { ok: false, error: `cannot complete task in status "${t.status}"` }; break; }
        if (staleAttemptRejectedFor(t, args.attempt_id)) {
          result = { ok: false, error: `stale attempt_id ${args.attempt_id} (current ${t.attempt_id || 'none'}) — task was re-assigned or re-claimed` }; break;
        }
        if (!args.attempt_id && t.reassigning && t.stale_attempt_ids && t.stale_attempt_ids.length) {
          result = { ok: false, error: `task is under reassignment (attempt ${t.attempt_id || 'revoked'}) — complete requires the current attempt_id` }; break;
        }
        if (t.deliverable && (t.deliverable.includes(':') || t.deliverable.includes('\\') || t.deliverable.includes('/')) && !existsSync(t.deliverable)) {
          result = { ok: false, error: `completed 时 deliverable 不存在: ${t.deliverable}` }; break;
        }
        if (t.require_approval) {
          t.status = 'awaiting_approval';
          t.approved_at = null; t.approver = null; t.approval_note = null;
          t.completed_at = null; t.result = args.result || '';
          result = { ok: true, awaiting_approval: true, hint: '需要人工 task_approve 审批通过后才视为完成' };
          break;
        }
        t.status = 'completed';
        t.completed_at = new Date().toISOString();
        t.completed_by = args.agent_name || t.claimed_by || 'unknown';
        t.result = args.result || '';
        result = { ok: true };
        break;
      }
      case 'fail': {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; break; }
        if (staleAttemptRejectedFor(t, args.attempt_id)) {
          result = { ok: false, error: `stale attempt_id ${args.attempt_id} (current ${t.attempt_id || 'none'}) — task was re-assigned or re-claimed` }; break;
        }
        t.status = 'failed';
        t.completed_at = new Date().toISOString();
        t.result = args.result || 'failed';
        result = { ok: true };
        break;
      }
      case 'approve': {
        const t = m.tasks[args.task_id];
        if (!t) { result = { ok: false, error: `task not found: ${args.task_id}` }; break; }
        if (t.status !== 'awaiting_approval') {
          result = { ok: false, error: `cannot approve task in status "${t.status}" (must be awaiting_approval)` }; break;
        }
        if (staleAttemptRejectedFor(t, args.attempt_id)) {
          result = { ok: false, error: `stale attempt_id ${args.attempt_id} (current ${t.attempt_id || 'none'}) — re-claimed after approval` }; break;
        }
        if (args.decision === 'approve') {
          t.status = 'completed';
          t.completed_at = t.completed_at || new Date().toISOString();
          t.completed_by = args.approver || (t.completed_by || t.claimed_by || 'unknown');
          t.approved_at = new Date().toISOString();
          t.approver = args.approver || 'unknown';
          t.approval_note = args.note || '';
          result = { ok: true, decision: 'approve', approved: true };
        } else {
          t.status = 'running';
          t.approved_at = null; t.approver = null; t.approval_note = args.note || '';
          result = { ok: true, decision: 'reject', back_to: 'running', note: args.note || 'rejected by human' };
        }
        break;
      }
      case 'send': {
        if (!args.to || !args.body) { result = { ok: false, error: 'send requires to + body' }; break; }
        if (!m.mailbox) m.mailbox = {};
        if (!m.mailbox[args.to]) m.mailbox[args.to] = { lastNdx: 0, msgs: [] };
        const box = m.mailbox[args.to];
        const ndx = ++box.lastNdx;
        const id = `${args.to}:${ndx}`;
        const nowIso = new Date().toISOString();
        if (!box.msgs) box.msgs = [];
        box.msgs.push({
          id, from: args.from || 'panel', to: args.to, kind: args.kind || 'message',
          topic: args.topic || null, priority: args.priority || 'normal', body: args.body,
          memory: !!args.memory, created_at: nowIso,
          consumed: false, lease: null, lease_by: null,
        });
        result = { ok: true, id, msg_id: id };
        break;
      }
    }
  });
  return result;
}

function readNotes() {
  try {
    if (!existsSync(NOTES_FILE)) return [];
    return readFileSync(NOTES_FILE, 'utf8').split('\n')
      .filter(Boolean)
      .map((line) => {
        // 格式：- <ts> [tag] <note>
        const m = line.match(/^- (\S+) (?:\[(\S+)\])? (.*)$/);
        return m ? { ts: m[1], tag: m[2] || '', note: m[3] } : { ts: '', tag: '', note: line };
      });
  } catch (e) {
    return [];
  }
}

function htmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── 计算任务深度（拓扑，环安全） ─────────────────────────────────── */
function computeDepths(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cache = new Map();
  const visiting = new Set();
  function depthOf(id) {
    if (cache.has(id)) return cache.get(id);
    const t = byId.get(id);
    if (!t || !t.dependencies || t.dependencies.length === 0) {
      cache.set(id, 0); return 0;
    }
    if (visiting.has(id)) { cache.set(id, 0); return 0; }
    visiting.add(id);
    let d = 0;
    for (const dep of t.dependencies) {
      if (byId.has(dep)) d = Math.max(d, depthOf(dep) + 1);
    }
    visiting.delete(id);
    cache.set(id, d);
    return d;
  }
  for (const t of tasks) depthOf(t.id);
  return cache;
}

/* ── 无真实依赖边时用填宽网格 ── */
function usesParallelTaskGrid(tasks) {
  if (tasks.length === 0) return false;
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.every((t) => (t.dependencies || []).every((d) => !ids.has(d)));
}

/* ── compactDagLayout（并行态走填宽网格） ── */
function compactDagLayout(tasks, maxWidth) {
  const n = tasks.length;
  if (n === 0) return { width: 0, height: 0, nodes: [], edges: [], stages: 0 };
  /* 列数：受宽度约束，避免超出面板容器(横向裁切/滚动)。 */
  const colW = NODE_W + COL_GAP;
  const maxCols = maxWidth ? Math.max(1, Math.floor((maxWidth - COL_GAP) / colW)) : 8;
  const cols = Math.min(maxCols, Math.max(1, Math.ceil(Math.sqrt(n))));
  /* 拓扑序：让被依赖的任务排在前面(左/上)，减少连边折返。 */
  const depths = computeDepths(tasks);
  const ordered = [];
  const visited = new Set();
  function visit(t) { if (visited.has(t.id)) return; visited.add(t.id); for (const d of (t.dependencies || [])) { const p = tasks.find((x) => x.id === d); if (p) visit(p); } ordered.push(t); }
  tasks.forEach(visit);
  /* 顺序铺进 cols 列网格。 */
  const pos = new Map();
  const sorted = ordered.length ? ordered
    : tasks.slice().sort((a, b) => (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0));
  sorted.forEach((t, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    pos.set(t.id, { x: col * (NODE_W + COL_GAP), y: row * (NODE_H + ROW_GAP) });
  });
  const nodes = sorted.map((t) => { const p = pos.get(t.id); return { id: t.id, x: p.x, y: p.y, status: t.status, title: t.title, assignee: t.assigned_to, dependencies: t.dependencies || [], evolve: t.evolve || null }; });
  const edges = [];
  for (const t of tasks) {
    const tgt = pos.get(t.id); if (!tgt) continue;
    for (const dep of (t.dependencies || [])) {
      const src = pos.get(dep); if (!src) continue;
      const x1 = src.x + NODE_W, y1 = src.y + NODE_H / 2;
      const x2 = tgt.x, y2 = tgt.y + NODE_H / 2;
      edges.push({ from: dep, to: t.id, path: `M${x1} ${y1} C ${x1 + 24} ${y1}, ${x2 - 24} ${y2}, ${x2} ${y2}` });
    }
  }
  const height = (Math.ceil(n / cols)) * (NODE_H + ROW_GAP) - ROW_GAP + 20;
  const width = cols * NODE_W + (cols - 1) * COL_GAP;
  return { width, height, nodes, edges, stages: cols };
}

/* ── 构建成员活动（从任务派生 working/idle + 进度 + 耗时） ─────────── */
const GHOST_AGENTS = new Set(['tester','agent','test','unknown','verify-agent','undefined','null','na','none','orchestrator']); // 测试/占位，不入成员列表
function buildMembers(mem) {
  const entries = Object.entries(mem.tasks || {});
  const agents = new Map();
  agents.set('claude', { agent: 'claude', claimed: 0, done: 0, failed: 0, running: 0, currentTask: '', taskList: [] });
  for (const [id, t] of entries) {
    const who = t.claimed_by || t.assigned_to;
    if (!who) continue;
    if (GHOST_AGENTS.has(who)) continue; // 排除测试/占位成员(tester/unknown/agent/verify-agent 等)+ 已弃用成员
    if (!agents.has(who)) agents.set(who, { agent: who, claimed: 0, done: 0, failed: 0, running: 0, currentTask: '', taskList: [] });
    const m = agents.get(who);
    m.claimed++;
    if (t.status === 'completed') m.done++;
    else if (t.status === 'failed') m.failed++;
    else if (t.status === 'running') { m.running++; m.currentTask = t.title; }
    /* ── 计算耗时 ── */
    let duration = null;
    if (t.completed_at && t.created_at) {
      const d = new Date(t.completed_at) - new Date(t.created_at);
      if (d > 0) duration = d;
    }
    m.taskList.push({ id: id, title: t.title || '(untitled)', status: t.status || 'pending', created_at: t.created_at || 0, duration });
  }
  return [...agents.values()].map((m) => {
    const r = roleOf(m.agent);
    const activity = m.running > 0 ? 'working' : 'idle';
    const progress = m.claimed > 0 ? Math.round((m.done / m.claimed) * 100) : 0;
    const taskList = m.taskList
      .sort((a, b) => (b.status === 'running' ? 1 : 0) - (a.status === 'running' ? 1 : 0) || (b.created_at || 0) - (a.created_at || 0))
      .slice(0, 6);
    return { ...m, role: r.role, label: r.label, grad: r.grad, activity, progress, taskList };
  });
}

/* ── 工作流分组：把任务聚成"一次多Agent工作流"，供面板按工作流查看 ──
 * 成员判定：
 *   ① 显式 workflow 标签（workflow_start / wf 桥上报带 workflow.{id,tpl,step}）
 *   ② 启发式最近批：标题共享同一前缀(有分隔符) 且 近期任务 且 ≥2 条 —— 可归成一次工作流批
 * 只把"活/近"批次上墙为卡片，纯历史单发任务折进"单发"桶。 */
function buildWorkflows(tasks, now) {
  // cannot make a workflow from nothing
  if (!tasks.length) return { list: [], other: 0 };
  const GROUPS = new Map(); // key -> { title, tpl, set, keys }
  function gkey(k) { if (!GROUPS.has(k)) GROUPS.set(k, { title: null, tpl: null, wfid: null, paradigm: null, set: new Set(), list: [] }); return GROUPS.get(k); }
  // wf 基准标题：去掉阶段后缀" * 01..質检"
  // wf 基准标题：去掉阶段后缀"01需求分析"。只按中文句读分隔符切，不切小横线(-/— 常在名称里)
  function wfBase(title) { return String(title || '').split(/[·|：:]/)[0].trim(); }
  const sepRe = /[·|：/][～\d]*\s*/;

  const byKey = new Map(); // task.id -> groupKey

  /* ① 显式 workflow 字段 */
  tasks.forEach((t) => {
    const w = t.workflow;
    if (w && (w.id || w.tpl)) {
      const base = w.id ? (w.tpl || 'wf') + ':' + w.id : (w.tpl || 'wf') + ':' + wfBase(t.title);
      const g = gkey(base);
      g.tpl = w.tpl || g.tpl;
      g.wfid = w.id || (w.tpl || 'wf');
      g.paradigm = w.paradigm || g.paradigm;   // 竞争式 compete / 合作式 collaborate / null=线性
      g.title = w.base || w.base_title || wfBase(t.title);
      g.list.push(t.id); g.set.add(t.id); byKey.set(t.id, base);
      return;
    }
  });

  /* ③ 并行簇虚拟卡（无显式 worklflow）：同 created_by + 同时间窗 + 标题共词的批次收敛成一张虚拟卡。
     default 去 failed/superseded/cancelled/completed —— 历史完成批不上墙，只看正在实施的并行派发簇。
     放 ② 之前：防 ② 把"不同前缀+共享词"的批次（如 调研A/调研B/调研C）各自吃成单任务后被丢弃。 */
  const VIRTUAL_WIN = 300 * 1000; // 同簇派发间隔容差(ms)：并行 run_<agent> 单次fan-out可达 ~2min/agent（codex/qwen 冷启动），短窗口会拆散真并行
  {
    const byCreator = new Map();
    const BAD_CREATOR = new Set(['unknown', 'undefined', 'null', 'auto', 'system']);
    tasks.forEach((t) => {
      if (byKey.has(t.id)) return;
      if (['failed', 'superseded', 'cancelled', 'completed'].includes(t.status)) return;
      if (!t.created_by) return;
      if (BAD_CREATOR.has(String(t.created_by).toLowerCase())) return; // 占位 creator 不做簇依据
      if (!byCreator.has(t.created_by)) byCreator.set(t.created_by, []);
      byCreator.get(t.created_by).push(t);
    });
    // 标题共词：只取跨任务出现 >=2 次的 CJK 2 字（中文语义词），ASCII 碎片（te/es/on）不聚类
    const sharedKw = (titles) => {
      const freq = new Map();
      const ok = (ch) => /[一-鿿]/.test(ch);
      for (const raw of titles) {
        const s = String(raw || '');
        for (let i = 0; i + 1 < s.length; i++) {
          if (ok(s[i]) && ok(s[i + 1])) {
            const g2 = s[i] + s[i + 1];
            freq.set(g2, (freq.get(g2) || 0) + 1);
          }
        }
      }
      let best = null, bestN = 0;
      for (const [w, c] of freq) {
        if (c < 2) continue;
        if (c > bestN || (c === bestN && w.length > (best ? best.length : 0))) { best = w; bestN = c; }
      }
      return best;
    };
    for (const [creator, arr] of byCreator) {
      arr.sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
      let burst = [];
      const flush = () => {
        if (burst.length >= 2) {
          const kw = sharedKw(burst.map((t) => t.title));
          if (kw && kw.length >= 2) {
            const key = 'virt:' + creator + ':' + kw;
            const g = gkey(key);
            g.title = '并行·' + kw; g.tpl = 'virtual'; g.wfid = null;
            for (const tt of burst) { g.list.push(tt.id); g.set.add(tt.id); byKey.set(tt.id, key); }
          }
        }
        burst = [];
      };
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        const tc = Date.parse(t.created_at) || 0;
        const pc = burst.length ? (Date.parse(burst[burst.length - 1].created_at) || 0) : 0;
        if (burst.length && (tc - pc) > VIRTUAL_WIN) flush();
        burst.push(t);
      }
      flush();
    }
  }

  /* ② 启发式批次（无显式 workel）：只认"活/近"批次，历史完成批不上墙 */
  tasks.forEach((t) => {
    if (byKey.has(t.id)) return;
    const raw = String(t.title || '');
    if (!sepRe.test(raw)) return;                       // 不含分隔符的普通任务不猜
    const base = wfBase(raw);
    if (base.length < 2 || base.length > 40) return;
    const isActive = ['running', 'pending', 'awaiting_approval', 'escalating'].includes(t.status);
    if (!isActive) return;                              // 只要 pending 的批次（运行/待领/待批）
    const g = gkey('heur:' + base);
    g.title = base; g.tpl = 'ad-hoc'; g.wfid = null;
    g.list.push(t.id); g.set.add(t.id); byKey.set(t.id, 'heur:' + base);
  });

  // 折叠成卡片：按 groupKey 聚合，剔除"单发"(仅1条) 的非显式组
  const nowMs = Date.now();
  for (const [k, g] of GROUPS) {
    const explicit = k.startsWith('heur') === false;
    if (!explicit && g.list.length < 2) continue;               // 启发组仅1条不要
    // 排序 list 按创建时间
    const gtasks = g.list.map((id) => tasks.find((x) => x.id === id));
    gtasks.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    g.items = gtasks;
  }
  /* 未分组任务 -> 单发桶 */
  const other = tasks.filter((t) => !byKey.has(t.id)).length;

  /* 组装卡片 */
  const out = [];
  for (const [k, g] of GROUPS) {
    if (!g.items) continue;
    const st = { pending: 0, running: 0, completed: 0, failed: 0, superseded: 0, interrupted: 0, escalating: 0, awaiting_approval: 0, cancelled: 0 };
    g.items.forEach((t) => { st[t.status] = (st[t.status] || 0) + 1; });
    const steps = g.items.map((t) => ({
      step: (t.workflow && t.workflow.step) || wfBase(t.title),
      id: t.id,
      status: t.status || 'pending',
      claimed_by: t.claimed_by || '',
      assigned_to: t.assigned_to || '',            // UI：已派发但未领取 → 区分"待领取"vs"已派发待开工"
      created_at: t.created_at || 0,
      completed_at: t.completed_at || null,
      evolve: t.evolve || null,                    //  演进标记：fork/repoint 节点打徽标区分"原规划"
      duration: (t.completed_at && t.created_at) ? Math.max(0, new Date(t.completed_at) - new Date(t.created_at)) : null,
      // / 心跳 + 里程碑：进度摘要（末 3 条 note）+ 心跳新鲜度（running 态才判）
      progress: (t.progress_log || []).slice(-3).map((p) => p.note),
      hb: t.last_heartbeat_at || null,
      heartbeat_n: t.heartbeat_n || 0,
      live: t.agent_live || undefined,
    }));
    const dag = compactDagLayout(g.items, 1024);
    /* 空心壳判定：显式工作流若全阶段一仍 pending 且用的是内置 bmad 通用模板
       （需求分析/架构设计/实现/质量评审），且确实没有任何运行/完成 →
       判定为派发后无人从该卡推进、工件任务也未挂接的空壳占位（如某个未接工件的空壳卡），
       前端灰显折叠。带自定义 stages 的真实工作流不误标。 */
    const genericSteps = ['01需求分析','02架构设计','03实现','04质量评审'];
    const isGenericBmad = g.items.length === 4 && g.items.every((t) =>
      genericSteps.includes((t.workflow && t.workflow.step) || wfBase(t.title)));
    const isParadigm = g.paradigm === 'compete' || g.paradigm === 'collaborate';
    const explicitShell = (g.tpl !== 'virtual' && g.tpl !== 'ad-hoc')
      && st.running === 0 && st.completed === 0 && st.failed === 0 && st.pending > 0
      && isGenericBmad
      && !isParadigm
      && g.items.every((t) => !t.claimed_by && !t.assigned_to);
    /* 历史折叠：①路显式工作流若阶段任务全终态（completed/failed/superseded/cancelled，
       无 running/pending/escalating/awaiting_approval）→ 归档为“历史”行，不占当前工作流卡片。
       空壳卡（explicitShell 含 pending>0）不受影响，仍正常上墙。 */
    const nonTerminal = st.running + st.pending + st.escalating + st.awaiting_approval;
    const archived = nonTerminal === 0 && !explicitShell;
    out.push({
      key: k,
      title: g.title || '未命名工作流',
      tpl: g.tpl || 'ad-hoc',
      paradigm: g.paradigm || null,
      wfid: g.wfid || null,
      total: g.items.length,
      done: st.completed, running: st.running, failed: st.failed, pending: st.pending,
      escalating: st.escalating,                      // 决策上浮：待决任务数（面板徽标）
      assigned: (g.items.filter((t) => t.assigned_to && !t.claimed_by && t.status === 'pending')).length, // UI：已派发待开工
      awaiting_approval: st.awaiting_approval,        // UI：待批
      superseded: st.superseded,                      // UI：已结束(被fork取代)
      interrupted: st.interrupted,                    // UI：已中断(可恢复)
      emptyShell: explicitShell,
      archived: !!archived,                           // 历史折叠：全阶段终态的旧工作流
      completed_archived: st.completed + st.superseded + st.failed, // 历史行统计
      steps,
      dag,
    });
  }
  // 有运行态的排前
  out.sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || (b.done + b.running) - (a.done + a.running));
  return { list: out, other };
}

/* ── 构建完整状态（供 /api/state） ────────────────────────────────── */
function buildState() {
  const mem = readMemory();
  const now = Date.now();
  const rawTasks = Object.values(mem.tasks || {});
  const tasks = Object.entries(mem.tasks || {}).map(([id, t]) => ({
    id: id, title: t.title || '(untitled)', status: t.status || 'pending',
    assigned_to: t.assigned_to || '', claimed_by: t.claimed_by || '',
    dependencies: t.dependencies || [], created_at: t.created_at || 0,
    completed_at: t.completed_at || null, exit_code: t.exit_code,
    retries: t.retries || [], result: t.result || null,
    workflow: t.workflow || null,
    created_by: t.created_by || null,
    //  worker 里程碑 +  心跳：面板据此读进度摘要 / 心跳新鲜度
    last_heartbeat_at: t.last_heartbeat_at || null,
    heartbeat_n: t.heartbeat_n || 0,
    agent_live: t.agent_live || null,
    progress_log: Array.isArray(t.progress_log) ? t.progress_log : [],
    escalation: t.escalation || null,
    //  演进标记：fork 分支 / repoint 重算依赖的节点，面板打视觉徽标区分"原规划"
    evolve: t.evolve || null,
    // worker 运行会话 id：每次派发/上报都记录，面板给队长显示，可凭其 points 到 DSH/opencode 续接取证
    session_id: t.session_id || null,
  }));
  const stat = { pending: 0, running: 0, completed: 0, failed: 0, superseded: 0, interrupted: 0 };
  for (const t of tasks) stat[t.status] = (stat[t.status] || 0) + 1;
  const members = buildMembers(mem);
  /* ── 队长摘要（随主控漂移） ── */
  const controller = readController();
  const allAgents = [...new Set(tasks.map((t) => t.assigned_to).filter(Boolean))];
  const activeAgents = [...new Set(tasks.filter((t) => t.claimed_by).map((t) => t.claimed_by))];
  const isController = (a) => a === controller;
  const captainSummary = {
    controller,
    dispatched: tasks.filter((t) => t.assigned_to && !isController(t.assigned_to)).length,
    activeMembers: activeAgents.filter(isController).length,
    running: tasks.filter((t) => t.status === 'running').length,
    completed: stat.completed,
  };
  /* ── 任务耗时 ── */
  tasks.forEach((t) => {
    if (t.completed_at && t.created_at) {
      const dur = new Date(t.completed_at) - new Date(t.created_at);
      t.duration = dur > 0 ? dur : null;
    } else {
      t.duration = null;
    }
    t.elapsed = (t.status === 'running' && t.created_at) ? (now - new Date(t.created_at)) : null;
  });
  /* ── 每 Agent 调用统计 ── */
  const agentStats = {};
  for (const agent of allAgents) {
    const agentTasks = tasks.filter((t) => (t.claimed_by || t.assigned_to) === agent);
    const total = agentTasks.length;
    const ok = agentTasks.filter((t) => t.status === 'completed').length;
    const fail = agentTasks.filter((t) => t.status === 'failed').length;
    const retries = agentTasks.reduce((n, t) => n + (t.retries || []).length, 0);
    const timeout = agentTasks.filter((t) => t.retries && t.retries.some((r) => r.reason === 'timeout')).length;
    const succRate = total > 0 ? Math.round((ok / total) * 100) : 0;
    // 平均耗时 ms（仅 completed）
    const avgMs = (() => {
      const durs = agentTasks.filter((t) => t.duration !== null && t.duration !== undefined).map((t) => t.duration);
      return durs.length > 0 ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0;
    })();
    agentStats[agent] = { total, ok, fail, retries, timeout, succRate, avgMs };
  }
  /* ── DAG 只展示「活动流」任务：运行/待领/待批 + 近 1h 新建，其余历史从图排除(可在总览查看) ── */
  const dagActive = tasks.filter((t) =>
    ['running','pending','awaiting_approval','escalating'].includes(t.status)   // 存活/待办节点
    || (t.created_at && (now - new Date(t.created_at).getTime() < 60 * 3600 * 1000)) // 近 1h 新建
  ).sort((a,b)=> (b.created_at||0)-(a.created_at||0));
  const dagTasks = dagActive.slice(0, 25); // 最多 25 节点，进一步压缩到可一眼扫视
  const dag = compactDagLayout(dagTasks, 1024);
  const mailbox = mem.mailbox || {};
  /* ── 完整收件箱时间线：全 agent 全字段（含已读/topic/kind/priority），供「Agent 消息时间线」tab ── */
  const inbox = Object.entries(mailbox).map(([to, box]) => {
    const msgs = (box.msgs || []).map((m) => ({
      id: m.id, from: m.from || '', to: m.to || to,
      kind: m.kind || 'message', topic: m.topic || null,
      priority: m.priority || 'normal', body: m.body || '',
      created_at: m.created_at || null, consumed: !!m.consumed,
      lease_by: m.lease_by || null,
    }));
    return { agent: to, lastNdx: box.lastNdx || 0, msgs };
  });
  const allUnread = inbox.reduce((n, b) => n + b.msgs.filter((m) => !m.consumed).length, 0);
  let sharedMemMap = {};
  try { sharedMemMap = JSON.parse(readFileSync(KV_FILE, 'utf8')); } catch { /* 无 KV 或不可读则空 */ }
  const sharedMemory = Object.keys(sharedMemMap)
    .map((k) => ({ key: k, value: String(sharedMemMap[k] ?? '').slice(0, 120) }));
  const notes = readNotes().slice(-12).reverse();
  /* ── 主控 ── */
  const controllerLabel = (AGENT_ROLE[controller] || DEFAULT_ROLE).label;
  /* ── 每 Agent 任务进度总览（含耗时/结果，供右侧/中间空白区） ── */
  const agentTasks = {};
  for (const t of tasks) {
    const who = t.claimed_by || t.assigned_to || ''; // 认领优先，其次按 assign 归组；两者皆无从略
    if (!who) continue;
    if (!agentTasks[who]) agentTasks[who] = [];
    agentTasks[who].push(t);
  }
  const agentOverview = Object.keys(agentTasks)
    .filter((who) => !GHOST_AGENTS.has(who))   // 与成员卡同规则：去除测试/占位/已弃用；认领/assign 皆无者已在分组时跳过
    .sort((a, b) => (a === controller ? -1 : 0) - (b === controller ? -1 : 0) || a.localeCompare(b))
    .map((who) => {
      const list = agentTasks[who];
      const done = list.filter((t) => t.status === 'completed').length;
      const running = list.filter((t) => t.status === 'running').length;
      const failed = list.filter((t) => t.status === 'failed').length;
      const progress = list.length > 0 ? Math.round((done / list.length) * 100) : 0;
      return {
        agent: who,
        isController: who === controller,
        total: list.length, done, running, failed,
        progress,
        tasks: list.slice().sort((a, b) => (b.status === 'running' ? 1 : 0) - (a.status === 'running' ? 1 : 0) || (b.created_at || 0) - (a.created_at || 0)).slice(0, 50),
      };
    });
  return { stat, total: tasks.length, members, dag, tasks, workflows: buildWorkflows(tasks, now), captainSummary, agentStats, inbox, allUnread, sharedMemory, notes, controller, controllerLabel, controllerCandidates: CONTROLLER_CANDIDATES, agentOverview };
}

/* ── 渲染 HTML 外壳 + 客户端轮询 ───────────────────────────────────
 * 注意：HTML 是服务端模板字符串（反引号），其中 ${NODE_W} 等在此插值。
 * 客户端 <script> 内一律用字符串拼接，不用反引号/模板字符串，避免与服务端插值冲突。
 */
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>multi-agent 面板</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#0f172a;--panel:#1e293b;--panel2:#334155;--line:#475569;--txt:#e2e8f0;--mut:#94a3b8;--acc:#6366f1;--ok:#22c55e;--warn:#f59e0b;--err:#ef4444;--run:#3b82f6;--pend:#eab308;--sup:#64748b}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--txt);padding-top:52px;min-height:100vh}
  .topbar{position:fixed;top:0;left:0;right:0;display:flex;flex-direction:column;padding:10px 18px 12px;background:rgba(15,23,42,0.95);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);z-index:1000;gap:6px}
  .toprow{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
  .toprow h1{font-size:1.15rem;display:flex;align-items:center;gap:10px;white-space:nowrap}
  h1 .sub{font-size:.75rem;color:var(--mut);font-weight:400}
  .ctrl-box{display:flex;align-items:center;gap:6px;font-size:.78rem;color:var(--mut)}
  .ctrl-box label{cursor:pointer}
  .ctrl-box select{padding:4px 8px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--txt);font-size:.78rem;cursor:pointer;outline:none}
  .ctrl-box select:focus{border-color:var(--acc)}
  .search-box{position:relative;max-width:240px;flex:0 1 240px}
  .search-box input{width:100%;padding:4px 10px 4px 30px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--txt);font-size:.78rem;outline:none;transition:border-color .15s}
  .search-box input:focus{border-color:var(--acc)}
  .search-box svg{position:absolute;left:8px;top:50%;transform:translateY(-50%);pointer-events:none}
  .stats{display:flex;gap:6px;flex-wrap:wrap;flex-shrink:1}
  .chip{padding:4px 10px;border-radius:999px;font-size:.72rem;font-weight:600;background:var(--panel);border:1px solid var(--line)}
  .chip b{font-size:.9rem}
  .chip.pend{color:var(--pend)} .chip.run{color:var(--run)} .chip.ok{color:var(--ok)} .chip.err{color:var(--err)} .chip.sup{color:var(--sup)}
  .chip.warn{color:var(--warn);border-color:var(--warn)}
  .grid{display:grid;grid-template-columns:1fr;gap:16px;width:100%;padding:18px}
  @media(min-width:1400px){.grid{grid-template-columns:340px minmax(0,1fr) 360px}}
  @media(min-width:1100px) and (max-width:1399px){.grid{grid-template-columns:300px 1fr}}
  .col-side{min-width:0}
  .col-main{min-width:0;max-width:100%}
  .col-right{min-width:0}
  .col-main{display:flex;flex-direction:column;gap:16px}
  @media(min-width:1100px) and (max-width:1399px){.col-right{grid-column:1/-1;margin-top:0}} /* 中屏把右列下移并横跨 */
  .panel-dag .dag-wrap{min-height:420px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
  .panel h2{font-size:.95rem;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;display:flex;align-items:center;gap:8px}
  .member{display:flex;align-items:center;gap:12px;padding:10px;border-radius:10px;background:var(--panel2);margin-bottom:8px;border:1px solid transparent;transition:border-color .15s,transform .15s;cursor:pointer}
  .member:hover{transform:translateX(4px);border-color:var(--acc)}
  .member.working{border-color:var(--ok)}
  .member .info{flex:1;min-width:0}
  .member .name{font-weight:600;font-size:.92rem;display:flex;align-items:center;gap:6px;white-space:nowrap}
  .member .role{font-size:.72rem;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .member .bar{height:5px;border-radius:3px;background:#1e293b;margin-top:5px;overflow:hidden}
  .member .bar > i{display:block;height:100%;background:linear-gradient(90deg,var(--acc),#818cf8);transition:width .4s}
  .member .meta{font-size:.7rem;color:var(--mut);margin-top:3px}
  .badge{font-size:.68rem;padding:1px 7px;border-radius:999px;font-weight:600}
  .badge.working{background:rgba(34,197,94,.18);color:var(--ok)} .badge.idle{background:rgba(148,163,184,.18);color:var(--mut)}
  .avatar{flex-shrink:0;filter:drop-shadow(0 2px 4px rgba(0,0,0,.3))}
  .dag-wrap{overflow:auto;max-height:560px;border-radius:8px;background:#0b1220;border:1px solid var(--line);padding:12px}
  .dag-wrap svg{display:block;max-width:100%;height:auto;transform-origin:top left;transition:transform .12s ease-out}
  /* DAG 画布缩放控件 */
  .dag-zoom{display:inline-flex;align-items:center;gap:2px;margin-left:6px}
  .zoom-btn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:5px;background:var(--panel);border:1px solid var(--line);color:var(--txt);cursor:pointer;font-size:.8rem;line-height:1;user-select:none;transition:background .15s}
  .zoom-btn:hover{background:var(--panel2);border-color:var(--acc)}
  .zoom-lvl{font-size:.66rem;color:var(--mut);min-width:34px;text-align:center;font-family:ui-monospace,Consolas,monospace}
  .zoom-btn.active{background:var(--acc);border-color:var(--acc);color:#fff}
  /* 阶段折叠（）：按依赖深度分组的可折叠阶段芯片栏 */
  .dag-stages{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0 0}
  .stage-chip{font-size:.68rem;padding:2px 9px;border-radius:999px;background:var(--panel);border:1px solid var(--line);color:var(--mut);cursor:pointer;user-select:none;transition:all .15s}
  .stage-chip:hover{border-color:var(--acc);color:var(--txt)}
  .stage-chip.folded{opacity:.6;border-style:dashed;background:var(--panel2)}
  .dag-empty{color:var(--mut);text-align:center;padding:40px;font-size:.85rem}
  .legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;font-size:.72rem;color:var(--mut)}
  .legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:4px;vertical-align:middle}
  .tnode{cursor:pointer;transition:opacity .15s}
  .tnode rect{transition:stroke-width .15s}
  .tnode:hover rect{stroke-width:2.5}
  .tnode.dim{opacity:.22}
  .tnode.pinned rect{stroke-width:3;filter:drop-shadow(0 0 5px var(--acc))}
  .tnode text{font-size:9px;font-family:system-ui,sans-serif;pointer-events:none}
  /* UI DAG 节点状态动效：运行=描边呼吸 + 右上圆点脉冲；待决=琥珀呼吸 */
  .tnode.t-run rect{animation:dashBreathe 1.6s ease-in-out infinite}
  .tnode.t-esc rect{animation:dashBreathe 1.6s ease-in-out infinite}
  .tnode.t-pulse circle{animation:nodePulse 1.4s ease-out infinite;transform-origin:center}
  .tnode.t-term{opacity:.72}
  @keyframes dashBreathe{0%,100%{stroke-width:2}50%{stroke-width:3.4}}
  @keyframes nodePulse{0%{r:3;opacity:1}70%{r:6.5;opacity:0}100%{r:3;opacity:0}}
  .edge{fill:none;stroke:var(--line);stroke-width:1.4;transition:opacity .15s,stroke .15s}
  .edge.dispatch{stroke:#22d3ee;stroke-width:1.4;stroke-dasharray:5 4;opacity:.75;pointer-events:stroke}
  .edge.dispatch.dim{opacity:.15}
  .edge.dispatch:active,.edge.dispatch:hover{stroke:#67e8f9;stroke-width:2}
  .edge.dim{opacity:.12}
  .edge.hl{stroke:var(--acc);stroke-width:2}
  .inbox{max-height:220px;overflow:auto}
  .msg{padding:8px 10px;border-radius:8px;background:var(--panel2);margin-bottom:6px;font-size:.8rem;border-left:3px solid var(--acc);cursor:pointer;transition:background .15s}
  .msg:hover{background:var(--panel)}
  .msg .from{font-weight:600;color:var(--acc);font-size:.74rem}
  .msg .body{color:var(--txt);margin-top:2px;word-break:break-word}
  /*  消息时间线 */
  .inbox-bar{margin-bottom:6px}
  .inbox-bar select{width:100%;padding:4px 6px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--txt);font-size:.76rem}
  .inbox-list{overflow:visible}
  .tl-msg{padding:7px 9px;border-radius:8px;background:var(--panel2);margin-bottom:5px;font-size:.76rem;border-left:3px solid var(--acc);cursor:pointer;transition:background .15s}
  .tl-msg:hover{background:var(--panel)}
  .tl-msg.consumed{opacity:.55;border-left-color:var(--line)}
  .tl-head{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
  .tl-who{font-weight:600;color:var(--acc);font-size:.72rem}
  .tl-ts{color:var(--mut);font-size:.68rem;margin-left:auto}
  .tl-dir{font-size:.66rem;padding:0 4px;border-radius:4px;background:var(--panel);color:var(--mut)}
  .tl-tag{font-size:.62rem;padding:0 5px;border-radius:4px;border:1px solid var(--line);color:var(--mut)}
  .tl-tag.topic{border-color:#38bdf8;color:#38bdf8}
  .tl-tag.hi{color:#fbbf24;border-color:#fbbf24}
  .tl-tag.crit{color:#ef4444;border-color:#ef4444}
  .tl-new{font-size:.6rem;padding:0 4px;border-radius:4px;background:#ef4444;color:#fff}
  .tl-body{color:var(--txt);margin-top:2px;word-break:break-word;white-space:pre-wrap}
  .tl-foot{color:var(--mut);font-size:.64rem;margin-top:2px;display:flex;gap:5px}
  .empty-note{color:var(--mut);font-size:.82rem;padding:8px 0}
  .empty-note.compact{padding:2px 0;font-size:.72rem;opacity:.7}
  .kv{padding:8px 10px;border-radius:6px;background:var(--panel2);margin-bottom:5px;font-size:.76rem;border-left:2px solid var(--acc);cursor:pointer;transition:background .15s}
  .kv:hover{background:var(--panel)}
  .kv .k{color:var(--acc);font-weight:600;font-size:.72rem;word-break:break-all}
  .kv .v{color:var(--mut);margin-top:2px;word-break:break-word}
  .note{padding:6px 10px;border-radius:6px;background:var(--panel2);margin-bottom:5px;font-size:.76rem;border-left:2px solid var(--line);cursor:pointer;transition:background .15s}
  .note:hover{background:var(--panel)}
  .note .tag{color:var(--acc);font-weight:600;font-size:.68rem}
  .progbar{display:flex;gap:2px;height:6px;border-radius:3px;overflow:hidden;background:var(--panel2)}
  .progbar > i{height:100%;transition:width .4s}
  .progsum{display:flex;justify-content:space-between;font-size:.7rem;color:var(--mut);margin-top:3px}
  .mtask{display:inline-block;font-size:.7rem;padding:2px 8px;border-radius:999px;margin:2px 2px 2px 0;cursor:pointer;border:1px solid var(--line);background:var(--panel2);transition:border-color .15s,background .15s}
  .mtask:hover{background:var(--panel);border-color:var(--acc)}
  .dag-hint{font-size:.7rem;color:var(--mut);margin-top:6px}
  footer{text-align:center;color:var(--mut);font-size:.75rem;margin-top:18px;padding-bottom:18px}
  .pulse{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 0 rgba(34,197,94,.5);animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
  .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:2000;opacity:0;pointer-events:none;transition:opacity .2s}
  .modal-overlay.open{opacity:1;pointer-events:auto}
  .modal{background:var(--panel);border:1px solid var(--line);border-radius:12px;max-width:640px;width:92%;max-height:80vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .modal-header{display:flex;justify-content:space-between;align-items:center;padding:16px;border-bottom:1px solid var(--line)}
  .modal-header h3{font-size:1.1rem;color:var(--txt)}
  .modal-close{background:none;border:none;color:var(--mut);font-size:1.5rem;cursor:pointer;padding:4px;line-height:1}
  .modal-close:hover{color:var(--txt)}
  .modal-body{padding:16px}
  .modal-row{display:flex;gap:8px;margin-bottom:10px;font-size:.85rem;align-items:flex-start}
  .modal-label{color:var(--mut);min-width:80px;flex-shrink:0}
  .modal-value{color:var(--txt);word-break:break-word;flex:1}
  .modal-value pre{background:var(--panel2);padding:10px;border-radius:6px;overflow:auto;max-height:300px;font-size:.8rem;white-space:pre-wrap;word-break:break-word}
  .mini-btn{margin-left:6px;padding:2px 8px;font-size:.68rem;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--acc);cursor:pointer;transition:background .15s}
  .mini-btn:hover{background:var(--panel);border-color:var(--acc)}
  .ses-id{font-family:ui-monospace,monospace;font-size:.74rem;color:var(--acc);background:var(--panel2);padding:1px 5px;border-radius:4px}
  .ses-copied{font-size:.66rem;color:var(--ok);margin-left:4px}
  .modal-actions .mini-btn{margin-left:0;margin-right:6px}
  .action-feedback{font-size:.72rem;color:var(--mut);margin-top:-4px;margin-bottom:10px}
  .action-feedback.ok{color:var(--ok)}
  .action-feedback.err{color:var(--err)}
  /* 错误告警条 */
  .alert-bar{padding:6px 14px;border-radius:8px;font-size:.78rem;font-weight:600;display:flex;align-items:center;gap:8px}
  .alert-bar.err{background:rgba(239,68,68,.12);color:var(--err);border:1px solid rgba(239,68,68,.25)}
  /* 队长卡片 */
  .captain-card{background:linear-gradient(135deg,rgba(99,102,241,.12),rgba(67,56,202,.08));border-color:var(--acc)!important}
  .captain-card .stats-row{display:flex;gap:10px;margin-top:6px;font-size:.7rem;color:var(--mut)}
  .captain-card .stats-row span{padding:2px 6px;border-radius:4px;background:rgba(99,102,241,.12);color:#818cf8}
  /* 展开任务列表 */
  .task-chips{display:none;flex-wrap:wrap;gap:3px;margin-top:6px;padding-top:6px;border-top:1px solid var(--line)}
  .task-chips.show{display:flex}
  .task-chip{font-size:.65rem;padding:2px 7px;border-radius:999px;cursor:pointer;border:1px solid var(--line);background:var(--panel2);transition:border-color .15s,background .15s}
  .task-chip:hover{background:var(--panel);border-color:var(--acc)}
  .task-chip.ok{border-color:var(--ok)} .task-chip.err{border-color:var(--err)} .task-chip.run{border-color:var(--run)} .task-chip.pend{border-color:var(--pend)}
  /* 折叠箭头 */
  .collapse-arrow{display:inline-block;transition:transform .2s;font-size:.65rem;color:var(--mut);margin-right:4px}
  .collapse-arrow.open{transform:rotate(90deg)}
  .task-chips{display:none} .task-chips.show{display:flex}
  /* 任务进度总览 */
  .ov-group{background:var(--panel2);border-radius:10px;padding:10px 12px;margin-bottom:10px}
  .ov-group.controller{border:1px solid var(--acc);box-shadow:0 0 0 1px rgba(99,102,241,.25)}
  .ov-head{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer}
  .ov-name{display:flex;align-items:center;gap:6px;font-weight:600;font-size:.85rem;white-space:nowrap}
  .ov-name .crown{color:var(--acc)}
  .ov-name .role{font-weight:400;color:var(--mut);font-size:.72rem;white-space:nowrap}
  .ov-num{font-size:.72rem;color:var(--mut);white-space:nowrap}
  .ov-prog{margin-top:6px}
  .ov-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:.7rem;color:var(--mut);margin-bottom:8px}
  .ov-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;vertical-align:middle}
  .ov-tasks{display:none;margin-top:8px;border-top:1px solid var(--line);padding-top:8px}
  .ov-group.open .ov-tasks{display:block}
  .ov-task{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;background:var(--panel);margin-bottom:4px;font-size:.74rem;border-left:3px solid var(--line)}
  .ov-task.run{border-left-color:var(--run)} .ov-task.ok{border-left-color:var(--ok)} .ov-task.err{border-left-color:var(--err)} .ov-task.pend{border-left-color:var(--pend)}
  .ov-task .t-title{flex:1;min-width:0;word-break:break-all;color:var(--txt)}
  .ov-task .t-meta{flex-shrink:0;font-size:.68rem;color:var(--mut);text-align:right}
  .ov-task .t-time{color:var(--mut);font-family:ui-monospace,Consolas,monospace}
  .ov-task .t-stat{font-weight:600}
  .ov-task .t-stat.ok{color:var(--ok)} .ov-task .t-stat.err{color:var(--err)} .ov-task .t-stat.run{color:var(--run)} .ov-task .t-stat.pend{color:var(--pend)}
  .ov-task .t-res{margin-top:2px;font-size:.68rem;color:var(--mut);word-break:break-all;max-width:100%}
  .ov-task .t-ses{margin-top:2px;font-size:.62rem;color:#7c8db5;font-family:ui-monospace,Consolas,monospace;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}
  /* 工作流卡片 + 步骤 stepper */
  .wf-row{display:flex;gap:10px;flex-wrap:wrap}
  .wf-card{flex:1 1 320px;max-width:520px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:10px 12px;cursor:pointer;transition:border-color .15s,box-shadow .15s;position:relative}
  .wf-card:hover{border-color:var(--acc);box-shadow:0 0 0 1px rgba(99,102,241,.25)}
  .wf-card.active{border-color:var(--acc);box-shadow:0 0 0 1px rgba(99,102,241,.35)}
  .wf-card .wf-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .wf-card .wf-title{font-weight:600;font-size:.88rem;word-break:break-all}
  .wf-tpl{font-size:.64rem;padding:1px 8px;border-radius:999px;background:rgba(14,165,233,.15);color:#38bdf8;border:1px solid rgba(14,165,233,.35);white-space:nowrap}
  .wf-para-compete{background:rgba(99,102,241,.15);color:#a5b4fc;border-color:rgba(99,102,241,.4)}
  .wf-para-collab{background:rgba(16,185,129,.15);color:#6ee7b7;border-color:rgba(16,185,129,.4)}
  .wf-para-esc{background:rgba(251,191,36,.15);color:#fcd34d;border-color:rgba(251,191,36,.4)}
  .wf-card .wf-meta{font-size:.7rem;color:var(--mut);margin-top:4px}
  .wf-stepper{display:flex;gap:4px;margin-top:8px;align-items:center;overflow-x:auto;padding-bottom:2px}
  .wf-step{flex:1;min-width:0;font-size:.6rem;padding:3px 5px;border-radius:6px;text-align:center;background:var(--panel);border:1px solid var(--line);border-top:2px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wf-step.ok{border-top-color:var(--ok);color:var(--ok)}
  .wf-step.run{border-top-color:var(--run);color:#60a5fa;background:rgba(59,130,246,.12)}
  .wf-step.fail{border-top-color:var(--err);color:var(--err)}
  .wf-step.pend{border-top-color:var(--pend);color:var(--pend)}
  .wf-step.esc{border-top-color:#fcd34d;color:#fcd34d;background:rgba(251,191,36,.12)}
  .wf-step.appr{border-top-color:var(--warn);color:var(--warn);background:rgba(245,158,11,.12)}   /* UI 待批 */
  .wf-step.term{border-top-color:var(--sup);color:var(--sup);opacity:.7}                          /* UI 已结束(superseded/cancelled) */
  .wf-step.disp{border-top-color:#38bdf8;color:#38bdf8;background:rgba(56,189,248,.08)}           /* UI 已派发待开工 */
  .wf-legend{display:flex;gap:10px;flex-wrap:wrap;margin-top:7px;font-size:.58rem;color:var(--mut)}
  .wf-legend .lg{display:inline-flex;align-items:center;gap:2px}
  .wf-legend .lg.ok{color:#60a5fa}.wf-legend .lg.disp{color:#38bdf8}.wf-legend .lg.pend{color:var(--pend)}
  .wf-legend .lg.appr{color:var(--warn)}.wf-legend .lg.ok2{color:var(--ok)}.wf-legend .lg.term{color:var(--sup)}
  .wf-mini{font-size:.62rem;color:var(--mut);margin-top:6px;text-align:right}
  .wf-none{color:var(--mut);font-size:.82rem}
  /* 当前/历史切换：segmented 两个视图，点击互斥切换 */
  .wf-tabs{display:flex;gap:6px;margin-bottom:10px;align-items:center}
  .wf-tab{padding:4px 14px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--mut);font-size:.74rem;font-weight:600;cursor:pointer;user-select:none;transition:all .15s}
  .wf-tab:hover{color:var(--txt);border-color:var(--acc)}
  .wf-tab.active{background:var(--acc);border-color:var(--acc);color:#fff}
  .wf-tab .cnt{font-weight:400;opacity:.8;margin-left:3px}
  .wf-arch{border-style:dashed}
  .wf-filter{background:var(--panel);border:1px solid var(--line);color:var(--txt);font-size:.78rem;border-radius:8px;padding:3px 8px;cursor:pointer;outline:none;max-width:220px}
  .wf-filter:focus{border-color:var(--acc)}
  .wf-filter.stf{max-width:110px;margin-left:6px}
  .dag-filtered{color:var(--warn);font-size:.62rem;padding:6px 10px;border-left:3px solid var(--warn);background:rgba(245,158,11,.08);border-radius:0 6px 6px 0;margin-top:6px}
  /* 任务依赖图：DAG / 树状 切换 */
  .dag-tabs{display:inline-flex;gap:4px;align-items:center}
  .dag-tab{padding:3px 12px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--mut);font-size:.72rem;font-weight:600;cursor:pointer;user-select:none;transition:all .15s}
  .dag-tab:hover{color:var(--txt);border-color:var(--acc)}
  .dag-tab.active{background:var(--acc);border-color:var(--acc);color:#fff}
  .panel-dag h2 #dagTabsLabel{text-transform:uppercase}
  /* 树状（队长→队员） */
  .tree{display:flex;flex-direction:column;gap:6px;padding:6px 2px}
  .tree-branch{display:flex;flex-direction:column}
  .tree-cap{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:10px;background:linear-gradient(135deg,rgba(99,102,241,.16),rgba(67,56,202,.10));border:1px solid var(--acc);cursor:pointer}
  .tree-cap:hover{border-color:#818cf8;box-shadow:0 0 0 1px rgba(99,102,241,.3)}
  .tree-mems{display:flex;flex-direction:column;margin:8px 0 4px 24px;padding-left:22px;border-left:2px solid var(--line);position:relative}
  .tree-mems::before{content:'';position:absolute;left:0;top:-10px;width:10px;height:10px;border-left:2px solid var(--acc);border-bottom:2px solid var(--acc);border-bottom-left-radius:6px}
  .tree-mem{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;background:var(--panel2);margin-bottom:6px;border:1px solid transparent;cursor:pointer;transition:border-color .15s,transform .15s;position:relative}
  .tree-mem::before{content:'';position:absolute;left:-24px;top:50%;width:22px;height:2px;background:var(--line);border-radius:2px}
  .tree-mem:hover{transform:translateX(4px);border-color:var(--acc)}
  .tree-mem.working{border-color:var(--ok)}
  .tree-mem .tinfo{flex:1;min-width:0}
  .tree-mem .tname{font-weight:600;font-size:.9rem;display:flex;align-items:center;gap:6px;white-space:nowrap}
  .tree-mem .trole{font-size:.7rem;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tree-mem .tbar{height:5px;border-radius:3px;background:#1e293b;margin-top:5px;overflow:hidden}
  .tree-mem .tbar>i{display:block;height:100%;background:linear-gradient(90deg,var(--acc),#818cf8)}
  .tree-mem .tmeta{font-size:.7rem;color:var(--mut);margin-top:3px}
  .tree-chips{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px}
  .tree-chip{font-size:.64rem;padding:2px 7px;border-radius:6px;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--txt);transition:background .15s,border-color .15s;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tree-chip:hover{background:var(--panel2);border-color:var(--acc)}
  .tree-chip.ok{border-left:3px solid var(--ok)} .tree-chip.err{border-left:3px solid var(--err)} .tree-chip.run{border-left:3px solid var(--run)} .tree-chip.pend{border-left:3px solid var(--pend)}
  .tree-cap .cstat{display:flex;gap:10px;margin-top:4px;font-size:.72rem;color:var(--mut)}
  .tree-cap .cstat span{padding:2px 8px;border-radius:999px;background:rgba(99,102,241,.14);color:#818cf8;white-space:nowrap}
  .tree-mem .tright{flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
  /* ── 树状·工作流生命周期流 ── */
  .lf{display:flex;flex-direction:column}
  .lf-empty{color:var(--mut);text-align:center;padding:44px 20px;font-size:.85rem;border:1px dashed var(--line);border-radius:12px}
  .lf-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;border-radius:12px;background:linear-gradient(135deg,rgba(99,102,241,.15),rgba(67,56,202,.07));border:1px solid var(--acc);margin-bottom:8px}
  .lf-head .lf-title{font-weight:700;font-size:1rem;color:var(--txt)}
  .lf-head .lf-sub{font-size:.72rem;color:var(--mut)}
  .lf-flow{display:flex;flex-direction:column;gap:0}
  .lf-node{display:flex;gap:10px;align-items:stretch;position:relative;padding:8px 0}
  .lf-node .lf-rail{position:relative;width:26px;flex-shrink:0;display:flex;flex-direction:column;align-items:center}
  .lf-node .lf-dot{width:14px;height:14px;border-radius:50%;background:var(--panel2);border:3px solid var(--line);z-index:2;flex-shrink:0;margin-top:14px;transition:background .2s,border-color .2s}
  .lf-node .lf-line{flex:1;width:2px;background:linear-gradient(var(--line),var(--line) 60%,transparent);z-index:1}
  .lf-node:last-child .lf-line{background:rgba(148,163,184,.15)}
  .lf-node.done .lf-dot{background:var(--ok);border-color:#22c55e}
  .lf-node.run .lf-dot{background:var(--run);border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.25);animation:pulse 1.6s infinite}
  .lf-node.fail .lf-dot{background:var(--err);border-color:#ef4444}
  .lf-node.pend .lf-dot{background:#eab308;border-color:#eab308}
  .lf-node.sink .lf-dot{background:var(--acc);border-color:#818cf8}
  .lf-card{flex:1;min-width:0;padding:10px 12px;border-radius:10px;background:var(--panel2);border:1px solid var(--line);cursor:pointer;transition:border-color .15s,transform .15s;position:relative}
  .lf-card:hover{border-color:var(--acc);transform:translateX(3px)}
  .lf-card .lf-step{font-weight:600;font-size:.88rem;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lf-card .lf-meta{font-size:.7rem;color:var(--mut);margin-top:3px;display:flex;flex-wrap:wrap;gap:4px 8px}
  .lf-card .lf-badge{font-size:.62rem;padding:1px 7px;border-radius:999px;border:1px solid var(--line);background:var(--panel);white-space:nowrap}
  .lf-st{font-size:.62rem;padding:1px 7px;border-radius:999px;font-weight:600;white-space:nowrap}
  .lf-st.ok{color:#22c55e;background:rgba(34,197,94,.12)} .lf-st.run{color:#60a5fa;background:rgba(59,130,246,.14)}
  .lf-st.fail{color:#ef4444;background:rgba(239,68,68,.12)} .lf-st.pend{color:#eab308;background:rgba(234,179,8,.12)}
  .lf-st.term{color:#94a3b8;background:rgba(148,163,184,.12)} .lf-st.appr{color:#f59e0b;background:rgba(245,158,11,.12)}
  .lf-flowtag{position:absolute;left:34px;top:-9px;font-size:.6rem;color:var(--mut);background:var(--panel);padding:0 5px;border-radius:4px;letter-spacing:.2px;white-space:nowrap}
  .lf-cap{display:inline-flex;align-items:center;gap:4px;font-size:.62rem;color:#a5b4fc;padding:1px 7px;border-radius:999px;border:1px solid rgba(99,102,241,.4);background:rgba(99,102,241,.12)}
  .lf-badge.lf-compete{color:#a5b4fc;border-color:rgba(99,102,241,.5);background:rgba(99,102,241,.14)}
  .lf-badge.lf-collab{color:#6ee7b7;border-color:rgba(16,185,129,.5);background:rgba(16,185,129,.1)}
  .lf-sink{display:inline-flex;align-items:center;gap:4px;font-size:.62rem;color:#6ee7b7;padding:1px 7px;border-radius:999px;border:1px solid rgba(16,185,129,.35);background:rgba(16,185,129,.1)}
  /* 树状徽章标准化：节点序号 + 流转分隔线 + 汇入主控高亮条 */
  .lf-seq{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;font-size:.6rem;font-weight:700;color:var(--mut);border:1px solid var(--line);border-radius:50%;background:var(--panel);margin-right:2px;flex-shrink:0}
  .lf-node.ok .lf-seq{color:#22c55e;border-color:#22c55e}
  .lf-node.run .lf-seq{color:#3b82f6;border-color:#3b82f6;animation:pulse 1.6s infinite}
  .lf-node.fail .lf-seq{color:#ef4444;border-color:#ef4444}
  .lf-node.pend .lf-seq{color:#eab308;border-color:#eab308}
  .lf-flowline{height:1px;background:var(--line);opacity:.4;margin:-4px 0 6px;border-radius:1px}
  .lf-sinkbar{display:flex;align-items:center;gap:6px;margin-top:6px;padding:5px 9px;font-size:.64rem;font-weight:600;color:#6ee7b7;border:1px solid rgba(16,185,129,.4);border-radius:6px;background:linear-gradient(90deg,rgba(16,185,129,.16),rgba(16,185,129,.05));box-shadow:0 0 0 3px rgba(16,185,129,.06)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  /* 导出按钮 */
  .export-btn{position:absolute;top:10px;right:18px;background:var(--panel);border:1px solid var(--line);color:var(--mut);font-size:.72rem;padding:3px 10px;border-radius:999px;cursor:pointer;transition:color .15s,border-color .15s}
  .export-btn:hover{color:var(--txt);border-color:var(--acc)}
  /* Tab 样式 */
  .tab-bar{display:flex;gap:2px;margin-bottom:12px;border-bottom:1px solid var(--line);padding-bottom:0}
  .tab-btn{padding:6px 14px;font-size:.8rem;color:var(--mut);border-radius:8px 8px 0 0;cursor:pointer;transition:color .15s,background .15s;border:1px solid transparent;border-bottom:none}
  .tab-btn:hover{color:var(--txt);background:var(--panel2)}
  .tab-btn.active{color:var(--acc);background:var(--panel2);border-color:var(--line)}
  .tab-content{display:none}
  .tab-content.active{display:block}
  /* 左栏进度条面板 */
  .team-progress{margin-bottom:12px}
  /* 浅色主题（）：data-theme="light" 覆盖 :root 暗色变量；默认无属性=深色。同特异性靠源序在后取胜 */
  [data-theme="light"]{--bg:#f1f5f9;--panel:#ffffff;--panel2:#e2e8f0;--line:#cbd5e1;--txt:#1e293b;--mut:#64748b;--acc:#6366f1;--ok:#16a34a;--warn:#d97706;--err:#dc2626;--run:#2563eb;--pend:#ca8a04;--sup:#64748b}
  [data-theme="light"] .topbar{background:rgba(241,245,249,0.95)}
  [data-theme="light"] .dag-wrap{background:#eef2f7}
  [data-theme="light"] .member .bar{background:#e2e8f0}
  [data-theme="light"] .tree-mem .tbar{background:#e2e8f0}
  [data-theme="light"] .ov-task .t-ses{color:#64748b}
  [data-theme="light"] .modal-overlay{background:rgba(15,23,42,.45)}
  [data-theme="light"] .modal{box-shadow:0 20px 60px rgba(15,23,42,.25)}
  /* 浅色主题：覆盖所有为深色背景而硬编码的浅色字/边/底，避免浅字落在浅底上 */
  [data-theme="light"] .member .bar>i{background:linear-gradient(90deg,var(--acc),#4f46e5)}
  [data-theme="light"] .tree-mem .tbar>i{background:linear-gradient(90deg,var(--acc),#4f46e5)}
  [data-theme="light"] .captain-card .stats-row span{background:rgba(99,102,241,.14);color:#4f46e5}
  [data-theme="light"] .tree-cap .cstat span{background:rgba(99,102,241,.16);color:#4f46e5}
  [data-theme="light"] .tree-cap:hover{border-color:#4f46e5;box-shadow:0 0 0 1px rgba(99,102,241,.3)}
  [data-theme="light"] .wf-tpl{background:rgba(14,165,233,.12);color:#0369a1;border-color:rgba(14,165,233,.4)}
  [data-theme="light"] .wf-para-compete{background:rgba(99,102,241,.12);color:#4f46e5;border-color:rgba(99,102,241,.4)}
  [data-theme="light"] .wf-para-collab{background:rgba(16,185,129,.12);color:#059669;border-color:rgba(16,185,129,.4)}
  [data-theme="light"] .wf-para-esc{background:rgba(217,119,6,.12);color:#b45309;border-color:rgba(217,119,6,.4)}
  [data-theme="light"] .wf-step.esc{color:var(--warn);background:rgba(217,119,6,.1)}
  [data-theme="light"] .wf-step.disp{color:#0369a1;background:rgba(14,165,233,.1)}
  [data-theme="light"] .wf-step.run{color:var(--run);background:rgba(37,99,235,.1)}
  [data-theme="light"] .wf-legend .lg.ok{color:var(--run)}
  [data-theme="light"] .wf-legend .lg.disp{color:#0369a1}
  [data-theme="light"] .lf-st.ok{color:var(--ok);background:rgba(22,163,74,.1)}
  [data-theme="light"] .lf-st.run{color:var(--run);background:rgba(37,99,235,.1)}
  [data-theme="light"] .lf-st.term{color:var(--sup);background:rgba(100,116,139,.1)}
  [data-theme="light"] .lf-cap{color:#4f46e5;border-color:rgba(99,102,241,.4);background:rgba(99,102,241,.1)}
  [data-theme="light"] .lf-sink{color:#059669;border-color:rgba(5,150,105,.4);background:rgba(5,150,105,.1)}
  [data-theme="light"] .lf-sinkbar{color:#059669;border-color:rgba(5,150,105,.4);background:linear-gradient(90deg,rgba(5,150,105,.16),rgba(5,150,105,.05));box-shadow:0 0 0 3px rgba(5,150,105,.06)}
  [data-theme="light"] .lf-node.sink .lf-dot{border-color:#4f46e5}
  [data-theme="light"] .lf-badge{color:#4f46e5}
  [data-theme="light"] .lf-badge.lf-compete{color:#4f46e5;border-color:rgba(99,102,241,.5);background:rgba(99,102,241,.1)}
  [data-theme="light"] .lf-badge.lf-collab{color:#059669;border-color:rgba(5,150,105,.5);background:rgba(5,150,105,.1)}
  [data-theme="light"] .search-box svg{stroke:var(--mut)}
  /* 主题切换按钮（与导出按钮并排于右上角） */
  .theme-btn{position:absolute;top:10px;right:72px;background:var(--panel);border:1px solid var(--line);color:var(--mut);font-size:.85rem;padding:3px 10px;border-radius:999px;cursor:pointer;transition:color .15s,border-color .15s;line-height:1.4}
  .theme-btn:hover{color:var(--txt);border-color:var(--acc)}
</style>
<script>(function(){try{var q=location.search.match(/[?&]theme=light/);var s=q?'light':localStorage.getItem('ma-theme');if(s==='light')document.documentElement.setAttribute('data-theme','light');}catch(e){}})();</script>
</head>
<body>
<div class="topbar">
  <div class="toprow">
    <h1>multi-agent 面板 <span class="sub" id="ts"></span></h1>
    <div class="ctrl-box">
      <label for="controller">主控</label>
      <select id="controller"></select>
    </div>
    <div class="search-box">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21,21 L16.65,16.65"/></svg>
      <input type="text" id="search" placeholder="搜索 Agent / 任务…">
    </div>
    <div class="stats" id="stats"></div>
    <button class="theme-btn" id="themeBtn" onclick="toggleTheme()" title="切换深色/浅色主题">🌙</button>
    <button class="export-btn" onclick="exportState()">导出</button>
  </div>
  <div id="errbar"></div>
</div>
<div class="grid">
  <div class="col-side">
    <div class="panel"><h2><span class="pulse"></span> 团队成员</h2><div id="members"></div></div>
  </div>
  <div class="col-main">
    <div class="panel">
      <h2>🛠 工作流
        <span class="wf-tabs">
          <span class="wf-tab" id="wfTabCur" onclick="wfSwitch('current')">当前</span>
          <span class="wf-tab" id="wfTabHist" onclick="wfSwitch('history')">历史</span>
        </span>
      </h2>
      <div class="wf-row" id="workflows"></div>
    </div>
    <div class="panel panel-dag">
      <h2><span id="dagTabsLabel">🔗 任务依赖图</span>
        <span class="dag-tabs" id="dag-tabs">
          <span class="dag-tab" id="dagTabDag" onclick="dagSwitch('dag')">DAG</span>
          <span class="dag-tab" id="dagTabTree" onclick="dagSwitch('tree')">树状</span>
        </span>
        <select class="wf-filter" id="wf-filter" onchange="onWfFilter(this)"><option value="">全部工作流</option></select>
        <select class="wf-filter stf" id="st-filter" onchange="onStFilter(this)" title="按状态过滤 DAG 节点"><option value="">全部状态</option><option value="run">运行中</option><option value="pend">待领</option><option value="disp">已派发</option><option value="appr">待批</option><option value="ok">已完成</option><option value="fail">失败</option><option value="term">已结束</option></select>
        <span class="dag-zoom" title="DAG 画布缩放（滚轮亦可）">
          <span class="zoom-btn" onclick="dagZoom(-1)" title="缩小">−</span>
          <span class="zoom-lvl" id="zoomLvl">100%</span>
          <span class="zoom-btn" onclick="dagZoom(1)" title="放大">+</span>
          <span class="zoom-btn" onclick="dagZoom(0)" title="复位">⟲</span>
        </span>
      </h2>
      <div class="dag-wrap" id="dag" onwheel="onDagWheel(event)"></div>
      <div class="dag-stages" id="dag-stages"></div>
      <div class="legend" id="legend"></div>
      <div class="dag-hint" id="dag-hint">悬停聚焦上下游 · 点击固定/查看详情 · Esc 取消固定 · 选中工作流后此图聚焦该工作流全阶段</div>
    </div>
    <div class="panel" style="margin-top:16px">
      <h2>📋 任务进度总览</h2>
      <div class="ov-legend" id="ov-legend"></div>
      <div id="overview"></div>
    </div>
  </div>
  <div class="col-right">
    <div class="panel team-progress" id="team-progress-panel"></div>
    <div class="panel" style="margin-top:16px">
      <div class="tab-bar">
        <span class="tab-btn active" id="tab-btn-inbox" onclick="switchTab(&;inbox&;)">📬 收件箱</span>
        <span class="tab-btn" id="tab-btn-shared" onclick="switchTab(&;shared&;)">🧠 共享记忆</span>
        <span class="tab-btn" id="tab-btn-notes" onclick="switchTab(&;notes&;)">📝 共享笔记</span>
      </div>
      <div class="tab-content active" id="tab-content-inbox">
        <div class="inbox-bar"><select id="inbox-agent" onchange="inboxSel=this.value;renderInbox(allInbox)"></select></div>
        <div class="inbox-list" id="inbox-list"></div>
      </div>
      <div class="tab-content" id="tab-content-shared"></div>
      <div class="tab-content" id="tab-content-notes"></div>
    </div>
  </div>
</div>
<footer>只读 · 数据源 memory.json · SSE 主推(250ms 去抖) + 30s 兜底轮询 · 仅 127.0.0.1</footer>

<div class="modal-overlay" id="modal-overlay">
  <div class="modal">
    <div class="modal-header">
      <h3 id="modal-title">详情</h3>
      <button class="modal-close" onclick="closeModal()">&times;</button>
    </div>
    <div class="modal-body" id="modal-body"></div>
  </div>
</div>

<script>
const NODE_W=${NODE_W},NODE_H=${NODE_H};
function themeIsLight(){return document.documentElement.getAttribute('data-theme')==='light';}
/* SVG/JS 端按主题取色：深色=原浅色字，浅色=深色字，保证对比度 */
function svgTxt(){return themeIsLight()?'#1e293b':'#e2e8f0';}      /* 节点标题 */
function svgMut(){return themeIsLight()?'#475569':'#94a3b8';}     /* 节点副标题/归属人 */
function svgTermMut(){return themeIsLight()?'#94a3b8':'#64748b';} /* 终态副标题 */
const STATUS_COLOR={completed:'#22c55e',failed:'#ef4444',running:'#3b82f6',pending:'#eab308',superseded:'#64748b',interrupted:'#f97316'};
const STATUS_LABEL={completed:'完成',failed:'失败',running:'运行',pending:'待领',superseded:'已替代',interrupted:'已中断',awaiting_approval:'待批',escalating:'待决',disp:'已派发',term:'已结束'};
// UI DAG 节点状态色（与工作流卡片 wf-step 同源）：disp=已派发待开工(天蓝) / appr=待批(橙) / term=已结束(灰)
const DAG_STATUS_COLOR={completed:'#22c55e',failed:'#ef4444',running:'#3b82f6',pending:'#eab308',
  superseded:'#64748b',cancelled:'#64748b',interrupted:'#f97316',awaiting_approval:'#f59e0b',escalating:'#f59e0b',
  disp:'#38bdf8',term:'#64748b'};
function dagColor(n){var c=DAG_STATUS_COLOR[n.status];return c||'#64748b'}
//  React Flow 风格类别色：按任务"活动类别"染节点（报警/工具/流程/正常）。状态仍用描边,类别用填充。
const CATEGORY_COLOR={alarm:'#ef4444',tool:'#a855f7',gate:'#f59e0b',workflow:'#0ea5e9',normal:'#64748b'};
function categoryColor(n){
  var w=n.workflow&&n.workflow.step, ww=String(w||'');
  if(ww.indexOf('质量')>-1||ww.indexOf('评审')>-1||n.status==='failed')return CATEGORY_COLOR.alarm;   // 报警/评审/出错
  if(ww.indexOf('实现')>-1)return CATEGORY_COLOR.tool;                                                   // 工具/落地
  if(ww.indexOf('架构')>-1||ww.indexOf('设计')>-1||n.requireApproval||n.status==='awaiting_approval')return CATEGORY_COLOR.gate; // 审批门/设计门
  if(n.status==='running'||n.status==='pending')return CATEGORY_COLOR.normal;
  return CATEGORY_COLOR.workflow;
}
let allTasks=[],allMembers=[],allInbox=[],allShared=[],allNotes=[],__tlMessages=[];
// 派工连线需排除测试/占位成员。server 同名集合在服务端逻辑区，前端须自带一份（否则 renderDAG 崩 ReferenceError）。
const GHOST_AGENTS = new Set(['tester','agent','test','unknown','verify-agent','undefined','null','na','none','orchestrator']);
var pinnedTaskId=null,hoverTimer=null,detailTasks=[];
var collapsed=new Set(); // 成员卡片折叠态，跨轮询保持
var ovOpen=new Set();    // 总览分组展开态，跨轮询保持
var win_escPinBound=false; // renderDAG 重复绑定 Esc 防泄漏标记

function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

/* ── 角色专属形象符号（零依赖 SVG path，非鲸鱼主题）───────────────────
 * 每个 path 在 0..24 坐标系内绘制，统一加 transform="translate(5,5) scale(1.6)"
 * 将符号缩放到 38×38，居中于 44×44 画布。
 */
var ROLE_SYMBOL={
  captain:'<path d="M6,2 L6,20 M6,2 L14,5 L14,11 L8,10 L8,20" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M14,5 L22,3 L22,15 L14,13Z" fill="rgba(255,255,255,.35)" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>',
  engineer:'<g fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M19,4 L13,10 M13,10 L5,10 L5,15 L10,15 L19,22 C21,24 23,22 23,20 L20,16 L18,18 L15,10Z"/><path d="M6,10 C3,8 4,4 7,3"/><path d="M18,10 C21,8 22,4 19,3"/></g>',
  coordinator:'<g fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12,5v2 M12,17v2 M5,12h2 M17,12h2 M7.5,7.5l1.4,1.4 M15.1,15.1l1.4,1.4 M16.5,7.5l-1.4,1.4 M8.9,15.1l-1.4,1.4"/><circle cx="12" cy="12" r="7" stroke-dasharray="2 2"/></g>',
  docs:'<g fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7,3h8l5,5v13c0,1-1,2-2,2H7c-1,0-2-1-2-2V5C5,4 6,3 7,3z"/><path d="M15,3v5h5"/><line x1="9" y1="12" x2="17" y2="12"/><line x1="9" y1="16" x2="17" y2="16"/><line x1="9" y1="20" x2="13" y2="20"/></g>',
  security:'<path d="M12,3 L5,6 L5,12 C5,17 8,21 12,23 C16,21 19,17 19,12 L19,6Z" fill="rgba(255,255,255,.2)" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/><path d="M9,12 L11,14 L16,9" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  qa:'<g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M7,12 L10.5,15.5 L18,8"/></g>',
};
function avatar(m,i){
  var c=m.grad,ini=(m.agent[0]||'?').toUpperCase(),gid='ag-'+m.agent+'-'+i,
      sym=ROLE_SYMBOL[m.role]||ROLE_SYMBOL.member,dot=m.activity==='working'?'#22c55e':'#94a3b8';
  var symSvg=sym||'<circle cx="12" cy="12" r="5" fill="rgba(255,255,255,.3)"/>';
  return '<svg class="avatar" viewBox="0 0 44 44" width="44" height="44">'
    +'<defs><linearGradient id="'+gid+'" x1="0" y1="0" x2="1" y2="1">'
    +'<stop offset="0" stop-color="'+c[0]+'"/><stop offset="1" stop-color="'+c[1]+'"/></linearGradient></defs>'
    +'<circle cx="22" cy="22" r="20" fill="url(#'+gid+')"/>'
    +'<g transform="translate(5,5) scale(1.6)">'+symSvg+'</g>'
    +'<circle cx="34" cy="34" r="5" fill="'+dot+'" stroke="#fff" stroke-width="1.5"/></svg>'
}

function openModal(title,content){
  document.getElementById('modal-title').textContent=title;
  document.getElementById('modal-body').innerHTML=content;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal(){document.getElementById('modal-overlay').classList.remove('open')}
document.getElementById('modal-overlay').addEventListener('click',function(e){if(e.target===this)closeModal()});
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeModal()});

function row(label,value){return '<div class="modal-row"><span class="modal-label">'+label+'</span><span class="modal-value">'+value+'</span></div>'}
function rowPre(label,value){return '<div class="modal-row"><span class="modal-label">'+label+'</span><div class="modal-value"><pre>'+esc(value)+'</pre></div></div>'}

function showMemberDetail(i){
  var m=allMembers[i];
  detailTasks=m.taskList||[];
  var status=m.activity==='working'?'<span style="color:var(--ok)">工作中</span>':'<span style="color:var(--mut)">空闲</span>';
  var c=row('代理',esc(m.agent))+row('角色',esc(m.label))+row('状态',status)+row('进度',m.progress+'%')+row('已领取',m.claimed)+row('已完成',m.done)+row('失败',m.failed);
  if(m.agentStats){
    var a=m.agentStats;
    c+=row('成功率',a.succRate+'%')+row('总任务',a.total)+row('重试',a.retries)+(a.timeout?' · 超时'+a.timeout:'');
    if(a.avgMs>0)c+=' · 平均'+msFmt(a.avgMs);
  }
  if(m.running>0)c+=row('运行中',m.running);
  if(m.currentTask)c+=rowPre('当前任务',m.currentTask);
  if(detailTasks.length){
    var chips=detailTasks.map(function(tk,idx){var col=STATUS_COLOR[tk.status]||'#64748b';return '<span class="mtask" style="border-color:'+col+'" onclick="jumpDetailTask('+idx+')">'+esc((tk.title||'').slice(0,18))+'</span>'}).join('');
    c+='<div class="modal-row"><span class="modal-label">派发任务</span><div class="modal-value">'+chips+'</div></div>';
  }
  openModal('成员详情 — '+esc(m.agent),c);
}
// 从成员详情的任务芯片跳转到任务详情：经 detailTasks[idx] 取 id，再在 allTasks 中定位
function jumpDetailTask(idx){
  var tk=detailTasks[idx]; if(!tk)return;
  for(var i=0;i<allTasks.length;i++){if(allTasks[i]&&allTasks[i].id===tk.id){showTaskDetail(i);return}}
}
function showMessageDetail(i){
  var m=allInbox[i];
  openModal('消息详情',row('来自','<span style="color:var(--acc)">'+esc(m.from)+'</span>')+rowPre('内容',m.body));
}
function showSharedDetail(i){
  var s=allShared[i];
  openModal('共享记忆 — '+esc(s.key),row('键',esc(s.key))+rowPre('值(预览)',s.value));
}
function showNoteDetail(i){
  var n=allNotes[i];
  var tag=n.tag?'['+esc(n.tag)+']':'(无标签)';
  openModal('共享笔记',row('标签','<span style="color:var(--acc)">'+tag+'</span>')+row('时间',esc(n.ts))+rowPre('内容',n.note));
}
function showTaskDetail(i){
  var t=allTasks[i];
  if(!t)return;
  var color=STATUS_COLOR[t.status]||'#64748b';
  var status='<span style="color:'+color+'">'+(STATUS_LABEL[t.status]||t.status)+'</span>';
  var dep=t.dependencies&&t.dependencies.length?t.dependencies.join(', '):'无';
  var result=t.result?esc(t.result):'-';
  if(t.exit_code!==undefined&&t.exit_code!==null)result+=' (exit='+t.exit_code+')';
  var created=t.created_at?new Date(t.created_at).toLocaleString('zh-CN'):'-';
  var sesRow=t.session_id?row('会话', '<code class="ses-id">'+esc(t.session_id)+'</code> <button class="mini-btn" onclick="copySes(\\''+esc(t.session_id).replace(/'/g,"\\'")+'\\',\\'copied-'+esc(t.id).slice(-6)+'\\')">复制</button> <span class="ses-copied" id="copied-'+esc(t.id).slice(-6)+'"></span>'):'';
  var whoBtn='<button class="mini-btn" onclick="showMemberByAgent(\\''+esc(t.claimed_by||t.assigned_to||'')+'\\')">👤 成员</button>';
  openModal('任务详情 — '+esc(t.id),row('任务 ID',esc(t.id))+row('标题',esc(t.title))+row('状态',status)+row('负责人',esc(t.assigned_to||'未分配')+' '+whoBtn)+row('认领者',esc(t.claimed_by||'-'))+row('创建时间',created)+row('依赖',dep)+sesRow+row('结果',result)+actionBar(t));
}
// 可编辑动作条：按状态给候选动作，落到 /api/action 写端
function actionBar(t){
  var btns=[];
  function b(label,action,extra){var ea=extra?"','"+extra+"\\'":"";btns.push('<button class="mini-btn" onclick="doAction(\\''+esc(t.id)+'\\',\\''+action+"'"+ea+')">'+label+'</button>')}
  if(t.status==='pending')          b('▶ 认领','claim');
  if(t.status==='running')          {b('✔ 完成','complete');b('✘ 失败','fail');b('⇄ 改派','reassign');}
  if(t.status==='awaiting_approval'){b('✔ 通过','approve','approve');b('↩ 驳回','approve','reject');}
  if(btns.length===0)return '';
  return '<div class="modal-row modal-actions"><span class="modal-label">动作</span><div class="modal-value">'+btns.join(' ')+'</div><div class="action-feedback" id="fb-'+esc(t.id)+'"></div></div>';
}
function doAction(taskId,action,decision){
  var body={action:action,task_id:taskId};
  if(decision)body.decision=decision;
  if(action==='complete'){var r=prompt('完成结果（result）:');if(r===null)return;body.result=r;}
  if(action==='fail'){var f=prompt('失败原因（result）:');if(f===null)return;body.result=f;}
  if(action==='reassign'){var n=prompt('改派说明（note，可空）:','');if(n===null)return;if(n)body.note=n;}
  var fb=document.getElementById('fb-'+taskId);
  if(fb){fb.textContent='处理中…';fb.className='action-feedback';}
  fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json()})
    .then(function(res){
      if(res.ok){if(fb){fb.textContent=res.hint||(action==='claim'?'已认领':'完成');fb.className='action-feedback ok';}
        setTimeout(function(){closeModal()},700);}
      else{if(fb){fb.textContent='✘ '+res.error;fb.className='action-feedback err';}}
    })
    .catch(function(e){if(fb){fb.textContent='✘ '+e;fb.className='action-feedback err';}});
}
function copySes(val,elId){
  var el=document.getElementById(elId);
  try{navigator.clipboard.writeText(val);if(el)el.textContent='✓ 已复制';
    var hint=el.closest('.modal-row').querySelector('.ses-id');if(hint)hint.title='已在 DSH/opencode 续接：session 续接';}
  catch(e){var ta=document.createElement('textarea');ta.value=val;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);if(el)el.textContent='✓ 已复制';}
  setTimeout(function(){if(el)el.textContent=''},1600);
}

function renderMembers(ms,capStat){
  allMembers=ms;
  if(capStat){
    capStat.dispatched=capStat.dispatched||0;
    capStat.activeMembers=capStat.activeMembers||0;
    capStat.running=capStat.running||0;
    capStat.completed=capStat.completed||0;
  }
  /* ── 搜索词 ── */
  var q=document.getElementById('search');
  var query=q?q.value.toLowerCase():'';
  function matches(m){
    if(!query)return true;
    return (m.agent||'').toLowerCase().indexOf(query)!==-1
      || (m.label||'').indexOf(query)!==-1
      || (m.currentTask||'').toLowerCase().indexOf(query)!==-1;
  }
  /* ── 渲染单个成员 ── */
  var ctrlName=capStat&&capStat.controller?capStat.controller:'claude';
  function renderOne(m,i){
    var isCaptain=m.agent===ctrlName;
    var cls='member'+(isCaptain?' captain-card':'')+' '+m.activity;
    var arrow='<span class="collapse-arrow" id="ca-'+i+'" data-agent="'+esc(m.agent)+'" onclick="event.stopPropagation();collapseMember(this)">&#9654;</span>';
    var nameHtml=isCaptain?'<b>👑 '+esc(m.agent)+'</b>':esc(m.agent);
    var barHtml=isCaptain?'':
      '<div class="bar"><i style="width:'+m.progress+'%"></i></div>';
    var meta='已领 '+m.claimed+' · 完成 '+m.done+' · 失败 '+m.failed+(m.running?' · 运行中 '+m.running:'');
    /* 任务芯片 */
    var chipsHtml='<div class="task-chips" id="ct-'+i+'">'+
    m.taskList.slice(0,3).map(function(tk){
      var chipCls='task-chip '+(tk.status==='completed'?'ok':tk.status==='failed'?'err':tk.status==='running'?'run':'pend');
      var dur='';
      if(tk.duration>0) dur=' · '+msFmt(tk.duration);
      return '<span class="'+chipCls+'" onclick="event.stopPropagation();showTaskById(\\''+esc(tk.id)+'\\')" title="'+esc((tk.title||'').slice(0,40))+'">'+esc((tk.title||'').slice(0,14))+(dur?' · '+msFmtShort(tk.duration):'')+'</span>';
    }).join('')+
    (m.taskList.length>3?'<span class="task-chip more" title="全部 '+m.taskList.length+' 项任务">+'+ (m.taskList.length-3) +'</span>':'')+
    '</div>';
    var capStatsHtml=isCaptain&&(capStat)?
      '<div class="stats-row"><span>派发 '+capStat.dispatched+' 项</span><span>活跃 '+capStat.activeMembers+' 人</span><span>执行中 '+capStat.running+'</span><span>已完成 '+capStat.completed+'</span></div>':'';
    return '<div class="'+cls+'" data-agent="'+esc(m.agent)+'" onclick="showMemberDetail('+i+')">'+
      avatar(m,i)+'<div class="info">'+
      '<div class="name">'+arrow+nameHtml+' <span class="badge '+m.activity+'">'+(m.activity==='working'?'工作中':'空闲')+'</span></div>'+
      '<div class="role">'+esc(m.label)+''+(isCaptain?' · 主控':'')+'</div>'+
      barHtml+capStatsHtml+
      '<div class="meta">'+meta+'</div>'+
      chipsHtml+'</div></div>';
  }
  document.getElementById('members').innerHTML=ms.map(renderOne).join('');
  /* ── 搜索过滤：只显示匹配的 ── */
  var domEls=document.getElementById('members').querySelectorAll('.member');
  domEls.forEach(function(el,i){
    el.style.display=matches(ms[i])?'':'none';
  });
  /* ── 展开/折叠（记折叠态，防轮询重渲染强制展开） ── */
  /* ── 展开/折叠（折叠态存 collapsed Set，跨 2s 轮询保持） ── */
  ms.forEach(function(m,i){
    var ch=document.getElementById('ct-'+i);
    if(!ch)return;
    if(collapsed.has(m.agent)){ch.classList.remove('show')}else{ch.classList.add('show')}
    var ar=document.getElementById('ca-'+i);
    if(!ar)return;
    if(collapsed.has(m.agent)){ar.classList.remove('open')}else{ar.classList.add('open')}
  });
}
// 成员卡片折叠（inline onclick 调用，跨 2s 轮询经 collapsed Set 保持）
function collapseMember(arrow){
  var agent=arrow.getAttribute('data-agent'), ch=arrow.closest('.member').querySelector('.task-chips');
  if(!ch)return;
  if(collapsed.has(agent)){collapsed.delete(agent);ch.classList.add('show')}
  else{collapsed.add(agent);ch.classList.remove('show')}
  arrow.classList.toggle('open',!collapsed.has(agent));
}
/* ── 收件箱时间线：全 agent 可切换。inboxSel 跨轮询持久（session 内）。 ── */
var inboxSel='';
function renderInbox(boxes){
  allInbox=boxes;
  var sel=document.getElementById('inbox-agent');
  if(!sel)return;
  var agents=(boxes||[]).map(function(b){return b.agent}).filter(Boolean);
  var all='<option value="">所有 Agent ('+boxes.length+')</option>'+
    boxes.map(function(b){var n=b.msgs.filter(function(m){return !m.consumed}).length;return '<option value="'+esc(b.agent)+'">'+esc(b.agent)+(n?' ('+n+' 未读)':'')+'</option>'}).join('');
  if(sel.value!==inboxSel)sel.value=inboxSel;
  if(sel.innerHTML!==all)sel.innerHTML=all;
  if(sel.value!==inboxSel)sel.value=inboxSel;
  var listEl=document.getElementById('inbox-list');
  var boxes2=inboxSel? (boxes||[]).filter(function(b){return b.agent===inboxSel}) : (boxes||[]);
  var total=boxes2.reduce(function(n,b){return n+b.msgs.length},0);
  if(!total){listEl.innerHTML='<div class="empty-note compact">📭 该收件箱暂无消息</div>';return}
  var flat=[];
  boxes2.forEach(function(b){
    b.msgs.forEach(function(m){flat.push({b:m,agent:b.agent})});
  });
  flat.sort(function(a,b2){return (b2.b.created_at||0)-(a.b.created_at||0)});
  __tlMessages=flat.map(function(x){return x.b});
  flat.forEach(function(x,fi){ x.__i=fi; });
  listEl.innerHTML=flat.slice(0,200).map(function(x){
    var m=x.b;
    var dir=(m.from&&m.from!==x.agent)?'<span class="tl-dir in" title="发往 '+esc(x.agent)+'">‹ 入</span>':'';
    var kindBadge=m.kind&&m.kind!=='message'?'<span class="tl-tag" title="kind">'+esc(m.kind)+'</span>':'';
    var prioBadge=m.priority&&m.priority!=='normal'?'<span class="tl-tag '+(m.priority==='critical'?'crit':m.priority==='high'?'hi':'')+'" title="优先级">'+esc(m.priority)+'</span>':'';
    var topicBadge=m.topic?'<span class="tl-tag topic" title="topic">'+esc(m.topic)+'</span>':'';
    var unread=m.consumed?'':'<span class="tl-new">新</span>';
    var who=(m.from?esc(m.from):'?')+' → '+(m.to?esc(m.to):esc(x.agent));
    var ts=m.created_at?new Date(m.created_at).toLocaleString('zh-CN'):'';
    return '<div class="tl-msg'+(m.consumed?' consumed':'')+'" onclick="showMessageDetailByObj('+x.__i+')">'+
      '<div class="tl-head">'+unread+dir+kindBadge+prioBadge+'<span class="tl-who">'+who+'</span><span class="tl-ts">'+ts+'</span></div>'+
      '<div class="tl-body">'+esc(String(m.body||''))+'</div>'+
      (topicBadge?'<div class="tl-foot">'+topicBadge+' · '+esc(m.id||'')+'</div>':'<div class="tl-foot">'+esc(m.id||'')+'</div>')+
    '</div>';
  }).join('');
}
function showMessageDetailByObj(globalIdx){
  var m=__tlMessages[globalIdx];
  if(!m)return;
  openModal('消息详情 — '+esc(m.id),row('来自',esc(m.from))+row('发往',esc(m.to))+row('类型',esc(m.kind||'message'))+(m.topic?row('主题',esc(m.topic)):'')+(m.priority?row('优先级',esc(m.priority)):'')+row('时间',m.created_at?new Date(m.created_at).toLocaleString('zh-CN'):'-')+rowPre('内容',m.body));
}
function renderShared(kv){
  allShared=kv;
  var el=document.getElementById('tab-content-shared');
  if(!kv.length){el.innerHTML='<div class="empty-note">无共享记忆</div>';return}
  el.innerHTML=kv.map(function(s,i){return '<div class="kv" onclick="showSharedDetail('+i+')"><div class="k">'+esc(s.key)+'</div><div class="v">'+esc(s.value)+'</div></div>'}).join('')
}
function renderNotes(ns){
  allNotes=ns;
  var el=document.getElementById('tab-content-notes');
  if(!ns.length){el.innerHTML='<div class="empty-note">无共享笔记</div>';return}
  el.innerHTML=ns.map(function(n,i){return '<div class="note" onclick="showNoteDetail('+i+')"><span class="tag">['+esc(n.tag||'')+']</span> '+esc((n.note||'').slice(0,120))+'</div>'}).join('')
}
function switchTab(name){
  var tabs = ['inbox','shared','notes'];
  tabs.forEach(function(tab){
    var btn = document.getElementById('tab-btn-'+tab);
    var content = document.getElementById('tab-content-'+tab);
    if(btn) btn.classList.toggle('active', tab===name);
    if(content) content.classList.toggle('active', tab===name);
  });
}
/* 图例单一来源：把 [[key,label,color],...] 写进 sel，避免 DAG/树状各自手写色板偏色 */
function polyEchoLegend(sel,arr){ var e2=document.querySelector(sel); if(!e2)return; e2.innerHTML=arr.map(function(x){return '<span><i style="background:'+x[2]+'"></i>'+x[1]+'</span>'}).join(''); }
function renderDAG(dag){
  var el=document.getElementById('dag');
  if(!dag.nodes.length){el.innerHTML='<div class="dag-empty">暂无任务</div>';document.getElementById('legend').innerHTML='';return}
  var pad=10,w=dag.width+pad*2,h=Math.max(dag.height+pad*2,80);
  var NS='http://www.w3.org/2000/svg';
  var svg=document.createElementNS(NS,'svg');
  svg.setAttribute('width',w);svg.setAttribute('height',h);svg.setAttribute('viewBox','0 0 '+w+' '+h);
  var full = window.__allTasksMap||{};
  /* 阶段折叠（）：按依赖深度分组。折叠的深度 → keepMap 置 0 → 节点/边循环跳过。 */
  var depthMap = dagDepthMap(dag.nodes);
  var stageCounts = {};
  dag.nodes.forEach(function(n){ var d=depthMap[n.id]; stageCounts[d]=(stageCounts[d]||0)+1 });
  var stageList = Object.keys(stageCounts).map(Number).sort(function(a,b){return a-b});
  function renderStageChips(){
    var box=document.getElementById('dag-stages');
    if(!box)return;
    if(stageList.length<2){box.innerHTML='';return}
    box.innerHTML=stageList.map(function(d){
      var folded=dagFoldedStages.has(d);
      return '<span class="stage-chip'+(folded?' folded':'')+'" onclick="toggleStage('+d+')" title="折叠/展开第 '+(d+1)+' 层（共 '+stageCounts[d]+' 节点）">'
        +'L'+(d+1)+(folded?' ⊞':' ▽')+' · '+stageCounts[d]+'</span>';
    }).join('');
  }
  renderStageChips();
  /* 状态过滤：先把节点归入 run/pend/disp/appr/ok/fail/term 桶并铺 keepMap，边循环在其后引用 */
  function effBucket(node){
    var st=node.status||'pending', ft=full[node.id]||{};
    if(st==='running')return 'run';
    if(st==='failed')return 'fail';
    if(st==='completed')return 'ok';
    if(st==='awaiting_approval'||st==='escalating')return 'appr';
    if(st==='superseded'||st==='cancelled')return 'term';
    if(st==='pending'&&ft.assigned_to&&!ft.claimed_by)return 'disp';
    return 'pend';
  }
  var keepMap={};
  for(var ki=0;ki<dag.nodes.length;ki++){
    var _n=dag.nodes[ki];
    var _folded = dagFoldedStages.has(depthMap[_n.id]);
    var _stOk = dagStFilter ? effBucket(_n)===dagStFilter : 1;
    keepMap[_n.id]= _folded ? 0 : (_stOk?1:0);
  }
  // 用 createElementNS 构建 SVG，避免 innerHTML 字符串在旧 Chrome 吞掉 g/rect/path 只留 text（黑底白字）
  for(var ei=0;ei<dag.edges.length;ei++){
    var e=dag.edges[ei];
    if(dagStFilter&&(!keepMap[e.from]||!keepMap[e.to]))continue;
    var pe=document.createElementNS(NS,'path');
    pe.setAttribute('class','edge');pe.setAttribute('data-f',e.from);pe.setAttribute('data-t',e.to);
    pe.setAttribute('d',e.path);pe.setAttribute('transform','translate('+pad+','+pad+')');svg.appendChild(pe);
  }
  /* ──  队长→成员派工连线：creator≠assignee 且 creator 有节点时画青色虚线，落主控/人工下达语义 ── */
  var posById={}; dag.nodes.forEach(function(n){posById[n.id]={x:n.x,y:n.y}});
  var nodeY=n=>posById[n.id]?posById[n.id].y+NODE_H:0;
  var nodeRightX=n=>posById[n.id]?posById[n.id].x+NODE_W:0;
  var dispatchNodes={};
  dag.nodes.forEach(function(_nd){
    var ft=full[_nd.id]||{};
    var who=ft.created_by||''; if(!who)return;
    if(GHOST_AGENTS.has(who))return;
    var isDisp=(ft.claimed_by||ft.assigned_to||'')===''; // 未认领/未指派 → 悬空待领，连线到左上示意
    var targetNode=null;
    if(!isDisp&&_nd.assignee&&_nd.assignee!==who){
      // assignee 自身有节点 → 连到 assignee 节点；否则视为派发到当前节点
      targetNode = _nd;
    } else {
      targetNode = null; // 仅当前节点自身被派发（creator→ assignee=本节点 或 creator→未指派）
    }
    // 只对「creator 有独立节点」的左节点加连线，避免无 creator 节点时乱连
    var creatorNode = dag.nodes.find(function(n){return n.id===who});
    if(creatorNode){
      var x2=_nd.x, y2=_nd.y+NODE_H/2;
      var x1=nodeRightX(creatorNode), y1=nodeY(creatorNode)+NODE_H/2;
      var dispEdge=document.createElementNS(NS,'path');
      dispEdge.setAttribute('class','edge dispatch');dispEdge.setAttribute('data-f',who);dispEdge.setAttribute('data-t',_nd.id);dispEdge.setAttribute('title','派发：'+who+' → '+(ft.assigned_to||'待领')+'（'+(_nd.title||'')+'）');
      dispEdge.setAttribute('d','M'+x1+' '+y1+' C '+(x1+24)+' '+y1+', '+(x2-24)+' '+y2+', '+x2+' '+y2);
      dispEdge.setAttribute('transform','translate('+pad+','+pad+')');svg.appendChild(dispEdge);
      dispatchNodes[_nd.id]=who;
    }
  });
  // 建立 id→完整任务 映射供点击用
  allTasks=dag.nodes.map(function(n){return window.__allTasksMap[n.id]||n});
  function shortLabel(title){
    var t=String(title||'').trim();
    t=t.replace(/^(你(是|要|请|帮|负责)|请|任务[：: ]|Read the file|Analyze|优化|评估|审查|Review|审核|只需|返回|输出、?)/i,'');
    t=t.replace(/^["“「'].*/,'');
    if(t.length>20)t=t.slice(0,20)+'…';
    return t;
  }
  /* DAG 图例（先于 keepMap 无关，仅展示用） */
  var LEG=[
    ['running','运行','#3b82f6'],['disp','已派发','#38bdf8'],['pending','待领','#eab308'],
    ['appr','待批','#f59e0b'],['escalating','待决','#f59e0b'],['completed','完成','#22c55e'],
    ['failed','失败','#ef4444'],['term','已结束','#64748b'],['dispatch','派工连线','#22d3ee']
  ];
  polyEchoLegend("#legend",LEG);
  var filtered=0, foldedN=0;
  for(var fk=0;fk<dag.nodes.length;fk++){
    if(!keepMap[dag.nodes[fk].id]){
      if(dagStFilter)filtered++;
      if(dagFoldedStages.has(depthMap[dag.nodes[fk].id]))foldedN++;
    }
  }
  for(var ni=0;ni<dag.nodes.length;ni++){
    if(!keepMap[dag.nodes[ni].id])continue;
    var n=dag.nodes[ni],c=dagColor(n),catC=categoryColor(n),Tft=full[n.id]||{};
    var st=n.status||'pending';
    var disp = st==='pending' && Tft.assigned_to && !Tft.claimed_by; // 已派发待开工
    if(disp)st='disp';
    var term = st==='superseded'||st==='cancelled';
    if(term)st='term';
    var g=document.createElementNS(NS,'g');
    g.setAttribute('class','tnode'+(st==='running'?' t-run':st==='escalating'?' t-esc':'')
      +(term?' t-term':'')+(disp?' t-disp':''));
    g.setAttribute('data-id',n.id);g.setAttribute('data-idx',ni);
    g.setAttribute('transform','translate('+(n.x+pad)+','+(n.y+pad)+')');
    // 状态主记：左缘竖条(状态色) + 节点填充(类别淡色) + 描边(状态色)
    var bar=document.createElementNS(NS,'rect');
    bar.setAttribute('x','0');bar.setAttribute('y','0');bar.setAttribute('width','4');bar.setAttribute('height',NODE_H);bar.setAttribute('fill',c);
    g.appendChild(bar);
    var rn=document.createElementNS(NS,'rect');
    rn.setAttribute('x','4');rn.setAttribute('width',NODE_W-4);rn.setAttribute('height',NODE_H);rn.setAttribute('rx','0');
    rn.setAttribute('fill',catC+(themeIsLight()?'26':'1e'));
    rn.setAttribute('stroke',term?(themeIsLight()?'#94a3b8':'#475569'):c);rn.setAttribute('stroke-width',(st==='running'||st==='escalating')?'2':'1.2');
    if(term){rn.setAttribute('stroke-dasharray','4 3');rn.setAttribute('opacity','0.72')}
    g.appendChild(rn);
    // 右上：状态圆点（完成=绿 / 运行=跳蓝 / 待批=橙 / 已派发=天蓝 / 已结束=灰）※ 类别点改放右下，状态点放右上更易扫读
    var dot=document.createElementNS(NS,'circle');
    dot.setAttribute('cx',NODE_W-7);dot.setAttribute('cy','7');dot.setAttribute('r','3');dot.setAttribute('fill',c);
    if(st==='running'){dot.setAttribute('class','pulse-dot');g.setAttribute('class',g.getAttribute('class')+' t-pulse')}
    g.appendChild(dot);
    // 类别图标（右下角小方块）：alarm呈红色角标提示异常/评审
    var icon=document.createElementNS(NS,'rect');
    icon.setAttribute('x',NODE_W-13);icon.setAttribute('y','22');icon.setAttribute('width','6');icon.setAttribute('height','6');icon.setAttribute('fill',catC);icon.setAttribute('opacity','0.75');
    g.appendChild(icon);
    // 标题（第1行）：取 shortLabel，运行/待批前加状态符号
    var t1=document.createElementNS(NS,'text');
    t1.setAttribute('x','9');t1.setAttribute('y','14');t1.setAttribute('fill',svgTxt());t1.setAttribute('font-size','8.5');t1.setAttribute('font-weight','600');
    var sym = st==='running'?'▶ ':st==='escalating'?'⚠ ':st==='awaiting_approval'?'⏸ ':st==='appr'?'⏸ ':disp?'→ ':'';
    //  演进徽标：fork 分支=⊕(备选换 agent)，append 追加=＋(后置连完成尾段)，
    // insert 前置插=⟳(fork 补丁+重算依赖)，repoint 重连=↻。区分"原规划"节点。
    // 主 kind 优先；fork 分支若又经 repoint(sub.kind=repoint)则主徽标仍 ⊕、标题前缀补 ↻ 表示二次演进。
    var ev = (Tft.evolve||n.evolve||null);
    var evKind = ev?ev.kind:null;
    var evSub = ev&&ev.sub?ev.sub.kind:null;
    var evSym = evKind==='fork'?'⊕':evKind==='append'?'＋':evKind==='insert'?'⟳':evKind==='repoint'?'↻':evKind==='rollback'?'↩':evKind==='branch'?'⎇':'';
    var evTint = evKind==='fork'?'#f472b6':(evKind==='append'?'#38bdf8':(evKind==='insert'?'#fbbf24':(evKind==='repoint'?'#facc15':(evKind==='rollback'?'#fb7185':(evKind==='branch'?'#34d399':null)))));
    if(evTint){t1.setAttribute('fill',evTint);t1.setAttribute('font-weight','700')}
    t1.textContent=(evSym?evSym+' ':'')+(evSub==='repoint'?'↻ ':(evSub==='branch'?'⎇ ':(evSub==='rollback'?'↩ ':'')))+sym+shortLabel(n.title);
    g.appendChild(t1);
    // 演进节点加 data-* 供 hover 判读
    if(ev){g.setAttribute('data-evolve',(evKind||'')+(ev.reason?('|'+ev.reason):'')+(evSub?('|↻'+((ev.sub.reason)||'')):''));}
    // 第2行：归属人 + 状态译文（小字右对齐）※ 已派发显示 →assignee，运行显示 claimer
    var who=Tft.claimed_by||n.assignee||'';
    var t2=document.createElementNS(NS,'text');
    t2.setAttribute('x','9');t2.setAttribute('y','25');t2.setAttribute('fill',term?svgTermMut():svgMut());t2.setAttribute('font-size','7.5');
    t2.textContent=(disp?'→':'')+(who||'-');
    g.appendChild(t2);
    var lbl=document.createElementNS(NS,'text');
    lbl.setAttribute('x',NODE_W-9);lbl.setAttribute('y','25');lbl.setAttribute('fill',c);lbl.setAttribute('font-size','6.5');lbl.setAttribute('text-anchor','end');lbl.setAttribute('font-weight','600');
    lbl.textContent=({completed:'✓',failed:'✕',running:'▶',disp:'→',appr:'批',escalating:'决',term:'终',pending:'待'}[st]||'待').slice(0,1);
    g.appendChild(lbl);
    svg.appendChild(g);
  }
  /* 若过滤后无节点：空提示；有隐藏节点则附一行提示 */
  var shown=el.querySelectorAll ? [].slice.call(svg.childNodes).filter(function(x){return x.tagName==='g'&&x.getAttribute('data-id')}).length : 0;
  var shownTasks=[];
  [].slice.call(svg.childNodes).forEach(function(x){ if(x.tagName==='g'&&x.getAttribute('data-id'))shownTasks.push(window.__allTasksMap[x.getAttribute('data-id')]||{id:x.getAttribute('data-id')}); });
  allTasks=shownTasks;
  el.innerHTML='';el.appendChild(svg);
  applyDagZoom();   // 重建 svg 后恢复缩放（transform 随 svg 重建丢失）
  if(dagStFilter&&shown===0){el.innerHTML='<div class="dag-empty">无「'+dagStFilter+'」状态节点</div>';}
  else if(dagStFilter&&filtered>0){el.insertAdjacentHTML('beforeend','<div class="dag-filtered">已过滤隐藏 '+filtered+' 个节点（仅显示 '+shown+'）'+(foldedN?' · 其中 '+foldedN+' 个被阶段折叠':'')+'</div>');}
  else if(foldedN>0){el.insertAdjacentHTML('beforeend','<div class="dag-filtered">已折叠 '+foldedN+' 个节点（点击上方阶段芯片展开）</div>');}
  var nodes=[].slice.call(el.querySelectorAll('.tnode')),edges=[].slice.call(el.querySelectorAll('.edge'));
  var related=function(id){
    var byId=new Map(dag.nodes.map(function(n){return [n.id,n]}));
    if(!byId.has(id))return new Set();
    var deps=new Map();
    dag.nodes.forEach(function(n){(n.dependencies||[]).forEach(function(d){if(!deps.has(d))deps.set(d,[]);deps.get(d).push(n.id)})});
    var rel=new Set(),su=new Set(),sd=new Set();
    var up=function(x){if(su.has(x))return;su.add(x);rel.add(x);var ds=(byId.get(x)||{}).dependencies||[];ds.forEach(up)};
    var dn=function(x){if(sd.has(x))return;sd.add(x);rel.add(x);(deps.get(x)||[]).forEach(dn)};
    up(id);dn(id);return rel
  };
  var apply=function(id){
    if(!id){nodes.forEach(function(n){n.classList.remove('dim')});edges.forEach(function(e){e.classList.remove('dim','hl')});return}
    var rel=related(id);
    nodes.forEach(function(n){n.classList.toggle('dim',!rel.has(n.dataset.id))});
    edges.forEach(function(e){var on=rel.has(e.dataset.f)&&rel.has(e.dataset.t);e.classList.toggle('dim',!on);e.classList.toggle('hl',on)})
  };
  var clearPin=function(){pinnedTaskId=null;nodes.forEach(function(n){n.classList.remove('pinned')});apply(null)};
  nodes.forEach(function(n){
    n.addEventListener('mouseenter',function(){
      if(pinnedTaskId)return;  // 固定时悬停不抢
      if(hoverTimer)clearTimeout(hoverTimer);
      hoverTimer=setTimeout(function(){apply(n.dataset.id)},120)
    });
    n.addEventListener('mouseleave',function(){
      if(pinnedTaskId)return;
      if(hoverTimer)clearTimeout(hoverTimer);
      apply(null)
    });
    n.addEventListener('click',function(ev){
      ev.stopPropagation();
      if(pinnedTaskId===n.dataset.id){clearPin();return}  // 再点取消
      pinnedTaskId=n.dataset.id;
      nodes.forEach(function(x){x.classList.remove('pinned')});
      n.classList.add('pinned');
      apply(n.dataset.id);
      showTaskDetail(parseInt(n.dataset.idx,10))
    })
  });
  // 画布空白处点击取消固定
  el.addEventListener('click',function(){if(pinnedTaskId)clearPin()});
  el.addEventListener('mouseleave',function(){if(!pinnedTaskId)apply(null)});
  // Esc 已全局关闭 modal，这里额外取消固定
  // 一次性绑定：renderDAG 每 2s 重绘，若每次 addEventListener 会累积 document 级监听导致内存泄漏
  if(!win_escPinBound){
    win_escPinBound=true;
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&pinnedTaskId)clearPin()});
  }
  // 若上次有固定任务，重新渲染后恢复固定态
  if(pinnedTaskId){
    var pn=nodes.filter(function(n){return n.dataset.id===pinnedTaskId})[0];
    if(pn){pn.classList.add('pinned');apply(pinnedTaskId)}else{pinnedTaskId=null}
  }
}
/* 任务依赖图视图：DAG / 树状 */
var dagView='dag';
function dagSwitch(name){
  dagView=name;
  var a=document.getElementById('dagTabDag'),b=document.getElementById('dagTabTree');
  if(a)a.classList.toggle('active',name==='dag');
  if(b)b.classList.toggle('active',name==='tree');
  var hint=document.getElementById('dag-hint');
  if(hint)hint.style.display=name==='dag'?'':'none';
  if(lastState)renderFromState(lastState); // 立即重渲染，不等 2s 轮询
}
/* 树状·工作流生命周期：选中某工作流(currentWfKey)时返回该工作流卡对象；未选中返回 null。
 * renderTree 据此纵向渲染该工作流从派发到审核/汇入主控的完整生命周期。 */
function selectedWorkflow(s){
  if(!currentWfKey) return null;
  for(var i=0;i<allWorkflows.length;i++){ if(allWorkflows[i].key===currentWfKey) return allWorkflows[i]; }
  return null;
}
/* 树状（工作流生命周期）：纵向节点流，展示范式 + 队长→队员派发 + 各节点执行状态 + 数据汇入主控/审核。
 * wf=工作流卡（含 paradigm 范式、steps[] 每阶段任务的执行者/状态）；capStat=captainSummary（主控名）。 */
function renderTree(wf,capStat){
  var el=document.getElementById('dag');
  var legend=document.getElementById('legend');
  legend.innerHTML=[
    ['run','运行','#3b82f6'],['pend','待领/待批','#eab308'],['ok','完成','#22c55e'],
    ['fail','失败','#ef4444'],['term','已结束','#64748b'],['sink','主控/审核','#6366f1']
  ].map(function(e){return '<span><i style="background:'+e[2]+'"></i>'+e[1]+'</span>'}).join('');
  if(!wf){el.innerHTML='<div class="lf-empty">👈 从上方选择一个工作流卡片查看它的完整生命周期<br>（范式 · 队长→队员派发 · 节点执行状态 · 数据汇入主控/审核）</div>';return}
  var capName=(capStat&&capStat.controller)||'claude';
  var paraBadge=wf.paradigm==='compete'
      ?'<span class="lf-badge lf-compete" title="多个 Agent 并行评估→1 个 Agent 收敛评审">竞争式 · 多视角评</span>'
      :(wf.paradigm==='collaborate'
        ?'<span class="lf-badge lf-collab" title="多个 Agent 分工实现→主控汇总审核">合作式 · 分工做</span>'
        :'<span class="lf-badge" style="border-color:var(--line);color:var(--mut)" title="按阶段顺序顺序执行">线性 · 顺序流</span>');
  var head='<div class="lf-head"><div><div class="lf-title">'+esc(wf.title)+'</div>'+
    '<div class="lf-sub">共 '+wf.total+' 阶段 · 完成 '+wf.done+' · 运行 '+wf.running+' · 失败 '+wf.failed+'</div></div>'+
    '<div style="margin-left:auto;display:flex;gap:6px;align-items:center">'+paraBadge+'<span class="lf-cap">👑 主控 '+esc(capName)+'</span></div></div>';
  var steps=wf.steps||[];
  /* 节点流 */
  var body=steps.map(function(st,idx){
    var s=st.status;
    var cls=s==='completed'?'ok':s==='running'?'run':s==='failed'?'fail'
      :(s==='superseded'||s==='cancelled')?'term'
      :((s==='awaiting_approval'||s==='escalating')?'appr':'pend');
    var dotCls=s==='completed'?'done':s==='running'?'run':s==='failed'?'fail':(s==='superseded'||s==='cancelled')?'pend':'pend';
    var who=st.claimed_by||st.assigned_to||'';
    /* 判定"汇入主控"节点：任务落入主控 或 阶段名含审核/收敛 */
    var sink=/审核|收敛|评审|汇总|最终/.test(st.step||'') && who==='' || who===capName && /审核|收敛|评审|汇总|最终/.test(st.step||'');
    var nodeCls=cls;
    var statusLabel={completed:'完成',running:'运行',failed:'失败',pending:'待领',superseded:'已结束',cancelled:'已结束',awaiting_approval:'待批',escalating:'待决'}[s]||s;
    var whoHtml = who ? '<span class="lf-badge" title="执行者">👤 '+esc(who)+(who===capName?' <span class="lf-cap">主控</span>':'')+'</span>'
                      : '<span class="lf-badge">⌛ 未指派</span>';
    var prevWho = idx>0 ? (steps[idx-1].claimed_by||steps[idx-1].assigned_to||'') : '';
    var trans = (who && who!==prevWho) ? '<span class="lf-flowtag">↑ '+esc(prevWho||'队长')+' → '+esc(who)+'</span>' : (prevWho && !who ? '<span class="lf-flowtag">→ '+esc(prevWho)+' 顺序</span>' : '');
    /* 节点序号 ①②③…（配合 rail 竖线做"阶段流"引导） */
    var seqChar=['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'][idx];
    var seqHtml='<span class="lf-seq">'+(seqChar||(''+(idx+1)))+'</span>';
    var click='onclick="showTaskById(\\''+esc(st.id)+'\\')"';
    return '<div class="lf-node '+dotCls+'" data-seq="'+(idx+1)+'">'+
      '<div class="lf-rail"><div class="lf-dot"></div><div class="lf-line"></div></div>'+
      '<div class="lf-card" '+click+'>'+
        '<div class="lf-flowline"></div>'+
        (trans)+
        '<div class="lf-step"><span>'+seqHtml+esc(st.step||('阶段 '+(idx+1)))+
          (st.evolve&&st.evolve.kind==='fork'?'&nbsp;<span class="lf-badge" style="border-color:#f472b6;color:#f472b6" title="'+esc((st.evolve.reason||'备选 fork'))+'">⊕ 演进分支</span>':'')+
          (st.evolve&&st.evolve.kind==='append'?'&nbsp;<span class="lf-badge" style="border-color:#38bdf8;color:#38bdf8" title="'+esc((st.evolve.reason||'后置追加'))+'">＋ 追加段</span>':'')+
          (st.evolve&&st.evolve.kind==='insert'?'&nbsp;<span class="lf-badge" style="border-color:#fbbf24;color:#fbbf24" title="'+esc((st.evolve.reason||'前置插入'))+'">⟳ 前置插</span>':'')+
          ((st.evolve&&st.evolve.kind==='repoint')||(st.evolve&&st.evolve.sub&&st.evolve.sub.kind==='repoint')?'&nbsp;<span class="lf-badge" style="border-color:#facc15;color:#facc15" title="'+esc(((st.evolve.sub&&st.evolve.sub.reason)||st.evolve.reason||'前置插入重算依赖'))+'">↻ 重连依赖</span>':'')+
          (st.evolve&&st.evolve.kind==='rollback'?'&nbsp;<span class="lf-badge" style="border-color:#fb7185;color:#fb7185" title="'+esc((st.evolve.reason||'阶段回退'))+'">↩ 回退段</span>':'')+
          (st.evolve&&st.evolve.kind==='branch'?'&nbsp;<span class="lf-badge" style="border-color:#34d399;color:#34d399" title="'+esc((st.evolve.condition||st.evolve.reason||'条件分支'))+'">⎇ 条件分支 '+(st.evolve.condition?esc(st.evolve.condition.slice(0,12)):'')+'</span>':'')+
          ((st.evolve&&st.evolve.sub&&(st.evolve.sub.kind==='branch'||st.evolve.sub.kind==='rollback'))?'&nbsp;<span class="lf-badge" style="border-color:'+((st.evolve.sub.kind==='branch')?'#34d399':'#fb7185')+';color:'+((st.evolve.sub.kind==='branch')?'#34d399':'#fb7185')+'" title="'+esc((st.evolve.sub.reason||'二次演进'))+'">'+(st.evolve.sub.kind==='branch'?'⎇ 又称':'↩ 又回退')+'</span>':'')+
        '</span>'+
          '<span class="lf-st '+nodeCls+'">'+esc(statusLabel)+'</span>'+
        '</div>'+
        (sink?'<div class="lf-sinkbar">⟱ 数据汇入主控/审核</div>':'')+
        '<div class="lf-meta">'+whoHtml+'<span class="lf-badge" title="任务 id">#'+esc(st.id.slice(-6))+'</span>'+
          (st.created_at?'<span class="lf-badge">'+msFmtAge(st.created_at)+'</span>':'')+
        '</div>'+
      '</div>'+
    '</div>';
  }).join('');
  el.innerHTML='<div class="lf">'+head+'<div class="lf-flow">'+body+'</div></div>';
}
function msFmtAge(ts){ if(!ts)return ''; var d=Math.max(0,Math.floor((Date.now()-ts)/60000)); return d<1?'刚刚':(d<60?d+' 分钟前':(Math.floor(d/60)+' 小时前')); }
function showMemberByAgent(agent){
  var i=-1;allMembers.forEach(function(m,k){if(m.agent===agent)i=k});
  if(i>=0)showMemberDetail(i);else closeModal();
}
function renderProgress(s,total){
  var el=document.getElementById('progbar'),sum=document.getElementById('progsum');
  if(!total){el.innerHTML='';sum.innerHTML='';return}
  var segs=[
    {n:s.completed||0,c:'#22c55e'},
    {n:s.running||0,c:'#3b82f6'},
    {n:s.pending||0,c:'#eab308'},
    {n:s.failed||0,c:'#ef4444'},
    {n:s.superseded||0,c:'#64748b'}
  ];
  el.innerHTML=segs.map(function(g){return '<i style="width:'+(g.n/total*100)+'%;background:'+g.c+'"></i>'}).join('');
  var done=s.completed||0,rate=total?Math.round(done/total*100):0;
  sum.innerHTML='<span>总 '+total+' · 完成 '+done+' ('+rate+'%)</span><span>运行 '+(s.running||0)+' · 待领 '+(s.pending||0)+' · 失败 '+(s.failed||0)+'</span>'
}
function renderStats(s,total,unread){
  document.getElementById('stats').innerHTML=
    '<span class="chip">📋 任务 <b>'+total+'</b></span>'+
    '<span class="chip run">▶ 运行 <b>'+s.running+'</b></span>'+
    '<span class="chip pend">⏳ 待领 <b>'+s.pending+'</b></span>'+
    '<span class="chip ok">✓ 完成 <b>'+s.completed+'</b></span>'+
    '<span class="chip err">✕ 失败 <b>'+s.failed+'</b></span>'+
    '<span class="chip sup">↷ 替代 <b>'+s.superseded+'</b></span>'+
    (unread?'<span class="chip" style="color:var(--warn)">📥 未读 <b>'+unread+'</b></span>':'')
}
function renderTeamProgress(s, total) {
  if (!total) { document.getElementById('team-progress-panel').innerHTML = ''; return; }
  var segs = [{n:s.completed||0,c:'#22c55e'},{n:s.running||0,c:'#3b82f6'},{n:s.pending||0,c:'#eab308'},{n:s.failed||0,c:'#ef4444'},{n:s.superseded||0,c:'#64748b'}];
  var barHtml = segs.map(function(g){return '<i style="width:'+(g.n/total*100)+'%;background:'+g.c+'"></i>'}).join('');
  var done=s.completed||0, rate=total?Math.round(done/total*100):0;
  var sumHtml = '<span>总 '+total+' · 完成 '+done+' ('+rate+'%)</span><span>运行 '+(s.running||0)+' · 待领 '+(s.pending||0)+' · 失败 '+(s.failed||0)+'</span>';
  document.getElementById('team-progress-panel').innerHTML =
    '<h2>📊 团队整体进度</h2>' +
    '<div class="progbar" style="margin-bottom:6px">'+barHtml+'</div>' +
    '<div class="progsum">'+sumHtml+'</div>';
}
function renderOverview(ov){
  var legend='';
  [['run','运行中','#3b82f6'],['ok','完成','#22c55e'],['err','失败','#ef4444'],['pend','待领','#eab308']].forEach(function(e){
    legend+='<span><i style="background:'+e[2]+'"></i>'+e[1]+'</span>';
  });
  document.getElementById('ov-legend').innerHTML=legend;
  var el=document.getElementById('overview');
  if(!ov||!ov.length){el.innerHTML='<div class="empty-note">暂无任务</div>';return}
  el.innerHTML=ov.map(function(g,k){
    var isOpen=g.isController ? ovOpen.has(g.agent) : ovOpen.has(g.agent); // 控制器默认收起（点开），其余默认收起（点开）
    var cls='ov-group'+(g.isController?' controller':'')+(isOpen?' open':'');
    var roleLabel=g.isController?globalControllerLabel:roleOfLabel(g.agent);
    var crown=g.isController?'<span class="crown">👑</span>':'';
    var head='<div class="ov-head" onclick="toggleOvGroup(\\''+esc(g.agent)+'\\')">'+
      '<div class="ov-name">'+crown+esc(g.agent)+'<span class="role">'+esc(roleLabel)+'</span></div>'+
      '<div class="ov-num">'+g.total+' 项 · 完成 '+g.done+' · 失败 '+g.failed+(g.running?' · 运行 '+g.running:'')+'</div></div>';
    var prog='<div class="progbar ov-prog">'+
      '<i style="width:'+(g.done/g.total*100)+'%;background:#22c55e"></i>'+
      '<i style="width:'+(g.running/g.total*100)+'%;background:#3b82f6"></i>'+
      '<i style="width:'+(g.failed/g.total*100)+'%;background:#ef4444"></i></div>';
    var tasks='<div class="ov-tasks">'+g.tasks.map(function(t){
      var lbl=STATUS_LABEL[t.status]||t.status, cls='t-stat '+t.status;
      var time=t.duration?'<span class="t-time">'+msFmt(t.duration)+'</span>':'<span class="t-time">—</span>';
      if(t.status==='running'&&t.elapsed){time='<span class="t-time">已 '+msFmt(t.elapsed)+'</span>';}
      var res=t.result?'<div class="t-res">'+esc(String(t.result).slice(0,80))+'</div>':'';
      var ses=t.session_id?'<div class="t-ses" title="worker 会话 id，可在 DSH/opencode 续接取证">会话 '+esc(t.session_id)+'</div>':'';
      return '<div class="ov-task '+t.status+'" onclick="showTaskById(\\''+esc(t.id)+'\\')">'+
        '<div class="t-title">'+esc((t.title||'(untitled)').slice(0,60))+'</div>'+
        '<div class="t-meta"><span class="'+cls+'">'+lbl+'</span> · '+time+'</div>'+res+ses+'</div>';
    }).join('')+'</div>';
    return '<div class="'+cls+'">'+head+prog+tasks+'</div>';
  }).join('');
}
function roleOf(ag){var r={claude:{role:'captain',label:'队长 · 主控',grad:['#6366f1','#818cf8']},codex:{role:'engineer',label:'工程师 · 实现',grad:['#0ea5e9','#0369a1']},opencode:{role:'engineer',label:'工程师 · 兜底',grad:['#14b8a6','#0f766e']},qwen:{role:'docs',label:'文档 · 写作',grad:['#f59e0b','#b45309']},dsh:{role:'coordinator',label:'编排 · 多后端',grad:['#8b5cf6','#6d28d9']},'verify-agent':{role:'qa',label:'QA · 验证',grad:['#10b981','#047857']} }[ag]||{role:'member',label:'成员',grad:['#64748b','#334155']};return r}
function roleOfLabel(ag){var r={claude:'队长 · 主控',codex:'工程师 · 实现',opencode:'工程师 · 兜底',qwen:'文档 · 写作',dsh:'编排 · 多后端','verify-agent':'QA · 验证'}[ag];return r||'成员'}

/* ── 工作流卡片 + DAG 聚焦 ─────────────────────────────────── */
var allWorkflows=[], currentWfKey='', wfView='current';
function activeDag(s){
  if(currentWfKey){
    for(var i=0;i<allWorkflows.length;i++){
      if(allWorkflows[i].key===currentWfKey) return allWorkflows[i].dag||s.dag;
    }
  }
  return s.dag;
}
function renderWorkflows(wfs){
  allWorkflows=(wfs&&wfs.list)||[];
  var active=allWorkflows.filter(function(wf){return !wf.archived;});
  var archivedWF=allWorkflows.filter(function(wf){return wf.archived;});
  /* 当前/历史 segmented 高亮 */
  var curT=document.getElementById('wfTabCur'), hisT=document.getElementById('wfTabHist');
  if(curT)curT.className='wf-tab'+(wfView==='current'?' active':'');
  if(hisT)hisT.className='wf-tab'+(wfView==='history'?' active':'');
  var el=document.getElementById('workflows');
  var list = wfView==='history' ? archivedWF : active;
  function cardHtml(wf,historic){
    var shellBadge=wf.emptyShell?'<span class="wf-tpl" style="background:rgba(148,163,184,.15);color:var(--mut);border-color:rgba(148,163,184,.4)">空壳</span>':'';
    var paraBadge=wf.paradigm==='compete'?'<span class="wf-tpl wf-para-compete">竞争式·评</span>'
      :(wf.paradigm==='collaborate'?'<span class="wf-tpl wf-para-collab">合作式·做</span>':'');
    var escBadge=wf.escalating>0?'<span class="wf-tpl wf-para-esc">待决 '+(wf.escalating)+'</span>':'';
    var steps=wf.steps.map(function(st){
      // UI 状态映射：completed=ok / running=run / failed=fail / escalating=esc(待决)
      //   awaiting_approval=appr(待批,橙) / superseded|cancelled=term(已结束,灰) / pending 细分：
      //   assigned_to 已派发但无人领取 = disp(已派发待开工,蓝边浅)，否则 pend(待领取,黄)
      var s=st.status;
      var cls='wf-step '+(s==='completed'?'ok':s==='running'?'run':s==='failed'?'fail'
        :s==='escalating'?'esc':s==='awaiting_approval'?'appr'
        :(s==='superseded'||s==='cancelled')?'term'
        :(st.assigned_to&&!st.claimed_by?'disp':'pend'));
      var who=st.claimed_by?' ·'+esc(st.claimed_by):(st.assigned_to?' ·→'+esc(st.assigned_to):'');
      var body=esc(st.step)+who;
      if(s==='escalating') body='<span style="color:var(--warn)">⚠</span>'+body;
      else if(s==='awaiting_approval') body='<span style="color:var(--warn)">⏸</span>'+body;
      else if(s==='superseded'||s==='cancelled') body='<span style="opacity:.6">✓</span>'+body;
      else if(s==='completed') body='<span style="color:var(--ok)">✓</span>'+body;
      else if(s==='running') body='<span style="color:var(--run)">▶</span>'+body;
      else if(st.assigned_to&&!st.claimed_by&&s==='pending') body='<span style="color:var(--run)">→</span>'+body;
      else if((st.progress&&st.progress.length)&&s!=='completed') body+=' <span class="wf-meta" style="font-weight:400">·'+esc(st.progress[st.progress.length-1])+'</span>';
      return '<div class="'+cls+'" title="'+esc(st.step)+' · '+esc(st.id)+'">'+body+'</div>';
    }).join('');
    var act=(wf.key===currentWfKey)?' active':'';
    var meta='共 '+wf.total+' 阶段 · 完成 '+wf.done+(historic?'':' · 运行 '+wf.running)+' · 失败 '+wf.failed
      +(wf.assigned?' · 已派发 '+wf.assigned:'')+(wf.awaiting_approval?' · 待批 '+wf.awaiting_approval:'')
      +(wf.escalating?' · 待决 '+wf.escalating:'')+(wf.superseded?' · 已结束 '+wf.superseded:'')
      +(historic?' · 历史终态':'')+(wf.emptyShell?' · 派发后未被填充':'');
    // UI 颜色图例条（参考面板参考示例.png）：进行中/等待/已交付/已结束
    var legend='<div class="wf-legend">'
      +'<span class="lg ok">●进行中</span><span class="lg disp">●已派发</span>'
      +'<span class="lg pend">●待领取</span><span class="lg appr">●待批</span>'
      +'<span class="lg ok2">●已交付</span><span class="lg term">●已结束</span></div>';
    return '<div class="wf-card'+(historic?' wf-arch':'')+act+'" onclick="pickWf(\\''+esc(wf.key)+'\\')">'+
      '<div class="wf-head"><span class="wf-title">'+esc(wf.title)+'</span>'+shellBadge+paraBadge+escBadge+'<span class="wf-tpl">'+esc(wf.tpl)+'</span></div>'+
      '<div class="wf-meta">'+meta+'</div>'+
      '<div class="wf-stepper">'+steps+'</div>'+
      legend+
      '<div class="wf-mini">点击聚焦此工作流，全阶段图见下方 DAG</div></div>';
  }
  if(!list.length){
    el.innerHTML='<div class="wf-none">'+(wfView==='history'?'暂无历史工作流':'暂无正在运行的工作流（切换「历史」可查看已归档工作流）')+'</div>';
  }else{
    el.innerHTML=list.map(function(wf){return cardHtml(wf,wfView==='history');}).join('');
    if(wfView==='current'&&wfs&&wfs.other)el.innerHTML+='<div class="wf-none" style="margin-top:8px">+ 单发任务 '+wfs.other+' 个（未归属工作流）</div>';
  }
  var sel=document.getElementById('wf-filter');
  if(sel){
    var opts=['<option value="">全部工作流</option>'].concat(active.map(function(wf){
      return '<option value="'+esc(wf.key)+'"'+(wf.key===currentWfKey?' selected':'')+'>'+esc(wf.title)+(wf.tpl?' ['+esc(wf.tpl)+']':'')+' · '+wf.running+'运行/'+wf.total+'阶段</option>';
    })).join('');
    if(sel.innerHTML!==opts)sel.innerHTML=opts;
    sel.value=currentWfKey||'';
  }
}
function pickWf(key){ currentWfKey=key; var sel=document.getElementById('wf-filter'); if(sel)sel.value=key; if(lastState)renderFromState(lastState); }
/* 当前/历史切换：互斥切换两个视图，状态跨轮询保持（session 内） */
function wfSwitch(view){
  wfView=view;
  currentWfKey='';
  if(lastState)renderFromState(lastState); // 立即重渲染，DOM 依 wfView 显示当前卡或历史卡
}
function onWfFilter(sel){ currentWfKey=sel.value||''; if(lastState)renderFromState(lastState); }
var dagStFilter='';
function onStFilter(sel){ dagStFilter=sel.value||''; if(lastState)renderFromState(lastState); }
/* DAG 画布缩放（，解决节点拥挤）：CSS transform:scale 包裹 svg，不影响坐标/事件。
   dagZoomLvl 持久跨轮询；applyDagZoom 应用到当前 svg。滚轮缩放 onDagWheel。*/
var dagZoomLvl=1;
var DAG_ZOOM_MIN=0.4, DAG_ZOOM_MAX=2.5, DAG_ZOOM_STEP=0.15;
function applyDagZoom(){
  var svg=document.querySelector('#dag svg');
  if(svg) svg.style.transform='scale('+dagZoomLvl+')';
  var zl=document.getElementById('zoomLvl');
  if(zl) zl.textContent=Math.round(dagZoomLvl*100)+'%';
}
function dagZoom(dir){
  if(dir===0){ dagZoomLvl=1; }            // 复位
  else if(dir>0){ dagZoomLvl=Math.min(DAG_ZOOM_MAX,dagZoomLvl+DAG_ZOOM_STEP); }
  else { dagZoomLvl=Math.max(DAG_ZOOM_MIN,dagZoomLvl-DAG_ZOOM_STEP); }
  applyDagZoom();
}
function onDagWheel(e){
  // 滚轮缩放：ctrl/alt+滚轮 或 直接滚轮（避免与纵向滚动冲突时仍可缩放）
  if(!e.ctrlKey && !e.altKey && Math.abs(e.deltaY)<50) return; // 普通滚轮优先滚动；小幅滚动或带修饰键才缩放
  e.preventDefault();
  dagZoom(e.deltaY<0?1:-1);
}
/* 阶段折叠（）：按依赖深度分组，点击阶段芯片折叠/展开该深度全部节点 + 连带边。
   dagFoldedStages 跨轮询持久（Set of depth）。折叠=keepMap 置 0 → 节点/边循环跳过。 */
var dagFoldedStages = new Set();
function dagDepthMap(nodes){
  var byId={};nodes.forEach(function(n){byId[n.id]=n});
  var cache={};
  function dep(id){
    if(cache[id]!=null)return cache[id];
    var n=byId[id]; if(!n||!n.dependencies||!n.dependencies.length){cache[id]=0;return 0}
    var d=0; n.dependencies.forEach(function(x){ if(byId[x]) d=Math.max(d, dep(x)+1) });
    cache[id]=d; return d;
  }
  nodes.forEach(function(n){dep(n.id)});
  return cache;
}
function toggleStage(d){
  d=parseInt(d,10);
  if(dagFoldedStages.has(d))dagFoldedStages.delete(d);else dagFoldedStages.add(d);
  if(lastState)renderFromState(lastState);
}
var globalControllerLabel='';
function syncControllerSelect(ctrl,cands,label){
  globalControllerLabel=label||roleOfLabel(ctrl);
  var sel=document.getElementById('controller');
  var cur=cands&&cands.length?cands:['claude'];
  if(sel.value!==ctrl||sel.options.length!==cur.length){
    var prev=sel.value;
    sel.innerHTML=cur.map(function(c){return '<option value="'+c+'"'+(c===ctrl?' selected':'')+'>'+esc(c)+' · '+esc(roleOfLabel(c))+'</option>'}).join('');
  }
}
function toggleOvGroup(agent){
  if(ovOpen.has(agent))ovOpen.delete(agent);else ovOpen.add(agent);
  if(lastState)renderFromState(lastState); // 立即重渲染，不等 SSE/轮询
}
async function renderFromState(s){
    if(!s)return;
    try{
    window.__allTasksMap={};(s.tasks||[]).forEach(function(t){window.__allTasksMap[t.id]=t});
    /* ── 错误告警条 ── */
    var errBar=document.getElementById('errbar');
    if(s.stat.failed>0){
      errBar.innerHTML='<div class="alert-bar err">⚠ 失败 '+(s.stat.failed)+' 项 · 最接近失败：<span id="lastfail"></span></div>';
      var lastF=null;
      (s.tasks||[]).forEach(function(t){if(t.status==='failed'){lastF=t;}});
      if(lastF){
        var el=document.getElementById('lastfail');
        if(el)el.textContent=(lastF.title||'').slice(0,24);
      }
    }else{
      errBar.innerHTML='';
    }
    renderStats(s.stat,s.total,s.allUnread);
    renderTeamProgress(s.stat,s.total);
    /* ── 注入 agentStats 到成员卡片 ── */
    if(s.agentStats){
      (s.members||[]).forEach(function(m){
        m.agentStats=s.agentStats[m.agent]||null;
      });
    }
    renderMembers(s.members,s.captainSummary||null);
    renderInbox(s.inbox);
    renderShared(s.sharedMemory);
    renderNotes(s.notes);
    renderOverview(s.agentOverview);
    if(dagView==='tree'){renderTree(selectedWorkflow(s),s.captainSummary||null)}
    else{renderDAG(activeDag(s));}
    renderWorkflows(s.workflows);
    syncControllerSelect(s.controller,s.controllerCandidates,s.controllerLabel);
    document.getElementById('ts').textContent='· '+new Date().toLocaleTimeString('zh-CN')
  }catch(e){document.getElementById('ts').textContent='· SSE 异常: '+String(e)}
}
/* ── 实时刷新：SSE 主推 + 低频轮询兜底 ── */
var lastState=null;
function applyState(s){lastState=s;renderFromState(s)}
function sseConnect(){
  if(window.__es)window.__es.close();
  var es=new EventSource('/events');
  window.__es=es;
  es.addEventListener('state',function(ev){applyState(JSON.parse(ev.data))});
  es.onerror=function(){
    document.getElementById('ts').textContent='· SSE 重连中…';
    /* EventSource 内建自动重连；此处只提示状态。 */
  };
}
sseConnect();
fetch('/api/state',{cache:'no-store'}).then(function(r){return r.json()}).then(applyState).catch(function(){});
/* 兜底轮询：SSE 万一漏变（如 watch 被占用），30s 拉全量对账。 */
setInterval(function(){
  fetch('/api/state',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){applyState(s)}).catch(function(){});
},30000);
/* URL 快捷视图：?view=tree 加载即切树状（也便于无头诊断） */
if(location.search.indexOf('view=tree')!==-1)dagSwitch('tree');else dagSwitch('dag');
/* ── 工具函数 ── */
function msFmt(ms){
  if(ms<1000)return ms+'ms';
  if(ms<60000)return Math.round(ms/1000)+'s';
  if(ms<3600000)return Math.round(ms/60000)+'分'+Math.round((ms%60000)/1000)+'秒';
  return Math.round(ms/3600000)+'时'+Math.round((ms%3600000)/60000)+'分';
}
function msFmtShort(ms){
  if(ms<1000)return '';
  if(ms<60000)return Math.round(ms/1000)+'s';
  if(ms<3600000)return Math.round(ms/60000)+'分';
  return Math.round(ms/3600000)+'时';
}
function showTaskById(id){
  for(var i=0;i<allTasks.length;i++){if(allTasks[i]&&allTasks[i].id===id){showTaskDetail(i);return}}
}
function exportState(){
  var btn=document.querySelector('.export-btn');
  btn.textContent='导出中…';
  fetch('/api/state',{cache:'no-store'}).then(function(r){return r.json()}).then(function(data){
    var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a');
    a.href=url;a.download='multi-agent-state-'+new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')+'.json';
    document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
    btn.textContent='导出';
  }).catch(function(){btn.textContent='导出失败';setTimeout(function(){btn.textContent='导出'},2000);});
}
/* ── 主题切换（深色/浅色，）── data-theme="light" 覆盖 :root；localStorage 持久化；按钮图标同步。 */
function syncThemeBtn(){
  var isLight=document.documentElement.getAttribute('data-theme')==='light';
  var b=document.getElementById('themeBtn');
  if(b)b.textContent=isLight?'☀':'🌙';
}
function toggleTheme(){
  var isLight=document.documentElement.getAttribute('data-theme')==='light';
  if(isLight){document.documentElement.removeAttribute('data-theme');try{localStorage.setItem('ma-theme','dark')}catch(e){}}
  else{document.documentElement.setAttribute('data-theme','light');try{localStorage.setItem('ma-theme','light')}catch(e){}}
  syncThemeBtn();
}
syncThemeBtn(); /* 初始图标与早期 anti-flash 脚本设定的 data-theme 对齐 */
/* ── 搜索过滤 ── */
var searchDebounce=null;
document.getElementById('search').addEventListener('input',function(){
  if(searchDebounce)clearTimeout(searchDebounce);
  searchDebounce=setTimeout(function(){if(lastState)renderFromState(lastState)},200);
});
/* ── 主控切换 ── */
document.getElementById('controller').addEventListener('change',function(){
  var val=this.value;
  fetch('/api/controller',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({controller:val})})
    .then(function(r){return r.json()})
    .then(function(){if(lastState)renderFromState(lastState)})
    .catch(function(){});
});
</script>
</body>
</html>`;

/* ── SSE 实时推送 ─────────────────────────────────────────────────── */
// 用 fs.watch 监听 memory.json 变更，broadcast() 重算 buildState 推给所有已连 EventSource。
// 变更可能突发（多个 worker 同时写），去抖 250ms 合并。心跳每 25s 保持连接。
const sseClients = new Set();
let sseTimer = null, ssePending = false;
function broadcast() {
  ssePending = true;
  if (sseTimer) return;
  sseTimer = setTimeout(() => {
    sseTimer = null;
    if (!ssePending) return;
    ssePending = false;
    if (sseClients.size === 0) return;
    let body;
    try { body = JSON.stringify(buildState()); }
    catch (e) { console.error('broadcast buildState error:', e); return; }
    const frame = `event: state\ndata: ${body}\n\n`;
    for (const cl of sseClients) {
      try { cl.write(frame); }
      catch { sseClients.delete(cl); }
    }
  }, 250);
}

/* ── HTTP 服务器 ──────────────────────────────────────────────────── */
const server = createServer((req, res) => {
  let _url = req.url || '/';
  if (_url.indexOf('?') !== -1) _url = _url.slice(0, _url.indexOf('?'));
  if (_url !== req.url) req.query = new URL(req.url, 'http://127.0.0.1').searchParams; // 保留查询参数（含 ?view=tree）
  if (_url === '/events') {
    // SSE:保持长连接，memory 变化经 broadcast() 推送。首帧立即发一次当前状态。
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
    });
    res.write(`event: state\ndata: ${JSON.stringify(buildState())}\n\n`);
    sseClients.add(res);
    res.on('close', () => sseClients.delete(res));
    return;
  }
  if (_url === '/health') {
    // 轻量健康检查：不读 memory.json，只报服务存活 + 时间戳 + 端口。
    // 供外部监控/负载均衡探活，避免靠 /api/state 大响应判断存活。
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, status: 'healthy', ts: new Date().toISOString(), port: PORT }));
    return;
  }
  if (_url === '/api/state') {
    try {
      const body = JSON.stringify(buildState());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) {
      console.error('buildState error:', e);
      res.writeHead(500); res.end(JSON.stringify({ error: String(e.stack || e) }));
    }
    return;
  }
  if (_url === '/api/stats') {
    try {
      /* ── bridge_stats 精简版：从 memory.json 计算 ── */
      const mem = readMemory();
      const rawTasks = Object.values(mem.tasks || {});
      const stats = {};
      Object.entries(mem.tasks || {}).forEach(([id, t]) => {
        const who = t.claimed_by || t.assigned_to;
        if (!who) return;
        if (!stats[who]) stats[who] = { total: 0, ok: 0, fail: 0, retries: 0, timeout: 0, succRate: 0, avgMs: 0 };
        const s = stats[who];
        s.total++;
        if (t.status === 'completed') s.ok++;
        else if (t.status === 'failed') s.fail++;
        if (t.retries && t.retries.length) s.retries += t.retries.length;
        if (t.retries && t.retries.some(r => r.reason === 'timeout')) s.timeout++;
        s.succRate = s.total > 0 ? Math.round((s.ok / s.total) * 100) : 0;
      });
      /* 平均耗时 */
      rawTasks.forEach((t) => {
        const who = t.claimed_by || t.assigned_to;
        if (!who || !stats[who] || !t.duration || t.duration <= 0) return;
        const s = stats[who];
        if (!s._durSum) s._durSum = 0;
        s._durCount = (s._durCount || 0) + 1;
        s._durSum += t.duration;
        s.avgMs = s._durCount > 0 ? Math.round(s._durSum / s._durCount) : 0;
      });
      delete stats._durSum;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(stats));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  /* ──  可编辑动作写端：面板升为写入端。复用 state-store 同锁 updateMem，与 MCP server 语义一致。 ── */
  if (_url === '/api/action' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const args = JSON.parse(body || '{}');
        const action = args.action || '';
        const result = panelDoAction(action, args);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        if (result.ok) { ssePending = true; setTimeout(broadcast, 250); }  // 写后立即推新状态
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }
  if (_url === '/api/controller' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { controller } = JSON.parse(body || '{}');
        const ok = saveController(controller);
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok, controller: ok ? controller : readController() }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }
  /* ── 任务派发端点：POST /api/run ─────────────────────────────── */
  if (_url === '/api/run' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const args = JSON.parse(body || '{}');
        const { worker, prompt, model, session } = args;
        
        if (!worker || !prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'worker and prompt required' }));
          return;
        }
        
        // 动态导入 run-driver 以避免循环依赖
        const { runAgent } = await import('./run-driver.mjs');
        const result = await runAgent(worker, {
          prompt,
          model,
          session_id: session,
        });
        
        if (!result) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `worker "${worker}" not found` }));
          return;
        }
        
        // 从结果中提取 taskId（runAgent 返回的对象包含 task_id）
        const taskId = result.task_id || result.taskId;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ taskId, status: 'queued' }));
      } catch (err) {
        console.error('[api/run] error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  if (_url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(HTML);
    return;
  }
  res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Bridge Web Panel running at http://127.0.0.1:${PORT}`);
  console.log(`Data source: ${MEM_FILE}`);
  console.log('Press Ctrl+C to stop');
});

/* 监听 memory.json 变更 → 推送 SSE。atomic rename 也能被 fs.watch 捕获。 */
try {
  watch(MEM_FILE, () => broadcast());
} catch (e) {
  console.warn('fs.watch unavailable, falling back to client polling:', e.message);
}

/* SSE 心跳：保持连接不被中间层断开；无数据时每 25s 发一次注释帧。 */
setInterval(() => {
  if (sseClients.size === 0) return;
  const hb = `: ping ${Date.now()}\n\n`;
  for (const cl of sseClients) { try { cl.write(hb); } catch { sseClients.delete(cl); } }
}, 25000);
