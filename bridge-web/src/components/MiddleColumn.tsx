import React, { useMemo } from 'react';
import type { BridgeState } from 'bridge-ui';
import { WorkflowCard, ArchSection } from 'bridge-ui';

interface MiddleColumnProps {
  state: BridgeState | null;
  selectedWfKey: string | null;
  onSelectWf: (key: string) => void;
  collapsedSections: { running: boolean; done: boolean; archived: boolean };
  onToggleSection: (key: string) => void;
  memberLabel: (agent: string) => string;
}

// Paradigm badge label
function paradigmLabel(p: string | null, tpl: string): string | null {
  if (p === 'compete') return '竞争式';
  if (p === 'collaborate') return '合作式';
  if (tpl === 'virtual') return '并行簇';
  return null;
}

// Status color for progress segments
function wfMainDot(running: number, failed: number, done: number): string {
  if (running > 0) return 'running';
  if (failed > 0) return 'failed';
  if (done > 0) return 'completed';
  return 'pending';
}

const DOT_COLOR: Record<string, string> = {
  running: 'var(--run, #3b82f6)',
  failed: 'var(--err, #ef4444)',
  completed: 'var(--ok, #22c55e)',
  pending: 'var(--pend, #eab308)',
};

// Compact card rendered in list; full WorkflowCard is used for selected item
function CompactWfCard({
  wf,
  selected,
  onSelect,
  memberLabel,
}: {
  wf: any;
  selected: boolean;
  onSelect: () => void;
  memberLabel: (agent: string) => string;
}) {
  const total = wf.total || 1;
  const segments = [
    { n: wf.done || 0, color: 'var(--ok, #22c55e)' },
    { n: wf.running || 0, color: 'var(--run, #3b82f6)' },
    { n: wf.pending || 0, color: 'var(--pend, #eab308)' },
    { n: wf.failed || 0, color: 'var(--err, #ef4444)' },
  ].filter((s) => s.n > 0);

  // Build member set from steps
  const memberSet = new Set<string>();
  (wf.steps || []).forEach((s: any) => {
    const a = s.claimed_by || s.assigned_to;
    if (a) memberSet.add(a);
  });

  const pLabel = paradigmLabel(wf.paradigm, wf.tpl);
  const dotType = wfMainDot(wf.running || 0, wf.failed || 0, wf.done || 0);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <div
      className={`wf-compact${selected ? ' selected' : ''}`}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      {/* Row 1: title + badges */}
      <div className="wf-compact-row1">
        <span
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: DOT_COLOR[dotType],
            flexShrink: 0,
          }}
        />
        <span className="wf-compact-title">{wf.title}</span>
        {pLabel && <span className="wf-badge">{pLabel}</span>}
        {wf.tpl && wf.tpl !== 'ad-hoc' && wf.tpl !== 'adhoc' && (
          <span className="wf-badge" style={{ opacity: 0.7 }}>
            {wf.tpl}
          </span>
        )}
        <span style={{ fontSize: '10px', color: 'var(--mut, #6b6b80)', flexShrink: 0 }}>
          {wf.done}/{wf.total}
        </span>
      </div>

      {/* Row 2: progress bar */}
      <div className="wf-compact-row2">
        <div className="wf-compact-prog">
          {segments.map((s, i) => (
            <i
              key={i}
              style={{
                width: `${(s.n / total) * 100}%`,
                background: s.color,
              }}
            />
          ))}
        </div>
      </div>

      {/* Row 3: metadata + member dots */}
      <div className="wf-compact-row3">
        <span>{(wf.steps || []).length} 步</span>
        {wf.failed > 0 && (
          <span style={{ color: 'var(--err, #ef4444)' }}>失败 {wf.failed}</span>
        )}
        <span className="wf-member-dots">
          {[...memberSet].slice(0, 4).map((a, i) => (
            <span
              key={a}
              className="wf-member-dot"
              title={memberLabel(a) || a}
              style={{
                background: 'linear-gradient(135deg, #6366f1, #4338ca)',
                marginLeft: i === 0 ? 0 : -5,
              }}
            >
              {(memberLabel(a) || a).charAt(0).toUpperCase()}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

const MiddleColumn: React.FC<MiddleColumnProps> = ({
  state,
  selectedWfKey,
  onSelectWf,
  collapsedSections,
  onToggleSection,
  memberLabel,
}) => {
  const workflows = state?.workflows || { list: [], other: 0 };

  const { runningWfs, doneWfs, archivedWfs } = useMemo(() => {
    const list = workflows.list || [];
    const running: any[] = [];
    const done: any[] = [];
    const archived: any[] = [];

    for (const w of list) {
      // Check if workflow has any active tasks
      const nonTerminal =
        (w.running || 0) + (w.pending || 0) + (w.escalating || 0) + (w.awaiting_approval || 0);

      if (w.archived || w.manualArchived) {
        archived.push(w);
      } else if (nonTerminal > 0) {
        running.push(w);
      } else {
        done.push(w);
      }
    }
    return { runningWfs: running, doneWfs: done, archivedWfs: archived };
  }, [workflows]);

  const otherCount = workflows.other || 0;

  return (
    <div className="web-center">
      {/* Running workflows */}
      {runningWfs.length > 0 && (
        <>
          <div
            className="wf-section-title"
            onClick={() => onToggleSection('running')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggleSection('running');
              }
            }}
          >
            <span className={`chev${!collapsedSections.running ? ' open' : ''}`}>▸</span>
            <span>进行中</span>
            <span className="count">{runningWfs.length}</span>
          </div>
          {!collapsedSections.running && (
            <div className="wf-section-list">
              {runningWfs.map((wf) =>
                selectedWfKey === wf.key ? (
                  <WorkflowCard
                    key={wf.key}
                    wf={wf}
                    memberLabel={memberLabel}
                    isActive={true}
                  />
                ) : (
                  <CompactWfCard
                    key={wf.key}
                    wf={wf}
                    selected={false}
                    onSelect={() => onSelectWf(wf.key)}
                    memberLabel={memberLabel}
                  />
                ),
              )}
            </div>
          )}
        </>
      )}

      {/* Done workflows */}
      {doneWfs.length > 0 && (
        <ArchSection
          title="已完成"
          count={doneWfs.length}
          collapsed={collapsedSections.done}
          onToggle={() => onToggleSection('done')}
        >
          {doneWfs.map((wf) =>
            selectedWfKey === wf.key ? (
              <WorkflowCard
                key={wf.key}
                wf={wf}
                memberLabel={memberLabel}
                isActive={true}
              />
            ) : (
              <CompactWfCard
                key={wf.key}
                wf={wf}
                selected={false}
                onSelect={() => onSelectWf(wf.key)}
                memberLabel={memberLabel}
              />
            ),
          )}
        </ArchSection>
      )}

      {/* Archived workflows */}
      {archivedWfs.length > 0 && (
        <ArchSection
          title="已归档"
          count={archivedWfs.length}
          collapsed={collapsedSections.archived}
          onToggle={() => onToggleSection('archived')}
        >
          <div className="wf-section-list archived">
            {archivedWfs.map((wf) => (
              <CompactWfCard
                key={wf.key}
                wf={wf}
                selected={selectedWfKey === wf.key}
                onSelect={() => onSelectWf(wf.key)}
                memberLabel={memberLabel}
              />
            ))}
          </div>
        </ArchSection>
      )}

      {/* Empty state */}
      {runningWfs.length === 0 && doneWfs.length === 0 && archivedWfs.length === 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1,
            color: 'var(--mut, #6b6b80)',
            fontSize: '13px',
          }}
        >
          {otherCount > 0
            ? `${otherCount} 个单发任务`
            : '暂无工作流 — 点击右下角 ＋ 派发任务'}
        </div>
      )}
    </div>
  );
};

export default MiddleColumn;
