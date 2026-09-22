import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as S from '../inlineStyles';

interface DagNode {
  id: string;
  x: number;
  y: number;
  status: string;
  title: string;
  assignee: string | null;
  dependencies: string[];
  evolve: string | null;
  last_heartbeat_at?: any;
}
interface DagEdge {
  from: string;
  to: string;
  path: string;
}
interface Dag {
  width: number;
  height: number;
  nodes: DagNode[];
  edges: DagEdge[];
  stages: number;
}

const NODE_W = 150;
const NODE_H = 34;
const MET = new Set(['completed', 'superseded', 'cancelled']);
const HBT_STALE_MS = 90000;

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// B. DAG 连线着色：依赖(from)终态且非失败 → 绿；失败/取消 → 红；进行/待执行 → 黄/灰
function edgeColor(from: DagNode | undefined): string {
  if (!from) return 'var(--pend, #eab308)';
  if (from.status === 'failed' || from.status === 'cancelled') return 'var(--err, #ef4444)';
  if (MET.has(from.status)) return 'var(--ok, #22c55e)';
  return 'var(--dim, #7d7d94)';
}

function nodeStroke(status: string): string {
  if (status === 'running') return 'var(--run, #3b82f6)';
  if (status === 'completed') return 'var(--ok, #22c55e)';
  if (status === 'failed') return 'var(--err, #ef4444)';
  if (status === 'pending') return 'var(--pend, #eab308)';
  if (['awaiting_approval', 'escalating'].includes(status)) return 'var(--pend, #eab308)';
  if (['superseded', 'cancelled', 'interrupted'].includes(status)) return 'var(--dim, #7d7d94)';
  return 'var(--dim, #7d7d94)';
}

// A. 心跳停滞预警：running 节点 last_heartbeat_at 超 90s → 琥珀呼吸（SMIL animate，免 CSS 注入）
function isStale(n: DagNode, now: number): boolean {
  return (
    n.status === 'running' &&
    !!n.last_heartbeat_at &&
    now - new Date(n.last_heartbeat_at as any).getTime() > HBT_STALE_MS
  );
}

interface InlineDagProps {
  dag: Dag;
  shorts: Map<string, string>;
  /** 嵌入模式：由父组件控制展开状态，不显示自身 toggle */
  embedded?: boolean;
  /** 外部控制的打开状态（embedded 模式下使用） */
  open?: boolean;
  /** 外部控制的切换函数（embedded 模式下使用） */
  onToggle?: (e: React.MouseEvent) => void;
  /** 离线缓存快照：冻结心跳停滞判断（陈旧心跳不闪琥珀） */
  frozen?: boolean;
}

export function InlineDag({ dag, shorts, embedded, open: externalOpen, onToggle, frozen }: InlineDagProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = embedded ? externalOpen : internalOpen;
  const scrollRef = useRef<HTMLDivElement>(null);

  const nodeById = useMemo(() => {
    const m = new Map<string, DagNode>();
    dag.nodes.forEach(n => m.set(n.id, n));
    return m;
  }, [dag]);

  const now = Date.now();

  // 可发现性：宽 DAG 默认从左侧开始，自动滚到第一个运行中/待领取节点附近
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const t = requestAnimationFrame(() => {
      const target =
        dag.nodes.find(n => n.status === 'running') ||
        dag.nodes.find(n => n.status === 'pending');
      if (target && target.x + NODE_W > el.clientWidth) {
        el.scrollLeft = Math.max(0, target.x - 24);
      }
    });
    return () => cancelAnimationFrame(t);
  }, [dag]);

  if (!dag || !dag.nodes || dag.nodes.length === 0) return null;

  const scrollable = dag.width > 380;

  const handleToggle = (e: React.MouseEvent) => {
    if (embedded && onToggle) {
      onToggle(e);
    } else {
      setInternalOpen(v => !v);
    }
  };

  const dagContent = (
    <div style={{ position: 'relative' }}>
      <div ref={scrollRef} style={S.dagInner}>
        <svg width={dag.width} height={dag.height} viewBox={`0 0 ${dag.width} ${dag.height}`} style={{ display: 'block' }}>
        {dag.edges.map(e => (
          <path
            key={`${e.from}->${e.to}`}
            d={e.path}
            stroke={edgeColor(nodeById.get(e.from))}
            strokeWidth={1.5}
            fill="none"
            opacity={0.75}
          />
        ))}
        {dag.nodes.map(n => {
          const stale = !frozen && isStale(n, now);
          return (
            <g key={n.id} transform={`translate(${n.x},${n.y})`}>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={5}
                fill="var(--dag-node-fill, #12121a)"
                stroke={stale ? '#f59e0b' : nodeStroke(n.status)}
                strokeWidth={stale ? 2 : 1.5}
              >
                {stale && (
                  <>
                    <animate attributeName="stroke-width" values="2;3.4;2" dur="1.6s" repeatCount="indefinite" />
                    <animate attributeName="stroke-opacity" values="1;.55;1" dur="1.6s" repeatCount="indefinite" />
                  </>
                )}
              </rect>
              <text x={8} y={14} fill="var(--acc, #6366f1)" fontSize={9} fontWeight={700}>
                {shorts.get(n.id) || n.id}
              </text>
              <text x={8} y={27} fill="var(--txt, #e4e4ed)" fontSize={9}>
                {truncate(n.title || '', 16)}
              </text>
              {n.evolve && (
                <text x={NODE_W - 8} y={14} fill="var(--pend, #eab308)" fontSize={8} textAnchor="end">
                  {n.evolve === 'fork' ? 'fork' : 'repoint'}
                </text>
              )}
            </g>
          );
        })}
        </svg>
      </div>
      {scrollable && (
        <div
          title="依赖图可横向滚动"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: 28,
            pointerEvents: 'none',
            background: 'linear-gradient(to right, transparent, var(--bg, #0a0a0f))',
          }}
        />
      )}
    </div>
  );

  // embedded 模式：直接渲染 DAG 内容（不带 toggle 和 wrap）
  if (embedded) {
    return dagContent;
  }

  return (
    <>
      <div style={S.dagToggle} onClick={handleToggle}>
        {isOpen ? '▾' : ''} {isOpen ? '收起依赖图' : '查看依赖图'}
      </div>
      <div style={S.dagWrap(!!isOpen)}>
        {dagContent}
      </div>
    </>
  );
}
