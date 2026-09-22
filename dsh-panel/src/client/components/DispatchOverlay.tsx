import React, { useCallback, useEffect, useRef, useState } from 'react';

/* ── FAB ── */
export function FAB({ onClick }: { onClick: () => void }) {
  return (
    <button className="ma-fab" onClick={onClick} title="派发任务">
      ＋
    </button>
  );
}

/* ── Toast ── */
export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    // trigger enter animation
    const t1 = requestAnimationFrame(() => setShow(true));
    const t2 = window.setTimeout(() => {
      setShow(false);
      window.setTimeout(onDone, 300);
    }, 2500);
    return () => {
      cancelAnimationFrame(t1);
      clearTimeout(t2);
    };
  }, [onDone]);

  return (
    <div className={`ma-toast${show ? ' show' : ''}`}>
      ✓ {message}
    </div>
  );
}

/* ── Dispatch Overlay ── */
interface DispatchOverlayProps {
  workers: string[];
  open: boolean;
  onClose: () => void;
  onDispatch: (worker: string, prompt: string) => Promise<string | undefined>;
  onDispatched: (worker: string, taskId?: string) => void;
}

export function DispatchOverlay({
  workers,
  open,
  onClose,
  onDispatch,
  onDispatched,
}: DispatchOverlayProps) {
  const [worker, setWorker] = useState('');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const effectiveWorker = worker || workers[0] || '';

  useEffect(() => {
    if (open) {
      setWorker('');
      setPrompt('');
      setError(null);
      setTimeout(() => textareaRef.current?.focus(), 260);
    }
  }, [open]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!prompt.trim() || !effectiveWorker) return;
      setLoading(true);
      setError(null);
      try {
        const taskId = await onDispatch(effectiveWorker, prompt.trim());
        onDispatched(effectiveWorker, taskId);
        setPrompt('');
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : '派发失败');
      } finally {
        setLoading(false);
      }
    },
    [prompt, effectiveWorker, onDispatch, onDispatched, onClose],
  );

  return (
    <>
      <div className={`ma-overlay-mask${open ? ' open' : ''}`} onClick={onClose} />
      <div className={`ma-dispatch${open ? ' open' : ''}`}>
        <div className="ma-dispatch-head">
          <h4>派发任务</h4>
          <button className="ma-dispatch-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label>
            Worker
            <select value={effectiveWorker} onChange={e => setWorker(e.target.value)}>
              {workers.length === 0 && <option value="">（无可用 worker）</option>}
              {workers.map(w => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </label>
          <label>
            Prompt
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="输入要执行的任务…"
            />
          </label>
          {error && <div style={{ color: 'var(--err)', fontSize: '11px' }}>{error}</div>}
          <button
            className="ma-dispatch-btn"
            type="submit"
            disabled={loading || !prompt.trim() || !effectiveWorker}
          >
            {loading ? '派发中…' : '派发任务'}
          </button>
        </form>
      </div>
    </>
  );
}
