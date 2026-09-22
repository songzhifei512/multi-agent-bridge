import React, { useMemo, useState } from 'react';
import { TaskRow, InlineDag } from 'bridge-ui';

interface RightColumnProps {
  wf: any | null;
  memberLabel: (agent: string) => string;
  memberInitial: (agent: string) => string;
  memberGrad: (agent: string) => string;
  onClose: () => void;
  onDispatch: (wfKey: string) => void;
  onArchive: (wfKey: string) => void;
  onUnarchive: (wfKey: string) => void;
}

type ViewMode = 'dag' | 'tree';

const DOT_COLOR: Record<string, string> = {
  running: 'var(--run, #3b82f6)',
  failed: 'var(--err, #ef4444)',
  completed: 'var(--ok, #22c55e)',
  pending: 'var(--pend, #eab308)',
};

function paradigmLabel(p: string | null, tpl: string): string | null {
  if (p === 'compete') return '竞争式';
  if (p === 'collaborate') return '合作式';
  if (tpl === 'virtual') return '并行簇';
  return null;
}

function fmtTime(ts: any): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDur(ms: any): string {
  if (!ms) return '';
  const s = Math.round(Number(ms) / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  return `${Math.floor(m / 60)}时${m % 60}分`;
}

const RightColumn: React.FC<RightColumnProps> = ({
  wf,
  memberLabel,
  memberInitial,
  memberGrad,
  onClose,
  onDispatch,
  onArchive,
  onUnarchive,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('dag');
  const [dagOpen, setDagOpen] = useState(true);

  // Build shorts map for DAG/TaskRow: task id -> t1, t2, ...
  const shorts = useMemo(() => {
    if (!wf) return new Map<string, string>();
    const m = new Map<string, string>();
    (wf.steps || []).forEach((s: any, i: number) => m.set(s.id, 't' + (i + 1)));
    return m;
  }, [wf]);

  // Build member set from steps
  const memberSet = useMemo(() => {
    if (!wf) return new Set<string>();
    const s = new Set<string>();
    (wf.steps || []).forEach((st: any) => {
      const a = st.claimed_by || st.assigned_to;
      if (a) s.add(a);
    });
    return s;
  }, [wf]);

  // Compute blocked tasks for TaskRow
  const nodeById = useMemo(() => {
    if (!wf?.dag) return new Map<string, any>();
    const m = new Map<string, any>();
    (wf.dag.nodes || []).forEach((n: any) => m.set(n.id, n));
    return m;
  }, [wf]);

  const unmetDeps = (id: string): string[] => {
    const n = nodeById.get(id);
    if (!n) return [];
    const MET = new Set(['completed', 'superseded', 'cancelled']);
    return (n.dependencies || []).filter((d: string) => !MET.has(nodeById.get(d)?.status || ''));
  };

  if (!wf) {
    return (
      <div className="web-right">
        <div className="right-empty">📋 选择一个工作流查看详情</div>
      </div>
    );
  }

  const total = wf.total || (wf.steps || []).length || 1;
  const segments = [
    { n: wf.done || 0, color: 'var(--ok, #22c55e)' },
    { n: wf.running || 0, color: 'var(--run, #3b82f6)' },
    { n: wf.pending || 0, color: 'var(--pend, #eab308)' },
    { n: wf.failed || 0, color: 'var(--err, #ef4444)' },
  ].filter((s) => s.n > 0);

  const pLabel = paradigmLabel(wf.paradigm, wf.tpl);
  const isArchived = wf.archived || wf.manualArchived;

  const toggleDag = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDagOpen((v) => !v);
  };

  return (
    <div className="web-right">
      {/* Header */}
      <div className="right-header">
        <span
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background:
              wf.running > 0
                ? 'var(--run, #3b82f6)'
                : wf.failed > 0
                  ? 'var(--err, #ef4444)'
                  : 'var(--ok, #22c55e)',
            flexShrink: 0,
          }}
        />
        <span className="right-title">{wf.title}</span>
        {pLabel && <span className="wf-badge">{pLabel}</span>}
        <button
          className="right-close"
          onClick={onClose}
          aria-label="关闭详情面板"
          title="关闭"
        >
          ✕
        </button>
      </div>

      {/* Progress */}
      <div>
        <div className="wf-compact-prog" style={{ height: '8px' }}>
          {segments.map((s, i) => (
            <i
              key={i}
              style={{ width: `${(s.n / total) * 100}%`, background: s.color }}
            />
          ))}
        </div>
        <div className="right-stat-row">
          <span>
            <b className="stat-completed">{wf.done || 0}</b> 完成
          </span>
          <span>
            <b className="stat-running">{wf.running || 0}</b> 运行
          </span>
          <span>
            <b className="stat-pending">{wf.pending || 0}</b> 待领
          </span>
          <span>
            <b className="stat-failed">{wf.failed || 0}</b> 失败
          </span>
        </div>
      </div>

      {/* View toggle: DAG / Tree */}
      <div className="right-view-toggle">
        <button
          className={`right-view-btn${viewMode === 'dag' ? ' active' : ''}`}
          onClick={() => setViewMode('dag')}
        >
          DAG
        </button>
        <button
          className={`right-view-btn${viewMode === 'tree' ? ' active' : ''}`}
          onClick={() => setViewMode('tree')}
        >
          树状
        </button>
      </div>

      {/* Task list / DAG */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {viewMode === 'dag' ? (
          <>
            {/* DAG view: InlineDag embedded, then task list below */}
            {wf.dag && wf.dag.nodes && wf.dag.nodes.length > 0 ? (
              <div style={{ marginBottom: '8px' }}>
                <InlineDag
                  dag={wf.dag}
                  shorts={shorts}
                  embedded
                  open={dagOpen}
                  onToggle={toggleDag}
                />
              </div>
            ) : null}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
              }}
            >
              {(wf.steps || []).map((s: any) => (
                <TaskRow
                  key={s.id}
                  step={s}
                  shortId={shorts.get(s.id) || s.id}
                  isBlocked={s.status === 'pending' && unmetDeps(s.id).length > 0}
                />
              ))}
            </div>
          </>
        ) : (
          /* Tree timeline */
          <div className="tree-timeline">
            {(wf.steps || []).map((s: any) => (
              <div key={s.id} className="tree-node">
                <span
                  className={`tree-dot ${DOT_COLOR[s.status] ? s.status : 'other'}`}
                  style={
                    !DOT_COLOR[s.status]
                      ? { background: 'var(--dim, #44445a)' }
                      : undefined
                  }
                />
                <div className="tree-content">
                  <div className="tree-step-title">{s.step}</div>
                  <div className="tree-step-meta">
                    {shorts.get(s.id) || s.id}
                    {s.claimed_by || s.assigned_to
                      ? ` · ${memberLabel(s.claimed_by || s.assigned_to)}`
                      : ' · 待领取'}
                    {s.completed_at && ` · ${fmtTime(s.completed_at)}`}
                    {s.duration && ` · ${fmtDur(s.duration)}`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Members */}
      <div>
        <div className="web-card-title">参与成员 ({memberSet.size})</div>
        <div className="right-members">
          {[...memberSet].map((a) => (
            <span key={a} className="right-member-chip">
              <span
                className="member-avatar"
                style={{
                  width: '16px',
                  height: '16px',
                  fontSize: '8px',
                  background: memberGrad(a),
                }}
              >
                {memberInitial(a)}
              </span>
              {memberLabel(a) || a}
            </span>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="right-actions">
        <button
          className="right-action-btn primary"
          onClick={() => onDispatch(wf.key)}
        >
          派发任务
        </button>
        {isArchived ? (
          <button
            className="right-action-btn"
            onClick={() => onUnarchive(wf.key)}
          >
            恢复
          </button>
        ) : (
          <button
            className="right-action-btn"
            onClick={() => onArchive(wf.key)}
          >
            归档
          </button>
        )}
      </div>
    </div>
  );
};

export default RightColumn;
