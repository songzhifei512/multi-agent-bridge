import { useCallback, useEffect, useRef, useState } from 'react';

/** 兜底扫描端口（获取服务端口失败时尝试） */
const FALLBACK_PORTS = [3000, 3001, 3002, 8080, 8081];
/** 在线轮询间隔 */
const POLL_MS = 3000;
/** 离线时探测重连间隔 */
const RETRY_OFFLINE_MS = 5000;

export interface OfflineState {
  state: any | null;
  connected: boolean;
  /** 最近一次成功拉取的时间戳（在线时持续更新；离线/缓存渲染时为缓存时间） */
  lastSyncAt: number;
  /** true 表示当前展示的是 localStorage 缓存而非实时数据 */
  fromCache: boolean;
  /** 冷启动且无缓存时的错误文案；有缓存时为 null（静默离线） */
  error: string | null;
}

/**
 * 通过宿主 api 调用 Node 侧注册的服务（如 bridge.getPort）。
 * Qoder CN 的 webview→node 桥接口名未公开确认，按可能性依次尝试。
 */
async function callNodeService(api: any, name: string): Promise<any> {
  if (!api) return undefined;
  const candidates: Array<() => Promise<any>> = [];
  if (typeof api.callService === 'function') candidates.push(() => api.callService(name));
  if (typeof api.invoke === 'function') candidates.push(() => api.invoke(name));
  if (typeof api.call === 'function') candidates.push(() => api.call(name));
  if (typeof api[name] === 'function') candidates.push(() => api[name]());
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

/**
 * 写操作通道：POST /api/run（派发）与 /api/action（重试等）按端口优先级尝试
 */
export async function postToBridge(
  path: string,
  body: Record<string, any>,
  bridgePortRef: React.MutableRefObject<number | undefined>,
): Promise<any> {
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
}

/**
 * 离线状态管理 hook：负责在线/离线检测、端口解析、缓存读写
 *
 * @param api - Qoder CN webview 的 Node 服务桥接对象（可选）
 * @param loadState - 从 localStorage 加载缓存状态的函数
 * @param saveState - 将状态写入 localStorage 的函数
 */
export function useOfflineState(
  api?: any,
  loadState?: () => { state: any; timestamp: number } | null,
  saveState?: (state: any) => void,
) {
  // 初始 state：优先用缓存（秒开），无缓存则为空
  const [ui, setUi] = useState<OfflineState>(() => {
    const cached = loadState?.();
    return cached
      ? { state: cached.state, connected: false, lastSyncAt: cached.timestamp, fromCache: true, error: null }
      : { state: null, connected: false, lastSyncAt: 0, fromCache: false, error: null };
  });

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
    saveState?.(data);
    setUi({ state: data, connected: true, lastSyncAt: now, fromCache: false, error: null });
  }, [saveState]);

  /** 拉取失败：保留当前数据但标记离线；冷启动无缓存时给出友好空态 */
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
        const p = await callNodeService(api, 'bridge.getPort');
        const port = typeof p === 'number' ? p : undefined;
        if (port && port > 0) bridgePortRef.current = port;
      }

      const ports: number[] = [];
      if (bridgePortRef.current !== undefined) ports.push(bridgePortRef.current);
      for (const p of FALLBACK_PORTS) if (!ports.includes(p)) ports.push(p);

      let result = await fetchFromPorts(ports);

      // webview 网络隔离可能阻断 localhost fetch → 走 Node 服务 bridge.getState 兜底
      if (!result && !cancelled) {
        const viaService = await callNodeService(api, 'bridge.getState');
        if (viaService && typeof viaService === 'object' && !cancelled) {
          result = { data: viaService, port: bridgePortRef.current ?? -1 };
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

  return {
    state: ui.state,
    connected: ui.connected,
    lastSyncAt: ui.lastSyncAt,
    fromCache: ui.fromCache,
    error: ui.error,
    postToBridge: useCallback(
      (path: string, body: Record<string, any>) => postToBridge(path, body, bridgePortRef),
      [],
    ),
  };
}
