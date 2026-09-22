# dsh-panel -> Qoder CN 适配方案

> 将 multi-agent bridge 控制台从 DSH Desktop 右侧边栏迁移到 Qoder CN 左侧导航 + 主工作区

## 1. 架构差异总结

| 维度 | DSH Desktop (当前) | Qoder CN (目标) |
|------|-------------------|----------------|
| 插件框架 | Cordis (`cordis.patch.yml`) | `.qoder-app-plugin/plugin.json` |
| 侧边栏挂载 | `sidebarRightTabs()` + `slots.inject()` | `contributes.sidebarNavItems` → `workbench.sidebar.secondary` |
| 视图位置 | 右侧边栏内的 tab | 左侧导航图标 → 主工作区视图 |
| Host 入口 | Cordis 插件注入 `webServer` | `dist/node/main.cjs` (CJS) |
| Client 入口 | `__ModuleLoader__` 信封 + ESM/CJS | `dist/browser/view.cjs` (CJS) |
| 分发方式 | npm junction + cordis patch | 扩展目录 + `catalog.v1.json` |
| 依赖 | `@deepseek-ai/schemastery`, `@cordis/types` | 零三方依赖（纯 Node.js 标准库） |

## 2. 目标目录结构

```
qoder.bridge/                          # 新扩展根目录
  .qoder-app-plugin/
    plugin.json                        # Qoder CN 扩展清单
  assets/
    bridge.svg                         # 左侧导航栏图标
  cli/
    bridge/
      .qoder-plugin/
        plugin.json                    # Agent SDK 子插件（可选）
      skills/
        multi-agent/
          SKILL.md                     # multi-agent skill 定义
  dist/
    node/
      main.cjs                         # Node.js 后端入口
    browser/
      view.cjs                         # 浏览器 UI 入口
  src/
    node/
      main.ts                          # 后端源码（spawn proxy + bridge-web-panel）
    browser/
      view.tsx                         # 前端源码（复用 dsh-panel 组件）
      components/                      # 从 dsh-panel 复制
        WorkflowView.tsx
        TaskList.tsx
        MembersView.tsx
        DispatchForm.tsx
        DagGraph.tsx
      hooks/
        useBridgeState.ts
      styles.ts
  build.mjs                            # esbuild 双构建脚本
  package.json
```

## 3. plugin.json 清单

```json
{
  "id": "qoder.bridge",
  "name": "multi-agent-bridge",
  "version": "0.1.0",
  "engines": {
    "qoder": ">=0.0.1"
  },
  "main": "dist/node/main.cjs",
  "activationEvents": [
    "onStartup",
    "onView:bridge-portal"
  ],
  "permissions": [
    "node.callService",
    "telemetry.write",
    "workspace.read",
    "workspace.readProjects"
  ],
  "contributes": {
    "views": [
      {
        "id": "bridge-portal",
        "title": {
          "default": "Multi-Agent",
          "translations": {
            "zh-CN": "多智能体"
          }
        },
        "location": "workbench",
        "hostHeader": "hidden",
        "entry": "dist/browser/view.cjs"
      }
    ],
    "sidebarNavItems": [
      {
        "id": "bridge-sidebar",
        "title": {
          "default": "Multi-Agent",
          "translations": {
            "zh-CN": "多智能体"
          }
        },
        "icon": "assets/bridge.svg",
        "viewId": "bridge-portal",
        "slot": "workbench.sidebar.secondary"
      }
    ]
  }
}
```

## 4. Host 端适配 (dist/node/main.cjs)

### 4.1 核心变化

DSH 的 Host 端是一个 Cordis 插件，通过 `ctx.webServer.register()` 注册 HTTP 代理。Qoder CN 的 Host 端是一个标准 CJS 模块，通过 `globalThis.qoderPluginViewHost` 与宿主通信。

**关键问题：** Qoder CN 的扩展系统目前没有暴露 HTTP 代理 API。bridge-web-panel 需要一个 HTTP 端点来提供：
- `GET /api/state` — 状态快照
- `POST /api/run` — 派发任务
- `GET /events` — SSE 实时推送
- `POST /api/action` — 归档/恢复等操作

### 4.2 解决方案：独立端口 + 本地代理

```
┌─────────────────────────────────────────────┐
│  Qoder CN Electron App                      │
│                                             │
│  ┌──────────────────┐   ┌────────────────┐  │
│  │  Renderer Process │   │  Main Process   │  │
│  │                  │   │                 │  │
│  │  view.cjs        │   │  main.cjs       │  │
│  │  (React UI)      │   │  (Node.js)      │  │
│  │       │          │   │       │          │  │
│  │       │ fetch()  │   │       │ spawn()  │  │
│  │       ▼          │   │       ▼          │  │
│  │  localhost:PORT  │──▶│  bridge-web-     │  │
│  │  /api/*, /events │   │  panel.mjs       │  │
│  │                  │   │  (child process)  │  │
│  └──────────────────┘   └────────────────┘  │
└─────────────────────────────────────────────┘
```

**main.cjs 职责：**
1. 启动时 spawn `bridge-web-panel.mjs` 子进程（监听随机可用端口）
2. 通过 `globalThis.qoderPluginViewHost` 将端口号传递给 renderer
3. 管理子进程生命周期（指数退避重启，与当前 dsh-panel 一致）

**view.cjs 职责：**
1. 从 `globalThis.qoderPluginViewHost` 获取 bridge 端口号
2. 将所有 API 请求指向 `http://localhost:{port}`
3. SSE 连接也指向该端口

### 4.3 main.cjs 骨架

```javascript
// dist/node/main.cjs
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');

let child = null;
let bridgePort = 0;
let disposed = false;
let rapidExits = 0;
let spawnedAt = 0;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function spawnPanel(bridgePath, port) {
  if (disposed) return;
  spawnedAt = Date.now();
  child = spawn('node', [bridgePath, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', d => console.log(`[bridge] ${d.toString().trim()}`));
  child.stderr?.on('data', d => console.error(`[bridge ERROR] ${d.toString().trim()}`));
  child.on('exit', code => {
    console.log(`[bridge] exited with code ${code}`);
    if (disposed) return;
    rapidExits = (Date.now() - spawnedAt < 5000) ? rapidExits + 1 : 0;
    setTimeout(() => spawnPanel(bridgePath, port), Math.min(15000, 800 * 2 ** rapidExits));
  });
}

async function activate(context) {
  const bridgePath = path.join(__dirname, '../../bridge/mcp/bridge-web-panel.mjs');
  bridgePort = await findFreePort();
  spawnPanel(bridgePath, bridgePort);

  // 通过 node service 将端口号暴露给 renderer
  // （具体 API 取决于 Qoder CN 的 node.callService 机制）

  context.subscriptions.push({
    dispose() {
      disposed = true;
      if (child && !child.killed) child.kill();
    }
  });
}

module.exports = { activate };
```

### 4.4 端口传递方案

Qoder CN 的 renderer 和 node 端通信通过 `node.callService` 权限。有两种方式：

**方案 A：Node Service 暴露端口**
```javascript
// node 端注册 service
registerService('bridge.getPort', () => bridgePort);

// renderer 端调用
const port = await api.callService('bridge.getPort');
```

**方案 B：环境变量注入**
如果 Qoder CN 支持在 `plugin.json` 中声明环境变量（类似 `${QODER_PLUGIN_ROOT}`），可以在启动时将端口写入临时文件，renderer 读取。

**方案 C：固定端口**
最简单但最不健壮 — 使用固定端口（如 3000），与 DSH 版本保持一致。适合开发阶段。

## 5. Client 端适配 (dist/browser/view.cjs)

### 5.1 核心变化

UI 组件（WorkflowView, TaskList, MembersView, DispatchForm, DagGraph）可以**直接复用**，只需修改：

1. **入口文件**：从 cordis `__ModuleLoader__` 格式改为 `globalThis.qoderPluginView.register()` 格式
2. **API 基地址**：从同源 `/bridge/api/*` 改为 `http://localhost:{port}/api/*`
3. **CSS 注入**：保持不变（自包含暗色主题）

### 5.2 view.cjs 入口骨架

```javascript
// dist/browser/view.cjs (构建产物)
// 源码 src/browser/view.tsx

import { createRoot } from 'react-dom/client';
import React from 'react';
import BridgeConsole from './BridgeConsole';

globalThis.qoderPluginView.register({
  mount(container, context) {
    const root = createRoot(container);
    root.render(React.createElement(BridgeConsole, { api: context.api }));
    return {
      dispose() { root.unmount(); }
    };
  }
});
```

### 5.3 BridgeConsole 组件适配

```tsx
// src/browser/BridgeConsole.tsx
// 基于 dsh-panel/src/client/index.tsx 修改

export default function BridgeConsole({ api }: { api: any }) {
  injectStyles();
  // 从 node 端获取 bridge 端口
  const [port, setPort] = useState<number | null>(null);

  useEffect(() => {
    api.callService('bridge.getPort').then(setPort);
  }, [api]);

  if (port === null) return <div className="ma-root"><div className="ma-body"><div className="ma-empty">Connecting to bridge...</div></div></div>;

  const baseUrl = `http://localhost:${port}`;

  return (
    <div className="ma-root">
      {/* 与原版相同的 UI，但所有 fetch 使用 baseUrl */}
      <BridgeInner baseUrl={baseUrl} />
    </div>
  );
}
```

### 5.4 useBridgeState hook 适配

```typescript
// 原版：fetch('/bridge/api/state')
// 适配后：fetch(`${baseUrl}/api/state`)

// 原版 SSE：new EventSource('/bridge/events')
// 适配后：new EventSource(`${baseUrl}/events`)
```

## 6. 构建系统

### 6.1 build.mjs

```javascript
import esbuild from 'esbuild';

// Node.js 后端 → CJS
await esbuild.build({
  entryPoints: ['src/node/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/node/main.cjs',
  external: ['electron'],
});

// Browser 前端 → CJS (Qoder CN 格式)
await esbuild.build({
  entryPoints: ['src/browser/view.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  outfile: 'dist/browser/view.cjs',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  jsx: 'automatic',
});
```

### 6.2 与原版 build.mjs 的差异

| 原版 (dsh-panel) | 适配版 (qoder-bridge) |
|---|---|
| Host: ESM (`dist/index.js`) | CJS (`dist/node/main.cjs`) |
| Client: `__ModuleLoader__` 信封 CJS | 标准 CJS (`dist/browser/view.cjs`) |
| 依赖 `@deepseek-ai/schemastery` | 零依赖（纯 Node.js） |
| `cordis.patch.yml` 打包 | 无需 |

## 7. 分发注册

将扩展放入 Qoder CN 的扩展目录：

```
E:\AI\Agent\Qoder CN\resources\extensions\qoder.bridge\
```

并在 `catalog.v1.json` 中注册（需要计算文件 SHA-256 哈希）。

开发阶段可以用 symlink/junction 指向开发目录，避免每次复制。

## 8. 实施步骤

| # | 任务 | 预估时间 | 依赖 |
|---|------|---------|------|
| 1 | 创建 `qoder.bridge` 目录骨架 + `plugin.json` | 30 min | 无 |
| 2 | 编写 `assets/bridge.svg` 图标 | 15 min | 无 |
| 3 | 移植 `src/browser/` 组件（从 dsh-panel 复制 + 修改 API 基地址） | 1 h | 无 |
| 4 | 编写 `src/browser/view.tsx` 入口（`qoderPluginView.register` 格式） | 30 min | #3 |
| 5 | 编写 `src/node/main.ts`（spawn bridge-web-panel + 端口管理） | 1 h | 无 |
| 6 | 编写 `build.mjs`（双构建：node CJS + browser CJS） | 30 min | #3, #5 |
| 7 | 构建 + symlink 到 Qoder CN 扩展目录 | 30 min | #6 |
| 8 | 端到端测试（启动 Qoder CN → 点击导航图标 → 验证数据加载） | 1 h | #7 |
| 9 | 更新 `catalog.v1.json` 注册扩展 | 15 min | #8 |

**总计：约 5-6 小时**

## 9. 已知风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| `node.callService` API 细节未知 | 端口传递可能受阻 | 开发阶段先用固定端口 3000 |
| Qoder CN 的 CSP 可能阻止 localhost fetch | UI 无法加载数据 | 检查 `dist/browser/view.cjs` 的 CSP 策略；必要时用 `node.callService` 代理请求 |
| `qoderPluginView.register` 的 `context.api` 能力边界 | 可能缺少某些需要的 API | 先做最小原型验证 |
| 暗色主题与 Qoder CN 整体风格不完全一致 | 视觉不协调 | 后续可调整为 Qoder CN 的设计 token |
| `catalog.v1.json` 需要 SHA-256 哈希 | 注册流程可能复杂 | 参考现有扩展的注册方式 |

## 10. UI 交互变化说明

| 维度 | DSH Desktop (原版) | Qoder CN (适配版) |
|------|-------------------|------------------|
| 入口位置 | 右侧边栏 tab（点击展开） | 左侧导航栏图标（类似 VS Code Activity Bar） |
| 视图大小 | 右侧 ~300px 宽面板 | 主工作区（全屏可用） |
| 与其他功能的关系 | 与文件树等共享右侧空间 | 与 Chat、Sites、知识库并列 |
| 多任务体验 | 窄面板内滚动 | 宽屏布局，可同时展示更多信息 |
| 优势 | 随时可见，不遮挡主工作区 | 更大的展示空间，适合复杂工作流 DAG |

**实际上适配到 Qoder CN 后，由于主工作区的空间远大于右侧边栏，多智能体控制台的展示效果会更好。**
