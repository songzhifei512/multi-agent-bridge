import React, { useState } from 'react';
import type { BridgeState } from 'bridge-ui';
import TeamProgress from './TeamProgress';

interface LeftColumnProps {
  state: BridgeState | null;
  expandedMembers: Set<string>;
  onToggleMember: (agent: string) => void;
}

const STATUS_COLOR: Record<string, string> = {
  completed: 'var(--ok, #22c55e)',
  running: 'var(--run, #3b82f6)',
  failed: 'var(--err, #ef4444)',
  pending: 'var(--pend, #eab308)',
};

interface CollapsibleSectionProps {
  title: string;
  count: number;
  children: React.ReactNode;
}

function CollapsibleSection({ title, count, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="collapse-section">
      <div className="collapse-header" onClick={() => setOpen((v) => !v)}>
        <span className={`collapse-chevron${open ? ' open' : ''}`}>▸</span>
        <span>{title}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--dim, #44445a)' }}>{count}</span>
      </div>
      {open && <div className="collapse-body">{children}</div>}
    </div>
  );
}

const LeftColumn: React.FC<LeftColumnProps> = ({ state, expandedMembers, onToggleMember }) => {
  const stat = state?.stat || {};
  const total = state?.total ?? 0;
  const members = state?.members || [];
  const captainSummary = state?.captainSummary;
  const inbox = state?.inbox || [];
  const allUnread = state?.allUnread ?? 0;
  const sharedMemory = state?.sharedMemory || [];
  const notes = state?.notes || [];

  return (
    <div className="web-left">
      {/* Team Progress */}
      <TeamProgress stat={stat} total={total} />

      {/* Members */}
      <div className="web-card">
        <div className="web-card-title">成员 ({members.length})</div>
        {members.map((m: any) => {
          const isExpanded = expandedMembers.has(m.agent);
          const isCaptain = m.agent === state?.controller;
          const grad = m.grad && Array.isArray(m.grad) && m.grad.length >= 2
            ? `linear-gradient(135deg, ${m.grad[0]}, ${m.grad[1]})`
            : 'linear-gradient(135deg, #6366f1, #4338ca)';
          const initial = (m.label || m.agent).charAt(0).toUpperCase();

          return (
            <div key={m.agent}>
              <div
                className="member-row-compact"
                onClick={() => onToggleMember(m.agent)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onToggleMember(m.agent);
                  }
                }}
              >
                <span className="member-avatar" style={{ background: grad }}>
                  {initial}
                </span>
                <span className="member-name">
                  {isCaptain && <span className="captain-marker">👑 </span>}
                  {m.agent}
                </span>
                <span
                  className={`member-status-dot ${m.activity === 'working' ? 'working' : 'idle'}`}
                />
              </div>

              {isExpanded && (
                <div className="member-expand">
                  {/* Progress bar */}
                  <div className="member-progress-bar">
                    <div
                      className="member-progress-fill"
                      style={{ width: `${m.progress || 0}%` }}
                    />
                  </div>
                  {/* Stats */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '6px' }}>
                    <span className="member-stat">
                      完成 <b style={{ color: 'var(--ok, #22c55e)' }}>{m.done}</b>
                    </span>
                    <span className="member-stat">
                      运行 <b style={{ color: 'var(--run, #3b82f6)' }}>{m.running}</b>
                    </span>
                    <span className="member-stat">
                      失败 <b style={{ color: 'var(--err, #ef4444)' }}>{m.failed}</b>
                    </span>
                    <span className="member-stat">
                      认领 <b>{m.claimed}</b>
                    </span>
                  </div>
                  {/* Last 2 tasks */}
                  {(m.taskList || []).slice(0, 2).map((t: any) => (
                    <div
                      key={t.id}
                      style={{
                        fontSize: '10px',
                        color: 'var(--mut, #6b6b80)',
                        padding: '2px 0',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-block',
                          width: '6px',
                          height: '6px',
                          borderRadius: '50%',
                          background: STATUS_COLOR[t.status] || 'var(--dim, #44445a)',
                          marginRight: '4px',
                        }}
                      />
                      {t.title}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Collapsible sections */}
      <CollapsibleSection title="收件箱" count={allUnread}>
        {inbox.length === 0 ? (
          <div>无消息</div>
        ) : (
          inbox.slice(0, 5).map((box: any) => (
            <div key={box.agent}>
              <b>{box.agent}</b>: {box.msgs.filter((m: any) => !m.consumed).length} unread /{' '}
              {box.msgs.length} total
            </div>
          ))
        )}
      </CollapsibleSection>

      <CollapsibleSection title="共享记忆" count={sharedMemory.length}>
        {sharedMemory.length === 0 ? (
          <div>无共享记忆</div>
        ) : (
          sharedMemory.slice(0, 10).map((kv: any) => (
            <div key={kv.key}>
              <b>{kv.key}</b>: {kv.value}
            </div>
          ))
        )}
      </CollapsibleSection>

      <CollapsibleSection title="笔记" count={notes.length}>
        {notes.length === 0 ? (
          <div>无笔记</div>
        ) : (
          notes.slice(0, 6).map((n: any, i: number) => (
            <div key={i}>
              {typeof n === 'string' ? n : n.text || n.note || JSON.stringify(n)}
            </div>
          ))
        )}
      </CollapsibleSection>
    </div>
  );
};

export default LeftColumn;
