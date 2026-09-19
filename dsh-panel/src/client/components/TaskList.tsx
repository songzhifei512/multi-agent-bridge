import React from 'react';

interface Task {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress?: number;
  worker?: string;
  createdAt?: string;
}

interface TaskListProps {
  tasks: Task[];
}

export function TaskList({ tasks }: TaskListProps) {
  if (tasks.length === 0) {
    return <p style={{ color: '#999' }}>暂无任务</p>;
  }

  const statusColor = (status: Task['status']) => {
    switch (status) {
      case 'queued': return '#ffa500';
      case 'running': return '#4caf50';
      case 'completed': return '#2196f3';
      case 'failed': return '#f44336';
      default: return '#999';
    }
  };

  return (
    <div style={{ marginBottom: '20px' }}>
      <h3>任务列表 ({tasks.length})</h3>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {tasks.map(task => (
          <li key={task.id} style={{
            padding: '10px',
            marginBottom: '8px',
            borderLeft: `4px solid ${statusColor(task.status)}`,
            background: '#f5f5f5'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>{task.id}</strong>
              <span style={{ color: statusColor(task.status) }}>{task.status}</span>
            </div>
            {task.worker && <div>Worker: {task.worker}</div>}
            {task.progress !== undefined && (
              <div style={{ marginTop: '5px' }}>
                <progress value={task.progress} max={100} style={{ width: '100%' }} />
                <span>{task.progress}%</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
