# Multi-Agent Bridge 控制台面板 UI 优化设计文档

> **状态**：Draft — 待用户审查  
> **日期**：2026-09-21  
> **范围**：dsh-panel 前端 UI 全面优化（组件、布局、视觉、交互）  
> **可视化预览**：`dsh-panel/ui-optimization-preview.html`

---

## 1. 背景与动机

dsh-panel 是 Multi-Agent Bridge 的控制台面板，当前作为 Cordis 插件嵌入 DSH Desktop 右侧边栏（~320px 宽）。现有 UI 存在以下问题：

**信息碎片化** — 工作流、任务、成员、派发分散在 4 个 Tab 中，用户需要频繁切换才能拼凑全局视图。例如，看到工作流进度后必须切到"任务"Tab 才能查看具体任务状态。

**视觉层次不足** — 所有元素权重相近，缺乏清晰的信息层级。6px 高的多段进度条、纯文字 Tab、均质的卡片边框使关键信息不够突出。

**交互效率低** — 派发任务需要完整切换到派发 Tab 填写表单，打断了监控工作流的上下文。已完成和进行中的工作流混在一起，没有视觉区分。

**主题单一** — 仅支持暗色主题，无法适配浅色工作环境。

## 2. 设计目标

1. **一屏全局** — 核心信息（工作流进度 + 任务状态 + 成员分布）在同一视图中可见，消除 Tab 切换
2. **层次清晰** — 活跃 vs 已完成、进行中 vs 等待 vs 失败，通过视觉权重区分
3. **操作就近** — 派发任务不离开当前浏览位置
4. **主题自适应** — 支持暗色/浅色双主题，平滑切换

## 3. 方案选型

评估了三种方案后选择 **方案 A：融合视图（Fusion View）**：

| 方案 | 思路 | 取舍 |
|------|------|------|
| **A. 融合视图** ✓ | 取消 Tab，工作流卡片为主体，任务内联 | 信息密度最高，但卡片可能较长 |
| B. 增强 Tab | 保留 Tab 结构，优化各 Tab 内部设计 | 改动最小，但未解决碎片化 |
| C. 双区布局 | 上半固定概览，下半可切换详情 | 概览始终可见，但 320px 宽度下上下分区太挤 |

选择 A 的核心理由：320px 侧边栏宽度下，纵向滚动远比横向切 Tab 高效。工作流天然是任务的容器，将任务内联到工作流卡片中符合心智模型。

## 4. 信息架构

### 4.1 整体结构

```
┌─────────────────────────┐
│  Sticky Header          │  ← 连接状态 + Controller + 全局统计
├─────────────────────────┤
│                         │
│  ── 进行中 N ──         │  ← 分区标题
│  ┌───────────────────┐  │
│  │ Workflow Card 1   │  │  ← 默认展开，内联任务列表
│  │  ▸ 依赖图         │  │
│  └───────────────────┘  │
│  ┌───────────────────┐  │
│  │ Workflow Card 2   │  │  ← 可折叠
│  └───────────────────┘  │
│                         │
│  ── 已完成 M ──         │  ← 分区标题
│  ┌───────────────────┐  │
│  │ Workflow Card 3   │  │  ← 默认折叠，点击展开
│  └───────────────────┘  │
│  ...                    │
│                         │
│                    [＋]  │  ← FAB 派发按钮
└─────────────────────────┘
```

### 4.2 取消的模块

| 原模块 | 处置 | 理由 |
|--------|------|------|
| Tab 导航 | 移除 | 融合视图取代 |
| 独立任务视图 | 合并到工作流卡片 | 任务是工作流的子集，内联更直观 |
| 独立成员视图 | 合并到工作流卡片头部 | 成员信息以 dots 形式附属于工作流 |
| 独立派发表单 | 改为 FAB + overlay | 就近操作，不打断浏览 |

## 5. 组件设计

### 5.1 Sticky Header

**职责**：始终可见的连接状态和全局统计摘要。

**布局**：
- 第一行：连接指示灯（7px 圆点 + glow）+ Controller 名称 + "Multi-Agent" 标签
- 第二行：4 个 stat chip（运行 / 待领 / 完成 / 失败），每个 chip 数字着色对应状态色

**规格**：
- padding: 14px 14px 10px
- 底部 1px border 分隔
- 背景与面板同色，position: sticky, top: 0, z-index: 10

### 5.2 工作流卡片 (Workflow Card)

**职责**：展示单个工作流的进度、成员、任务列表和依赖图。

**两种形态**：

**活跃工作流**（状态为 running/pending/failed 且有未完成任务）：
- 默认展开
- 完整头部：状态点 + 名称 + 成员 dots + 进度计数 (3/5) + 展开箭头
- 2px 细进度条（分段着色：绿=完成、蓝=运行、黄=等待、红=失败）
- 内联任务列表
- DAG 依赖图切换

**已完成工作流**（所有任务完成或失败）：
- 默认折叠，仅显示精简行：状态点 + 名称 + 进度 + 箭头
- 点击展开可查看任务详情
- 使用 `wf-done-line` 样式（较矮的 padding）

**头部规格**：
- padding: 10px 12px
- hover 时背景变为 `--hover`
- 状态点 7px，running 带 glow，completed/failed 无 glow
- 成员 dots 6px，颜色对应成员标识色
- 名称 12px/600，单行截断
- 进度计数 10px，`--mut` 色

**进度条规格**：
- 高度 2px，位于头部下方
- 左右 margin: 12px
- 分段使用 flex 布局，宽度为百分比

### 5.3 任务行 (Task Row)

**职责**：在工作流卡片内展示单个任务的状态和归属。

**布局**：
```
[状态图标] [t1] 任务标题           assignee
```

**规格**：
- padding: 5px 6px
- border-radius: 6px
- hover 时背景 `--hover`
- 字体 11px

**状态图标**（14px 圆形）：
| 状态 | 样式 |
|------|------|
| completed | 绿底 + ✓ 白字 |
| running | 蓝底 + glow |
| pending | 透明 + 黄边框 |
| failed | 红底 + ✗ 白字 |
| waiting | 透明 + 灰边框（依赖未满足）|

**任务 ID**：monospace 字体，10px/600，accent 色，固定宽度 20px

**已完成任务标题**：颜色降为 `--mut`

**未分配任务**：assignee 位置显示 "待领取"，颜色 `--dim`

### 5.4 内联 DAG 依赖图

**职责**：可视化展示工作流内任务的依赖关系。

**交互**：
- 默认隐藏，点击 "▸ 查看依赖图" 展开
- 展开后文字变为 "▾ 收起依赖图"
- 使用 max-height transition 动画（250ms ease-out）

**视觉**：
- 背景 `--bg`（与面板底色一致，形成"凹入"感）
- 顶部 1px border 分隔
- SVG 节点：圆角矩形 (rx=5)，填充 `--dag-node-fill`，边框颜色对应任务状态
- 连线：`--dag-edge` 色，带箭头 marker
- 节点内文字：任务 ID 用 accent 色，描述文字已完成用 `--dag-text-done`，进行中用 `--dag-text-active`

### 5.5 FAB 派发按钮

**职责**：全局可达的任务派发入口，不依赖当前视图位置。

**规格**：
- 位置：absolute, bottom: 16px, right: 16px
- 尺寸：40px 圆形
- 背景：`--acc`，白色 ＋ 字符（font-size: 20px, font-weight: 300）
- 阴影：`--fab-shadow`，hover 时增强为 `--fab-shadow-hover`
- 交互：hover scale(1.08)，active scale(0.95)
- z-index: 20

### 5.6 派发 Overlay

**职责**：从底部滑入的派发表单，不离开当前浏览上下文。

**交互**：
- 点击 FAB → 半透明遮罩 + 底部面板 slide-up（250ms ease-out）
- 遮罩：`--overlay-bg` + backdrop-filter: blur(4px)
- 点击遮罩空白区域或 ✕ 关闭
- 派发成功后 Toast 提示，2.5s 自动消失

**表单布局**：
- 标题行："派发任务" + 关闭按钮
- Worker 选择：select 下拉，`--bg` 底色
- Prompt 输入：textarea，min-height 72px，可拉伸
- 派发按钮：全宽，`--acc` 底色

### 5.7 Toast 提示

**职责**：操作反馈。

**规格**：
- 位置：absolute, top: 12px, 全宽减 margin
- 初始 transform: translateY(-120%)，show 时 translateY(0)
- 背景：半透明绿 + 绿色边框
- 内容：✓ 图标 + 文字（如 "已派发 → alice"）
- 自动消失：2500ms

## 6. 视觉设计系统

### 6.1 暗色主题

| Token | 值 | 用途 |
|-------|-----|------|
| `--bg` | #0a0a0f | 面板底色 |
| `--card` | #12121a | 卡片底色 |
| `--hover` | #1a1a26 | hover 态 |
| `--border` | #1e1e2e | 默认边框 |
| `--border2` | #2a2a3e | 强调边框 |
| `--txt` | #e4e4ed | 主文字 |
| `--mut` | #6b6b80 | 次要文字 |
| `--dim` | #44445a | 最弱文字 |
| `--acc` | #6366f1 | 强调色 |
| `--ok` | #22c55e | 成功 |
| `--run` | #3b82f6 | 运行中 |
| `--pend` | #eab308 | 等待 |
| `--err` | #ef4444 | 失败 |

### 6.2 浅色主题

| Token | 值 | 调整说明 |
|-------|-----|----------|
| `--bg` | #f5f6fa | 浅灰底 |
| `--card` | #ffffff | 纯白卡片 |
| `--hover` | #eef0f5 | 浅灰 hover |
| `--border` | #e2e4ea | 浅灰边框 |
| `--border2` | #d0d3dc | 较深边框 |
| `--txt` | #1a1a2e | 深色文字 |
| `--mut` | #6b7080 | 中灰 |
| `--dim` | #9ca0ad | 浅灰 |
| `--acc` | #4f46e5 | 略深以保证对比度 |
| `--ok` | #16a34a | 深绿 |
| `--run` | #2563eb | 深蓝 |
| `--pend` | #ca8a04 | 深黄 |
| `--err` | #dc2626 | 深红 |

### 6.3 主题切换

- 通过 `document.documentElement.setAttribute('data-theme', 'light')` 切换
- 所有颜色属性（background, border-color, color, box-shadow, fill, stroke）添加 300ms transition
- 切换按钮位于预览控制区左上角，暗色模式显示 ☀️（点击切到浅色），浅色模式显示 🌙

### 6.4 字体

- UI 字体：`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif`
- 等宽字体：`ui-monospace, SFMono-Regular, Consolas, monospace`（任务 ID、DAG 节点标签）

### 6.5 圆角

- 面板：12px
- 卡片：10px (`--radius`)
- 内部元素（chip、task row、input）：6-8px (`--radius-sm`)

## 7. 数据流与状态管理

UI 优化不改变数据流架构。`useBridgeState()` hook 继续负责：
- SSE 连接 `${baseUrl}/events` 接收实时事件
- 每 3s 轮询 `${baseUrl}/api/state` 获取完整状态
- 返回 `{ state, connected }` 供组件消费

组件树变化：

```
BridgeConsoleTab (was: 4 tabs)
├── StickyHeader (new: 连接状态 + stats)
├── WorkflowList (new: 替代 4 个 Tab)
│   ├── SectionDivider "进行中"
│   ├── WorkflowCard[] (active, expanded)
│   │   ├── WorkflowHead
│   │   ├── ProgressBar
│   │   ├── TaskRow[]
│   │   └── InlineDag (toggleable)
│   ├── SectionDivider "已完成"
│   └── WorkflowCard[] (completed, collapsed)
├── FAB (new: 派发入口)
├── DispatchOverlay (new: slide-up 表单)
└── Toast (new: 操作反馈)
```

## 8. 响应式与约束

- 面板宽度固定 320px（侧边栏约束）
- 高度：`calc(100vh - 80px)`，max-height 780px
- 内容区 overflow-y: auto，自定义 6px 滚动条
- 对比模式下两个面板横向排列，740px 以下断点改为纵向

## 9. 不变的部分

以下保持不变，不在本次优化范围内：
- 后端 bridge-web-panel.mjs（API、SSE、数据模型）
- Host 端 Cordis 插件逻辑（/bridge 代理、子进程管理）
- useBridgeState hook 的 SSE/轮询机制
- API 接口契约（/api/state, /api/run, /api/action, /events）

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 工作流数量多时列表过长 | 用户需大量滚动 | 已完成工作流默认折叠；可考虑后续加虚拟滚动 |
| 内联任务列表使卡片很高 | 单卡片占满视口 | 卡片展开时限制 max-height + overflow-y: auto |
| 浅色主题对比度不足 | 可读性差 | 状态色统一加深（见 6.2 调整说明） |
| DAG SVG 硬编码颜色 | 主题切换时 DAG 不变 | 所有 SVG fill/stroke 使用 CSS 变量 |
| FAB 遮挡底部内容 | 最后几个像素不可见 | 内容区底部添加 56px padding |
