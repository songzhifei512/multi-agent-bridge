import { useEffect, useRef, useState } from 'react';

export interface BridgeState {
  stat?: Record<string, number>;
  total?: number;
  members?: any[];
  workers?: string[];
  tasks?: any[];
  workflows?: { list: any[]; other: number };
  dag?: any;
  captainSummary?: any;
  agentStats?: Record<string, any>;
  controller?: string;
  controllerLabel?: string;
  notes?: any[];
  agentOverview?: any[];
  [key: string]: any;
}

const POLL_MS = 3000;
const SSE_RETRY_MS = 2000;

// The panel server pushes the FULL state as a NAMED SSE event ("event: state"),
// so onmessage never fires — we must subscribe by name. Polling is only a fallback
// for when the EventSource cannot connect (e.g. proxied SSE blocked).
export function useBridgeState(baseUrl = '/bridge') {
  const [state, setState] = useState<BridgeState | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<number | null>(null);

  useEffect(() => {
    let stopped = false;
    let pollTimer: number | null = null;

    const applyState = (data: BridgeState) => {
      if (stopped) return;
      setState(data);
      setLastSyncAt(Date.now());
    };

    const poll = async () => {
      try {
        const res = await fetch(`${baseUrl}/api/state`, { cache: 'no-store' });
        if (!res.ok) return;
        applyState(await res.json());
        // SSE 建不起来时轮询是唯一数据通道：拉到即视为在线
        if (!esRef.current) setConnected(true);
      } catch { /* transient */ }
    };

    const startPolling = () => {
      if (pollTimer === null) pollTimer = window.setInterval(poll, POLL_MS);
    };
    const stopPolling = () => {
      if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
    };

    const connect = () => {
      if (stopped) return;
      const es = new EventSource(`${baseUrl}/events`);
      esRef.current = es;
      es.addEventListener('state', (e: MessageEvent) => {
        try { applyState(JSON.parse(e.data)); } catch { /* bad frame */ }
      });
      es.onopen = () => { setConnected(true); stopPolling(); };
      es.onerror = () => {
        setConnected(false);
        es.close();
        esRef.current = null;
        startPolling();
        retryRef.current = window.setTimeout(connect, SSE_RETRY_MS);
      };
    };

    poll();          // immediate first paint
    connect();       // live channel
    startPolling();  // safety net until SSE opens

    return () => {
      stopped = true;
      stopPolling();
      if (retryRef.current !== null) window.clearTimeout(retryRef.current);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [baseUrl]);

  return { state, connected, lastSyncAt };
}
