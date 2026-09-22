import React, { useEffect, useRef, useState } from 'react';
import type { Theme, ThemeOption } from '../hooks/useTheme';

interface ThemeToggleProps {
  theme: Theme;
  onToggle?: () => void;
  setTheme?: (t: Theme) => void;
  themeList?: ThemeOption[];
}

/**
 * 主题切换下拉菜单
 *
 * 向后兼容：
 * - 旧用法：<ThemeToggle theme={theme} onToggle={toggle} />
 * - 新用法：<ThemeToggle theme={theme} setTheme={setTheme} themeList={themeList} />
 */
export function ThemeToggle({ theme, onToggle, setTheme, themeList }: ThemeToggleProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const currentIcon = themeList?.find(t => t.value === theme)?.icon
    ?? (theme === 'dark' ? '🌙' : '☀️');

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleBtnClick = () => {
    if (setTheme && themeList && themeList.length > 0) {
      setOpen(v => !v);
    } else if (onToggle) {
      // 旧 API：直接切换
      onToggle();
    }
  };

  const handleSelect = (t: Theme) => {
    if (setTheme) setTheme(t);
    setOpen(false);
  };

  // 按 group 分组
  const grouped: Array<{ group: string; items: ThemeOption[] }> = [];
  if (themeList && themeList.length > 0) {
    for (const item of themeList) {
      let g = grouped.find(g => g.group === item.group);
      if (!g) {
        g = { group: item.group, items: [] };
        grouped.push(g);
      }
      g.items.push(item);
    }
  }

  // 如果没有提供 themeList 和 setTheme，退化为旧版按钮样式
  if (!themeList || !setTheme) {
    return (
      <button
        className="ma-theme-btn"
        onClick={handleBtnClick}
        title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
      >
        {currentIcon}
      </button>
    );
  }

  return (
    <div className="ma-theme-dropdown" ref={ref}>
      <button
        className="ma-theme-btn"
        onClick={handleBtnClick}
        title="切换主题"
      >
        {currentIcon}
        <span style={{ fontSize: 9, opacity: 0.6 }}>▾</span>
      </button>
      <div className={`ma-theme-menu${open ? ' open' : ''}`}>
        {grouped.map(g => (
          <React.Fragment key={g.group}>
            <div className="ma-theme-group">{g.group}</div>
            {g.items.map(item => (
              <div
                key={item.value}
                className={`ma-theme-item${theme === item.value ? ' active' : ''}`}
                onClick={() => handleSelect(item.value)}
              >
                <span className="ma-theme-icon">{item.icon}</span>
                <span className="ma-theme-label">{item.label}</span>
                {theme === item.value && <span style={{ fontSize: 10 }}>✓</span>}
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
