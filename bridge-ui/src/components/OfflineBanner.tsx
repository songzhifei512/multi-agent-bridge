import React, { useEffect, useState } from 'react';

/** 离线横幅：自带每秒 tick，计时器下沉到这里，避免离线时整棵组件树每秒重渲染 */
export function OfflineBanner({ lastSyncAt }: { lastSyncAt: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const ageMs = Date.now() - lastSyncAt;
  const ageSec = Math.max(0, Math.round(ageMs / 1000));
  const ageText = ageSec < 60
    ? `${ageSec}秒`
    : ageSec < 3600
      ? `${Math.floor(ageSec / 60)}分钟`
      : `${Math.floor(ageSec / 3600)}小时${Math.floor((ageSec % 3600) / 60)}分`;

  return (
    <div style={{
      padding: '4px 12px',
      background: 'var(--warn-bg, rgba(245,158,11,.1))',
      color: 'var(--warn, #f59e0b)',
      fontSize: '10px',
      textAlign: 'center',
      borderBottom: '1px solid var(--border, #1e1e2e)',
      flexShrink: 0,
    }}>
      ⚠ 离线模式 · 数据缓存于 {ageText}前 · 每 {RETRY_OFFLINE_MS / 1000}s 自动重连
    </div>
  );
}

const RETRY_OFFLINE_MS = 5000;
