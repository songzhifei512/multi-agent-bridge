import * as esbuild from 'esbuild';
import { resolve } from 'node:path';

const isWatch = process.argv.includes('--watch');

// Node.js 后端 → CJS
// 外部依赖：无（纯 Node.js 标准库）
await esbuild.build({
  entryPoints: ['src/node/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/node/main.cjs',
  target: 'node18',
  sourcemap: false,
});

// Browser 前端 → CJS
// React 和 ReactDOM 由 Qoder CN 宿主提供，标记为 external
// bridge-ui 通过 alias 解析到共享模块源码
await esbuild.build({
  entryPoints: ['src/browser/view.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  outfile: 'dist/browser/view.cjs',
  target: 'chrome120',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  jsx: 'automatic',
  alias: {
    'bridge-ui': resolve(import.meta.dirname, '../bridge-ui/src'),
  },
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
});

console.log('[qoder-panel] build done');

if (isWatch) {
  console.log('[qoder-panel] watching for changes...');
  const { watch } = await import('node:fs');
  watch('src', { recursive: true }, () => {
    console.log('[qoder-panel] change detected, rebuilding...');
  });
}
