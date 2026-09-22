import { useCallback, useState } from 'react';

export type Theme = 'dark' | 'light' | 'eye-care' | 'sepia' | 'high-contrast' | 'mono';

export interface ThemeOption {
  value: Theme;
  label: string;
  icon: string;
  group: string;
}

export const THEME_LIST: ThemeOption[] = [
  { value: 'dark', label: '深色', icon: '🌙', group: '基础' },
  { value: 'light', label: '浅色', icon: '☀️', group: '基础' },
  { value: 'eye-care', label: '护眼绿', icon: '🌿', group: '护眼' },
  { value: 'sepia', label: '羊皮纸', icon: '📜', group: '护眼' },
  { value: 'high-contrast', label: '高对比', icon: '◐', group: '特殊' },
  { value: 'mono', label: '灰度', icon: '⬛', group: '特殊' },
];

const ALL_THEMES: Theme[] = ['dark', 'light', 'eye-care', 'sepia', 'high-contrast', 'mono'];

function isValidTheme(v: string | null): v is Theme {
  return ALL_THEMES.includes(v as Theme);
}

export interface UseThemeResult {
  theme: Theme;
  setTheme: (t: Theme) => void;
  cycleTheme: () => void;
  toggle: () => void;
  themeList: ThemeOption[];
  // 元组兼容
  0: Theme;
  1: () => void;
  [Symbol.iterator](): Iterator<Theme | (() => void)>;
}

/**
 * 主题状态：跟随系统偏好（首次）或 localStorage 记忆（切换后）。
 * 由壳（dsh-panel / qoder-panel）应用到根节点 data-theme 属性,
 * 配合 styles.ts 的 CSS 自定义属性（--bg/--card/…）实现多主题。
 *
 * 支持两种调用方式：
 * - 元组（向后兼容）：const [theme, toggle] = useTheme()
 * - 对象（新 API）：const { theme, setTheme, cycleTheme, themeList } = useTheme()
 */
export function useTheme(): UseThemeResult {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem('ma-theme');
      if (isValidTheme(saved)) return saved;
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem('ma-theme', t);
    } catch {
      /* 忽略存储不可用 */
    }
  }, []);

  const cycleTheme = useCallback(() => {
    setThemeState(t => {
      const idx = ALL_THEMES.indexOf(t);
      const n = ALL_THEMES[(idx + 1) % ALL_THEMES.length];
      try {
        localStorage.setItem('ma-theme', n);
      } catch {
        /* 忽略存储不可用 */
      }
      return n;
    });
  }, []);

  const result = {
    theme,
    setTheme,
    cycleTheme,
    toggle: cycleTheme, // 向后兼容别名
    themeList: THEME_LIST,
    0: theme,
    1: cycleTheme,
    [Symbol.iterator]: function* () {
      yield result.theme;
      yield result.toggle;
    },
  } as UseThemeResult;

  // 每次重新渲染时更新 0 和 1 的值以及迭代器
  result[0] = theme;
  result[1] = cycleTheme;

  return result;
}
