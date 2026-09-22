import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  StickyHeader,
  WorkflowCard,
  FAB,
  DispatchOverlay,
  Toast,
  OfflineBanner,
} from 'bridge-ui';
import * as S from 'bridge-ui/inlineStyles';
import { saveState, loadState } from './stateCache';

/** 在线轮询间隔 */
const POLL_MS = 3000;
/** 离线时探测重连间隔 */
const RETRY_OFFLINE_MS = 5000;

/** 兜底扫描端口（获取服务端口失败时尝试） */
const FALLBACK_PORTS = [3000, 3001, 3002, 8080, 8081];

/** Node 侧服务名（与 main.ts registerService({ name }) 一致） */
const BRIDGE_SERVICE = 'multi-agent-bridge';

/**
 * 通过宿主 api 调用 Node 侧注册的服务方法。
 * 优先官方通道 api.node.callService(serviceName, method, input)，
 * 失败再尝试旧形态（api.callService('bridge.xxx') 等）。
 */
async function callNodeService(api: any, method: string, input?: any): Promise<any> {
  if (!api) return undefined;
  if (typeof api.node?.callService === 'function') {
    try {
      const r = await api.node.callService(BRIDGE_SERVICE, method, input);
      if (r !== undefined && r !== null) return r;
    } catch { /* 回退旧形态 */ }
  }
  const legacyName = `bridge.${method}`;
  const candidates: Array<() => Promise<any>> = [];
  if (typeof api.callService === 'function') candidates.push(() => api.callService(legacyName));
  if (typeof api.invoke === 'function') candidates.push(() => api.invoke(legacyName));
  if (typeof api.call === 'function') candidates.push(() => api.call(legacyName));
  if (typeof api[legacyName] === 'function') candidates.push(() => api[legacyName]());
  for (const fn of candidates) {
    try {
      const r = await fn();
      if (r !== undefined && r !== null) return r;
    } catch { /* 尝试下一个 */ }
  }
  return undefined;
}

/** 从候选端口列表中拉取状态，返回第一个成功的 */
async function fetchFromPorts(ports: number[]): Promise<{ data: any; port: number } | null> {
  for (const port of ports) {
    try {
      const res = await fetch(`http://localhost:${port}/api/state`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') return { data, port };
      }
    } catch { /* 下一个端口 */ }
  }
  return null;
}

interface ConsoleState {
  state: any | null;
  connected: boolean;
  /** 最近一次成功拉取的时间戳（在线时持续更新；离线/缓存渲染时为缓存时间） */
  lastSyncAt: number;
  /** true 表示当前展示的是 localStorage 缓存而非实时数据 */
  fromCache: boolean;
  /** 冷启动且无缓存时的错误文案；有缓存时为 null（静默离线） */
  error: string | null;
}

export default function BridgeConsole({ api }: { api: any }) {
  // 初始 state：优先用缓存（秒开），无缓存则为空
  const [ui, setUi] = useState<ConsoleState>(() => {
    const cached = loadState();
    return cached
      ? { state: cached.state, connected: false, lastSyncAt: cached.timestamp, fromCache: true, error: null }
      : { state: null, connected: false, lastSyncAt: 0, fromCache: false, error: null };
  });

  const [toast, setToast] = useState<string | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);

  const bridgePortRef = useRef<number | undefined>(undefined);
  const resolveTriesRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /** 在线拉取成功：更新 state + 写缓存 */
  const applyOnline = useCallback((data: any, port: number) => {
    bridgePortRef.current = port;
    const now = Date.now();
    saveState(data);
    setUi({ state: data, connected: true, lastSyncAt: now, fromCache: false, error: null });
  }, []);

  /** 拉取失败：保留当前数据但标记离线；冷启动无缓存时给出友好空态（不留开发者命令） */
  const applyOffline = useCallback(() => {
    setUi(prev => ({
      ...prev,
      connected: false,
      fromCache: prev.state != null,
      error: prev.state != null
        ? null
        : '暂时连不上 Multi-Agent 桥服务，也没有可展示的缓存数据。\n\n请确认桥服务面板已启动；启动后面板会自动重连，无需操作。',
    }));
  }, []);

  /** 写操作通道：/api/run（派发）与 /api/action（重试等）。优先 Node 侧代理，失败退化为端口直连 */
  const postToBridge = useCallback(async (path: string, body: Record<string, any>): Promise<any> => {
    // 1) Node 侧代理（webview fetch localhost 可能被 CSP/CORS 阻断，此通道最稳）
    const viaNode = await callNodeService(api, 'post', { path, body });
    if (viaNode && typeof viaNode === 'object' && viaNode.data !== undefined) {
      if (viaNode.status >= 200 && viaNode.status < 300 && viaNode.data?.ok !== false) return viaNode.data;
      if (viaNode.data?.error) throw new Error(String(viaNode.data.error));
    }
    // 2) 直连兜底
    const ports: number[] = [];
    if (bridgePortRef.current !== undefined) ports.push(bridgePortRef.current);
    for (const p of FALLBACK_PORTS) if (!ports.includes(p)) ports.push(p);
    let lastErr = '无法连接到桥服务';
    for (const port of ports) {
      try {
        const res = await fetch(`http://localhost:${port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({} as any));
        if (res.ok && data?.ok !== false) return data;
        lastErr = data?.error || `HTTP ${res.status}`;
      } catch { /* 尝试下一个端口 */ }
    }
    throw new Error(lastErr);
  }, [api]);

  // 主轮询循环
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const schedule = (ms: number) => {
      timer = window.setTimeout(run, ms);
    };

    const run = async () => {
      if (cancelled) return;

      // 端口未知时尝试通过 Node 服务解析（最多试 5 次，之后退化为端口扫描）
      if (bridgePortRef.current === undefined && resolveTriesRef.current < 5) {
        resolveTriesRef.current++;
        const r = await callNodeService(api, 'getPort');
        const port = typeof r === 'number' ? r : (typeof r?.port === 'number' ? r.port : undefined);
        if (port && port > 0) bridgePortRef.current = port;
      }

      const ports: number[] = [];
      if (bridgePortRef.current !== undefined) ports.push(bridgePortRef.current);
      for (const p of FALLBACK_PORTS) if (!ports.includes(p)) ports.push(p);

      let result = await fetchFromPorts(ports);

      // webview 网络隔离可能阻断 localhost fetch → 走 Node 服务 getState 兜底
      if (!result && !cancelled) {
        const viaService = await callNodeService(api, 'getState');
        const st = viaService && typeof viaService === 'object' && 'state' in viaService ? viaService.state : viaService;
        if (st && typeof st === 'object' && !cancelled) {
          result = { data: st, port: bridgePortRef.current ?? -1 };
        }
      }

      if (cancelled) return;

      if (result) {
        applyOnline(result.data, result.port);
        schedule(POLL_MS);
      } else {
        // 端口可能已变（面板重启）：丢弃缓存端口，下轮重新解析
        bridgePortRef.current = undefined;
        resolveTriesRef.current = 0;
        applyOffline();
        schedule(RETRY_OFFLINE_MS);
      }
    };

    run();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, applyOnline, applyOffline]);

  return (
    <BridgeInner
      state={ui.state}
      connected={ui.connected}
      fromCache={ui.fromCache}
      lastSyncAt={ui.lastSyncAt}
      error={ui.error}
      toast={toast}
      setToast={setToast}
      dispatchOpen={dispatchOpen}
      setDispatchOpen={setDispatchOpen}
      post={postToBridge}
    />
  );
}

interface InnerProps {
  state: any;
  connected: boolean;
  fromCache: boolean;
  lastSyncAt: number;
  error: string | null;
  toast: string | null;
  setToast: (t: string | null) => void;
  dispatchOpen: boolean;
  setDispatchOpen: (b: boolean) => void;
  /** 写操作通道（POST /api/run、/api/action） */
  post: (path: string, body: Record<string, any>) => Promise<any>;
}

function BridgeInner({
  state, connected, fromCache, lastSyncAt, error,
  toast, setToast, dispatchOpen, setDispatchOpen, post,
}: InnerProps) {
  const stat: any = state?.stat || {};
  const workflows: any[] = state?.workflows?.list || [];

  const active = workflows.filter(
    w => !w.archived && (w.running > 0 || w.pending > 0 || w.failed > 0),
  );
  const activeKeys = new Set(active.map(w => w.key));
  const completed = workflows.filter(w => !activeKeys.has(w.key));

  const memberLabel = useCallback(
    (agent: string) =>
      state?.members?.find((m: any) => m.agent === agent)?.label || '',
    [state?.members],
  );

  /** 真实派发：POST /api/run {worker, prompt, wf_key?}，返回新任务 id */
  const handleDispatch = useCallback(
    async (worker: string, prompt: string, wfKey?: string) => {
      const data = await post('/api/run', { worker, prompt, wf_key: wfKey || undefined });
      return (data?.taskId || data?.task_id) as string | undefined;
    },
    [post],
  );

  const handleDispatched = useCallback((worker: string, taskId?: string) => {
    setToast(`已派发 → ${worker}${taskId ? '（任务 ' + taskId.slice(-4) + '）' : ''}`);
  }, [setToast]);

  /** 心跳停滞重试：reassign 把任务打回 pending 并撤销认领，空闲 worker 会重新领取 */
  const handleRetry = useCallback(async (stepId: string) => {
    try {
      await post('/api/action', { action: 'reassign', task_id: stepId, note: '面板手动重试' });
      setToast('已重新排队，等待 worker 领取');
    } catch (e: any) {
      setToast(`重试失败: ${e?.message || e}`);
    }
  }, [post, setToast]);

  const offline = !connected && state != null;

  return (
    <div style={S.root}>
      <StickyHeader stat={stat} connected={connected}
        controller={state?.controller} controllerLabel={state?.controllerLabel} />

      {offline && <OfflineBanner lastSyncAt={lastSyncAt} />}

      <div style={S.body}>
        {error && (
          <div style={{ ...S.empty, color: 'var(--err, #ef4444)', padding: '20px 0', whiteSpace: 'pre-line' }}>
            {error}
          </div>
        )}

        {!error && active.length === 0 && completed.length === 0 && (
          <div style={S.empty}>当前没有活动工作流</div>
        )}

        {active.length > 0 && (
          <>
            <div style={S.section}>进行中 ({active.length})</div>
            {active.map(wf => (
              <WorkflowCard key={wf.key} wf={wf} memberLabel={memberLabel}
                isActive={true} onRetry={handleRetry} dataFrozen={!connected} />
            ))}
          </>
        )}

        {completed.length > 0 && (
          <>
            <div style={S.section}>历史 ({completed.length})</div>
            {completed.map(wf => (
              <WorkflowCard key={wf.key} wf={wf} memberLabel={memberLabel}
                isActive={false} onRetry={handleRetry} dataFrozen={!connected} />
            ))}
          </>
        )}
      </div>

      {/* 悬浮层锚定在 root（S.root position:relative），不随 body 滚动 */}
      <FAB onClick={() => setDispatchOpen(true)} />

      <DispatchOverlay
        workers={state?.workers || []}
        open={dispatchOpen}
        onClose={() => setDispatchOpen(false)}
        onDispatch={handleDispatch}
        onDispatched={handleDispatched}
        workflows={workflows.map((w: any) => ({ key: w.key, title: w.title }))}
      />

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
