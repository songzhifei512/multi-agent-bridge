/**
 * 构建 bridge-ui 原型预览 — 真实组件 + 模拟数据 → 单文件 HTML（唯一预览入口）
 * 运行：cd qoder-panel && node build-preview.mjs
 * 产物（自动生成，勿手改）：../bridge-ui/preview/preview.html
 * 视角切换用 URL 参数：?theme=light ?offline=1 ?dispatch=1 ?dag ?openTask=1 ?fit=0
 */
import * as esbuild from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const previewDir = resolve(here, '../bridge-ui/preview');

const result = await esbuild.build({
  entryPoints: [resolve(previewDir, 'main.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
  target: 'chrome120',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  jsx: 'automatic',
  alias: {
    'bridge-ui': resolve(here, '../bridge-ui/src'),
    'react': resolve(here, 'node_modules/react'),
    'react/jsx-runtime': resolve(here, 'node_modules/react/jsx-runtime.js'),
    'react/jsx-dev-runtime': resolve(here, 'node_modules/react/jsx-dev-runtime.js'),
    'react-dom': resolve(here, 'node_modules/react-dom'),
    'react-dom/client': resolve(here, 'node_modules/react-dom/client.js'),
  },
  absWorkingDir: here, // react 等依赖从 qoder-panel/node_modules 解析
});

const js = result.outputFiles[0].text;

/* markdown 渲染器输出的类名样式 + 页面外壳（预览专用，非 webview 环境无 CSP 限制） */
const css = `
html,body{margin:0;padding:0;background:#0a0a0f;}
html::-webkit-scrollbar,body::-webkit-scrollbar{display:none;}
*::-webkit-scrollbar{width:6px;height:6px;}
*::-webkit-scrollbar-track{background:transparent;}
*::-webkit-scrollbar-thumb{background:#2a2a3e;border-radius:3px;}
.md-p{margin:0 0 8px}
.md-h1{font-size:14px;font-weight:600;margin:12px 0 6px;border-bottom:1px solid #1e1e2e;padding-bottom:4px}
.md-h2{font-size:13px;font-weight:600;margin:10px 0 5px}
.md-h3{font-size:12px;font-weight:600;margin:8px 0 4px}
.md-h4{font-size:11px;font-weight:600;margin:6px 0 3px}
.md-ul,.md-ol{margin:0 0 8px;padding-left:16px}
.md-li{margin:2px 0}
.md-pre{background:#12121a;border:1px solid #2a2a3e;border-radius:4px;padding:6px 8px;margin:6px 0;overflow-x:auto;font-size:10px}
.md-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;background:#1a1a26;border-radius:3px;padding:0 4px}
.md-quote{border-left:3px solid #6366f1;padding-left:8px;margin:6px 0;color:#6b6b80;font-style:italic}
.md-hr{border:none;border-top:1px solid #1e1e2e;margin:8px 0}
.md-table{border-collapse:collapse;font-size:10px;margin:6px 0}
.md-th,.md-td{border:1px solid #2a2a3e;padding:3px 8px;text-align:left}
.md-th{background:#12121a;font-weight:600}
a{color:#6366f1}
select,textarea{font-family:inherit}
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Multi-Agent Bridge — UI 原型预览</title>
<style>${css}</style>
<script>
// 截图适配：把 420px 面板等比缩放到视口宽度（无头浏览器无法设置更小的窗口宽度）
// ?fit=0 可关闭，正常浏览时按原始 420px 渲染
(function () {
  if (new URLSearchParams(location.search).get('fit') === '0') return;
  var z = window.innerWidth / 420;
  document.documentElement.style.zoom = String(z);
  // zoom 不影响 vh 单位：给出缩放修正后的视口高度，供面板容器 1:1 占满窗口
  document.documentElement.style.setProperty('--fit-h', (window.innerHeight / z) + 'px');
})();
</script>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>`;

// 唯一入口：路径固定（截图回归脚本引用它）；不同视角用 URL 参数切换
writeFileSync(resolve(previewDir, 'preview.html'), html, 'utf-8');
console.log('[preview] build done →', resolve(previewDir, 'preview.html'));
