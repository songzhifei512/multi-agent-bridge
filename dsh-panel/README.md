# DSH Bridge Panel

DSH 侧边栏多智能体协作控制台插件

## 快速开始

### 前置要求

- Node.js 18+
- DSH Desktop（已安装 cordis plugin 支持）
- multi-agent bridge 已正确配置

### 安装

```bash
# 1. 构建插件
cd dsh-panel
npm install
npm run build

# 2. 注册到 DSH 插件目录（开发模式：junction 链接，代码改动即时生效）
npm run link-dev

# 也可手动指定路径：
#   DSH_PLUGINS_DIR=/custom/path npm run link-dev
# 或直接创建链接：
#   Windows（管理员 PowerShell）
#   New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.dsh\plugins\dsh-bridge-panel" \
#     -Target "<仓库路径>\multi-agent\dsh-panel"
```

> 升级版本号时，跑 `npm run build` 后重启 DSH Desktop 即可加载新 dist；不需重跑 `link-dev`（junction 始终指向同一源）。

### 开发

```bash
# 监听模式构建
npm run dev

# 运行集成测试
bash scripts/integration-test.sh
```

## 功能

- 实时监控 bridge 任务和 Worker 状态
- SSE 事件流实时推送
- 任务派发和主控切换
- Session 隔离的多会话管理

## 架构

- **Host Half**: `src/index.ts` - DSH cordis plugin 入口，管理子进程和 webServer proxy
- **Browser Half**: `src/client/index.tsx` - React UI 组件，通过 same-origin proxy 与桥服务通信
- **Bridge API**: `../bridge/mcp/bridge-web-panel.mjs` - HTTP 服务端，提供 /api/run、/api/state、/events 端点

## 故障排查

### 桥服务未启动

点击面板中的"启动服务"按钮，或手动运行：

```bash
node ../bridge/mcp/bridge-web-panel.mjs --port 3000
```

### Worker 缺失

运行探测脚本：

```bash
node ../scripts/probe-cli.mjs
```
