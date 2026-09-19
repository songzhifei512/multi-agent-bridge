import React, { useState, useEffect } from 'react';
import { useSessionFilter } from './hooks/useSessionFilter';
import { useSSESubscription } from './hooks/useSSESubscription';
import { TaskList } from './components/TaskList';
import { WorkerStats } from './components/WorkerStats';
import { DispatchForm } from './components/DispatchForm';
import { EventStream } from './components/EventStream';

interface Task {
  id: string;
  status: string;
  progress?: number;
  session?: string;
  [key: string]: any;
}

interface WorkerStatus {
  name: string;
  healthy: boolean;
  lastHeartbeat: string;
}

// 模拟从 DSH context 获取 session ID
function useDSHSession() {
  // 实际实现需要从 DSH 的 React context 或 global state 读取
  return 'current-session-id';
}

export default function BridgeConsoleTab() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workers, setWorkers] = useState<WorkerStatus[]>([]);
  const [error, setError] = useState<string | null>(null);

  const sessionId = useDSHSession();
  const filteredTasks = useSessionFilter(tasks, sessionId);
  const events = useSSESubscription(sessionId);

  // 轮询 /api/state
  useEffect(() => {
    const fetchState = async () => {
      try {
        const res = await fetch(`/api/state${sessionId ? `?session=${sessionId}` : ''}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setTasks(data.tasks || []);
        setWorkers(data.workers || []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    };

    fetchState();
    const interval = setInterval(fetchState, 3000);
    return () => clearInterval(interval);
  }, [sessionId]);

  const handleDispatch = async (workerName: string, promptText: string) => {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worker: workerName,
        prompt: promptText,
        session: sessionId,
      }),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Dispatch failed');
    }

    const result = await res.json();
    console.log('Task dispatched:', result.taskId);
  };

  if (error) {
    return (
      <div style={{ padding: '20px', color: 'red' }}>
        <h3>连接错误</h3>
        <pre>{error}</pre>
        <button onClick={() => window.location.reload()}>刷新页面</button>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px', maxHeight: '100vh', overflowY: 'auto' }}>
      <h2>Multi-Agent Console</h2>
      <p style={{ fontSize: '12px', color: '#666' }}>Session: {sessionId}</p>

      <DispatchForm
        workers={workers.map(w => ({ name: w.name, healthy: w.healthy }))}
        onDispatch={handleDispatch}
      />

      <TaskList tasks={filteredTasks} />
      <WorkerStats workers={workers} />
      <EventStream events={events} />
    </div>
  );
}
