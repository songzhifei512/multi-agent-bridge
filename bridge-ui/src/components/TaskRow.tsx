import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as S from '../inlineStyles';
import { renderMarkdown } from '../utils/markdown';

interface Step {
  step: string;
  id: string;
  status: string;
  claimed_by?: string;
  assigned_to?: string;
  created_at?: any;
  completed_at?: any;
  duration?: any;
  progress?: string[];
  hb?: any;
  heartbeat_n?: number;
  live?: any;
  result?: any;
  exit_code?: any;
}

interface TaskRowProps {
  step: Step;
  shortId: string;
  isBlocked: boolean;
  /** 心跳停滞时的重试回调 */
  onRetry?: (stepId: string) => Promise<void>;
  /** 数据为离线缓存快照：冻结心跳时效判断，避免用 Date.now() 对比陈旧心跳造成 ⏳ 误报风暴 */
  dataFrozen?: boolean;
}

const ICON_CHAR: Record<string, string> = {
  completed: '✓',
  failed: '✗',
  running: '▶',
};

const HBT_STALE_MS = 90000;

const STATUS_ZH: Record<string, string> = {
  running: '运行中',
  pending: '待领取',
  completed: '已完成',
  failed: '失败',
  superseded: '已取代',
  cancelled: '已取消',
  interrupted: '已中断',
  escalating: '待决策',
  awaiting_approval: '待审批',
};

function fmtDur(ms: any): string {
  if (!ms) return '';
  const s = Math.round(Number(ms) / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  return `${Math.floor(m / 60)}时${m % 60}分`;
}

function fmtTime(ts: any): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function TaskRow({ step, shortId, isBlocked, onRetry, dataFrozen }: TaskRowProps) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mdExpanded, setMdExpanded] = useState(false);
  const [mdHasMore, setMdHasMore] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const mdRef = useRef<HTMLDivElement>(null);
  const who = step.claimed_by || step.assigned_to || '';
  const isDone = step.status === 'completed';
  const cls = isBlocked && step.status === 'pending' ? 'waiting' : step.status;

  const handleCopy = useCallback(async () => {
    try {
      const text = step.result == null ? '' : String(step.result);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }, [step.result]);

  const handleRetry = useCallback(async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry(step.id);
    } finally {
      setRetrying(false);
    }
  }, [onRetry, step.id, retrying]);

  // A. 心跳停滞预警：running 且 last_heartbeat_at 超 90s 未刷新 → 琥珀边框
  //    离线缓存数据（dataFrozen）冻结判断——陈旧心跳不代表任务卡住
  const hbStale = useMemo(
    () =>
      !dataFrozen &&
      step.status === 'running' &&
      !!step.hb &&
      Date.now() - new Date(step.hb).getTime() > HBT_STALE_MS,
    [dataFrozen, step.status, step.hb],
  );

  const timeline = useMemo(() => {
    const rows: Array<[string, string]> = [];
    if (step.created_at) rows.push(['创建', fmtTime(step.created_at)]);
    if (step.completed_at) rows.push(['完成', fmtTime(step.completed_at)]);
    if (step.duration) rows.push(['耗时', fmtDur(step.duration)]);
    return rows;
  }, [step.created_at, step.completed_at, step.duration]);

  const resultPreview = useMemo(() => {
    if (!step.result) return '';
    const s = String(step.result);
    return s.length > 900 ? s.slice(s.length - 900) : s;
  }, [step.result]);

  // 判断结果内容是否超出 100px 高度
  useEffect(() => {
    if (!open || !step.result) return;
    const el = mdRef.current;
    if (!el) return;
    // 等一帧让 DOM 渲染完成
    const t = requestAnimationFrame(() => {
      if (el.scrollHeight > 100) {
        setMdHasMore(true);
      } else {
        setMdHasMore(false);
      }
    });
    return () => cancelAnimationFrame(t);
  }, [open, step.result, resultPreview]);

  const rowStyle: React.CSSProperties = {
    ...(hbStale ? { ...S.taskRow(hovered), ...S.taskRowStale } : S.taskRow(hovered)),
    flexWrap: 'wrap',
  };

  const mdResultStyle = mdExpanded ? S.mdResultExpanded : S.mdResult;

  // 渐变遮罩（内联版：用伪元素不可行，改用底部渐变 div）
  const fadeMaskStyle: React.CSSProperties = mdHasMore && !mdExpanded ? {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '40px',
    background: 'linear-gradient(to bottom, transparent, var(--bg, #0a0a0f))',
    pointerEvents: 'none',
    transition: 'opacity .3s',
    borderBottomLeftRadius: '6px',
    borderBottomRightRadius: '6px',
  } : { display: 'none' };

  return (
    <div style={rowStyle} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div style={S.taskHead} onClick={() => setOpen(v => !v)} title={open ? '收起详情' : '展开详情'}>
        <span style={S.taskIcon(cls)}>
          {ICON_CHAR[cls] || ''}
        </span>
        <span style={S.taskId}>{shortId}</span>
        <span style={{ ...S.taskTitle, color: isDone ? 'var(--mut, #8b8b9e)' : undefined }}>
          {step.step}
        </span>
        <span style={S.taskWho}>
          {who || (step.status === 'pending' ? '待领取' : '')}
        </span>
        {hbStale && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={S.hbStale} title="心跳停滞超 90s，疑似卡住">⏳</span>
            {onRetry && (
              <button
                onClick={handleRetry}
                disabled={retrying}
                style={{
                  appearance: 'none',
                  border: '1px solid var(--warn, #f59e0b)',
                  background: retrying ? 'var(--border2, #2a2a3e)' : 'transparent',
                  color: 'var(--warn, #f59e0b)',
                  fontSize: '9px',
                  borderRadius: '999px',
                  padding: '1px 6px',
                  cursor: retrying ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
                title="重新派发此任务"
              >
                {retrying ? '重试中…' : '重试'}
              </button>
            )}
          </span>
        )}
        <span style={{ ...S.wfChev, fontSize: 9 }}>{open ? '▾' : '▸'}</span>
      </div>

      {open && (
        <div style={S.taskBody}>
          <div style={S.kv}>
            <span>状态 <b style={S.kvBold}>{STATUS_ZH[step.status] || step.status}</b></span>
            <span>负责人 <b style={S.kvBold}>{who || '—'}</b></span>
            {step.exit_code !== null && step.exit_code !== undefined && (
              <span>exit <b style={S.kvBold}>{String(step.exit_code)}</b></span>
            )}
            {step.status === 'running' && (
              <span>
                心跳{' '}
                <b style={hbStale ? S.hbStale : S.hbOk}>
                  {hbStale ? '停滞(90s+)' : '正常'}
                </b>
              </span>
            )}
          </div>

          {timeline.length > 0 && (
            <div style={S.log}>
              {timeline.map(([k, v]) => (
                <div key={k} style={S.logRow}>
                  <span style={S.logTag}>{k}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          )}

          {step.progress && step.progress.length > 0 && (
            <div style={S.log}>
              <span style={S.logTag}>里程碑</span>
              {step.progress.map((n, i) => (
                <div key={i} style={S.logRow}>
                  <span style={S.logTag}>·</span>
                  <span>{n}</span>
                </div>
              ))}
            </div>
          )}

          {step.result != null && step.result !== '' && (
            <div style={{ position: 'relative' }} className="md-copy-wrap">
              <button
                onClick={handleCopy}
                title="复制原始结果到剪贴板"
                style={S.mdCopyBtn}
              >
                {copied ? '✓ 已复制' : '复制'}
              </button>
              <div
                ref={mdRef}
                className={`md-result${mdExpanded ? ' expanded' : ''}${mdHasMore ? ' has-more' : ''}`}
                style={mdResultStyle}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(resultPreview) }}
              />
              <div style={fadeMaskStyle} />
              {mdHasMore && (
                <button
                  className="md-expand-btn"
                  style={S.mdExpandBtn}
                  onClick={() => setMdExpanded(v => !v)}
                >
                  {mdExpanded ? '收起' : '展开'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
