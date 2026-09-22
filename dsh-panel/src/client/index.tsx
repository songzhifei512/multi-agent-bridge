import React, { useCallback, useState } from 'react';
import { useBridgeState } from './hooks/useBridgeState';
import { injectStyles } from './styles';
import { StickyHeader } from './components/StickyHeader';
import { WorkflowCard } from './components/WorkflowCard';
import { FAB, DispatchOverlay, Toast } from './components/DispatchOverlay';

export default function BridgeConsoleTab() {
  injectStyles();
  const { state, connected } = useBridgeState();
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const stat = state?.stat || {};
  const workflows = state?.workflows?.list || [];

  // 分为活跃和已完成两组
  const active = workflows.filter(
    w => !w.archived && (w.running > 0 || w.pending > 0 || w.failed > 0),
  );
  const completed = workflows.filter(
    w => !w.archived && w.running === 0 && w.pending === 0 && w.failed === 0,
  );

  const memberLabel = useCallback(
    (agent: string) =>
      state?.members?.find((m: any) => m.agent === agent)?.label || '',
    [state?.members],
  );

  const handleDispatch = useCallback(
    async (worker: string, prompt: string) => {
      const res = await fetch('/bridge/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker, prompt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data?.taskId as string | undefined;
    },
    [],
  );

  const handleDispatched = useCallback((worker: string, taskId?: string) => {
    setToast(`已派发 → ${worker}`);
  }, []);

  return (
    <div className="ma-root">
      <StickyHeader
        stat={stat}
        connected={connected}
        controller={state?.controller}
        controllerLabel={state?.controllerLabel}
      />

      <div className="ma-body">
        {active.length === 0 && completed.length === 0 && (
          <div className="ma-empty">当前没有活动工作流</div>
        )}

        {active.length > 0 && (
          <>
            <div className="ma-section">进行中 ({active.length})</div>
            {active.map(wf => (
              <WorkflowCard
                key={wf.key}
                wf={wf}
                memberLabel={memberLabel}
                isActive={true}
              />
            ))}
          </>
        )}

        {completed.length > 0 && (
          <>
            <div className="ma-section">已完成 ({completed.length})</div>
            {completed.map(wf => (
              <WorkflowCard
                key={wf.key}
                wf={wf}
                memberLabel={memberLabel}
                isActive={false}
              />
            ))}
          </>
        )}

        <FAB onClick={() => setDispatchOpen(true)} />

        <DispatchOverlay
          workers={state?.workers || []}
          open={dispatchOpen}
          onClose={() => setDispatchOpen(false)}
          onDispatch={handleDispatch}
          onDispatched={handleDispatched}
        />

        {toast && (
          <Toast message={toast} onDone={() => setToast(null)} />
        )}
      </div>
    </div>
  );
}
