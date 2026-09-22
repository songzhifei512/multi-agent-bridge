import React from 'react';

interface StickyHeaderProps {
  stat: Record<string, number>;
  connected: boolean;
  controller?: string;
  controllerLabel?: string;
}

export function StickyHeader({ stat, connected, controller, controllerLabel }: StickyHeaderProps) {
  return (
    <div className="ma-header">
      <div className="ma-header-row">
        <span className={`ma-conn ${connected ? 'on' : ''}`} />
        <span className="ma-header-title">Multi-Agent</span>
        <span className="ma-ctrl" title={`controller: ${controller || '?'}`}>
          {controllerLabel || controller || '—'}
        </span>
      </div>
      <div className="ma-stats-row">
        <span className="ma-stat run"><b>{stat.running || 0}</b>运行</span>
        <span className="ma-stat pend"><b>{stat.pending || 0}</b>待领</span>
        <span className="ma-stat ok"><b>{stat.completed || 0}</b>完成</span>
        <span className="ma-stat err"><b>{stat.failed || 0}</b>失败</span>
      </div>
    </div>
  );
}
