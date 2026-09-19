import React, { useRef, useEffect } from 'react';

interface SSEEvent {
  type: string;
  taskId?: string;
  progress?: number;
  message?: string;
  timestamp?: string;
}

interface EventStreamProps {
  events: SSEEvent[];
}

export function EventStream({ events }: EventStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const eventTypeColor = (type: string) => {
    if (type.includes('start')) return '#4caf50';
    if (type.includes('progress')) return '#2196f3';
    if (type.includes('complete')) return '#9c27b0';
    if (type.includes('error') || type.includes('fail')) return '#f44336';
    return '#666';
  };

  return (
    <div style={{ marginBottom: '20px' }}>
      <h3>事件流</h3>
      <div
        ref={scrollRef}
        style={{
          maxHeight: '250px',
          overflowY: 'auto',
          background: '#1e1e1e',
          color: '#d4d4d4',
          padding: '10px',
          borderRadius: '4px',
          fontFamily: 'monospace',
          fontSize: '11px'
        }}
      >
        {events.length === 0 ? (
          <div style={{ color: '#666' }}>等待事件...</div>
        ) : (
          events.map((event, i) => (
            <div key={i} style={{ marginBottom: '4px' }}>
              <span style={{ color: eventTypeColor(event.type) }}>
                [{event.type}]
              </span>
              {event.taskId && <span> Task: {event.taskId}</span>}
              {event.progress !== undefined && <span> Progress: {event.progress}%</span>}
              {event.message && <span> - {event.message}</span>}
              {event.timestamp && (
                <span style={{ color: '#666', marginLeft: '10px' }}>
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
