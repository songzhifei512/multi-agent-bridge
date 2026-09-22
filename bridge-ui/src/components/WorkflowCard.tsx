import React, { useMemo, useState } from 'react';
import { TaskRow } from './TaskRow';
import { InlineDag } from './InlineDag';
import * as S from '../inlineStyles';

interface Step {
  step: string;
  id: string;
  status: string;
  claimed_by?: string;
  assigned_to?: string;
  evolve?: string | null;
  created_at?: any;
  completed_at?: any;
  duration?: any;
  progress?: string[];
  hb?: any;
  heartbeat_n?: number;
  live?: any;
  result?: any;
  exit_code?: any;
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
  archived?: boolean;
  manualArchived?: boolean;
}

const MET = new Set(['completed', 'superseded', 'cancelled']);

/* 成员点颜色：按 agent 名散列到调色板，多成员时一眼可分（原全部 #6366f1 无区分度） */
const DOT_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#3b82f6', '#ec4899', '#14b8a6'];
function dotColor(agent: string): string {
  let h = 0;
  for (let i = 0; i < agent.length; i++) h = (h * 31 + agent.charCodeAt(i)) >>> 0;
  return DOT_COLORS[h % DOT_COLORS.length];
}

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
  onArchive,
  onUnarchive,
  onRetry,
  dataFrozen,
}: {
  wf: Workflow;
  memberLabel: (agent: string) => string;
  isActive: boolean;
  onArchive?: (wf: Workflow) => void;
  onUnarchive?: (wf: Workflow) => void;
  /** 心跳停滞时的任务重试回调 */
  onRetry?: (stepId: string) => Promise<void>;
  /** 离线缓存快照：冻结心跳时效判断 */
  dataFrozen?: boolean;
}) {
  const [open, setOpen] = useState(isActive);
  const [busy, setBusy] = useState(false);
  const [dagOpen, setDagOpen] = useState(false);
  const [progHover, setProgHover] = useState(false);
  const [archHover, setArchHover] = useState(false);

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

  const memberSet = useMemo(() => {
    const s = new Set<string>();
    wf.steps.forEach(st => {
      const a = st.claimed_by || st.assigned_to;
      if (a) s.add(a);
    });
    return s;
  }, [wf.steps]);

  let blocked = 0;
  let unclaimed = 0;
  for (const s of wf.steps) {
    if (s.status === 'pending' && unmetDeps(s.id).length > 0) blocked++;
    else if (s.status === 'pending' && !s.claimed_by) unclaimed++;
  }

  const segments = [
    { n: wf.done, color: 'var(--ok, #22c55e)', label: '完成' },
    { n: wf.running, color: 'var(--run, #3b82f6)', label: '运行' },
    { n: unclaimed, color: 'var(--pend, #eab308)', label: '待领取' },
    { n: blocked, color: 'var(--dim, #7d7d94)', label: '等依赖' },
    { n: wf.failed, color: 'var(--err, #ef4444)', label: '失败' },
  ].filter(s => s.n > 0);

  const mainDot = wf.running > 0 ? 'running' : wf.failed > 0 ? 'failed' : 'completed';

  const runAction = async (e: React.MouseEvent, fn?: (w: Workflow) => void) => {
    e.stopPropagation();
    if (!fn || busy) return;
    setBusy(true);
    try { await fn(wf); } finally { setBusy(false); }
  };

  const toggleDag = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDagOpen(v => !v);
  };

  // 进度条 tooltip 文字
  const progTipText = segments.map(s => `${s.label}: ${s.n}`).join(' / ');

  // 手动归档的工作流 → 紧凑行 + 恢复按钮
  if (wf.manualArchived) {
    return (
      <div style={S.archLine}>
        <span style={S.wfDotStatus(mainDot)} />
        <span style={{ ...S.wfName, fontSize: 11 }}>{wf.title}</span>
        <span style={S.wfCount}>{wf.done}/{wf.total}</span>
        {onUnarchive && (
          <button style={S.restoreBtn} onClick={e => runAction(e, onUnarchive)} disabled={busy}>
            {busy ? '…' : '恢复'}
          </button>
        )}
      </div>
    );
  }

  if (!open && !isActive) {
    return (
      <div style={S.wf}>
        <div style={S.wfHead} onClick={() => setOpen(true)}>
          <span style={S.wfDotStatus(mainDot)} />
          <span style={S.wfName}>{wf.title}</span>
          <span style={S.wfCount}>{wf.done}/{wf.total}</span>
          {wf.dag && (
            <button
              style={S.dagIconBtn}
              onClick={toggleDag}
              title="查看依赖图"
            >
              📊
            </button>
          )}
          {onArchive && (
            <button style={archHover ? S.archBtnHover : S.archBtn} onClick={e => runAction(e, onArchive)} disabled={busy}
              onMouseEnter={() => setArchHover(true)} onMouseLeave={() => setArchHover(false)}>
              {busy ? '…' : '归档'}
            </button>
          )}
          <span style={S.wfChev}>▸</span>
        </div>
        {wf.dag && dagOpen && (
          <div style={S.dagInner}>
            <InlineDag dag={wf.dag} shorts={shorts} embedded open={dagOpen} onToggle={toggleDag} frozen={dataFrozen} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={S.wf}>
      <div style={S.wfHead} onClick={() => setOpen(v => !v)}>
        <span style={S.wfDotStatus(mainDot)} />
        <span style={S.wfName}>{wf.title}</span>
        <span style={S.wfDots}>
          {[...memberSet].map(a => (
            <i key={a} title={memberLabel(a) || a} style={{ width: '6px', height: '6px', borderRadius: '50%', display: 'block', background: dotColor(a) }} />
          ))}
        </span>
        {paradigmLabel(wf.paradigm, wf.tpl) && (
          <span style={S.wfCount}>{paradigmLabel(wf.paradigm, wf.tpl)}</span>
        )}
        <span style={S.wfCount}>{wf.done}/{wf.total}</span>
        {wf.dag && (
          <button
            style={dagOpen ? S.dagIconBtnActive : S.dagIconBtn}
            onClick={toggleDag}
            title={dagOpen ? '收起依赖图' : '查看依赖图'}
            className="ma-dag-icon-btn"
          >
            📊
          </button>
        )}
        {onArchive && (
          <button style={archHover ? S.archBtnHover : S.archBtn} onClick={e => runAction(e, onArchive)} disabled={busy}
            onMouseEnter={() => setArchHover(true)} onMouseLeave={() => setArchHover(false)}>
            {busy ? '…' : '归档'}
          </button>
        )}
        <span style={S.wfChev}>{open ? '▾' : '▸'}</span>
      </div>

      {segments.length > 0 && (
        <div style={S.progWrap} className="ma-prog-wrap"
          onMouseEnter={() => setProgHover(true)} onMouseLeave={() => setProgHover(false)}>
          <div style={S.prog}>
            {segments.map((s, i) => (
              <i key={i} style={{ display: 'block', height: '100%', width: `${(s.n / wf.total) * 100}%`, background: s.color }} />
            ))}
          </div>
          <div style={{ ...S.progTip, opacity: progHover ? 1 : 0, transition: 'opacity .15s', pointerEvents: 'none' }} className="ma-prog-tip">
            {progTipText}
          </div>
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
                onRetry={dataFrozen ? undefined : onRetry}
                dataFrozen={dataFrozen}
              />
            ))}
          </div>
          {wf.dag && dagOpen && <InlineDag dag={wf.dag} shorts={shorts} embedded open={dagOpen} onToggle={toggleDag} frozen={dataFrozen} />}
        </>
      )}
    </div>
  );
}

/**
 * 归档分区标题 + 可折叠列表容器
 * 折叠状态由父组件管理（符合需求：状态在 App 或工作流列表组件中管理）
 */
export function ArchSection({
  title,
  count,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div
        className={`ma-arch-section${collapsed ? ' collapsed' : ''}`}
        style={S.archSection}
        onClick={onToggle}
      >
        <span style={collapsed ? S.archChevCollapsed : S.archChev} className="ma-arch-chev">▾</span>
        <span>{title}</span>
        {count !== undefined && <span>({count})</span>}
      </div>
      <div
        className={`ma-arch-list${collapsed ? ' collapsed' : ''}`}
        style={collapsed ? S.archListCollapsed : S.archList}
      >
        {children}
      </div>
    </>
  );
}
