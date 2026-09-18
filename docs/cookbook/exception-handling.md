# 多 Agent 协作 · 异常处理 cookbook（分发版 · 普适）

> 本 cookbook 只收录「跨机器、跨项目仍成立」的工程经验（可复用的踩坑与对策）。
> 不含任何本机端点、token、项目代号、账号路径。这里的每条经验在你自己的多 Agent 协作里大概率会遇到。

## 目录
1. [控制主控与 worker 的关系](#1-控制主控与-worker-的关系)
2. [worker 偶发失败——重试与模型轮换](#2-worker-偶发失败重试与模型轮换)
3. [长任务与交接代（handoff）](#3-长任务与交接代handoff)
4. [路径与沙箱隔离](#4-路径与沙箱隔离)
5. [密钥与端点——不落盘原则](#5-密钥与端点不落盘原则)
6. [队列/任务状态——僵尸任务的成因与处置](#6-队列任务状态僵尸任务的成因与处置)

---

## 1. 控制主控与 worker 的关系
- bridge 有一个「控制主控」（controller），通常是某 CLI（如 claude 或 codex）；其余是 worker（codex/claude/qwen/opencode/dsh）。
- 主控负责编排（`workflow_start` / `task_create` → 认领 → 收口），worker 负责执行子任务。
- **经验**：主控必须先于 worker 注册 MCP；若某个 worker 是「只读纯文本模型」，不要让它在主循环里承载需要看图/长上下文/重试的步骤。

## 2. worker 偶发失败——重试与模型轮换
- 最常见不是任务错，而是**上游 429 限流 / 超时**。表象各异：
  - CLI 报 `UnknownError` / `Connection` 类，且重跑即过 —— 多为限流 flake，非你的配置错。
- 对策优先级：
  1. 给 worker 配 `fallbackModels`（主模型被限流时自动倒到备模型），显著降低 429 导致的假失败。
  2. 用**指数退避重试**（非直线重试），别在同窗口疯狂重打上游。
  3. 别把「一次超时」当「任务失败」，用 task 的 running→pending/reassign 让另一个 worker 无争议接管（§3）。

## 3. 长任务与交接代（handoff）
- **痛点**：A worker 跑到一半假死不回，B 去抢同一任务，两者各写半份结果 → 双写/错乱。
- **对策**：交接要带「代（generation/handoffId）」：
  - 释放任务时封存旧 attempt 令牌；新主人带新令牌认领。
  - 旧持证者事后任何 complete/fail 一律被拒（stale attempt rejected）——保证同一任务只有「一人写库」。
- 长任务（评估/设计/重构 >2000 字 prompt）给显式 `timeout_sec`（600–900），防真跑一半被误杀。

## 4. 路径与沙箱隔离
- worker 的 `workdir` = 它的**写盘沙箱边界**。只读核对任务漏传 workdir，会让 worker 落在无意义目录甚至读不到要考察的盘/目录。
- **经验**：
  - 给评估/调研任务显式传 workdir，且**别把整个项目根直接塞给 worker 当 workdir**（可能被重解释成“来做 PPT/汇报”而非“读代码”）。
  - 读写工具应把路径**限制在 BRIDGE_WORK_ROOT 或显式 workdir 内**，越界拒绝——防止 worker 挂根目录到处乱改。

## 5. 密钥与端点——不落盘原则
- **红线**：密钥/端点不硬编码进源码，不入仓库，不入分发包。
- 运行时从 `env`（`ANTHROPIC_AUTH_TOKEN` / `QWEN_API_KEY` / `QWEN_BASE_URL`）或本机配置文件（如某 CLI 的 `opencode.json` provider）读取；读不到就让上游明确失败，**绝不 fallback 到明文 key**。
- 部署时把私有值写用户级配置（如 `~/.agents/.env`），与包/仓库物理分离。

## 6. 队列/任务状态——僵尸任务的成因与处置
- **成因**：脚本崩溃、worker 假死、进程被杀后没写终态 → task 卡在 running。
- **对策**：
  - 空闲超时心跳 + 逐级升级（heartbeat/escalation）把僵尸 running 回收。
  - 对「决定变更/被新步骤取代」的任务，用 supersede 而非删/完成，保持日志诚实（无幽灵 pending）。
  - 面板/查询按状态分组可一眼看到长期 running 的异常任务，及时手动回收。

---

> 维护：本 cookbook 与分发包同步更新。新增普适经验时按上述小节归类，再并入。