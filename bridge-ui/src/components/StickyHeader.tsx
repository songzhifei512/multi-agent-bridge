import React from 'react';
import * as S from '../inlineStyles';
import { ThemeToggle } from './ThemeToggle';
import type { Theme, ThemeOption } from '../hooks/useTheme';

interface StickyHeaderProps {
  stat: Record<string, number>;
  connected: boolean;
  controller?: string;
  controllerLabel?: string;
  theme?: Theme;
  onToggleTheme?: () => void;
  setTheme?: (t: Theme) => void;
  themeList?: ThemeOption[];
}

export function StickyHeader({ stat, connected, controller, controllerLabel, theme, onToggleTheme, setTheme, themeList }: StickyHeaderProps) {
  return (
    <div style={S.header}>
      <div style={S.headerRow}>
        <span style={connected ? S.connOn : S.conn} />
        <span style={S.headerTitle}>Multi-Agent</span>
        {theme && (onToggleTheme || setTheme) && (
          <ThemeToggle theme={theme} onToggle={onToggleTheme} setTheme={setTheme} themeList={themeList} />
        )}
        <span style={S.ctrl} title={`controller: ${controller || '?'}`}>
          {controllerLabel || controller || '—'}
        </span>
      </div>
      <div style={S.statsRow}>
        <span style={S.stat('run')}><b style={{ ...S.statBold, color: 'var(--run, #3b82f6)' }}>{stat.running || 0}</b>运行</span>
        <span style={S.stat('pend')}><b style={{ ...S.statBold, color: 'var(--pend, #eab308)' }}>{stat.pending || 0}</b>待领取</span>
        <span style={S.stat('ok')}><b style={{ ...S.statBold, color: 'var(--ok, #22c55e)' }}>{stat.completed || 0}</b>完成</span>
        <span style={S.stat('err')}><b style={{ ...S.statBold, color: 'var(--err, #ef4444)' }}>{stat.failed || 0}</b>失败</span>
      </div>
    </div>
  );
}
