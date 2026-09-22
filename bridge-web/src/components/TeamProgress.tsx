import React from 'react';

interface TeamProgressProps {
  stat: Record<string, number>;
  total: number;
}

const TeamProgress: React.FC<TeamProgressProps> = ({ stat, total }) => {
  const completed = stat.completed || 0;
  const running = stat.running || 0;
  const pending = stat.pending || 0;
  const failed = stat.failed || 0;

  const segments = [
    { n: completed, color: 'var(--ok, #22c55e)', label: '完成' },
    { n: running, color: 'var(--run, #3b82f6)', label: '运行' },
    { n: pending, color: 'var(--pend, #eab308)', label: '待领' },
    { n: failed, color: 'var(--err, #ef4444)', label: '失败' },
  ].filter((s) => s.n > 0);

  const tipText = segments.map((s) => `${s.label}: ${s.n}`).join(' / ');

  return (
    <div className="web-card">
      <div className="web-card-title">团队整体进度</div>
      {total > 0 ? (
        <div style={{ marginBottom: '6px' }}>
          <div
            className="wf-compact-prog"
            style={{ height: '8px' }}
            title={tipText}
          >
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
      ) : (
        <div
          className="wf-compact-prog"
          style={{ height: '8px', background: 'var(--border2, #2a2a3e)' }}
        />
      )}
      <div style={{ fontSize: '11px', color: 'var(--mut, #6b6b80)' }}>
        完成 <b style={{ color: 'var(--ok, #22c55e)' }}>{completed}</b> / 总{' '}
        <b>{total}</b>
      </div>
    </div>
  );
};

export default TeamProgress;
