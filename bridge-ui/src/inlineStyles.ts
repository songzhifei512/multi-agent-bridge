/**
 * Inline styles for Qoder CN webview compatibility (CSP blocks <style> injection)
 * Colors resolve through CSS variables (--bg/--card/...) when the host injects
 * them (DSH: styles.ts dark+light themes); fall back to dark literals (Qoder).
 */

const COLORS = {
  bg: 'var(--bg, #0a0a0f)',
  card: 'var(--card, #12121a)',
  hover: 'var(--hover, #1a1a26)',
  border: 'var(--border, #1e1e2e)',
  border2: 'var(--border2, #2a2a3e)',
  txt: 'var(--txt, #e4e4ed)',
  mut: 'var(--mut, #8b8b9e)',
  dim: 'var(--dim, #7d7d94)',
  acc: 'var(--acc, #6366f1)',
  ok: 'var(--ok, #22c55e)',
  run: 'var(--run, #3b82f6)',
  /* --pend：排队待领取（黄）；--warn：停滞/警示（琥珀）。语义分离，不再共用一色 */
  pend: 'var(--pend, #eab308)',
  warn: 'var(--warn, #f59e0b)',
  err: 'var(--err, #ef4444)',
};

export const root: React.CSSProperties = {
  background: COLORS.bg,
  color: COLORS.txt,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  /* FAB/遮罩/Toast 的锚定层：悬浮件必须挂在 root 而非滚动 body，否则随内容滚走 */
  position: 'relative',
  fontSize: '13px',
  lineHeight: 1.45,
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif',
  boxSizing: 'border-box',
};

export const header: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 10,
  background: COLORS.bg,
  padding: '14px 14px 10px',
  borderBottom: `1px solid ${COLORS.border}`,
};

export const headerRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  marginBottom: '8px',
};

export const headerTitle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  flex: 1,
};

export const ctrl: React.CSSProperties = {
  fontSize: '10px',
  color: COLORS.mut,
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: '999px',
  padding: '2px 8px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: '45%',
};

export const conn: React.CSSProperties = {
  width: '7px',
  height: '7px',
  borderRadius: '50%',
  background: COLORS.dim,
  flexShrink: 0,
};

export const connOn: React.CSSProperties = {
  ...conn,
  background: COLORS.ok,
  boxShadow: `0 0 6px ${COLORS.ok}`,
};

export const statsRow: React.CSSProperties = {
  display: 'flex',
  gap: '5px',
  flexWrap: 'wrap',
};

export function stat(cls?: string): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'baseline',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: '999px',
    background: COLORS.card,
    border: `1px solid ${COLORS.border}`,
    fontSize: '10px',
    color: COLORS.mut,
  };
}

export const statBold: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
};

export const wf: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: '10px',
  background: COLORS.card,
  overflow: 'hidden',
  marginBottom: '8px',
};

export const wfHead: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '7px',
  padding: '10px 12px',
  cursor: 'pointer',
  userSelect: 'none',
};

export const wfDot: React.CSSProperties = {
  width: '7px',
  height: '7px',
  borderRadius: '50%',
  background: COLORS.dim,
  flexShrink: 0,
};

export function wfDotStatus(status: string): React.CSSProperties {
  if (status === 'running') return { ...wfDot, background: COLORS.run, boxShadow: `0 0 5px ${COLORS.run}` };
  if (status === 'completed') return { ...wfDot, background: COLORS.ok };
  if (status === 'failed') return { ...wfDot, background: COLORS.err };
  return wfDot;
}

export const wfName: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const wfDots: React.CSSProperties = {
  display: 'flex',
  gap: '3px',
  flexShrink: 0,
};

export const wfCount: React.CSSProperties = {
  fontSize: '10px',
  color: COLORS.mut,
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

export const wfChev: React.CSSProperties = {
  fontSize: '10px',
  color: COLORS.dim,
  flexShrink: 0,
};

export const prog: React.CSSProperties = {
  display: 'flex',
  height: '2px',
  margin: '0 12px 8px',
  borderRadius: '1px',
  overflow: 'hidden',
  background: COLORS.border,
};

export function taskRow(isHovered: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '5px 6px',
    borderRadius: '6px',
    fontSize: '11px',
    background: isHovered ? COLORS.hover : 'transparent',
  };
}

export function taskIcon(status: string): React.CSSProperties {
  const base: React.CSSProperties = {
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '8px',
    flexShrink: 0,
    border: '1.5px solid transparent',
  };
  if (status === 'completed') return { ...base, background: COLORS.ok, color: '#fff', borderColor: COLORS.ok };
  if (status === 'running') return { ...base, background: COLORS.run, borderColor: COLORS.run, boxShadow: `0 0 4px rgba(59,130,246,.4)` };
  if (status === 'pending') return { ...base, background: 'transparent', borderColor: COLORS.pend };
  if (status === 'failed') return { ...base, background: COLORS.err, color: '#fff', borderColor: COLORS.err };
  return { ...base, background: 'transparent', borderColor: COLORS.dim };
}

export const taskId: React.CSSProperties = {
  fontFamily: 'ui-monospace,SFMono-Regular,Consolas,monospace',
  fontSize: '10px',
  fontWeight: 500,
  color: 'var(--dim, #7d7d94)',
  width: '20px',
  flexShrink: 0,
};

export const taskTitle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 500,
};

export const taskWho: React.CSSProperties = {
  fontSize: '10px',
  color: COLORS.dim,
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

export const fab: React.CSSProperties = {
  position: 'absolute',
  bottom: '16px',
  right: '16px',
  width: '40px',
  height: '40px',
  borderRadius: '50%',
  background: COLORS.acc,
  color: '#fff',
  border: 'none',
  fontSize: '20px',
  fontWeight: 300,
  cursor: 'pointer',
  zIndex: 20,
  boxShadow: 'var(--fab-shadow, 0 4px 16px rgba(99,102,241,.35))',
};

export const overlayMask: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(5,5,10,.7)',
  backdropFilter: 'blur(4px)',
  zIndex: 25,
};

export function dispatchPanel(open: boolean): React.CSSProperties {
  return {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 30,
    background: COLORS.card,
    borderTop: `1px solid ${COLORS.border}`,
    borderRadius: '12px 12px 0 0',
    padding: '14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    transform: open ? 'translateY(0)' : 'translateY(100%)',
    transition: 'transform .25s ease-out',
  };
}

export const dispatchHead: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

export const dispatchClose: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: COLORS.mut,
  fontSize: '16px',
  cursor: 'pointer',
  padding: '0 4px',
};

export const input: React.CSSProperties = {
  background: COLORS.bg,
  border: `1px solid ${COLORS.border2}`,
  borderRadius: '6px',
  color: COLORS.txt,
  padding: '7px 9px',
  fontSize: '12px',
  fontFamily: 'inherit',
  outline: 'none',
  width: '100%',
};

export const textarea: React.CSSProperties = {
  ...input,
  resize: 'vertical',
  minHeight: '72px',
};

export const label: React.CSSProperties = {
  fontSize: '10px',
  color: COLORS.mut,
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
};

export const dispatchBtn: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  borderRadius: '8px',
  background: COLORS.acc,
  color: '#fff',
  fontSize: '12px',
  fontWeight: 600,
  padding: '8px 14px',
  cursor: 'pointer',
  width: '100%',
};

export const toast: React.CSSProperties = {
  position: 'absolute',
  top: '12px',
  left: '12px',
  right: '12px',
  zIndex: 40,
  background: 'var(--toast-bg, rgba(34,197,94,.12))',
  border: '1px solid var(--toast-border, rgba(34,197,94,.3))',
  color: 'var(--toast-color, #86efac)',
  borderRadius: '6px',
  padding: '8px 12px',
  fontSize: '11px',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
};

export const section: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 600,
  color: COLORS.dim,
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  padding: '8px 4px 4px',
};

export const empty: React.CSSProperties = {
  color: COLORS.dim,
  fontSize: '12px',
  padding: '8px 0',
  textAlign: 'center',
};

export const body: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '0 12px 56px',
  position: 'relative',
};

export const dagToggle: React.CSSProperties = {
  fontSize: '10px',
  color: COLORS.mut,
  cursor: 'pointer',
  padding: '4px 12px',
  userSelect: 'none',
};

export const dagIconBtn: React.CSSProperties = {
  appearance: 'none',
  border: `1px solid ${COLORS.border2}`,
  background: COLORS.bg,
  color: 'var(--dim, #7d7d94)',
  fontSize: '12px',
  borderRadius: '6px',
  padding: '2px 6px',
  cursor: 'pointer',
  flexShrink: 0,
  lineHeight: 1,
};

export const dagIconBtnActive: React.CSSProperties = {
  ...dagIconBtn,
  color: 'var(--acc, #6366f1)',
  borderColor: 'var(--acc, #6366f1)',
};

export function dagWrap(open: boolean): React.CSSProperties {
  return {
    overflow: 'hidden',
    maxHeight: open ? '400px' : '0',
    transition: 'max-height .25s ease-out',
  };
}

export const dagInner: React.CSSProperties = {
  overflowX: 'auto',
  borderTop: `1px solid ${COLORS.border}`,
  background: COLORS.bg,
  padding: '8px',
};

export const progWrap: React.CSSProperties = {
  position: 'relative',
  padding: '4px 0',
  margin: '0 12px 4px',
  cursor: 'default',
};

export const progTip: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: '50%',
  transform: 'translateX(-50%)',
  marginBottom: '4px',
  background: 'var(--txt, #e4e4ed)',
  color: 'var(--bg, #0a0a0f)',
  fontSize: '10px',
  padding: '4px 8px',
  borderRadius: '4px',
  whiteSpace: 'nowrap',
  zIndex: 5,
};

/* ── 归档 / 恢复 ── */
const chipBtn: React.CSSProperties = {
  appearance: 'none',
  fontSize: '10px',
  fontWeight: 600,
  borderRadius: '999px',
  padding: '1px 9px',
  cursor: 'pointer',
  flexShrink: 0,
};

/* 归档：默认幽灵态（不抢视觉），悬停才升级为琥珀，避免琥珀语义过载 */
export const archBtn: React.CSSProperties = {
  ...chipBtn,
  border: `1px solid ${COLORS.border2}`,
  background: 'transparent',
  color: 'var(--mut, #8b8b9e)',
  transition: 'border-color .15s, color .15s, background .15s',
};
export const archBtnHover: React.CSSProperties = {
  ...archBtn,
  borderColor: 'var(--arch-border-h, rgba(245,158,11,.8))',
  background: 'var(--arch-bg-h, rgba(245,158,11,.22))',
  color: 'var(--arch, #fbbf24)',
};
export const restoreBtn: React.CSSProperties = {
  ...chipBtn,
  border: '1px solid var(--restore-border, rgba(34,197,94,.5))',
  background: 'var(--restore-bg, rgba(34,197,94,.13))',
  color: 'var(--restore, #86efac)',
};
export const restoreBtnHover: React.CSSProperties = {
  ...restoreBtn,
  borderColor: 'var(--restore-border-h, rgba(34,197,94,.8))',
  background: 'var(--restore-bg-h, rgba(34,197,94,.22))',
};
export const archLine: React.CSSProperties = {
  padding: '6px 12px',
  display: 'flex',
  alignItems: 'center',
  gap: '7px',
  border: `1px dashed ${COLORS.border2}`,
  borderRadius: '6px',
  marginBottom: '6px',
  background: COLORS.card,
};

export const archSection: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 600,
  color: COLORS.dim,
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  padding: '8px 4px 4px',
  cursor: 'pointer',
  userSelect: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
};

export const archChev: React.CSSProperties = {
  fontSize: '10px',
  transition: 'transform .2s',
  display: 'inline-block',
};

export const archChevCollapsed: React.CSSProperties = {
  ...archChev,
  transform: 'rotate(-90deg)',
};

export const archList: React.CSSProperties = {
  overflow: 'hidden',
  maxHeight: '1000px',
  transition: 'max-height .3s ease-out',
};

export const archListCollapsed: React.CSSProperties = {
  overflow: 'hidden',
  maxHeight: '0',
  transition: 'max-height .3s ease-out',
};

/* ── 任务展开详情（生命周期时间线 + 里程碑 + result） ── */
export const taskRowStale: React.CSSProperties = {
  borderColor: 'var(--warn-border, rgba(245,158,11,.45))',
};
export const taskHead: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '5px 6px',
  cursor: 'pointer',
  minWidth: 0,
  width: '100%',
};
export const taskBody: React.CSSProperties = {
  padding: '2px 8px 8px',
  borderTop: `1px dashed ${COLORS.border}`,
  margin: '4px 4px 0',
  width: '100%',
  flexBasis: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};
export const kv: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px 12px',
  fontSize: '10px',
  color: COLORS.mut,
};
export const kvBold: React.CSSProperties = { color: COLORS.txt, fontWeight: 600 };
export const log: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  fontSize: '10px',
  color: COLORS.mut,
};
export const logRow: React.CSSProperties = {
  display: 'flex',
  gap: '6px',
  alignItems: 'baseline',
};
export const logTag: React.CSSProperties = {
  color: COLORS.dim,
  fontFamily: 'ui-monospace,SFMono-Regular,Consolas,monospace',
  fontSize: '9px',
  flexShrink: 0,
};
export const pre: React.CSSProperties = {
  background: COLORS.bg,
  border: `1px solid ${COLORS.border}`,
  borderRadius: '6px',
  padding: '6px 8px',
  fontSize: '10px',
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: '180px',
  overflowY: 'auto',
  color: COLORS.txt,
  margin: 0,
};
export const hbOk: React.CSSProperties = { color: COLORS.ok };
export const hbStale: React.CSSProperties = { color: 'var(--warn, #f59e0b)' };

/* ── DAG 节点心跳停滞预警（running + 心跳超 90s → 琥珀呼吸） ── */
export const dagNodeStale: React.CSSProperties = {
  fill: 'var(--dag-node-fill, #12121a)',
  stroke: 'var(--warn, #f59e0b)',
  strokeWidth: 2,
};

/* ── 主题切换按钮 ── */
export const themeBtn: React.CSSProperties = {
  appearance: 'none',
  border: `1px solid var(--border2, #2a2a3e)`,
  background: 'var(--card, #12121a)',
  color: 'var(--txt, #e4e4ed)',
  fontSize: '13px',
  lineHeight: 1,
  borderRadius: '6px',
  padding: '3px 7px',
  cursor: 'pointer',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
};

export const themeDropdown: React.CSSProperties = {
  position: 'relative',
  flexShrink: 0,
};

export const themeMenu: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  right: 0,
  zIndex: 100,
  background: 'var(--card, #12121a)',
  border: `1px solid var(--border, #1e1e2e)`,
  borderRadius: '8px',
  padding: '4px',
  minWidth: '140px',
  boxShadow: '0 4px 12px rgba(0,0,0,.15)',
};

export const themeItem: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '6px 8px',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '12px',
  color: 'var(--txt, #e4e4ed)',
};

export const themeItemActive: React.CSSProperties = {
  ...themeItem,
  background: 'var(--hover, #1a1a26)',
  color: 'var(--acc, #6366f1)',
};

export const themeGroup: React.CSSProperties = {
  fontSize: '9px',
  color: 'var(--dim, #7d7d94)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  padding: '6px 8px 2px',
};

export const dispatchBtnDisabled: React.CSSProperties = {
  background: 'var(--border2, #2a2a3e)',
  color: '#6b7280',
  cursor: 'not-allowed',
  border: '1px solid var(--border2, #2a2a3e)',
};


/* ── Markdown 结果样式（内联版） ── */
export const mdResult: React.CSSProperties = {
  position: 'relative',
  background: COLORS.bg,
  border: `1px solid ${COLORS.border}`,
  borderRadius: '6px',
  padding: '8px 10px',
  fontSize: '11px',
  lineHeight: 1.6,
  maxHeight: '100px',
  overflow: 'hidden',
  color: COLORS.txt,
  transition: 'max-height .3s ease',
};

export const mdResultExpanded: React.CSSProperties = {
  ...mdResult,
  maxHeight: '240px',
  overflowY: 'auto',
};

export const mdExpandBtn: React.CSSProperties = {
  position: 'absolute',
  bottom: '6px',
  right: '8px',
  zIndex: 2,
  appearance: 'none',
  border: `1px solid ${COLORS.border2}`,
  background: COLORS.card,
  color: COLORS.mut,
  fontSize: '10px',
  borderRadius: '999px',
  padding: '1px 8px',
  cursor: 'pointer',
};

export const mdCopyBtn: React.CSSProperties = {
  position: 'absolute',
  top: '6px',
  right: '6px',
  zIndex: 2,
  appearance: 'none',
  border: `1px solid ${COLORS.border2}`,
  background: COLORS.card,
  color: COLORS.txt,
  fontSize: '10px',
  fontWeight: 600,
  borderRadius: '999px',
  padding: '2px 10px',
  cursor: 'pointer',
};

export const mdP: React.CSSProperties = { margin: '0 0 8px' };
export const mdH1: React.CSSProperties = { fontSize: '14px', fontWeight: 600, margin: '12px 0 6px', borderBottom: `1px solid ${COLORS.border}`, paddingBottom: '4px' };
export const mdH2: React.CSSProperties = { fontSize: '13px', fontWeight: 600, margin: '10px 0 5px' };
export const mdH3: React.CSSProperties = { fontSize: '12px', fontWeight: 600, margin: '8px 0 4px' };
export const mdH4: React.CSSProperties = { fontSize: '11px', fontWeight: 600, margin: '6px 0 3px' };
export const mdUl: React.CSSProperties = { margin: '0 0 8px', paddingLeft: '16px' };
export const mdOl: React.CSSProperties = { margin: '0 0 8px', paddingLeft: '16px' };
export const mdLi: React.CSSProperties = { margin: '2px 0' };
export const mdPre: React.CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border2}`,
  borderRadius: '4px',
  padding: '6px 8px',
  margin: '6px 0',
  overflowX: 'auto',
  fontSize: '10px',
};
export const mdCode: React.CSSProperties = {
  fontFamily: 'ui-monospace,SFMono-Regular,Consolas,monospace',
  fontSize: '10px',
  lineHeight: 1.5,
};
export const mdQuote: React.CSSProperties = {
  borderLeft: `3px solid ${COLORS.acc}`,
  paddingLeft: '8px',
  margin: '6px 0',
  color: COLORS.mut,
  fontStyle: 'italic',
};
export const mdHr: React.CSSProperties = {
  border: 'none',
  borderTop: `1px solid ${COLORS.border}`,
  margin: '8px 0',
};
