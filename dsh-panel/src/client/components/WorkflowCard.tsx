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
