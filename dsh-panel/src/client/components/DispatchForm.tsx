import React, { useState } from 'react';

interface DispatchFormProps {
  workers: Array<{ name: string; healthy: boolean }>;
  onDispatch: (worker: string, prompt: string) => Promise<void>;
}

export function DispatchForm({ workers, onDispatch }: DispatchFormProps) {
  const [worker, setWorker] = useState(workers[0]?.name || 'dsh');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    setLoading(true);
    setError(null);
    try {
      await onDispatch(worker, prompt);
      setPrompt('');
    } catch (err) {
      console.error('Dispatch failed:', err);
      setError(err instanceof Error ? err.message : '任务派发失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginBottom: '20px' }}>
      <h3>派发任务</h3>
      {error && (
        <div style={{
          padding: '10px',
          marginBottom: '10px',
          background: '#ffebee',
          border: '1px solid #f44336',
          borderRadius: '4px',
          color: '#c62828'
        }}>
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '10px' }}>
          <label>
            Worker:
            <select
              value={worker}
              onChange={e => setWorker(e.target.value)}
              style={{ marginLeft: '10px', padding: '5px' }}
            >
              {workers.map(w => (
                <option key={w.name} value={w.name} disabled={!w.healthy}>
                  {w.name} {!w.healthy && '(不可用)'}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ marginBottom: '10px' }}>
          <label>
            Prompt:
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={4}
              style={{ width: '100%', marginLeft: '10px', padding: '5px' }}
              placeholder="输入要执行的任务..."
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={loading || !prompt.trim()}
          style={{
            padding: '8px 20px',
            background: loading ? '#ccc' : '#2196f3',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: loading ? 'not-allowed' : 'pointer'
          }}
        >
          {loading ? '发送中...' : '发送'}
        </button>
      </form>
    </div>
  );
}
