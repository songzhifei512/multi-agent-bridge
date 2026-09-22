// bridge-ui — 共享 Multi-Agent Bridge 控制台 UI 模块
// 不独立构建，由消费端（dsh-panel / qoder-panel）通过 esbuild alias 引用源码

// 样式（保留用于 DSH Desktop）
export { injectStyles } from './styles';

// 内联样式（Qoder CN webview 专用）
export * as inlineStyles from './inlineStyles';

// Hooks
export { useBridgeState } from './hooks/useBridgeState';
export type { BridgeState } from './hooks/useBridgeState';
export { useOfflineState, postToBridge } from './hooks/useOfflineState';
export type { OfflineState } from './hooks/useOfflineState';
export { useTheme, THEME_LIST } from './hooks/useTheme';
export type { Theme, ThemeOption, UseThemeResult } from './hooks/useTheme';

// 组件
export { StickyHeader } from './components/StickyHeader';
export { WorkflowCard, ArchSection } from './components/WorkflowCard';
export { TaskRow } from './components/TaskRow';
export { InlineDag } from './components/InlineDag';
export { FAB, DispatchOverlay, Toast } from './components/DispatchOverlay';
export { OfflineBanner } from './components/OfflineBanner';
export { DagGraph } from './components/DagGraph';
export type { DagNode, DagEdge, Dag } from './components/DagGraph';
export { renderMarkdown } from './utils/markdown';
export { ThemeToggle } from './components/ThemeToggle';
