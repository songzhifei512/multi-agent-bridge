# Multi-Agent Bridge 控制台面板 UI 优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 dsh-panel 从 4-Tab 结构重构为 Fusion View（融合视图），实现一屏全局、层次清晰、主题自适应的侧边栏控制台。

**Architecture:** 移除 Tab 导航，以工作流卡片为主体，任务内联到卡片中。新增 StickyHeader（连接状态 + 全局统计）、WorkflowCard（进度 + 内联任务 + DAG）、FAB + DispatchOverlay（就近派发）、Toast（操作反馈）。CSS 全面使用 custom properties 支持暗色/浅色双主题。

**Tech Stack:** React 18 + TypeScript, CSS custom properties, SSE + polling (useBridgeState hook)

**Spec:** `docs/superpowers/specs/2026-09-21-ui-optimization-design.md`

## Global Constraints

- 面板宽度固定 320px（侧边栏约束）
- 不修改后端（bridge-web-panel.mjs）、不修改 useBridgeState hook、不修改 API 契约
- 所有颜色通过 CSS custom properties 定义，支持 `[data-theme="light"]` 切换
- 所有 SVG fill/stroke 使用 CSS 变量，不硬编码颜色
- 组件 CSS class 沿用 `ma-` 前缀命名空间
- 字体：UI 用系统字体栈，等宽用 `ui-monospace, SFMono-Regular, Consolas, monospace`

---

### Task 1: 重写 styles.ts — 新视觉设计系统

**Files:**
- Modify: `src/client/styles.ts` (full rewrite, 164 lines → ~220 lines)

**Interfaces:**
- Consumes: 无（纯 CSS 字符串）
- Produces: `injectStyles()` 函数（签名不变），所有 `ma-*` class 名保持或新增

- [ ] **Step 1: 替换 CSS 变量定义块**

将现有 `:root` 变量替换为新的暗色主题 token，并新增 `[data-theme="light"]` 块。

替换 `styles.ts` 中 CSS 字符串的开头部分（从 `.ma-root{` 到 `font-size:13px; line-height:1.45;`），改为：

```css
.ma-root{
  /* 暗色主题（默认） */
  --bg:#0a0a0f; --card:#12121a; --hover:#1a1a26;
  --border:#1e1e2e; --border2:#2a2a3e;
  --txt:#e4e4ed; --mut:#6b6b80; --dim:#44445a;
  --acc:#6366f1; --ok:#22c55e; --run:#3b82f6; --pend:#eab308; --err:#ef4444;
  --overlay-bg:rgba(5,5,10,.7);
  --shadow-panel:0 0 60px rgba(99,102,241,.06), 0 0 0 1px rgba(255,255,255,.03) inset;
  --fab-shadow:0 4px 16px rgba(99,102,241,.35);
  --fab-shadow-hover:0 6px 24px rgba(99,102,241,.5);
  --dag-node-fill:#12121a; --dag-edge:#44445a;
  --dag-text-done:#6b6b80; --dag-text-active:#e4e4ed;
  --toast-bg:rgba(34,197,94,.12); --toast-border:rgba(34,197,94,.3); --toast-color:#86efac;
  --radius:10px; --radius-sm:6px;
  color-scheme:dark;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  background:var(--bg); color:var(--txt);
  height:100%; display:flex; flex-direction:column; font-size:13px; line-height:1.45;
  transition:background .3s, color .3s;
}
.ma-root[data-theme="light"]{
  --bg:#f5f6fa; --card:#ffffff; --hover:#eef0f5;
  --border:#e2e4ea; --border2:#d0d3dc;
  --txt:#1a1a2e; --mut:#6b7080; --dim:#9ca0ad;
  --acc:#4f46e5; --ok:#16a34a; --run:#2563eb; --pend:#ca8a04; --err:#dc2626;
  --overlay-bg:rgba(0,0,0,.3);
  --shadow-panel:0 1px 3px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.04) inset;
  --fab-shadow:0 4px 12px rgba(79,70,229,.25);
  --fab-shadow-hover:0 6px 20px rgba(79,70,229,.35);
  --dag-node-fill:#ffffff; --dag-edge:#c0c4d0;
  --dag-text-done:#9ca0ad; --dag-text-active:#1a1a2e;
  --toast-bg:rgba(22,163,74,.1); --toast-border:rgba(22,163,74,.3); --toast-color:#16a34a;
  color-scheme:light;
}
```

- [ ] **Step 2: 替换滚动条和全局过渡样式**

在 CSS 变量块之后，添加：

```css
.ma-root *{box-sizing:border-box}
.ma-root ::-webkit-scrollbar{width:6px;height:6px}
.ma-root ::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}
.ma-root ::-webkit-scrollbar-track{background:transparent}
```

- [ ] **Step 3: 替换 Sticky Header 样式**

替换原来的 `.ma-top` 相关样式：

```css
.ma-header{position:sticky;top:0;z-index:10;background:var(--bg);padding:14px 14px 10px;border-bottom:1px solid var(--border);transition:background .3s, border-color .3s}
.ma-header-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.ma-header-title{font-size:13px;font-weight:600;flex:1}
.ma-ctrl{font-size:10px;color:var(--mut);background:var(--card);border:1px solid var(--border);border-radius:999px;padding:2px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%;transition:background .3s, border-color .3s, color .3s}
.ma-conn{width:7px;height:7px;border-radius:50%;background:var(--dim);flex-shrink:0;transition:background .3s}
.ma-conn.on{background:var(--ok);box-shadow:0 0 6px var(--ok)}
.ma-stats-row{display:flex;gap:5px;flex-wrap:wrap}
.ma-stat{display:flex;align-items:baseline;gap:4px;padding:2px 8px;border-radius:999px;background:var(--card);border:1px solid var(--border);font-size:10px;color:var(--mut);transition:background .3s, border-color .3s, color .3s}
.ma-stat b{font-size:12px;font-weight:600}
.ma-stat.run b{color:var(--run)} .ma-stat.pend b{color:var(--pend)} .ma-stat.ok b{color:var(--ok)} .ma-stat.err b{color:var(--err)}
```

- [ ] **Step 4: 替换工作流卡片样式**

替换原来的 `.ma-wf` 系列样式：

```css
.ma-wf{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);overflow:hidden;margin-bottom:8px;transition:background .3s, border-color .3s}
.ma-wf-head{display:flex;align-items:center;gap:7px;padding:10px 12px;cursor:pointer;user-select:none;transition:background .15s}
.ma-wf-head:hover{background:var(--hover)}
.ma-wf-dot{width:7px;height:7px;border-radius:50%;background:var(--dim);flex-shrink:0;transition:background .3s}
.ma-wf-dot.running{background:var(--run);box-shadow:0 0 5px var(--run)}
.ma-wf-dot.completed{background:var(--ok)} .ma-wf-dot.failed{background:var(--err)}
.ma-wf-name{font-size:12px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-wf-dots{display:flex;gap:3px;flex-shrink:0}
.ma-wf-dots i{width:6px;height:6px;border-radius:50%;display:block}
.ma-wf-count{font-size:10px;color:var(--mut);white-space:nowrap;flex-shrink:0}
.ma-wf-chev{font-size:10px;color:var(--dim);flex-shrink:0;transition:color .3s}
.ma-wf-done-line{padding:7px 12px}
.ma-wf-done-line .ma-wf-head{padding:6px 12px}
.ma-prog{display:flex;height:2px;margin:0 12px 8px;border-radius:1px;overflow:hidden;background:var(--border)}
.ma-prog i{display:block;height:100%;transition:width .3s}
.ma-prog i.ok{background:var(--ok)} .ma-prog i.run{background:var(--run)}
.ma-prog i.pend{background:var(--pend)} .ma-prog i.err{background:var(--err)}
```

- [ ] **Step 5: 添加任务行样式**

新增（替换原来的 `.ma-tchip` 系列）：

```css
.ma-task{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:var(--radius-sm);font-size:11px;transition:background .15s}
.ma-task:hover{background:var(--hover)}
.ma-task-icon{width:14px;height:14px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px;flex-shrink:0;border:1.5px solid transparent;transition:background .3s, border-color .3s}
.ma-task-icon.completed{background:var(--ok);color:#fff;border-color:var(--ok)}
.ma-task-icon.running{background:var(--run);border-color:var(--run);box-shadow:0 0 4px rgba(59,130,246,.4)}
.ma-task-icon.pending{background:transparent;border-color:var(--pend)}
.ma-task-icon.failed{background:var(--err);color:#fff;border-color:var(--err)}
.ma-task-icon.waiting{background:transparent;border-color:var(--dim)}
.ma-task-tid{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;font-weight:600;color:var(--acc);width:20px;flex-shrink:0}
.ma-task-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-task-title.done{color:var(--mut)}
.ma-task-who{font-size:10px;color:var(--dim);white-space:nowrap;flex-shrink:0}
```

- [ ] **Step 6: 添加 DAG 切换和容器样式**

新增（替换原来的 `.ma-dagwrap` 系列）：

```css
.ma-dag-toggle{font-size:10px;color:var(--mut);cursor:pointer;padding:4px 12px;user-select:none;transition:color .15s}
.ma-dag-toggle:hover{color:var(--txt)}
.ma-dag-wrap{overflow:hidden;max-height:0;transition:max-height .25s ease-out}
.ma-dag-wrap.open{max-height:400px}
.ma-dag-inner{overflow-x:auto;border-top:1px solid var(--border);background:var(--bg);padding:8px;transition:background .3s, border-color .3s}
svg.ma-dag{display:block}
.ma-dag-edge{stroke:var(--dag-edge);stroke-width:1.5;fill:none;opacity:.75}
.ma-dag-node{fill:var(--dag-node-fill);stroke:var(--dag-edge);stroke-width:1.5}
.ma-dag-node.stk-running{stroke:var(--run)} .ma-dag-node.stk-completed{stroke:var(--ok)}
.ma-dag-node.stk-failed{stroke:var(--err)} .ma-dag-node.stk-pending{stroke:var(--pend)}
.ma-dag-node.stk-awaiting_approval,.ma-dag-node.stk-escalating{stroke:var(--pend)}
.ma-dag-node.stk-superseded,.ma-dag-node.stk-cancelled,.ma-dag-node.stk-interrupted{stroke:var(--dim)}
.ma-dag-txt{fill:var(--txt);font-size:9px}
.ma-dag-txt.tid{fill:var(--acc);font-weight:700}
.ma-dag-evolve{fill:var(--pend);font-size:8px}
```

- [ ] **Step 7: 添加 FAB、Overlay、Toast 样式**

新增（替换原来的 `.ma-form` 系列）：

```css
.ma-fab{position:absolute;bottom:16px;right:16px;width:40px;height:40px;border-radius:50%;background:var(--acc);color:#fff;border:none;font-size:20px;font-weight:300;cursor:pointer;z-index:20;box-shadow:var(--fab-shadow);transition:transform .15s, box-shadow .3s, background .3s}
.ma-fab:hover{transform:scale(1.08);box-shadow:var(--fab-shadow-hover)}
.ma-fab:active{transform:scale(.95)}
.ma-overlay-mask{position:absolute;inset:0;background:var(--overlay-bg);backdrop-filter:blur(4px);z-index:25;opacity:0;pointer-events:none;transition:opacity .25s}
.ma-overlay-mask.open{opacity:1;pointer-events:auto}
.ma-dispatch{position:absolute;bottom:0;left:0;right:0;z-index:30;background:var(--card);border-top:1px solid var(--border);border-radius:12px 12px 0 0;padding:14px;display:flex;flex-direction:column;gap:8px;transform:translateY(100%);transition:transform .25s ease-out, background .3s, border-color .3s}
.ma-dispatch.open{transform:translateY(0)}
.ma-dispatch-head{display:flex;align-items:center;justify-content:space-between}
.ma-dispatch-head h4{margin:0;font-size:12px;font-weight:600}
.ma-dispatch-close{background:none;border:none;color:var(--mut);font-size:16px;cursor:pointer;padding:0 4px}
.ma-dispatch-close:hover{color:var(--txt)}
.ma-dispatch select,.ma-dispatch textarea{background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius-sm);color:var(--txt);padding:7px 9px;font-size:12px;font-family:inherit;outline:none;width:100%;transition:background .3s, border-color .3s, color .3s}
.ma-dispatch select:focus,.ma-dispatch textarea:focus{border-color:var(--acc)}
.ma-dispatch textarea{resize:vertical;min-height:72px}
.ma-dispatch label{font-size:10px;color:var(--mut);display:flex;flex-direction:column;gap:4px}
.ma-dispatch-btn{appearance:none;border:none;border-radius:8px;background:var(--acc);color:#fff;font-size:12px;font-weight:600;padding:8px 14px;cursor:pointer;width:100%;transition:background .3s}
.ma-dispatch-btn:hover{filter:brightness(1.1)}
.ma-dispatch-btn:disabled{background:var(--border2);color:var(--mut);cursor:not-allowed}
.ma-toast{position:absolute;top:12px;left:12px;right:12px;z-index:40;background:var(--toast-bg);border:1px solid var(--toast-border);color:var(--toast-color);border-radius:var(--radius-sm);padding:8px 12px;font-size:11px;display:flex;align-items:center;gap:6px;transform:translateY(-120%);opacity:0;transition:transform .25s ease-out, opacity .25s}
.ma-toast.show{transform:translateY(0);opacity:1}
```

- [ ] **Step 8: 添加分区标题和辅助样式**

新增：

```css
.ma-section{font-size:10px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;padding:8px 4px 4px}
.ma-empty{color:var(--dim);font-size:12px;padding:8px 0;text-align:center}
.ma-body{flex:1;overflow-y:auto;padding:0 12px 56px;position:relative}
```

- [ ] **Step 9: 删除不再需要的旧样式**

从 CSS 字符串中移除以下 class 的全部定义：`.ma-top`, `.ma-top h1`, `.ma-dot`（旧版）, `.ma-ctrl`（旧版，已被新的替代）, `.ma-stats`（旧版）, `.ma-chip`（旧版）, `.ma-tabs`, `.ma-tab`, `.ma-wf-head`（旧版）, `.ma-wf-title`（旧版）, `.ma-badge` 系列, `.ma-seg` 系列, `.ma-lanes` 系列, `.ma-tchip` 系列, `.ma-depsec` 系列, `.ma-mem` 系列, `.ma-form` 系列, `.ma-btn`, `.ma-err`, `.ma-ok`, `.ma-mini-btn`, `.ma-task`（旧版 TaskList 的）, `.ma-pre`, `.ma-kv`, `.ma-log` 系列, `.ma-archived` 系列, `.ma-arch-btn`。

- [ ] **Step 10: 验证样式注入**

确认 `injectStyles()` 函数签名不变：

```typescript
let injected = false;
export function injectStyles() {
  if (injected || typeof document === 'undefined') return;
  const el = document.createElement('style');
  el.setAttribute('data-ma-panel', '');
  el.textContent = CSS;
  document.head.appendChild(el);
  injected = true;
}
```

- [ ] **Step 11: Commit**

```bash
git add src/client/styles.ts
git commit -m "feat(ui): rewrite styles.ts with new design system (dark/light themes)"
```

---

### Task 2: 创建 StickyHeader 组件

**Files:**
- Create: `src/client/components/StickyHeader.tsx`

**Interfaces:**
- Consumes: `stat: Record<string, number>`, `connected: boolean`, `controller?: string`, `controllerLabel?: string`
- Produces: `<StickyHeader />` React 组件

- [ ] **Step 1: 创建 StickyHeader.tsx**

```tsx
import React from 'react';

interface StickyHeaderProps {
  stat: Record<string, number>;
  connected: boolean;
  controller?: string;
  controllerLabel?: string;
}

export function StickyHeader({ stat, connected, controller, controllerLabel }: StickyHeaderProps) {
  return (
    <div className="ma-header">
      <div className="ma-header-row">
        <span className={`ma-conn ${connected ? 'on' : ''}`} />
        <span className="ma-header-title">Multi-Agent</span>
        <span className="ma-ctrl" title={`controller: ${controller || '?'}`}>
          {controllerLabel || controller || '—'}
        </span>
      </div>
      <div className="ma-stats-row">
        <span className="ma-stat run"><b>{stat.running || 0}</b>运行</span>
        <span className="ma-stat pend"><b>{stat.pending || 0}</b>待领</span>
        <span className="ma-stat ok"><b>{stat.completed || 0}</b>完成</span>
        <span className="ma-stat err"><b>{stat.failed || 0}</b>失败</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/components/StickyHeader.tsx
git commit -m "feat(ui): add StickyHeader component"
```

---

### Task 3: 创建 TaskRow 组件

**Files:**
- Create: `src/client/components/TaskRow.tsx`

**Interfaces:**
- Consumes: `step: Step` (from WorkflowView), `shortId: string`, `isBlocked: boolean`
- Produces: `<TaskRow />` 内联任务行组件

- [ ] **Step 1: 创建 TaskRow.tsx**

```tsx
import React from 'react';

interface Step {
  step: string;
  id: string;
  status: string;
  claimed_by?: string;
  assigned_to?: string;
}

interface TaskRowProps {
  step: Step;
  shortId: string;
  isBlocked: boolean;
}

const ICON_CHAR: Record<string, string> = {
  completed: '✓',
  failed: '✗',
  running: '▶',
};

function statusClass(status: string, isBlocked: boolean): string {
  if (isBlocked && status === 'pending') return 'waiting';
  return status;
}

export function TaskRow({ step, shortId, isBlocked }: TaskRowProps) {
  const cls = statusClass(step.status, isBlocked);
  const who = step.claimed_by || step.assigned_to || '';
  const isDone = step.status === 'completed';

  return (
    <div className="ma-task">
      <span className={`ma-task-icon ${cls}`}>
        {ICON_CHAR[cls] || ''}
      </span>
      <span className="ma-task-tid">{shortId}</span>
      <span className={`ma-task-title${isDone ? ' done' : ''}`} title={step.step}>
        {step.step}
      </span>
      <span className="ma-task-who">
        {who || (step.status === 'pending' ? '待领取' : '')}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/components/TaskRow.tsx
git commit -m "feat(ui): add TaskRow component for inline task display"
```

---

### Task 4: 创建 InlineDag 组件

**Files:**
- Create: `src/client/components/InlineDag.tsx`

**Interfaces:**
- Consumes: `dag: Dag` (from DagGraph), `shorts: Map<string, string>`
- Produces: `<InlineDag />` 可折叠的 DAG 依赖图

- [ ] **Step 1: 创建 InlineDag.tsx**

复用现有 `DagGraph.tsx` 中的 `Dag`, `DagNode`, `DagEdge` 类型和 SVG 渲染逻辑，但包裹在可折叠容器中。

```tsx
import React, { useState } from 'react';

interface DagNode {
  id: string;
  x: number;
  y: number;
  status: string;
  title: string;
  assignee: string | null;
  dependencies: string[];
  evolve: string | null;
}
interface DagEdge {
  from: string;
  to: string;
  path: string;
}
interface Dag {
  width: number;
  height: number;
  nodes: DagNode[];
  edges: DagEdge[];
  stages: number;
}

const NODE_W = 150;
const NODE_H = 34;

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function InlineDag({ dag, shorts }: { dag: Dag; shorts: Map<string, string> }) {
  const [open, setOpen] = useState(false);

  if (!dag || !dag.nodes || dag.nodes.length === 0) return null;

  return (
    <>
      <div className="ma-dag-toggle" onClick={() => setOpen(v => !v)}>
        {open ? '▾' : '▸'} {open ? '收起依赖图' : '查看依赖图'}
      </div>
      <div className={`ma-dag-wrap${open ? ' open' : ''}`}>
        <div className="ma-dag-inner">
          <svg
            className="ma-dag"
            width={dag.width}
            height={dag.height}
            viewBox={`0 0 ${dag.width} ${dag.height}`}
          >
            {dag.edges.map(e => (
              <path key={`${e.from}->${e.to}`} d={e.path} className="ma-dag-edge" />
            ))}
            {dag.nodes.map(n => (
              <g key={n.id} transform={`translate(${n.x},${n.y})`}>
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={5}
                  className={`ma-dag-node stk-${n.status}`}
                />
                <text x={8} y={14} className="ma-dag-txt tid">
                  {shorts.get(n.id) || n.id}
                </text>
                <text x={8} y={27} className="ma-dag-txt">
                  {truncate(n.title || '', 16)}
                </text>
                {n.evolve && (
                  <text x={NODE_W - 8} y={14} className="ma-dag-evolve" textAnchor="end">
                    {n.evolve === 'fork' ? 'fork' : 'repoint'}
                  </text>
                )}
              </g>
            ))}
          </svg>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/components/InlineDag.tsx
git commit -m "feat(ui): add InlineDag component with collapsible DAG visualization"
```

---

### Task 5: 创建 WorkflowCard 组件

**Files:**
- Create: `src/client/components/WorkflowCard.tsx`

**Interfaces:**
- Consumes: `wf: Workflow`, `memberLabel: (agent: string) => string`, `isActive: boolean`
- Produces: `<WorkflowCard />` 工作流卡片（含内联 TaskRow 和 InlineDag）

- [ ] **Step 1: 创建 WorkflowCard.tsx**

```tsx
import React, { useMemo, useState } from 'react';
import { TaskRow } from './TaskRow';
import { InlineDag } from './InlineDag';

interface Step {
  step: string;
  id: string;
  status: string;
  claimed_by?: string;
  assigned_to?: string;
  evolve?: string | null;
}
interface Dag {
  width: number;
  height: number;
  nodes: any[];
  edges: any[];
  stages: number;
}
interface Workflow {
  key: string;
  title: string;
  tpl: string;
  paradigm: string | null;
  total: number;
  done: number;
  running: number;
  failed: number;
  pending: number;
  steps: Step[];
  dag?: Dag;
}

const MET = new Set(['completed', 'superseded', 'cancelled']);

function paradigmLabel(p: string | null, tpl: string): string | null {
  if (p === 'compete') return '竞争式';
  if (p === 'collaborate') return '合作式';
  if (tpl === 'virtual') return '并行簇';
  return null;
}

export function WorkflowCard({
  wf,
  memberLabel,
  isActive,
}: {
  wf: Workflow;
  memberLabel: (agent: string) => string;
  isActive: boolean;
}) {
  const [open, setOpen] = useState(isActive);

  const shorts = useMemo(() => {
    const m = new Map<string, string>();
    wf.steps.forEach((s, i) => m.set(s.id, 't' + (i + 1)));
    return m;
  }, [wf.steps]);

  const nodeById = useMemo(() => {
    const m = new Map<string, any>();
    (wf.dag?.nodes || []).forEach((n: any) => m.set(n.id, n));
    return m;
  }, [wf.dag]);

  const unmetDeps = (id: string): string[] => {
    const n = nodeById.get(id);
    if (!n) return [];
    return (n.dependencies || []).filter((d: string) => !MET.has(nodeById.get(d)?.status || ''));
  };

  // 收集参与成员
  const memberSet = useMemo(() => {
    const s = new Set<string>();
    wf.steps.forEach(st => {
      const a = st.claimed_by || st.assigned_to;
      if (a) s.add(a);
    });
    return s;
  }, [wf.steps]);

  // 进度分段
  let blocked = 0;
  let unclaimed = 0;
  for (const s of wf.steps) {
    if (s.status === 'pending' && unmetDeps(s.id).length > 0) blocked++;
    else if (s.status === 'pending' && !s.claimed_by) unclaimed++;
  }

  const segments = [
    { n: wf.done, cls: 'ok' },
    { n: wf.running, cls: 'run' },
    { n: blocked, cls: 'pend' },
    { n: unclaimed, cls: 'pend' },
    { n: wf.failed, cls: 'err' },
  ].filter(s => s.n > 0);

  const mainDot = wf.running > 0 ? 'running' : wf.failed > 0 ? 'failed' : 'completed';

  if (!open && !isActive) {
    // 折叠态（已完成工作流）
    return (
      <div className="ma-wf ma-wf-done-line">
        <div className="ma-wf-head" onClick={() => setOpen(true)}>
          <span className={`ma-wf-dot ${mainDot}`} />
          <span className="ma-wf-name">{wf.title}</span>
          <span className="ma-wf-count">{wf.done}/{wf.total}</span>
          <span className="ma-wf-chev">▸</span>
        </div>
      </div>
    );
  }

  return (
    <div className="ma-wf">
      <div className="ma-wf-head" onClick={() => setOpen(v => !v)}>
        <span className={`ma-wf-dot ${mainDot}`} />
        <span className="ma-wf-name">{wf.title}</span>
        <span className="ma-wf-dots">
          {[...memberSet].map(a => (
            <i key={a} title={memberLabel(a) || a} style={{ background: 'var(--acc)' }} />
          ))}
        </span>
        {paradigmLabel(wf.paradigm, wf.tpl) && (
          <span className="ma-wf-count">{paradigmLabel(wf.paradigm, wf.tpl)}</span>
        )}
        <span className="ma-wf-count">{wf.done}/{wf.total}</span>
        <span className="ma-wf-chev">{open ? '▾' : '▸'}</span>
      </div>

      {segments.length > 0 && (
        <div className="ma-prog">
          {segments.map((s, i) => (
            <i key={i} className={s.cls} style={{ width: `${(s.n / wf.total) * 100}%` }} />
          ))}
        </div>
      )}

      {open && (
        <>
          <div style={{ padding: '2px 6px 6px', display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: 320, overflowY: 'auto' }}>
            {wf.steps.map(s => (
              <TaskRow
                key={s.id}
                step={s}
                shortId={shorts.get(s.id) || s.id}
                isBlocked={s.status === 'pending' && unmetDeps(s.id).length > 0}
              />
            ))}
          </div>
          {wf.dag && <InlineDag dag={wf.dag} shorts={shorts} />}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/components/WorkflowCard.tsx
git commit -m "feat(ui): add WorkflowCard component with inline tasks and DAG"
```

---

### Task 6: 创建 DispatchOverlay + FAB + Toast

**Files:**
- Create: `src/client/components/DispatchOverlay.tsx`

**Interfaces:**
- Consumes: `workers: string[]`, `onDispatch: (worker: string, prompt: string) => Promise<string | undefined>`, `open: boolean`, `onClose: () => void`, `onDispatched: (worker: string, taskId?: string) => void`
- Produces: `<DispatchOverlay />` + `<FAB />` + `<Toast />`（均在此文件中）

- [ ] **Step 1: 创建 DispatchOverlay.tsx**

```tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';

/* ── FAB ── */
export function FAB({ onClick }: { onClick: () => void }) {
  return (
    <button className="ma-fab" onClick={onClick} title="派发任务">
      ＋
    </button>
  );
}

/* ── Toast ── */
export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    // trigger enter animation
    const t1 = requestAnimationFrame(() => setShow(true));
    const t2 = window.setTimeout(() => {
      setShow(false);
      window.setTimeout(onDone, 300);
    }, 2500);
    return () => {
      cancelAnimationFrame(t1);
      clearTimeout(t2);
    };
  }, [onDone]);

  return (
    <div className={`ma-toast${show ? ' show' : ''}`}>
      ✓ {message}
    </div>
  );
}

/* ── Dispatch Overlay ── */
interface DispatchOverlayProps {
  workers: string[];
  open: boolean;
  onClose: () => void;
  onDispatch: (worker: string, prompt: string) => Promise<string | undefined>;
  onDispatched: (worker: string, taskId?: string) => void;
}

export function DispatchOverlay({
  workers,
  open,
  onClose,
  onDispatch,
  onDispatched,
}: DispatchOverlayProps) {
  const [worker, setWorker] = useState('');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const effectiveWorker = worker || workers[0] || '';

  useEffect(() => {
    if (open) {
      setWorker('');
      setPrompt('');
      setError(null);
      setTimeout(() => textareaRef.current?.focus(), 260);
    }
  }, [open]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!prompt.trim() || !effectiveWorker) return;
      setLoading(true);
      setError(null);
      try {
        const taskId = await onDispatch(effectiveWorker, prompt.trim());
        onDispatched(effectiveWorker, taskId);
        setPrompt('');
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : '派发失败');
      } finally {
        setLoading(false);
      }
    },
    [prompt, effectiveWorker, onDispatch, onDispatched, onClose],
  );

  return (
    <>
      <div className={`ma-overlay-mask${open ? ' open' : ''}`} onClick={onClose} />
      <div className={`ma-dispatch${open ? ' open' : ''}`}>
        <div className="ma-dispatch-head">
          <h4>派发任务</h4>
          <button className="ma-dispatch-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label>
            Worker
            <select value={effectiveWorker} onChange={e => setWorker(e.target.value)}>
              {workers.length === 0 && <option value="">（无可用 worker）</option>}
              {workers.map(w => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </label>
          <label>
            Prompt
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="输入要执行的任务…"
            />
          </label>
          {error && <div style={{ color: 'var(--err)', fontSize: '11px' }}>{error}</div>}
          <button
            className="ma-dispatch-btn"
            type="submit"
            disabled={loading || !prompt.trim() || !effectiveWorker}
          >
            {loading ? '派发中…' : '派发任务'}
          </button>
        </form>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/components/DispatchOverlay.tsx
git commit -m "feat(ui): add DispatchOverlay with FAB and Toast components"
```

---

### Task 7: 重写 index.tsx — 组合新组件树

**Files:**
- Modify: `src/client/index.tsx` (full rewrite, 85 lines → ~90 lines)

**Interfaces:**
- Consumes: `useBridgeState()`, all new components
- Produces: `BridgeConsoleTab` 默认导出（签名不变）

- [ ] **Step 1: 重写 index.tsx**

完全替换文件内容：

```tsx
import React, { useCallback, useState } from 'react';
import { useBridgeState } from './hooks/useBridgeState';
import { injectStyles } from './styles';
import { StickyHeader } from './components/StickyHeader';
import { WorkflowCard } from './components/WorkflowCard';
import { FAB, DispatchOverlay, Toast } from './components/DispatchOverlay';

export default function BridgeConsoleTab() {
  injectStyles();
  const { state, connected } = useBridgeState();
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const stat = state?.stat || {};
  const workflows = state?.workflows?.list || [];

  // 分为活跃和已完成两组
  const active = workflows.filter(
    w => !w.archived && (w.running > 0 || w.pending > 0 || w.failed > 0),
  );
  const completed = workflows.filter(
    w => !w.archived && w.running === 0 && w.pending === 0 && w.failed === 0,
  );

  const memberLabel = useCallback(
    (agent: string) =>
      state?.members?.find((m: any) => m.agent === agent)?.label || '',
    [state?.members],
  );

  const handleDispatch = useCallback(
    async (worker: string, prompt: string) => {
      const res = await fetch('/bridge/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker, prompt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data?.taskId as string | undefined;
    },
    [],
  );

  const handleDispatched = useCallback((worker: string, taskId?: string) => {
    setToast(`已派发 → ${worker}`);
  }, []);

  return (
    <div className="ma-root">
      <StickyHeader
        stat={stat}
        connected={connected}
        controller={state?.controller}
        controllerLabel={state?.controllerLabel}
      />

      <div className="ma-body">
        {active.length === 0 && completed.length === 0 && (
          <div className="ma-empty">当前没有活动工作流</div>
        )}

        {active.length > 0 && (
          <>
            <div className="ma-section">进行中 ({active.length})</div>
            {active.map(wf => (
              <WorkflowCard
                key={wf.key}
                wf={wf}
                memberLabel={memberLabel}
                isActive={true}
              />
            ))}
          </>
        )}

        {completed.length > 0 && (
          <>
            <div className="ma-section">已完成 ({completed.length})</div>
            {completed.map(wf => (
              <WorkflowCard
                key={wf.key}
                wf={wf}
                memberLabel={memberLabel}
                isActive={false}
              />
            ))}
          </>
        )}

        <FAB onClick={() => setDispatchOpen(true)} />

        <DispatchOverlay
          workers={state?.workers || []}
          open={dispatchOpen}
          onClose={() => setDispatchOpen(false)}
          onDispatch={handleDispatch}
          onDispatched={handleDispatched}
        />

        {toast && (
          <Toast message={toast} onDone={() => setToast(null)} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/index.tsx
git commit -m "feat(ui): rewrite index.tsx with Fusion View (no tabs)"
```

---

### Task 8: 清理旧组件

**Files:**
- Delete: `src/client/components/WorkflowView.tsx`
- Delete: `src/client/components/TaskList.tsx`
- Delete: `src/client/components/MembersView.tsx`
- Delete: `src/client/components/DispatchForm.tsx`
- Keep: `src/client/components/DagGraph.tsx`（InlineDag 独立实现，但 DagGraph 保留供其他引用）

- [ ] **Step 1: 检查旧组件是否被其他文件引用**

```bash
grep -r "WorkflowView\|TaskList\|MembersView\|DispatchForm" src/ --include="*.ts" --include="*.tsx" -l
```

预期输出：仅 `src/client/index.tsx`（旧版 import 已被 Task 7 替换）。如果还有其他引用，需先移除。

- [ ] **Step 2: 删除旧组件文件**

```bash
rm src/client/components/WorkflowView.tsx
rm src/client/components/TaskList.tsx
rm src/client/components/MembersView.tsx
rm src/client/components/DispatchForm.tsx
```

- [ ] **Step 3: 确认 TypeScript 编译通过**

```bash
npx tsc --noEmit
```

预期：无错误。如果有类型错误，根据报错修复。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove obsolete tab-based components"
```

---

### Task 9: 构建验证与视觉检查

**Files:**
- 无新文件

- [ ] **Step 1: 完整构建**

```bash
npm run build
```

预期：构建成功，无错误。

- [ ] **Step 2: 启动开发服务器并视觉检查**

启动面板后，检查以下项目：

1. Sticky Header 正确显示连接状态和 4 个 stat chip
2. 工作流分为"进行中"和"已完成"两个分区
3. 活跃工作流默认展开，显示进度条 + 内联任务列表
4. 已完成工作流默认折叠，点击可展开
5. 任务行显示状态图标 + 短 ID + 标题 + 负责人
6. DAG 依赖图可通过点击切换显示/隐藏
7. FAB 按钮在右下角，点击弹出派发 overlay
8. 派发 overlay 从底部滑入，点击遮罩或 ✕ 关闭
9. 派发成功后 Toast 从顶部滑入，2.5s 后自动消失
10. 所有颜色通过 CSS 变量控制，无硬编码颜色泄漏

- [ ] **Step 3: 主题切换验证**

在浏览器控制台执行：

```js
document.querySelector('.ma-root').setAttribute('data-theme', 'light');
```

检查：
- 背景变为浅灰 #f5f6fa
- 卡片变为白色
- 文字变为深色
- 状态色加深（ok → #16a34a, run → #2563eb 等）
- DAG SVG 节点和连线颜色跟随变化
- 过渡动画平滑（300ms）

再执行：

```js
document.querySelector('.ma-root').removeAttribute('data-theme');
```

确认恢复暗色主题。

- [ ] **Step 4: 响应式检查**

在 320px 宽度下检查：
- 无水平溢出
- 文字截断正常（工作流名称、任务标题）
- FAB 不遮挡最后一条内容（底部 56px padding）
- 滚动条为 6px 窄条

- [ ] **Step 5: 最终 Commit**

```bash
git add -A
git commit -m "feat(ui): UI optimization complete — Fusion View with dark/light themes"
```
