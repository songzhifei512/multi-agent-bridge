import React, { useMemo } from 'react';

export interface DagNode {
  id: string;
  x: number;
  y: number;
  status: string;
  title: string;
  assignee: string | null;
  dependencies: string[];
  evolve: string | null;
  last_heartbeat_at?: number | string | null;
}
export interface DagEdge {
  from: string;
  to: string;
  path: string;
}
export interface Dag {
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

// B. DAG 连线着色：依赖(from)终态且非失败 → 绿；失败/取消 → 红；进行/待执行 → 灰虚线
function edgeCls(from: DagNode | undefined): string {
  if (!from) return 'wait';
  if (from.status === 'failed' || from.status === 'cancelled') return 'fail';
  if (MET.has(from.status)) return 'ok';
  return 'wait';
}

// A. 心跳停滞预警：running 节点 last_heartbeat_at 超 90s → 琥珀呼吸
function isStale(n: DagNode, now: number): boolean {
  return (
    n.status === 'running' &&
    !!n.last_heartbeat_at &&
    now - new Date(n.last_heartbeat_at as any).getTime() > HBT_STALE_MS
  );
}

export function DagGraph({ dag, shorts }: { dag: Dag; shorts: Map<string, string> }) {
  const nodeById = useMemo(() => {
    const m = new Map<string, DagNode>();
    (dag?.nodes || []).forEach(n => m.set(n.id, n));
    return m;
  }, [dag]);
  const now = Date.now();

  if (!dag || !dag.nodes || dag.nodes.length === 0) return null;
  return (
    <div className="ma-dagwrap">
      <svg
        className="ma-dag"
        width={dag.width}
        height={dag.height}
        viewBox={`0 0 ${dag.width} ${dag.height}`}
      >
        {dag.edges.map(e => (
          <path
            key={`${e.from}->${e.to}`}
            d={e.path}
            className={`ma-dag-edge ${edgeCls(nodeById.get(e.from))}`}
          />
        ))}
        {dag.nodes.map(n => (
          <g key={n.id} transform={`translate(${n.x},${n.y})`}>
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={7}
              className={`ma-dag-node stk-${n.status}${isStale(n, now) ? ' stale' : ''}`}
            />
            <text x={8} y={14} className="ma-dag-txt tid">
              {shorts.get(n.id) || n.id}
            </text>
            <text x={8} y={27} className="ma-dag-txt">
              {truncate(n.title || '', 16)}
            </text>
            {n.evolve && (
              <text x={NODE_W - 8} y={14} className="ma-dag-evolve" textAnchor="end">
                {n.evolve === 'fork' ? 'fork' : 'repoint'}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}