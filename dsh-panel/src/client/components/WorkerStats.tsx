import React from 'react';

interface WorkerStatus {
  name: string;
  healthy: boolean;
  lastHeartbeat: string;
  model?: string;
}

interface WorkerStatsProps {
  workers: WorkerStatus[];
}

export function WorkerStats({ workers }: WorkerStatsProps) {
  if (workers.length === 0) {
    return <p style={{ color: '#999' }}>未检测到 Worker</p>;
  }

  return (
    <div style={{ marginBottom: '20px' }}>
      <h3>Worker 状态</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
        {workers.map(worker => (
          <div key={worker.name} style={{
            padding: '12px',
            borderRadius: '6px',
            background: worker.healthy ? '#e8f5e9' : '#ffebee',
            border: `2px solid ${worker.healthy ? '#4caf50' : '#f44336'}`
          }}>
            <div style={{ fontWeight: 'bold', marginBottom: '5px' }}>{worker.name}</div>
            <div style={{ fontSize: '12px', color: '#666' }}>
              {worker.healthy ? '✓ 健康' : '✗ 异常'}
            </div>
            {worker.model && <div style={{ fontSize: '11px' }}>Model: {worker.model}</div>}
            <div style={{ fontSize: '10px', color: '#999', marginTop: '5px' }}>
              Last heartbeat: {new Date(worker.lastHeartbeat).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
