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
