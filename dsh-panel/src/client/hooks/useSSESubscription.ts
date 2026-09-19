import { useEffect, useState } from 'react';

interface SSEEvent {
  type: string;
  taskId?: string;
  progress?: number;
  [key: string]: any;
}

export function useSSESubscription(sessionId: string | null, maxEvents = 100) {
  const [events, setEvents] = useState<SSEEvent[]>([]);

  useEffect(() => {
    if (!sessionId) return;

    const eventSource = new EventSource(`/events?session=${sessionId}`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setEvents(prev => [...prev.slice(-(maxEvents - 1)), data]);
      } catch (err) {
        console.error('[SSE] parse error:', err);
      }
    };

    eventSource.onerror = () => {
      console.warn('[SSE] connection error, reconnecting...');
      eventSource.close();
      // 指数退避重连逻辑可在后续优化
    };

    return () => {
      eventSource.close();
    };
  }, [sessionId, maxEvents]);

  return events;
}
