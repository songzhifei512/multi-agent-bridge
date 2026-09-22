# dsh-panel → Qoder CN 适配实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 DSH Desktop 的 multi-agent bridge 控制台面板（dsh-panel）移植到 Qoder CN 扩展系统，以左侧导航图标 + 主工作区视图的形式呈现，复用现有 React 组件和 bridge-web-panel 后端。

**Architecture:** Qoder CN 扩展采用 `.qoder-app-plugin/plugin.json` 声明式清单，通过 `sidebarNavItems` 注册左侧导航图标，点击后在主工作区加载 `bridge-portal` 视图。Node 端（`main.cjs`）启动时 spawn `bridge-web-panel.mjs` 子进程监听随机端口，通过 `node.callService` 将端口号传递给 Browser 端（`view.cjs`）。Browser 端复用 dsh-panel 的全部 React 组件，仅将 API 基地址从同源 `/bridge` 改为 `http://localhost:{port}`。

**Tech Stack:** TypeScript 5.x, React 18, esbuild 0.19+, Node.js 标准库（零三方运行时依赖）, Qoder CN Extension API (`qoderPluginView.register`, `node.callService`)

**Spec:** `E:\AI\WorkRoot\Harness\multi-agent\dsh-panel\ADAPTATION-PLAN.md`

## Global Constraints

- 扩展 ID 必须为 `qoder.bridge`，与 Qoder CN 命名空间一致
- 所有构建产物必须为 CJS 格式（Node 端 `dist/node/main.cjs`，Browser 端 `dist/browser/view.cjs`）
- 零三方运行时依赖 — 仅使用 Node.js 标准库和 Qoder CN 内置 API
- 视图位置必须为 `"workbench"`（Qoder CN 仅支持 `workbench`、`file.preview`、`settings` 三种值）
- 侧边栏 slot 必须为 `"workbench.sidebar.secondary"`（Qoder CN 唯一可用的侧边栏 slot）
- `bridge-web-panel.mjs` 脚本路径相对于扩展根目录为 `../../bridge/mcp/bridge-web-panel.mjs`（需根据实际部署位置调整）
- 暗色主题 CSS 自包含，不依赖 Qoder CN 的设计 token（后续可迭代优化）

---

## File Structure

### 新建文件

| 路径 | 职责 |
|------|------|
| `qoder-bridge/.qoder-app-plugin/plugin.json` | Qoder CN 扩展清单（声明视图、侧边栏导航项、权限） |
| `qoder-bridge/assets/bridge.svg` | 左侧导航栏图标（16x16 或 24x24 SVG） |
| `qoder-bridge/src/node/main.ts` | Node 端入口：spawn bridge-web-panel 子进程 + 端口管理 + 向 renderer 暴露端口 |
| `qoder-bridge/src/browser/view.tsx` | Browser 端入口：`qoderPluginView.register()` 挂载 React 根组件 |
| `qoder-bridge/src/browser/BridgeConsole.tsx` | 主应用组件：获取端口 → 构造 baseUrl → 渲染内部 UI |
| `qoder-bridge/src/browser/styles.ts` | 自包含暗色主题 CSS（从 dsh-panel 直接复制） |
| `qoder-bridge/src/browser/hooks/useBridgeState.ts` | SSE + 轮询状态管理 hook（接受 `baseUrl` 参数） |
| `qoder-bridge/src/browser/components/WorkflowView.tsx` | 工作流视图（从 dsh-panel 直接复制） |
| `qoder-bridge/src/browser/components/DagGraph.tsx` | DAG 依赖图 SVG 组件（从 dsh-panel 直接复制） |
| `qoder-bridge/src/browser/components/TaskList.tsx` | 任务列表组件（从 dsh-panel 直接复制） |
| `qoder-bridge/src/browser/components/MembersView.tsx` | 成员视图组件（从 dsh-panel 直接复制） |
| `qoder-bridge/src/browser/components/DispatchForm.tsx` | 任务派发表单组件（从 dsh-panel 直接复制） |
| `qoder-bridge/build.mjs` | esbuild 双构建脚本（Node CJS + Browser CJS） |
| `qoder-bridge/package.json` | 项目元数据 + 构建脚本 + devDependencies |
| `qoder-bridge/tsconfig.json` | TypeScript 编译配置 |

### 不修改的文件

| 路径 | 说明 |
|------|------|
| `bridge/mcp/bridge-web-panel.mjs` | 后端服务，保持不变，由 Node 端 spawn |
| `dsh-panel/src/**` | 原版 DSH 源码，仅作为复制源 |

---

### Task 1: 创建项目骨架 + plugin.json 清单

**Files:**
- Create: `qoder-bridge/.qoder-app-plugin/plugin.json`
- Create: `qoder-bridge/package.json`
- Create: `qoder-bridge/tsconfig.json`

**Interfaces:**
- Consumes: 无（起始任务）
- Produces: 项目骨架目录和配置文件，后续所有任务在此基础上添加文件

- [ ] **Step 1: 创建目录结构**

```bash
mkdir -p qoder-bridge/.qoder-app-plugin
mkdir -p qoder-bridge/assets
mkdir -p qoder-bridge/src/node
mkdir -p qoder-bridge/src/browser/hooks
mkdir -p qoder-bridge/src/browser/components
mkdir -p qoder-bridge/dist/node
mkdir -p qoder-bridge/dist/browser
```

- [ ] **Step 2: 编写 plugin.json**

创建 `qoder-bridge/.qoder-app-plugin/plugin.json`：

```json
{
  "id": "qoder.bridge",
  "name": "Multi-Agent Bridge",
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
    "node.callService"
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

- [ ] **Step 3: 编写 package.json**

创建 `qoder-bridge/package.json`：

```json
{
  "name": "qoder-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node build.mjs",
    "dev": "node build.mjs --watch"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "esbuild": "^0.19.0",
    "typescript": "^5.0.0"
  },
  "peerDependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  }
}
```

- [ ] **Step 4: 编写 tsconfig.json**

创建 `qoder-bridge/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

- [ ] **Step 5: 验证目录结构**

Run: `find qoder-bridge -type f | sort`
Expected: 看到 `.qoder-app-plugin/plugin.json`, `package.json`, `tsconfig.json` 以及空的 `src/`, `dist/`, `assets/` 目录

---

### Task 2: 创建导航图标

**Files:**
- Create: `qoder-bridge/assets/bridge.svg`

**Interfaces:**
- Consumes: 无
- Produces: SVG 图标文件，被 `plugin.json` 的 `sidebarNavItems[0].icon` 引用

- [ ] **Step 1: 编写 bridge.svg**

创建 `qoder-bridge/assets/bridge.svg`，一个简洁的网络/桥接图标：

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="5" cy="6" r="2.5"/>
  <circle cx="19" cy="6" r="2.5"/>
  <circle cx="12" cy="18" r="2.5"/>
  <line x1="7" y1="7.5" x2="10.5" y2="16"/>
  <line x1="17" y1="7.5" x2="13.5" y2="16"/>
  <line x1="7.5" y1="6" x2="16.5" y2="6"/>
</svg>
```

该图标表示三个节点互联的网络拓扑，契合"多智能体协作"的语义。`stroke="currentColor"` 确保在 Qoder CN 导航栏中自动适配前景色。

- [ ] **Step 2: 验证 SVG 可渲染**

用文本编辑器或浏览器打开 `qoder-bridge/assets/bridge.svg`，确认能看到三个圆点由线条连接的网络图案。

---

### Task 3: 移植样式模块

**Files:**
- Create: `qoder-bridge/src/browser/styles.ts`

**Interfaces:**
- Consumes: 无
- Produces: `injectStyles()` 函数，供 `BridgeConsole.tsx` 调用

- [ ] **Step 1: 复制 styles.ts**

从 `dsh-panel/src/client/styles.ts` 完整复制到 `qoder-bridge/src/browser/styles.ts`。

该文件包含约 153 行自包含暗色主题 CSS，通过 `injectStyles()` 函数注入 `<style>` 标签。无需任何修改 — CSS 类名全部以 `ma-` 前缀开头，不会与 Qoder CN 的样式冲突。

源码参考（完整内容，不可省略）：

```typescript
const CSS = `
.ma-root{
  --bg:#0f172a; --panel:#1e293b; --panel2:#273449; --line:#334155; --line2:#475569;
  --txt:#e2e8f0; --mut:#94a3b8; --dim:#64748b;
  --acc:#6366f1; --ok:#22c55e; --warn:#f59e0b; --err:#ef4444; --run:#3b82f6; --pend:#eab308; --sup:#64748b;
  color-scheme:dark;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  background:var(--bg); color:var(--txt);
  height:100%; display:flex; flex-direction:column; font-size:13px; line-height:1.45;
}
.ma-root *{box-sizing:border-box}
.ma-root ::-webkit-scrollbar{width:8px;height:8px}
.ma-root ::-webkit-scrollbar-thumb{background:var(--line2);border-radius:4px}
.ma-root ::-webkit-scrollbar-track{background:transparent}

.ma-top{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);flex-shrink:0}
.ma-top h1{font-size:14px;font-weight:600;margin:0;display:flex;align-items:center;gap:8px;white-space:nowrap}
.ma-dot{width:8px;height:8px;border-radius:50%;background:var(--dim);flex-shrink:0}
.ma-dot.on{background:var(--ok);box-shadow:0 0 6px var(--ok)}
.ma-ctrl{margin-left:auto;font-size:11px;color:var(--mut);background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:2px 9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}

.ma-stats{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line);flex-shrink:0}
.ma-chip{display:flex;align-items:baseline;gap:5px;padding:3px 9px;border-radius:999px;background:var(--panel);border:1px solid var(--line);font-size:11px;color:var(--mut)}
.ma-chip b{font-size:13px;font-weight:600}
.ma-chip.run b{color:var(--run)} .ma-chip.pend b{color:var(--pend)} .ma-chip.ok b{color:var(--ok)} .ma-chip.err b{color:var(--err)}

.ma-tabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid var(--line);flex-shrink:0}
.ma-tab{appearance:none;border:none;background:transparent;color:var(--mut);font-size:12px;font-weight:500;padding:7px 12px;border-radius:8px 8px 0 0;cursor:pointer;border-bottom:2px solid transparent}
.ma-tab:hover{color:var(--txt);background:var(--panel)}
.ma-tab.on{color:var(--txt);background:var(--panel);border-bottom-color:var(--acc)}

.ma-body{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:12px}
.ma-card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.ma-card h3{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--mut);text-transform:uppercase;letter-spacing:.04em;display:flex;align-items:center;gap:6px}
.ma-empty{color:var(--dim);font-size:12px;padding:8px 0;text-align:center}

.ma-wf{border:1px solid var(--line);border-radius:10px;background:var(--panel);overflow:hidden}
.ma-wf + .ma-wf{margin-top:10px}
.ma-wf-head{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;user-select:none}
.ma-wf-head:hover{background:var(--panel2)}
.ma-wf-title{font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-badge{font-size:10px;font-weight:600;padding:1px 7px;border-radius:999px;border:1px solid var(--line2);color:var(--mut);white-space:nowrap}
.ma-badge.compete{color:#f472b6;border-color:#f472b6}
.ma-badge.collaborate{color:#38bdf8;border-color:#38bdf8}
.ma-badge.virtual{color:var(--warn);border-color:var(--warn)}
.ma-wf-prog{height:4px;background:var(--line);border-radius:2px;margin:0 12px 8px;overflow:hidden}
.ma-wf-prog i{display:block;height:100%;background:var(--ok);transition:width .3s}
.ma-dag-toggle{cursor:pointer}
.ma-dag-toggle:hover{color:var(--txt);border-color:var(--txt)}
.ma-dag-toggle.on{color:var(--acc);border-color:var(--acc)}
.ma-arch-btn{padding:2px 9px;font-size:10px;font-weight:600;border:1px solid var(--warn);border-radius:999px;background:rgba(245,158,11,.12);color:#fbbf24;cursor:pointer;white-space:nowrap;margin-left:auto}
.ma-arch-btn:hover{background:var(--warn);color:#111827}
.ma-archived{margin-top:10px;font-size:11px;color:var(--mut)}
.ma-archived-toggle{background:none;border:none;color:var(--mut);cursor:pointer;padding:4px 0;font-size:11px}
.ma-archived-toggle:hover{color:var(--txt)}
.ma-archived-row{display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px dashed var(--line2);border-radius:7px;margin-top:5px}
.ma-archived-row span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-unarch-btn{font-size:10px;padding:1px 8px;border:1px solid var(--line2);border-radius:999px;background:var(--panel2);color:var(--mut);cursor:pointer;flex-shrink:0}
.ma-unarch-btn:hover{color:var(--txt);border-color:var(--txt)}

.ma-seg{display:flex;height:6px;border-radius:3px;overflow:hidden;margin:0 12px 6px;background:var(--line)}
.ma-seg i{display:block;height:100%;transition:width .3s}
.ma-seg i.run{background:var(--run)} .ma-seg i.blk{background:var(--warn)}
.ma-seg i.pend{background:var(--pend)} .ma-seg i.ok{background:var(--ok)} .ma-seg i.err{background:var(--err)}
.ma-seg-leg{display:flex;gap:10px;flex-wrap:wrap;padding:0 12px 8px;font-size:10px;color:var(--mut)}
.ma-seg-leg span{display:flex;align-items:center;gap:4px}
.ma-seg-leg em{width:7px;height:7px;border-radius:2px;display:inline-block}

.ma-wf-body{padding-bottom:4px}
.ma-lanes{border-left:2px solid var(--line2);margin:4px 12px 10px 14px;padding-left:12px;display:flex;flex-direction:column;gap:10px}
.ma-lane-head{display:flex;align-items:center;gap:6px;font-size:12px}
.ma-lane-head b{font-weight:600}
.ma-lane-role{font-size:10px;color:var(--dim)}
.ma-lane-tasks{display:flex;flex-direction:column;gap:4px;margin-top:4px}
.ma-tchip{display:flex;align-items:center;gap:6px;font-size:11px;background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:4px 8px}
.ma-tchip:hover{border-color:var(--line2)}
.ma-tchip .st{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.ma-tchip .tid{font-weight:700;color:var(--acc);font-size:10px;flex-shrink:0}
.ma-tchip .tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-tflag{font-size:10px;color:var(--pend);white-space:nowrap;flex-shrink:0}
.ma-twait{font-size:10px;color:var(--warn);white-space:nowrap;flex-shrink:0}

.ma-depsec{margin:0 12px 10px}
.ma-depsec h4{margin:0 0 4px;font-size:11px;color:var(--mut);font-weight:600}
.ma-dep{display:flex;align-items:center;gap:6px;font-size:11px;padding:3px 6px;border-radius:6px}
.ma-dep:hover{background:var(--panel2)}
.ma-dep .st{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.ma-dep .tid{font-weight:700;color:var(--acc);font-size:10px;flex-shrink:0}
.ma-dep .dt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mut)}
.ma-dep .dd{display:flex;gap:4px;flex-shrink:0}
.dep-chip{font-size:10px;font-weight:600;padding:0 5px;border-radius:4px;border:1px solid}
.dep-chip.met{color:var(--dim);border-color:var(--line2)}
.dep-chip.unmet{color:var(--warn);border-color:var(--warn)}

.ma-dagwrap{overflow-x:auto;margin:0 12px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
svg.ma-dag{display:block}
.ma-dag-edge{stroke:var(--line2);stroke-width:1.5;fill:none;opacity:.75}
.ma-dag-node{fill:var(--panel2);stroke:var(--line2);stroke-width:1.5}
.ma-dag-node.stk-running{stroke:var(--run)} .ma-dag-node.stk-completed{stroke:var(--ok)}
.ma-dag-node.stk-failed{stroke:var(--err)} .ma-dag-node.stk-pending{stroke:var(--pend)}
.ma-dag-node.stk-awaiting_approval,.ma-dag-node.stk-escalating{stroke:var(--warn)}
.ma-dag-node.stk-superseded,.ma-dag-node.stk-cancelled,.ma-dag-node.stk-interrupted{stroke:var(--sup)}
.ma-dag-txt{fill:var(--txt);font-size:9px}
.ma-dag-txt.tid{fill:var(--acc);font-weight:700}
.ma-dag-evolve{fill:var(--warn);font-size:8px}
.st-running{background:var(--run);box-shadow:0 0 5px var(--run)}
.st-completed{background:var(--ok)} .st-failed{background:var(--err)}
.st-pending{background:var(--pend)} .st-superseded,.st-cancelled,.st-interrupted{background:var(--sup)}
.st-awaiting_approval,.st-escalating{background:var(--warn)}

.ma-task{border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:12px;overflow:hidden}
.ma-task + .ma-task{margin-top:6px}
.ma-task.focused{border-color:var(--acc);box-shadow:0 0 0 1px rgba(99,102,241,.35)}
.ma-task-head{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;user-select:none}
.ma-task-head:hover{background:var(--panel2)}
.ma-task .bar{width:3px;align-self:stretch;border-radius:2px;flex-shrink:0}
.ma-task .t{flex:1;min-width:0}
.ma-task .t .id{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-task .t .sub{font-size:10px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-task .s{font-size:10px;font-weight:600;white-space:nowrap}
.ma-task .chev{font-size:10px;color:var(--dim);flex-shrink:0}
.ma-task-body{padding:8px 10px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
.ma-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:11px}
.ma-kv span{color:var(--mut)}
.ma-kv b{color:var(--txt);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-log{display:flex;flex-direction:column;gap:2px;font-size:10px}
.ma-log-row{display:flex;gap:8px}
.ma-log-t{color:var(--dim);white-space:nowrap;flex-shrink:0}
.ma-log-n{color:var(--mut);word-break:break-all}
.ma-pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;margin:0;font-size:10px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--txt)}
.ma-mini-btn{font-size:10px;padding:1px 8px;border:1px solid var(--acc);border-radius:999px;background:rgba(99,102,241,.14);color:#a5b4fc;cursor:pointer;margin-left:6px}
.ma-mini-btn:hover{background:var(--acc);color:#fff}

.ma-mem{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ma-memcard{border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:9px 10px}
.ma-memcard .nm{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12px;margin-bottom:2px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.ma-memcard .role{font-size:10px;color:var(--mut);margin-bottom:3px}
.ma-memcard .act{font-size:10px;color:var(--dim)}
.ma-memcard .row{display:flex;justify-content:space-between;font-size:11px;color:var(--mut);margin-top:2px}
.ma-memcard .prog{height:3px;background:var(--line);border-radius:2px;margin-top:6px;overflow:hidden}
.ma-memcard .prog i{display:block;height:100%;background:var(--acc)}

.ma-form{display:flex;flex-direction:column;gap:8px}
.ma-form label{font-size:11px;color:var(--mut);display:flex;flex-direction:column;gap:4px}
.ma-form select,.ma-form textarea{background:var(--panel2);border:1px solid var(--line2);border-radius:8px;color:var(--txt);padding:7px 9px;font-size:12px;font-family:inherit;outline:none}
.ma-form select:focus,.ma-form textarea:focus{border-color:var(--acc)}
.ma-form textarea{resize:vertical;min-height:64px}
.ma-btn{appearance:none;border:none;border-radius:8px;background:var(--acc);color:#fff;font-size:12px;font-weight:600;padding:8px 14px;cursor:pointer}
.ma-btn:hover{filter:brightness(1.1)}
.ma-btn:disabled{background:var(--line2);color:var(--mut);cursor:not-allowed}
.ma-err{background:rgba(239,68,68,.12);border:1px solid var(--err);color:#fca5a5;border-radius:8px;padding:7px 10px;font-size:11px}
.ma-ok{background:rgba(34,197,94,.12);border:1px solid var(--ok);color:#86efac;border-radius:8px;padding:7px 10px;font-size:11px}
`;

let injected = false;
export function injectStyles() {
  if (injected || typeof document === 'undefined') return;
  const el = document.createElement('style');
  el.setAttribute('data-ma-panel', '');
  el.textContent = CSS;
  document.head.appendChild(el);
  injected = true;
}
```

- [ ] **Step 2: 验证文件已创建**

Run: `wc -l qoder-bridge/src/browser/styles.ts`
Expected: 约 163 行

---

### Task 4: 移植 useBridgeState hook

**Files:**
- Create: `qoder-bridge/src/browser/hooks/useBridgeState.ts`

**Interfaces:**
- Consumes: 无
- Produces: `useBridgeState(baseUrl: string)` hook，返回 `{ state: BridgeState | null, connected: boolean }`
- 被 `BridgeConsole.tsx`（Task 6）消费

- [ ] **Step 1: 编写 useBridgeState.ts**

创建 `qoder-bridge/src/browser/hooks/useBridgeState.ts`。

与原版的关键差异：`baseUrl` 参数从默认值 `'/bridge'` 改为必传参数（无默认值），因为 Qoder CN 版本中 API 不再通过同源代理访问。

```typescript
import { useEffect, useRef, useState } from 'react';

export interface BridgeState {
  stat?: Record<string, number>;
  total?: number;
  members?: any[];
  workers?: string[];
  tasks?: any[];
  workflows?: { list: any[]; other: number };
  dag?: any;
  captainSummary?: any;
  agentStats?: Record<string, any>;
  controller?: string;
  controllerLabel?: string;
  notes?: any[];
  agentOverview?: any[];
  [key: string]: any;
}

const POLL_MS = 3000;
const SSE_RETRY_MS = 2000;

export function useBridgeState(baseUrl: string) {
  const [state, setState] = useState<BridgeState | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<number | null>(null);

  useEffect(() => {
    let stopped = false;
    let pollTimer: number | null = null;

    const applyState = (data: BridgeState) => {
      if (!stopped) setState(data);
    };

    const poll = async () => {
      try {
        const res = await fetch(`${baseUrl}/api/state`, { cache: 'no-store' });
        if (!res.ok) return;
        applyState(await res.json());
      } catch { /* transient */ }
    };

    const startPolling = () => {
      if (pollTimer === null) pollTimer = window.setInterval(poll, POLL_MS);
    };
    const stopPolling = () => {
      if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
    };

    const connect = () => {
      if (stopped) return;
      const es = new EventSource(`${baseUrl}/events`);
      esRef.current = es;
      es.addEventListener('state', (e: MessageEvent) => {
        try { applyState(JSON.parse(e.data)); } catch { /* bad frame */ }
      });
      es.onopen = () => { setConnected(true); stopPolling(); };
      es.onerror = () => {
        setConnected(false);
        es.close();
        esRef.current = null;
        startPolling();
        retryRef.current = window.setTimeout(connect, SSE_RETRY_MS);
      };
    };

    poll();
    connect();
    startPolling();

    return () => {
      stopped = true;
      stopPolling();
      if (retryRef.current !== null) window.clearTimeout(retryRef.current);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [baseUrl]);

  return { state, connected };
}
```

- [ ] **Step 2: 验证与原版差异**

Run: `diff dsh-panel/src/client/hooks/useBridgeState.ts qoder-bridge/src/browser/hooks/useBridgeState.ts`
Expected: 仅 `baseUrl` 参数签名不同（原版有默认值 `= '/bridge'`，新版无默认值）

---

### Task 5: 移植 React 组件

**Files:**
- Create: `qoder-bridge/src/browser/components/WorkflowView.tsx`
- Create: `qoder-bridge/src/browser/components/DagGraph.tsx`
- Create: `qoder-bridge/src/browser/components/TaskList.tsx`
- Create: `qoder-bridge/src/browser/components/MembersView.tsx`
- Create: `qoder-bridge/src/browser/components/DispatchForm.tsx`

**Interfaces:**
- Consumes: 无（纯展示组件，不依赖 Node 端）
- Produces: 5 个 React 组件，供 `BridgeConsole.tsx`（Task 6）导入使用
- 所有组件从 dsh-panel 直接复制，**无需修改** — 它们都是纯 React 组件，不包含框架特定代码

- [ ] **Step 1: 复制 DagGraph.tsx**

```bash
cp dsh-panel/src/client/components/DagGraph.tsx qoder-bridge/src/browser/components/DagGraph.tsx
```

该组件导出 `DagNode`, `DagEdge`, `Dag` 接口和 `DagGraph` 组件。纯 SVG 渲染，无 API 调用。

- [ ] **Step 2: 复制 WorkflowView.tsx**

```bash
cp dsh-panel/src/client/components/WorkflowView.tsx qoder-bridge/src/browser/components/WorkflowView.tsx
```

该组件导出 `WorkflowView`。内部调用 `/bridge/api/action` 进行归档/恢复操作 — 这些 URL 需要后续在 Task 6 中通过 props 覆盖，但暂不修改，因为 `WorkflowView` 中的 `fetch` 使用硬编码的 `/bridge/api/action` 路径。

**重要：** `WorkflowView.tsx` 中有两处 `fetch('/bridge/api/action', ...)` 调用（归档和恢复操作）。在 Task 6 中我们将为 `WorkflowView` 添加 `baseUrl` prop，但为保持组件可移植性，此处先原样复制，Task 6 统一处理。

- [ ] **Step 3: 复制 TaskList.tsx**

```bash
cp dsh-panel/src/client/components/TaskList.tsx qoder-bridge/src/browser/components/TaskList.tsx
```

纯展示组件，无 API 调用。

- [ ] **Step 4: 复制 MembersView.tsx**

```bash
cp dsh-panel/src/client/components/MembersView.tsx qoder-bridge/src/browser/components/MembersView.tsx
```

纯展示组件，无 API 调用。

- [ ] **Step 5: 复制 DispatchForm.tsx**

```bash
cp dsh-panel/src/client/components/DispatchForm.tsx qoder-bridge/src/browser/components/DispatchForm.tsx
```

纯表单组件，通过 `onDispatch` prop 回调，不直接发起 API 请求。

- [ ] **Step 6: 验证所有组件已复制**

Run: `ls -la qoder-bridge/src/browser/components/`
Expected: 5 个 `.tsx` 文件 — `DagGraph.tsx`, `WorkflowView.tsx`, `TaskList.tsx`, `MembersView.tsx`, `DispatchForm.tsx`

---

### Task 6: 编写主应用组件 BridgeConsole

**Files:**
- Create: `qoder-bridge/src/browser/BridgeConsole.tsx`
- Modify: `qoder-bridge/src/browser/components/WorkflowView.tsx`（添加 `baseUrl` prop）

**Interfaces:**
- Consumes: `useBridgeState`（Task 4）, `injectStyles`（Task 3）, 5 个 React 组件（Task 5）
- Produces: `BridgeConsole` 组件，接收 `{ api: any }` prop，由 `view.tsx`（Task 7）渲染
- 关键适配点：
  - 通过 `api.callService('bridge.getPort')` 获取 bridge-web-panel 端口
  - 构造 `baseUrl = http://localhost:${port}` 传递给所有子组件
  - 所有 `fetch` 调用使用 `baseUrl` 前缀

- [ ] **Step 1: 修改 WorkflowView 支持 baseUrl prop**

在 `qoder-bridge/src/browser/components/WorkflowView.tsx` 中，将硬编码的 `/bridge/api/action` 改为使用 `baseUrl` prop：

找到 `archiveWf` 函数中的：
```typescript
await fetch('/bridge/api/action', {
```
替换为：
```typescript
await fetch(`${baseUrl}/api/action`, {
```

找到 `unarchiveWf` 函数中的：
```typescript
await fetch('/bridge/api/action', {
```
替换为：
```typescript
await fetch(`${baseUrl}/api/action`, {
```

在 `WorkflowView` 组件的 props 类型中添加 `baseUrl`：
```typescript
export function WorkflowView({
  workflows,
  members,
  baseUrl = '',
}: {
  workflows?: { list: Workflow[]; other: number };
  members?: MemberInfo[];
  baseUrl?: string;
}) {
```

在 `WorkflowCard` 组件的 props 中添加 `baseUrl` 并传递到 `archiveWf`：
```typescript
function WorkflowCard({
  wf,
  memberLabel,
  baseUrl = '',
}: {
  wf: Workflow;
  memberLabel: (agent: string) => string;
  baseUrl?: string;
}) {
```

在渲染 `WorkflowCard` 时传递 `baseUrl`：
```typescript
<WorkflowCard key={wf.key} wf={wf} memberLabel={labelOf} baseUrl={baseUrl} />
```

- [ ] **Step 2: 编写 BridgeConsole.tsx**

创建 `qoder-bridge/src/browser/BridgeConsole.tsx`。

这是适配的核心文件 — 负责从 Node 端获取端口号，构造 `baseUrl`，并将原版 `BridgeConsoleTab` 的所有逻辑适配到新的 API 路径。

```tsx
import React, { useState, useEffect } from 'react';
import { useBridgeState } from './hooks/useBridgeState';
import { injectStyles } from './styles';
import { WorkflowView } from './components/WorkflowView';
import { TaskList } from './components/TaskList';
import { MembersView } from './components/MembersView';
import { DispatchForm } from './components/DispatchForm';

type TabId = 'workflows' | 'tasks' | 'members' | 'dispatch';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'workflows', label: '工作流' },
  { id: 'tasks', label: '任务' },
  { id: 'members', label: '成员' },
  { id: 'dispatch', label: '派发' },
];

export default function BridgeConsole({ api }: { api: any }) {
  injectStyles();

  const [port, setPort] = useState<number | null>(null);
  const [portError, setPortError] = useState<string | null>(null);

  useEffect(() => {
    if (!api?.callService) {
      // 开发模式 fallback：使用固定端口
      setPort(3000);
      return;
    }
    api.callService('bridge.getPort')
      .then((p: number) => setPort(p))
      .catch((err: Error) => {
        console.error('[bridge] failed to get port:', err);
        setPortError('无法获取 Bridge 端口，请确认后端已启动');
        // fallback 到固定端口以便开发调试
        setPort(3000);
      });
  }, [api]);

  if (port === null) {
    return (
      <div className="ma-root">
        <div className="ma-body">
          <div className="ma-empty">
            {portError || '正在连接 Bridge 服务...'}
          </div>
        </div>
      </div>
    );
  }

  const baseUrl = `http://localhost:${port}`;

  return <BridgeInner baseUrl={baseUrl} />;
}

function BridgeInner({ baseUrl }: { baseUrl: string }) {
  const { state, connected } = useBridgeState(baseUrl);
  const [tab, setTab] = useState<TabId>('workflows');
  const [focusedTask, setFocusedTask] = useState<string | null>(null);

  const stat = state?.stat || {};

  const handleDispatch = async (worker: string, prompt: string) => {
    const res = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker, prompt }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data?.taskId as string | undefined;
  };

  const handleViewTask = (taskId: string) => {
    setTab('tasks');
    setFocusedTask(taskId);
  };

  return (
    <div className="ma-root">
      <div className="ma-top">
        <h1><span className={`ma-dot ${connected ? 'on' : ''}`} />Multi-Agent</h1>
        <span className="ma-ctrl" title={`controller: ${state?.controller || '?'}`}>
          {state?.controllerLabel || state?.controller || '—'}
        </span>
      </div>

      <div className="ma-stats">
        <span className="ma-chip run"><b>{stat.running || 0}</b>运行</span>
        <span className="ma-chip pend"><b>{stat.pending || 0}</b>待领</span>
        <span className="ma-chip ok"><b>{stat.completed || 0}</b>完成</span>
        <span className="ma-chip err"><b>{stat.failed || 0}</b>失败</span>
      </div>

      <div className="ma-tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`ma-tab ${tab === t.id ? 'on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="ma-body">
        {tab === 'workflows' && (
          <WorkflowView
            workflows={state?.workflows}
            members={state?.members}
            baseUrl={baseUrl}
          />
        )}
        {tab === 'tasks' && (
          <TaskList tasks={state?.tasks || []} focusedTask={focusedTask} />
        )}
        {tab === 'members' && <MembersView members={state?.members} />}
        {tab === 'dispatch' && (
          <DispatchForm
            workers={state?.workers || []}
            onDispatch={handleDispatch}
            onViewTask={handleViewTask}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 验证编译**

Run: `cd qoder-bridge && npx tsc --noEmit`
Expected: 无错误（或仅有 `api: any` 相关的隐式 any 警告，不影响运行）

---

### Task 7: 编写 Browser 端入口 view.tsx

**Files:**
- Create: `qoder-bridge/src/browser/view.tsx`

**Interfaces:**
- Consumes: `BridgeConsole`（Task 6）
- Produces: `dist/browser/view.cjs`（构建产物），通过 `globalThis.qoderPluginView.register()` 挂载到 Qoder CN

- [ ] **Step 1: 编写 view.tsx**

创建 `qoder-bridge/src/browser/view.tsx`：

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import BridgeConsole from './BridgeConsole';

// Qoder CN 扩展视图入口
// globalThis.qoderPluginView 由 Qoder CN Electron 主进程注入
declare const globalThis: {
  qoderPluginView?: {
    register(descriptor: {
      mount(container: HTMLElement, context: { api: any }): { dispose(): void };
    }): void;
  };
} & typeof global;

if (globalThis.qoderPluginView) {
  globalThis.qoderPluginView.register({
    mount(container, context) {
      const root = createRoot(container);
      root.render(React.createElement(BridgeConsole, { api: context.api }));
      return {
        dispose() {
          root.unmount();
        },
      };
    },
  });
}
```

- [ ] **Step 2: 验证文件已创建**

Run: `wc -l qoder-bridge/src/browser/view.tsx`
Expected: 约 30 行

---

### Task 8: 编写 Node 端入口 main.ts

**Files:**
- Create: `qoder-bridge/src/node/main.ts`

**Interfaces:**
- Consumes: `bridge-web-panel.mjs`（外部文件，由 Node 端 spawn）
- Produces: `dist/node/main.cjs`（构建产物），Qoder CN 启动时加载
- 关键职责：
  1. 分配随机可用端口
  2. Spawn `bridge-web-panel.mjs` 子进程
  3. 管理子进程生命周期（指数退避重启）
  4. 通过 `node.callService` 向 renderer 暴露端口号

- [ ] **Step 1: 编写 main.ts**

创建 `qoder-bridge/src/node/main.ts`：

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';

let child: ChildProcess | null = null;
let bridgePort = 0;
let disposed = false;
let rapidExits = 0;
let spawnedAt = 0;

/** 寻找一个可用的 TCP 端口 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address();
      if (port && typeof port !== 'string') {
        const p = port.port;
        srv.close(() => resolve(p));
      } else {
        srv.close(() => reject(new Error('Failed to get port')));
      }
    });
    srv.on('error', reject);
  });
}

/** 解析 bridge-web-panel.mjs 的路径 */
function resolvePanelPath(): string {
  // 从 dist/node/main.cjs 出发，向上两级到扩展根目录，再到 bridge/mcp/
  // 实际部署时路径为：
  //   <QODER_EXTENSIONS>/qoder.bridge/dist/node/main.cjs
  //   <QODER_EXTENSIONS>/../../bridge/mcp/bridge-web-panel.mjs
  // 开发时可通过环境变量 BRIDGE_PANEL_PATH 覆盖
  if (process.env.BRIDGE_PANEL_PATH) {
    return process.env.BRIDGE_PANEL_PATH;
  }
  return path.resolve(__dirname, '../../../bridge/mcp/bridge-web-panel.mjs');
}

/** Spawn bridge-web-panel 子进程，带指数退避重启 */
function spawnPanel(bridgePath: string, port: number): void {
  if (disposed) return;
  spawnedAt = Date.now();

  child = spawn('node', [bridgePath, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  child.stdout?.on('data', (d: Buffer) => {
    console.log(`[bridge-panel] ${d.toString().trim()}`);
  });

  child.stderr?.on('data', (d: Buffer) => {
    console.error(`[bridge-panel ERROR] ${d.toString().trim()}`);
  });

  child.on('exit', (code) => {
    console.log(`[bridge-panel] exited with code ${code}`);
    if (disposed) return;
    const lifetime = Date.now() - spawnedAt;
    rapidExits = lifetime < 5000 ? rapidExits + 1 : 0;
    const delay = Math.min(15000, 800 * 2 ** rapidExits);
    setTimeout(() => spawnPanel(bridgePath, port), delay);
  });

  console.log(`[qoder-bridge] spawned panel process on port ${port} (PID: ${child.pid})`);
}

/** Qoder CN 扩展激活入口 */
export function activate(context: any): void {
  const bridgePath = resolvePanelPath();
  
  (async () => {
    try {
      bridgePort = await findFreePort();
      spawnPanel(bridgePath, bridgePort);

      // 注册 node service，让 renderer 端可以获取端口号
      // Qoder CN 的 node.callService 机制允许 browser 端调用 node 端注册的服务
      if (context?.registerService) {
        context.registerService('bridge.getPort', () => bridgePort);
      }
    } catch (err) {
      console.error('[qoder-bridge] activation failed:', err);
    }
  })();

  // 注册 dispose 回调
  if (context?.subscriptions) {
    context.subscriptions.push({
      dispose() {
        disposed = true;
        if (child && !child.killed) {
          console.log('[qoder-bridge] shutting down panel process');
          child.kill();
        }
      },
    });
  }
}

/** Qoder CN 扩展停用时调用 */
export function deactivate(): void {
  disposed = true;
  if (child && !child.killed) {
    child.kill();
  }
}
```

- [ ] **Step 2: 验证文件已创建**

Run: `wc -l qoder-bridge/src/node/main.ts`
Expected: 约 100 行

---

### Task 9: 编写构建脚本 build.mjs

**Files:**
- Create: `qoder-bridge/build.mjs`

**Interfaces:**
- Consumes: `src/node/main.ts`, `src/browser/view.tsx` 及所有依赖
- Produces: `dist/node/main.cjs`（Node 端 CJS）, `dist/browser/view.cjs`（Browser 端 CJS）

- [ ] **Step 1: 编写 build.mjs**

创建 `qoder-bridge/build.mjs`：

```javascript
import * as esbuild from 'esbuild';

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
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
});

console.log('[qoder-bridge] build done');

if (isWatch) {
  console.log('[qoder-bridge] watching for changes...');
  // 简单的文件监听重建（开发模式）
  const { watch } = await import('node:fs');
  watch('src', { recursive: true }, () => {
    console.log('[qoder-bridge] change detected, rebuilding...');
  });
}
```

- [ ] **Step 2: 安装依赖并执行构建**

```bash
cd qoder-bridge
npm install
npm run build
```

Expected: `dist/node/main.cjs` 和 `dist/browser/view.cjs` 生成成功，无编译错误。

- [ ] **Step 3: 验证构建产物**

Run: `ls -lh qoder-bridge/dist/node/main.cjs qoder-bridge/dist/browser/view.cjs`
Expected: 两个文件都存在，`view.cjs` 约 30-50KB（包含 React 组件），`main.cjs` 约 3-5KB。

- [ ] **Step 4: 验证 CJS 格式**

Run: `head -5 qoder-bridge/dist/node/main.cjs`
Expected: 以 `"use strict";` 或 `var __create = ...` 开头（CJS 格式标志）

Run: `head -5 qoder-bridge/dist/browser/view.cjs`
Expected: 以 `"use strict";` 开头（CJS 格式标志）

---

### Task 10: 部署到 Qoder CN 扩展目录

**Files:**
- 部署目标: `E:\AI\Agent\Qoder CN\resources\extensions\qoder.bridge\`

**Interfaces:**
- Consumes: `dist/node/main.cjs`, `dist/browser/view.cjs`, `.qoder-app-plugin/plugin.json`, `assets/bridge.svg`
- Produces: 完整部署的扩展目录，Qoder CN 启动时可加载

- [ ] **Step 1: 创建 symlink（开发模式）**

开发阶段使用 symlink 避免每次构建后手动复制：

```bash
# Windows (需要管理员权限或使用 Developer Mode)
mklink /D "E:\AI\Agent\Qoder CN\resources\extensions\qoder.bridge" "E:\AI\WorkRoot\Harness\multi-agent\qoder-bridge"

# 或者使用 junction（不需要管理员权限）
cmd /c mklink /J "E:\AI\Agent\Qoder CN\resources\extensions\qoder.bridge" "E:\AI\WorkRoot\Harness\multi-agent\qoder-bridge"
```

- [ ] **Step 2: 验证扩展目录结构**

Run: `ls -R "E:\AI\Agent\Qoder CN\resources\extensions\qoder.bridge/"`
Expected:
```
.qoder-app-plugin/
  plugin.json
assets/
  bridge.svg
dist/
  node/main.cjs
  browser/view.cjs
```

- [ ] **Step 3: 启动 Qoder CN 验证扩展加载**

启动 Qoder CN 应用，检查开发者工具控制台是否出现：
- `[qoder-bridge] spawned panel process on port XXXX (PID: YYYY)` — Node 端成功启动
- 无 `plugin.json` 解析错误
- 左侧导航栏出现桥接图标

- [ ] **Step 4: 点击导航图标验证视图加载**

点击左侧导航栏的桥接图标，验证：
- 主工作区切换到 Multi-Agent 视图
- 显示暗色主题界面
- 顶部显示 "Multi-Agent" 标题和连接状态指示灯
- 四个 tab（工作流、任务、成员、派发）可见

---

### Task 11: 端到端集成测试

**Files:**
- 无新文件（测试现有功能）

**Interfaces:**
- Consumes: 完整部署的扩展 + 运行中的 bridge-web-panel
- Produces: 验证报告

**前置条件：**
- `bridge-web-panel.mjs` 可正常启动
- 工作目录下存在 `memory.json`（bridge-web-panel 的数据源）

- [ ] **Step 1: 验证 Node 端 → bridge-web-panel 通信**

检查 Qoder CN 控制台输出：
```
[qoder-bridge] spawned panel process on port 12345 (PID: 6789)
[bridge-panel] listening on :12345
```

- [ ] **Step 2: 验证 Browser 端 → Node 端端口获取**

在 Qoder CN 开发者工具控制台中执行：
```javascript
// 验证 callService 是否正常工作
// 如果 registerService 正确，这里应该返回端口号
```

检查控制台无 `failed to get port` 错误。

- [ ] **Step 3: 验证 SSE 实时推送**

在另一个终端中修改 `memory.json`，观察 Qoder CN 中的 Multi-Agent 视图是否自动更新数据。

- [ ] **Step 4: 验证各 Tab 功能**

| Tab | 验证点 |
|-----|--------|
| 工作流 | 显示工作流卡片，进度条，泳道，DAG 依赖图可切换 |
| 任务 | 显示任务列表，可展开查看详情，进度日志可见 |
| 成员 | 显示成员卡片网格，活动状态指示灯 |
| 派发 | 选择 worker → 输入 prompt → 点击派发 → 显示成功/失败反馈 |

- [ ] **Step 5: 验证归档/恢复功能**

点击工作流卡片上的"归档"按钮 → 工作流移入"已归档"区域 → 点击"恢复" → 工作流回到活动列表。

- [ ] **Step 6: 验证进程生命周期管理**

手动 kill bridge-web-panel 子进程：
```bash
kill <PID>
```
观察 Qoder CN 控制台是否自动重启（指数退避）：
```
[bridge-panel] exited with code null
[qoder-bridge] spawned panel process on port XXXX (PID: ZZZZ)
```

---

### Task 12: 注册到 catalog.v1.json（发布阶段）

**Files:**
- Modify: `E:\AI\Agent\Qoder CN\resources\extensions\catalog.v1.json`

**Interfaces:**
- Consumes: 所有构建产物的 SHA-256 哈希
- Produces: 扩展在 Qoder CN 扩展目录中正式注册

**注意：** 此任务仅在开发验证通过后、准备正式发布时执行。开发阶段使用 symlink 即可。

- [ ] **Step 1: 计算所有文件的 SHA-256 哈希**

```bash
cd qoder-bridge
# 列出所有需要注册的文件
find .qoder-app-plugin dist assets -type f | sort | while read f; do
  hash=$(sha256sum "$f" | cut -d' ' -f1)
  echo "$f: $hash"
done
```

- [ ] **Step 2: 编写 catalog 条目**

在 `catalog.v1.json` 的 `plugins` 数组中添加新条目：

```json
{
  "id": "qoder.bridge",
  "name": "Multi-Agent Bridge",
  "version": "0.1.0",
  "root": "qoder.bridge",
  "enabledByDefault": true,
  "manifest": {
    "id": "qoder.bridge",
    "name": "Multi-Agent Bridge",
    "version": "0.1.0",
    "engines": { "qoder": ">=0.0.1" },
    "main": "dist/node/main.cjs",
    "activationEvents": ["onStartup", "onView:bridge-portal"],
    "permissions": ["node.callService"],
    "contributes": {
      "views": [
        {
          "id": "bridge-portal",
          "title": { "default": "Multi-Agent", "translations": { "zh-CN": "多智能体" } },
          "location": "workbench",
          "entry": "dist/browser/view.cjs"
        }
      ],
      "sidebarNavItems": [
        {
          "id": "bridge-sidebar",
          "title": { "default": "Multi-Agent", "translations": { "zh-CN": "多智能体" } },
          "icon": "assets/bridge.svg",
          "viewId": "bridge-portal",
          "slot": "workbench.sidebar.secondary"
        }
      ]
    }
  },
  "files": [
    { "path": ".qoder-app-plugin/plugin.json", "sha256": "<计算值>" },
    { "path": "assets/bridge.svg", "sha256": "<计算值>" },
    { "path": "dist/node/main.cjs", "sha256": "<计算值>" },
    { "path": "dist/browser/view.cjs", "sha256": "<计算值>" }
  ]
}
```

- [ ] **Step 3: 验证 catalog 格式**

```bash
node -e "JSON.parse(require('fs').readFileSync('catalog.v1.json','utf8')); console.log('OK')"
```

Expected: 输出 `OK`（JSON 格式有效）

- [ ] **Step 4: 重启 Qoder CN 验证扩展自动加载**

重启后，无需 symlink，扩展应直接从 extensions 目录加载。

---

## 风险与缓解措施

| 风险 | 影响 | 缓解 |
|------|------|------|
| `node.callService` API 细节未完全文档化 | 端口传递可能受阻 | 开发阶段 fallback 到固定端口 3000；`BridgeConsole.tsx` 已包含 fallback 逻辑 |
| Qoder CN 的 CSP 策略可能阻止 `fetch('http://localhost:...')` | UI 无法加载数据 | 若发生，改为通过 `node.callService` 代理所有 HTTP 请求（Node 端做 HTTP client） |
| `qoderPluginView.register` 的 `context.api` 能力边界 | 可能缺少某些需要的 API | Task 10 做最小原型验证，确认 `callService` 可用 |
| `bridge-web-panel.mjs` 路径在不同部署场景下不同 | 子进程启动失败 | `resolvePanelPath()` 支持环境变量覆盖 + 相对路径自动解析 |
| 暗色主题与 Qoder CN 整体风格不完全一致 | 视觉不协调 | 后续迭代：提取 Qoder CN 的 CSS 变量并映射到 `ma-root` 的 CSS 变量 |

## 与原版 dsh-panel 的关键差异总结

| 维度 | dsh-panel (DSH Desktop) | qoder-bridge (Qoder CN) |
|------|------------------------|------------------------|
| 插件框架 | Cordis (`cordis.patch.yml`) | `.qoder-app-plugin/plugin.json` |
| 侧边栏挂载 | `sidebarRightTabs()` + `slots.inject('sidebar.right.pane.tab')` | `sidebarNavItems` → `workbench.sidebar.secondary` |
| 视图位置 | 右侧边栏 tab (~300px) | 主工作区（全屏可用） |
| Host 入口 | Cordis 插件注入 `webServer` | `dist/node/main.cjs` (CJS)，spawn 子进程 |
| Client 入口 | `__ModuleLoader__.load()` 信封 | `globalThis.qoderPluginView.register()` |
| API 路径 | 同源 `/bridge/api/*`（通过 Cordis webServer 代理） | `http://localhost:{port}/api/*`（直连子进程） |
| 构建格式 | Host: ESM, Client: CJS with envelope | 双 CJS（Node + Browser） |
| 分发方式 | npm junction + cordis patch | 扩展目录 + `catalog.v1.json` |
| 依赖 | `@deepseek-ai/schemastery`, `@cordis/types` | 零三方依赖 |
