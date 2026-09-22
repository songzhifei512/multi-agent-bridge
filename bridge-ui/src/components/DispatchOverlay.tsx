import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as S from '../inlineStyles';

/* ── FAB ── */
export function FAB({ onClick }: { onClick: () => void }) {
  return (
    <button style={S.fab} onClick={onClick} title="派发任务">
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
    <div style={{ ...S.toast, opacity: show ? 1 : 0, transition: 'opacity .3s ease' }}>
      ✓ {message}
    </div>
  );
}

/* ── Dispatch Overlay ── */
interface WorkflowOption {
  key: string;
  title: string;
}
interface DispatchOverlayProps {
  workers: string[];
  open: boolean;
  onClose: () => void;
  onDispatch: (worker: string, prompt: string, wfKey?: string) => Promise<string | undefined>;
  onDispatched: (worker: string, taskId?: string) => void;
  /** 可挂靠的工作流（来自当前 workflows.list，过滤掉「单发任务」adhoc 卡） */
  workflows?: WorkflowOption[];
}

export function DispatchOverlay({
  workers,
  open,
  onClose,
  onDispatch,
  onDispatched,
  workflows,
}: DispatchOverlayProps) {
  const [worker, setWorker] = useState('');
  const [prompt, setPrompt] = useState('');
  const [wfKey, setWfKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const effectiveWorker = worker || workers[0] || '';

  // 过滤掉 adhoc 卡；其余可作为挂靠目标
  const wfOptions: WorkflowOption[] = (workflows || []).filter((w) => w.key !== 'adhoc');

  useEffect(() => {
    if (open) {
      setWorker('');
      setPrompt('');
      setWfKey('');
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
        const taskId = await onDispatch(effectiveWorker, prompt.trim(), wfKey || undefined);
        onDispatched(effectiveWorker, taskId);
        setPrompt('');
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : '派发失败');
      } finally {
        setLoading(false);
      }
    },
    [prompt, effectiveWorker, wfKey, onDispatch, onDispatched, onClose],
  );

  const canDispatch = prompt.trim().length > 0 && !!effectiveWorker;
  const disabledReason = !effectiveWorker
    ? '请选择执行者'
    : !prompt.trim()
    ? '请输入任务内容'
    : '';

  return (
    <>
      <div style={{ ...S.overlayMask, opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none', transition: 'opacity .25s ease' }} onClick={onClose} />
      <div style={S.dispatchPanel(open)}>
        <div style={S.dispatchHead}>
          <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600 }}>派发任务</h4>
          <button style={S.dispatchClose} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={S.label}>
            Worker
            <select style={S.input} value={effectiveWorker} onChange={e => setWorker(e.target.value)}>
              {workers.length === 0 && <option value="">（无可用 worker）</option>}
              {workers.map(w => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </label>
          <label style={S.label}>
            派发至
            <select style={S.input} value={wfKey} onChange={e => setWfKey(e.target.value)} title="选择工作流则任务作为该卡的新阶段；不选则新建单发任务">
              <option value="">（新建单发任务）</option>
              {wfOptions.map(w => (
                <option key={w.key} value={w.key}>{w.title}</option>
              ))}
            </select>
          </label>
          <label style={S.label}>
            任务描述
            <textarea
              ref={textareaRef}
              style={S.textarea}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="输入要执行的任务…"
            />
          </label>
          {error && (
            <div style={{
              padding: '6px 10px',
              background: 'var(--err, #ef4444)',
              color: '#fff',
              borderRadius: '6px',
              fontSize: '11px',
              lineHeight: 1.4,
            }}>
              ⚠ {error}
            </div>
          )}
          {!canDispatch && disabledReason && (
            <div style={{
              fontSize: '10px',
              color: 'var(--mut, #8b8b9e)',
              textAlign: 'center',
              marginTop: '-4px',
            }}>
              {disabledReason}
            </div>
          )}
          <button
            style={{ ...S.dispatchBtn, ...(loading || !canDispatch ? S.dispatchBtnDisabled : {}) }}
            type="submit"
            disabled={loading || !canDispatch}
          >
            {loading ? '派发中…' : '派发任务'}
          </button>
        </form>
      </div>
    </>
  );
}