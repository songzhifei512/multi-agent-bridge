import React, { useState } from 'react';

interface DagNode {
  id: string;
  x: number;
  y: number;
  status: string;
  title: string;
  assignee: string | null;
  dependencies: string[];
  evolve: string | null;
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

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function InlineDag({ dag, shorts }: { dag: Dag; shorts: Map<string, string> }) {
  const [open, setOpen] = useState(false);

  if (!dag || !dag.nodes || dag.nodes.length === 0) return null;

  return (
    <>
      <div className="ma-dag-toggle" onClick={() => setOpen(v => !v)}>
        {open ? '▾' : '▸'} {open ? '收起依赖图' : '查看依赖图'}
      </div>
      <div className={`ma-dag-wrap${open ? ' open' : ''}`}>
        <div className="ma-dag-inner">
          <svg
            className="ma-dag"
            width={dag.width}
            height={dag.height}
            viewBox={`0 0 ${dag.width} ${dag.height}`}
          >
            {dag.edges.map(e => (
              <path key={`${e.from}->${e.to}`} d={e.path} className="ma-dag-edge" />
            ))}
            {dag.nodes.map(n => (
              <g key={n.id} transform={`translate(${n.x},${n.y})`}>
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={5}
                  className={`ma-dag-node stk-${n.status}`}
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
      </div>
    </>
  );
}
