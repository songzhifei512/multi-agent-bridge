import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBridgeState, useTheme, StickyHeader, FAB, DispatchOverlay, Toast } from 'bridge-ui';
import type { BridgeState } from 'bridge-ui';
import LeftColumn from './components/LeftColumn';
import MiddleColumn from './components/MiddleColumn';
import RightColumn from './components/RightColumn';

interface WfSectionState {
  running: boolean;
  done: boolean;
  archived: boolean;
}

const App: React.FC = () => {
  const { state, connected } = useBridgeState('');
  const { theme, setTheme, cycleTheme, themeList } = useTheme();

  const [selectedWfKey, setSelectedWfKey] = useState<string | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<WfSectionState>({
    running: false,
    done: true,
    archived: false,
  });

  const stat = state?.stat || {};
  const total = state?.total ?? 0;
  const controller = state?.controller;
  const controllerLabel = state?.controllerLabel;
  const workflows = state?.workflows || { list: [], other: 0 };
  const members = state?.members || [];
  const workers = state?.workers || [];
  const captainSummary = state?.captainSummary;
  const agentStats = state?.agentStats || {};
  const notes = state?.notes || [];
  const inbox = state?.inbox || [];
  const allUnread = state?.allUnread ?? 0;
  const sharedMemory = state?.sharedMemory || [];

  // Build member label lookup: agent name -> display label
  const memberLabel = useCallback(
    (agent: string): string => {
      const m = members.find((m: any) => m.agent === agent);
      if (m) return m.label || m.agent;
      return agent;
    },
    [members],
  );

  // Member name -> initial for avatar
  const memberInitial = useCallback(
    (agent: string): string => {
      const m = members.find((m: any) => m.agent === agent);
      const label = m?.label || m?.agent || agent;
      return label.charAt(0).toUpperCase();
    },
    [members],
  );

  // Build avatar gradient for a member
  const memberGrad = useCallback(
    (agent: string): string => {
      const m = members.find((m: any) => m.agent === agent);
      if (m?.grad && Array.isArray(m.grad) && m.grad.length >= 2) {
        return `linear-gradient(135deg, ${m.grad[0]}, ${m.grad[1]})`;
      }
      return 'linear-gradient(135deg, #6366f1, #4338ca)';
    },
    [members],
  );

  // Toggle member expansion
  const handleToggleMember = useCallback((agent: string) => {
    setExpandedMembers((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent);
      else next.add(agent);
      return next;
    });
  }, []);

  // Toggle workflow section collapse
  const handleToggleSection = useCallback((key: string) => {
    setCollapsedSections((prev) => {
      if (key === 'running') return { ...prev, running: !prev.running };
      if (key === 'done') return { ...prev, done: !prev.done };
      if (key === 'archived') return { ...prev, archived: !prev.archived };
      return prev;
    });
  }, []);

  // Find selected workflow
  const selectedWf = useMemo(() => {
    if (!selectedWfKey) return null;
    return workflows.list.find((w: any) => w.key === selectedWfKey) || null;
  }, [selectedWfKey, workflows.list]);

  // 默认选中：首帧数据到达后自动选一个（运行中 > 历史 > 归档），
  // 只执行一次，之后完全交给用户（关闭详情不再自动重选）。
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current || selectedWfKey) return;
    const list = (workflows.list || []).filter((w: any) => w.key !== 'adhoc');
    if (list.length === 0) return;
    const pick =
      list.find((w: any) => w.running > 0) ||
      list.find((w: any) => !w.archived) ||
      list[0];
    autoSelectedRef.current = true;
    setSelectedWfKey(pick.key);
  }, [workflows.list, selectedWfKey]);

  // Dispatch task
  const handleDispatch = useCallback(
    async (worker: string, prompt: string, wfKey?: string): Promise<string | undefined> => {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker, prompt, wf_key: wfKey }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.taskId;
    },
    [],
  );

  const handleDispatched = useCallback((_worker: string, taskId?: string) => {
    setToast(taskId ? `已派发任务 #${taskId}` : '已派发任务');
  }, []);

  // Archive / unarchive workflow
  const handleArchive = useCallback(async (wfKey: string) => {
    try {
      await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'archive_wf', wf_key: wfKey }),
      });
      setToast(`已归档工作流`);
    } catch {
      setToast('归档失败');
    }
  }, []);

  const handleUnarchive = useCallback(async (wfKey: string) => {
    try {
      await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unarchive_wf', wf_key: wfKey }),
      });
      setToast(`已恢复工作流`);
    } catch {
      setToast('恢复失败');
    }
  }, []);

  // Dispatch to specific workflow
  const handleDispatchToWf = useCallback((wfKey: string) => {
    setDispatchOpen(true);
    // Pre-select workflow in dispatch overlay via state
    setSelectedWfKey(wfKey);
  }, []);

  // Workflow options for dispatch overlay (exclude adhoc)
  const dispatchWfOptions = useMemo(
    () =>
      workflows.list
        .filter((w: any) => w.key !== 'adhoc' && !w.archived)
        .map((w: any) => ({ key: w.key, title: w.title })),
    [workflows.list],
  );

  return (
    <div className="ma-root" data-theme={theme}>
      <StickyHeader
        stat={stat}
        connected={connected}
        controller={controller}
        controllerLabel={controllerLabel}
        theme={theme}
        setTheme={setTheme}
        onToggleTheme={cycleTheme}
        themeList={themeList}
      />

      <div className="web-layout">
        <LeftColumn
          state={state}
          expandedMembers={expandedMembers}
          onToggleMember={handleToggleMember}
        />

        {/* 详情/DAG 是展示重点 → 居中占宽列；工作流列表收窄放最右 */}
        <RightColumn
          wf={selectedWf}
          memberLabel={memberLabel}
          memberInitial={memberInitial}
          memberGrad={memberGrad}
          onClose={() => setSelectedWfKey(null)}
          onDispatch={handleDispatchToWf}
          onArchive={handleArchive}
          onUnarchive={handleUnarchive}
        />

        <MiddleColumn
          state={state}
          selectedWfKey={selectedWfKey}
          onSelectWf={setSelectedWfKey}
          collapsedSections={collapsedSections}
          onToggleSection={handleToggleSection}
          memberLabel={memberLabel}
        />
      </div>

      <FAB onClick={() => setDispatchOpen(true)} />

      <DispatchOverlay
        workers={workers}
        open={dispatchOpen}
        onClose={() => setDispatchOpen(false)}
        onDispatch={handleDispatch}
        onDispatched={handleDispatched}
        workflows={dispatchWfOptions}
      />

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
};

export default App;
