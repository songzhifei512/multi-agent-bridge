# 多智能体协作系统 · 故障排查手册

> **文档版本**：v1.0.1
> **适用版本**：multi-agent-bridge v1.0.1+
> **最后更新**：2026-09-23

> **v1.0.1+ 修复合入**（与代码同步，未单独发版 v1.0.2）：
> - `bridge/mcp/agents-registry.mjs`：`envStrip()` 工具函数 + `cleanProcessEnv()` 工具函数 + `CLAUDE_AUTH_ENV` / `OPENCODE_ENV` / `QWEN_ENV` 三个 env 对象构造时统一过 strip（剥空串 / 占位符 `<...>` / 宿主污染 `QODER_AGENT_SDK_*`）
> - `bridge/mcp/run-driver.mjs`：派发前 `auto-probe gate`（CLI 不在 PATH 上 fast-fail）+ `envStrip` 二次清洗 + `cleanProcessEnv` 基底层 + `model-follow-env` 占位符守卫
> - `bridge/mcp/state-store.mjs`：`sweepStaleRunning` 增加 `orphan-reaped pid-dead fast path`（`process.kill(pid, 0)` 抛 ESRCH 立即判失败，不靠 10 分钟心跳盲等）
> - `bridge/mcp/bridge-web-panel.mjs`：启动后 60 秒周期 sweep（`BRIDGE_SWEEP_MS` 可调）+ 启动时立即扫一次（捕获重启前留下的孤儿）+ `BRIDGE_SWEEP_DISABLE=1` 可关停

---

## 目录

1. [快速诊断](#1-快速诊断)
2. [诊断工具速查](#2-诊断工具速查)
3. [环境与部署](#3-环境与部署)
4. [MCP 连接](#4-mcp-连接)
5. [任务派发与执行](#5-任务派发与执行)
6. [结果上报与状态](#6-结果上报与状态)
7. [Web 控制台](#7-web-控制台)
8. [DSH / Qoder Panel](#8-dsh--qoder-panel)
9. [数据持久化](#9-数据持久化)
10. [并发与协作](#10-并发与协作)
11. [Windows 平台特有](#11-windows-平台特有)
12. [附录](#12-附录)
13. [获取技术支持](#13-获取技术支持)

---

## 1. 快速诊断

### 1.1 故障定位流程图

```
问题出现
  │
  ├─ 服务无法启动 / CLI 找不到 ──→ 第 3 章 环境与部署
  │
  ├─ MCP 连接失败 / 频繁断开 ──→ 第 4 章 MCP 连接
  │
  ├─ 任务派发失败 / 执行报错 ──→ 第 5 章 任务派发与执行
  │   │
  │   └─ 先调 bridge_stats → 判断是限流 / 配置 / 代码问题
  │
  ├─ 结果上报异常 / 状态错乱 ──→ 第 6 章 结果上报与状态
  │
  ├─ Web 面板异常 ──→ 第 7 章 Web 控制台
  │
  ├─ 侧边栏面板异常 ──→ 第 8 章 DSH / Qoder Panel
  │
  ├─ 数据丢失 / 损坏 ──→ 第 9 章 数据持久化
  │
  ├─ 多 Agent 协作异常 ──→ 第 10 章 并发与协作
  │
  └─ Windows 特有现象 ──→ 第 11 章 Windows 平台特有
```

### 1.2 派发链路定位法

如果是**派发任务失败**，按链路逐级定位：

```
主控（DSH/Claude/Codex/opencode/Qoder）
  │
  ├─ MCP 工具调用（workflow_start / run_* / agent_invoke）
  │     ↓ 报错 "tool not found" → 第 4 章 MCP 连接
  ├─ 参数校验 & Worker 路由
  │     ↓ 报错 "unknown agent" / "not available" → §3.1 Worker 可用性
  ├─ agents-registry 构建命令
  │     ↓ 模型名错误 / env 污染 → §5.2 模型相关
  ├─ run-driver spawn 子进程
  │     ↓ ENOENT / 权限错 / workdir 不存在 → §5.3 工作区 & §3.1
  ├─ Worker CLI 实际执行
  │     ↓ 429 / 超时 / 卡死 → §5.1 限流 & §5.4 任务卡住
  └─ 结果解析 & 状态回写
        ↓ 假成功 / stale attempt / 结果丢失 → 第 6 章
```

**第一步通用动作**：调用 `bridge_stats`，判断是偶发还是系统性故障。

---

## 2. 诊断工具速查

| 工具 | 功能 | 典型使用场景 |
|------|------|-------------|
| `agent_scan` | 检测本地所有 Worker CLI 的可用性 | 新环境部署、怀疑某个 Agent 不可用 |
| `bridge_stats` | 聚合运行统计：总调用数、成功数、失败数、超时数、重试数、平均耗时 | 怀疑限流、性能退化、定位瓶颈 |
| `bridge_checkpoint` | 内存快照的保存 / 恢复 / 列举 | 高危操作前备份、数据损坏后回滚 |
| `bus_history` | 消息总线历史（含已消费） | 排查消息丢失、确认投递状态 |
| `task_list` | 任务列表，支持多维度筛选与排序 | 定位卡住的任务、批量状态核查 |
| `memory_stats` | 向量记忆库统计：总量、分类分布、维度 | 排查向量记忆加载 / 搜索异常 |
| `file_lock_list` | 当前持有的所有文件锁 | 排查锁泄漏、锁持有者定位 |
| `agent_eval` | 按 Agent 聚合的能力评估：完成率、质量分、平均时长 | 任务路由选型、性能对比 |

---

## 3. 环境与部署

### 3.1 Worker CLI 不可用（ENOENT / not found）

**现象**：任务立即失败，错误包含 `spawn <agent> ENOENT`、`command not found` 或 `agent_scan` 返回 `available: false`。

**常见原因**：

| 编号 | 原因 | 概率 |
|------|------|------|
| A | CLI 未安装或不在系统 PATH 中 | 高 |
| B | MCP Server 子进程未继承宿主的 PATH | 中 |
| C | Windows 下 `.cmd` shim 需经 shell 解析 | 高（Windows） |

**排查步骤**：

1. 终端执行 `where <agent>`（Windows）或 `which <agent>`（Unix），确认 CLI 可用
2. 调用 `agent_scan()`，查看目标 Worker 的 `available` 状态
3. 检查 MCP 配置的 `env` 段是否包含正确的 PATH

**解决方案**：

- **推荐**：通过 `*_BIN` 环境变量指定完整路径
  ```
  CLAUDE_BIN=<claude 完整路径>
  CODEX_BIN=<codex 完整路径>
  DSH_BIN=<dsh 入口路径>
  ```
- 备选：在 MCP 宿主配置中补全 PATH
- 备选：将 CLI 所在目录加入**系统级** PATH

**验证**：`agent_scan()` 中目标 Worker 的 `available` 为 `true`。

---

### 3.2 Claude 认证失败

**现象**：`run_claude` 立即返回失败，错误涉及认证或 token。

**原因**：

| 编号 | 原因 |
|------|------|
| A | `ANTHROPIC_AUTH_TOKEN` 未配置 |
| B | 宿主 CLI 已登录，但 MCP 子进程未继承登录态 |
| C | Token 无效或过期 |

**解决**：在 MCP 配置的 `env` 中显式注入：

```json
"env": {
  "ANTHROPIC_AUTH_TOKEN": "sk-ant-..."
}
```

验证：终端执行 `claude -p "hi"` 确认正常返回。

---

### 3.3 Qwen Worker 启动失败

**现象**：`run_qwen` 失败，报错 "No auth type is selected" 或连接错误。

**根因**：Qwen 是 API 端点型 Worker，核心问题不是认证，而是 base URL 未配置导致 SDK 不知道往哪发请求。

**解决**：设置以下环境变量：

```
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
# 或
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

DASHSCOPE_API_KEY=sk-...
```

**验证**：`agent_scan()` 中 `qwen.available` 为 `true`。

---

### 3.4 Node.js 版本不兼容

**现象**：MCP Server 启动即报语法错误（`Unexpected token`、`Top-level await is not available`）。

**原因**：项目使用 ES2022+ 语法，需 Node.js 18+。

**解决**：升级到 Node.js 18 LTS 或更高版本。

---

## 4. MCP 连接

### 4.1 MCP Server 启动失败

**现象**：宿主客户端报 "MCP server error" 或 "connection refused"。

**排查步骤**：

1. **手动启动看报错**：
   ```bash
   node bridge/mcp/shared-context-server.mjs
   ```
2. 检查 `mcpServers` 配置：`command` 指向 node，`args` 指向 `shared-context-server.mjs` 的**绝对路径**
3. 确认 `bridge/data/` 目录存在且有写入权限
4. Web 面板模式下检查端口占用

---

### 4.2 连接频繁断开

**现象**：客户端频繁重连，状态更新延迟，Web 面板 SSE 断开。

| 原因 | 特征 | 对策 |
|------|------|------|
| 网络抖动 | 断开无规律 | 检查网络；Web 面板已内置自动重连 |
| 服务端崩溃 | 每次断开伴随 Server 重启 | 查看日志，定位崩溃原因 |
| 心跳超时 | 约 60 秒周期性 | 确认 `task_heartbeat` 正常调用 |
| 大消息阻塞 | 发大数据后断开 | 避免过大 payload，分片处理 |

**诊断**：`bridge_stats()` 观察失败率与重试次数的时间分布。

---

### 4.3 端口占用（EADDRINUSE）

**现象**：Web 面板服务启动报 `Error: listen EADDRINUSE: address already in use :::3333`。

**解决**：

```bash
# 查占用进程
netstat -ano | findstr 3333

# 终止进程
taskkill /PID <PID> /F

# 或换端口（BRIDGE_PORT 环境变量）
```

---

## 5. 任务派发与执行

> 派发链路：MCP 调用 → 参数校验 → 命令构建 → spawn → Worker 执行

### 5.1 API 限流（429 Too Many Requests）

**现象**：任务失败或大量重试，日志含 "429"、"rate limit"。

**内置机制**：
- 指数退避重试（默认 2 次 = 3 次尝试）
- `fallbackModels` 模型轮换池
- `agent_invoke` 自动备路（忙时改派空闲 Worker）

**分级处置**：

| 程度 | 判断标准 | 措施 |
|------|---------|------|
| 轻度 | 偶发重试，最终成功 | 无需干预 |
| 中度 | 重试上升，成功率下降 | 降并发，启用备模型 |
| 重度 | 大面积失败，重试无效 | 暂停新任务，等限流窗口恢复 |

**操作建议**：
1. `bridge_stats()` 确认范围
2. 重要任务用 `agent_invoke` 而非直接 `run_*`
3. 重度限流时设 `max_retries=0` 避免火上浇油

---

### 5.2 模型相关问题

#### 5.2.1 模型不存在 / 未识别

**现象**：Worker 启动即报错 "model not found"、"unrecognized_model"。

**按 Worker 分类**：

| Worker | 常见原因 | 解决 |
|--------|---------|------|
| Claude | 模型名错误，或宿主 env 污染 | 不传 model 走默认，或传正确名称 |
| Codex | 模型名带了 provider 前缀 | 用 Codex 本地配置中的模型名（无前缀） |
| Qwen | 默认模型在端点不存在 | 显式指定存在的模型（已内置 QWEN_DEFAULT_MODEL） |
| opencode | 模型名格式错误 | 带 provider 前缀，如 `<provider>/model-name` |
| DSH | profile 配置不对 | 检查 `--profile headless` 对应配置 |

**通用诊断**：
1. 先不传 `model`，看默认模型能否跑通
2. 确认模型名格式（前缀/大小写）
3. `agent_scan()` 确认 Worker 可用

#### 5.2.2 宿主环境变量污染

**现象**：`run_codex` / `run_opencode` 报 `unrecognized_model`；`run_qoder` 报 `sdk_invalid_args`。

**根因**：宿主进程（DSH Desktop / Qoder CN / Claude Code）把自身的环境变量注入到 MCP 子进程，再透传给 Worker，覆盖了 Worker 的本地配置。

**受影响的变量**：

| 宿主 | 污染变量 | 影响的 Worker |
|------|---------|-------------|
| Claude Code | `ANTHROPIC_*`（6 个） | codex / opencode / qwen |
| DSH / Qoder | `QODER_AGENT_SDK_ENTRYPOINT` | qoder / qoder_cn |
| 通用 | `OPENAI_*` | opencode / qwen |

**内置修复**（v1.0.1+ 实测可用）：
- `envStrip`（agents-registry.mjs:114）：构造时统一剥空串 / `<PLACEHOLDER>` / undefined / null；spread 进 process.env 时子进程拿到的全是干净键
- `run-driver.mjs` 二次清洗（run-driver.mjs:27）：`opts.env = { ...cleanProcessEnv(), ...envStrip(agent.env) }`，防自定义 descriptor mutate 漏洗
- `cleanProcessEnv()`（agents-registry.mjs:138）：从 process.env 基底层剥除宿主污染 `QODER_AGENT_SDK_*`（DSH / Qoder Desktop 注入的内部 SDK entrypoint，传给 qoderclicn 子进程会报 `sdk_invalid_args`），紧急逃生设 `BRIDGE_KEEP_QODER_SDK=1`
- 本地配置优先：未注入真实 token 时 envStrip 后不传空串，claude SDK 走本地登录态而非报 "Not logged in"
- v1.0.1+ 新增 `auto-probe gate`（run-driver.mjs:200）：派发前 `execOnPath` 探 CLI 是否在 PATH 上，缺失 fast-fail 立即返回结构化报错而非 spawn ENOENT 后再暴露

**如果仍遇到**：
1. 确认使用 v1.0.1+
2. 检查是否手动设置了相关环境变量
3. 无头部署场景设 `BRIDGE_<NAME>_FORCE_ENV_AUTH=1` 强制走 env 认证

---

### 5.3 工作区（workdir）相关

#### 5.3.1 目录不存在（ENOENT exit=-1）

**现象**：任务立即失败，`exit_code=-1`，`spawnError` 含 ENOENT。

**根因**：`workdir` 不存在，spawn 的 `cwd` 指向无效路径。

**内置修复**（v1.0.1+ 实测可用）：自动 `mkdirSync(recursive: true)` 创建目录再 spawn（run-driver.mjs:36）。

**仍遇到时检查**：
- 版本是否为 v1.0.1+
- 路径是否有非法字符或权限问题
- `BRIDGE_WORK_ROOT` 配置是否正确

#### 5.3.2 沙箱隔离机制

- 未传 `workdir` 但有 `task_id` 时，自动创建 `task-<id>` 沙箱目录
- 沙箱位于 `BRIDGE_WORK_ROOT` 下
- 各任务工作区互相隔离

**安全注意**：
- DSH Worker 启用 `workspace-write+never` patch 时，Worker 在 workdir 内可自由写文件
- **务必确保 workdir 指向安全的沙箱目录**，勿指向主仓库或敏感目录
- prompt 中避免包含 shell 元字符（`;`、`|`、`&&` 等）

#### 5.3.3 路径越界

**现象**：文件操作工具报错 "path out of root"。

**原因**：`read_file`、`list_dir` 等工具做了沙箱隔离，超出 `BRIDGE_WORK_ROOT` 的路径被拒绝。

**解决**：确保操作路径在 `BRIDGE_WORK_ROOT` 范围内，或调整该配置。

---

### 5.4 任务长时间无响应（卡住）

**现象**：任务持续 `running`，输出停滞，心跳可能停止。

| 原因 | 识别特征 | 处置 |
|------|---------|------|
| 等待用户输入 | 输出末尾为提问句式 | 中断后通过消息总线补发指令 |
| 网络阻塞 | 心跳停止，进程存活 | 等超时自动终止，或手动中断 |
| 死循环 / 无限生成 | 输出增长但无实质进展 | 手动中断，检查产物可用性 |
| 进程假死 | `agent_live` busy 但无输出 | 超时自动 kill（默认 10 分钟） |

**默认超时**：单次执行 10 分钟，可通过 `timeout_ms` 调整。

**手动恢复**：

```
1. task_interrupt({ task_id })    // 中断，保留输出与 session_id
2. 检查中断前输出，定位问题
3. task_resume({ task_id })       // 续跑（支持 resume 的 Agent 复用上下文）
```

---

### 5.5 权限与审批模式

**现象**：Worker 执行中需要人工确认，或报 "permission denied"。

**各 Worker 审批模式**：

| Worker | 默认审批模式 | 可调参数 |
|--------|-------------|---------|
| Claude | `acceptEdits`（内置） | `--permission-mode` |
| Codex | 依本地配置 | 配置文件中设置 |
| Qwen | `auto`（内置） | `--approval-mode` |
| DSH | `workspace-write+never`（patch） | `--patch` |
| opencode | 依配置 | 视具体配置 |

**写入权限问题排查**：
1. 确认 MCP Server 进程对 workdir 有写入权限
2. Windows 下检查文件是否被其他程序锁定
3. 检查杀毒软件/安全软件拦截

---

### 5.6 按主控分类的特有问题

#### 5.6.1 DSH 作为主控

- **MCP 配置错误** → 参见 §4.1
- **DSH Panel 不显示** → 参见第 8 章 & 《DSH 安装与接入指南》
- **派发后面板无响应** → 确认 Bridge Web Server 启动 + API 正常返回

#### 5.6.2 Claude Code 作为主控

- **环境变量污染** → 参见 §5.2.2
- **认证未继承** → 参见 §3.2

#### 5.6.3 Codex 作为主控

- **本地配置不生效** → 确认 MCP 进程用户与 Codex 配置用户一致，或显式传 `--model`
- **模型名前缀问题** → Codex 模型名**不带** provider 前缀

#### 5.6.4 opencode 作为主控

- **首次启动慢** → `OPENCODE_DISABLE_MODELS_FETCH=1` 跳过模型列表拉取（已内置默认启用）
- **长 prompt 截断** → 已通过 stdin 传递修复（v1.0.1+：claude/codex/qwen/opencode 的 `needsStdin=true`，run-driver 在 spawn 时对 needsStdin 打开 stdin 写入 args.prompt）

#### 5.6.5 Qoder / Qoder CN 作为主控

- **宿主 SDK 变量污染（sdk_invalid_args）** → 参见 §5.2.2
- **CLI 找不到** → `npm i -g @qoder-ai/qodercli`（国际版）或 `@qodercn-ai/qoderclicn`（国内版）

---

## 6. 结果上报与状态

### 6.1 假成功（Exit 0 但实际失败）

**现象**：任务为 `completed` 且 `exit_code=0`，但 `result` 为空或含错误信息。

**根因**：部分 Worker CLI 在上游 API 错误（5xx）时仍返回 exit=0，导致上层误判。

**各 Worker 风险等级**：

| Worker | 风险 | 检测方式 |
|--------|------|---------|
| Qwen | 高 | `isFakeSuccess` 输出特征检测 |
| opencode | 中 | JSON 输出格式校验 |
| Claude | 低 | JSON 输出格式校验 |
| Codex | 低 | JSON 输出格式校验 |
| DSH | 低 | 文本输出特征检测 |

**加固方案**：
1. `run_verify` 质量门禁：LLM-as-judge 打分，低于阈值打回
2. 结果非空校验 + 格式校验
3. 高价值任务用竞争式并行 + 交叉比对

---

### 6.2 结果上报被拒（stale attempt_id）

**现象**：

```
stale attempt_id <id> — task was re-assigned or re-claimed
```

**机制说明**：

这是**正常的并发保护机制**，不是 bug。每个任务每次认领生成唯一 `attempt_id`（交接代令牌），任务被重新分配后旧令牌失效，避免过期结果覆盖新状态。

**Worker 端正确处理**：

```javascript
const res = await task_complete({ task_id, result, attempt_id });
if (res.error?.includes("stale attempt_id")) {
  // 任务已被重新分配，放弃本次结果，重新认领新任务
  return findAndClaimNextTask();
}
```

---

### 6.3 依赖未满足无法认领

**现象**：

```
cannot claim task <id>: unmet dependencies [...]
```

**原因**：前置任务尚未完成（非 completed/superseded/failed）。

**正确流程**：
1. `task_list({ status: "pending" })` 筛选可认领任务
2. 再对符合条件的任务 `task_claim`
3. 或使用 `workflow_start` + 自动调度

---

### 6.4 孤儿任务（面板重启后永久 running）

**现象**：任务一直卡在 `running`，心跳数不变，重试次数为 0，Worker 进程已死。

**根因**：面板进程自重启 / 闪退 / 代码热重载后，在途任务的 settle 回调随旧进程消失，任务永远不会写终态。

**内置修复**（v1.0.1+ 实测可用）：
- `sweepStaleRunning`（state-store.mjs:204）孤儿回收器：双重保险
  - **pid-dead fast path**：running + 有 `agent_live.pid` 时 `process.kill(pid, 0)` 抛 ESRCH → 立即判失败（不靠 10 分钟心跳盲等）
  - **心跳超时兜底**：`last_heartbeat_at` 停滞超阈值（默认 10 分钟）→ 判失败
- 面板进程（bridge-web-panel.mjs:2353）：启动后 `setImmediate(sweepOnce)` 先扫一次（捕获重启前留下的孤儿），再 `setInterval` 每 60 秒扫（`BRIDGE_SWEEP_MS` 可调）
- 回收的任务标记 `[orphan-reaped: pid N dead]`，`agent_live` 字段同步删除，面板立刻看到 `failed` 状态，DAG 下游自动解锁

**预期**：面板异常退出后，最长 60 秒内孤儿任务被回收。

---

### 6.5 Session 续接失效

**现象**：`task_resume` 后 Agent 是全新会话，丢失上下文。

| Agent | Resume 支持 | 说明 |
|-------|------------|------|
| Claude Code | ✅ | `--resume` |
| Codex | ✅ | 原生支持 |
| Qwen | ✅ | API 型天然支持 |
| DSH | ❌ | 无 session 机制 |
| opencode | ❌ | 每次全新会话 |
| qoder / qoder_cn | 视版本 | 取决于后端 |

不支持 resume 的 Agent，`task_resume` 以全新上下文重跑，属预期行为。

---

### 6.6 结果丢失 / 未正确回写

**现象**：Worker 执行完了，但任务仍为 `running` 或 `result` 为空。

| 可能原因 | 排查方法 |
|---------|---------|
| 输出解析失败 | 检查原始输出格式是否符合 parse 函数预期 |
| 结果过长被截断 | result 默认上限 20000 字符 |
| 进程异常退出 | 查看 `exit_code`、`timedOut`、`spawnError` |
| 上报时连接中断 | run_* 为异步写入，断连可能丢结果 |

**诊断**：查看任务记录的 `result`、`exit_code`、`timedOut`、`spawnError` 字段。

---

## 7. Web 控制台

### 7.1 页面白屏

**排查步骤**：
1. F12 → Console：JS 错误 = 前端构建问题；404 = 路径错误
2. `curl http://localhost:3333/`：有内容 → 前端问题；连不上 → 服务未启动
3. 检查 `bridge-web/dist/index.html` 是否存在（不存在则自动 fallback 到内联版）

---

### 7.2 未启用 React 版本

**现象**：界面是旧版纯 HTML，非三栏布局。

**原因**：React 构建产物不存在，自动降级为内联 HTML（兜底机制）。

**解决**：

```bash
cd bridge-web
npm install
npm run build
```

重启 MCP Server。

> **设计说明**：React 版 + 内联版并存是容错设计 — 前端构建挂了也不影响核心功能。

---

### 7.3 SSE 断开 / 实时更新失效

**现象**：数据不自动刷新，需手动刷新页面。

**机制**：SSE 实时推送 + 自动重连 + 重连期间降级为轮询。

**排查**：F12 → Network → `/events` 请求状态，`pending` 为正常。

**临时恢复**：刷新页面。

---

### 7.4 Vite Dev Server 代理异常

**现象**：`npm run dev` 时 API 404。

**原因**：Vite 端口与 MCP Server 端口不一致。

**解决**：确认 `bridge-web/vite.config.ts` 的代理配置指向正确端口（默认 3333）。

---

## 8. DSH / Qoder Panel

### 8.1 样式与 Web 面板不一致

| 原因 | 说明 | 解决 |
|------|------|------|
| CSP 限制 | Qoder CN webview 禁止注入 `<style>` | 用内联样式版本（`inlineStyles`） |
| 样式文件未同步 | `styles.ts` 与 `inlineStyles.ts` 两份独立 | 新增样式需同步改两份 |
| 容器宽度不同 | 侧边栏窄于 Web 面板 | 预期差异，非故障 |

---

### 8.2 派发按钮无响应

| 检查项 | 预期 | 异常原因 |
|--------|------|---------|
| 按钮是否禁用 | 有内容后可点击 | 内容为空时禁用（预期行为） |
| 输入框提示 | 空内容显示"请输入任务内容" | 正常表单验证 |
| Network 是否有 API 请求 | 点击后有 `/api/dispatch` 请求 | 无请求 = 前端事件未绑定 |
| API 返回 | `ok: true` | 失败 = 后端问题 |

---

### 8.3 折叠三角不生效（历史 / 已归档）

**排查**：
1. `onToggle` 回调是否正确传递
2. React 状态更新是否触发重渲染
3. CSS `max-height` 过渡的初始值是否正确
4. 加日志确认点击事件与状态变更正常

---

### 8.4 DAG 图节点布局异常

**已知限制**：
- 侧边栏内联 DAG 为轻量级实现，节点 >10 个可能拥挤
- 复杂依赖（多入多出）布局算法较简化

**替代方案**：
- 切换到「树状视图」（更稳定）
- 在 Web 面板中查看全尺寸 DAG

---

## 9. 数据持久化

### 9.1 memory.json 损坏

**现象**：启动报 `SyntaxError` 或 `Unexpected end of JSON input`。

**成因**：进程异常终止（断电 / 强杀）导致 JSON 写入不完整。

**防护机制**：原子写入（先写 `.tmp` 再 rename），正常场景不会损坏。

**恢复流程**：

1. **Checkpoint 恢复（首选）**：
   ```
   bridge_checkpoint({ name: "list" })
   bridge_checkpoint({ name: "<name>", restore: true })
   ```
2. 从备份文件恢复
3. 删除损坏文件，系统自动初始化（数据丢失）

**预防**：
- 高危操作前 `bridge_checkpoint` 存快照
- 避免强制终止进程
- 定期备份 `bridge/data/memory.json`

---

### 9.2 向量记忆首次调用缓慢

**原因**：懒加载 — ONNX + sqlite-vec 在首次使用时才初始化。

**预期行为**：首次慢（秒级），之后快，启动时不预加载。

**预热**：启动后调用一次 `memory_stats()` 触发初始化。

---

### 9.3 向量记忆搜索相关性低

| 原因 | 优化 |
|------|------|
| 数据量不足 | 增加记忆条目 |
| 内容过短 | 确保记忆内容完整 |
| 未限定分类 | 用 `category` 参数缩小范围 |
| 中英文混合 | 尽量统一语言 |

**进阶**：`memory_promote` 手动提升关键记忆权重。

---

## 10. 并发与协作

### 10.1 任务重复认领

**机制保证**：单 MCP Server 实例下**不会发生** — 内存更新原子 + MCP stdio 天然串行。

**若发生，请检查**：
- 是否启动了多个 MCP Server 共享同一个 `memory.json`（不支持）
- 是否外部直接修改了 `memory.json`（绕过状态机）

---

### 10.2 文件锁未生效

**机制说明**：Advisory Lock（劝告锁），依赖所有参与者协作遵守。类比会议室预订系统。

**最佳实践**：
- 协作规范中明确：改文件前必须 `file_lock_acquire`
- 主控负责监督与审计
- 用 `file_lock_list` 定期检查

---

### 10.3 消息投递失败

**排查路径**：
1. `to` 参数的 Agent 名是否完全匹配（大小写敏感）
2. 消息是否已被消费（消息只能消费一次）
3. 是否被其他 reader 持有租约（60 秒自动释放）
4. `bus_history` 确认消息是否真实投递

**实时性**：接收方在 `inbox_wait` 挂起时，消息即时唤醒。

---

## 11. Windows 平台特有

### 11.1 终端能跑但 MCP 中找不到

**根因**：Node.js `spawn` 默认不走 shell；npm `.cmd` shim 需 shell 解析；子进程 PATH 可能不同。

**解决**：通过 `*_BIN` 环境变量指定完整路径（推荐）。

---

### 11.2 中文长 Prompt 截断

**根因**：`shell:true` 时命令行经 cmd.exe 解析，有长度限制 + 中文字节数超限 + 特殊字符被解释。

**内置修复**：支持 stdin 的 Worker（claude/codex/qwen/opencode）均通过 stdin 传 prompt，彻底规避。

---

### 11.3 路径含空格导致命令错误

**根因**：cmd.exe 按空格切词，路径中的空格被误认为参数分隔。

**内置修复**：run-driver 对 Windows 命令首项自动加引号包裹。

---

### 11.4 中文输出乱码

**解决**：启动前切换控制台编码：
```powershell
chcp 65001
```

---

### 11.5 task_interrupt 杀不掉进程

**根因**：Windows 下 `child_process.kill()` 有时杀不干净进程树。

**内置修复**：已适配 `taskkill /T /F` 强制终止进程树。

**手动处置**：
```bash
tasklist | findstr "<关键词>"
taskkill /PID <PID> /T /F
```

---

### 11.6 PowerShell 执行策略限制

**说明**：项目不直接调用 `.ps1`，使用 `.cmd` 版本。优先用 `.cmd` 版 CLI，勿修改执行策略（有安全风险）。

---

## 12. 附录

### 12.1 run_* 工具参数矩阵

| 参数 | claude | codex | qwen | dsh | opencode | qoder | qoder_cn |
|------|--------|-------|------|-----|----------|-------|----------|
| `prompt` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `model` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `workdir` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `session_id` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `task_id` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `timeout_ms` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `max_retries` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `agent_name` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### 12.2 各 Worker 能力对比

| 能力 | claude | codex | qwen | dsh | opencode | qoder |
|------|--------|-------|------|-----|----------|-------|
| Resume 支持 | ✅ | ✅ | ✅ | ❌ | ❌ | 视版本 |
| 模型轮换 | ✅ | ✅ | ✅ | ❌ | ✅ | 视版本 |
| Stdin 传 prompt | ✅ | ✅ | ✅ | ❌ | ✅ | 视版本 |
| 工作区隔离 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| JSON 输出 | ✅ | ✅ | ✅ | ❌ | ✅ | 视版本 |

### 12.3 环境变量速查

| 环境变量 | 用途 | 对应 Worker |
|---------|------|------------|
| `BRIDGE_WORK_ROOT` | 工作区根目录 | 全部 |
| `BRIDGE_PORT` | Web 面板端口 | Web 面板 |
| `BRIDGE_CLAUDE_FORCE_ENV_AUTH` | 强制 claude 走 env 认证 | claude |
| `BRIDGE_OPENCODE_FORCE_ENV_AUTH` | 强制 opencode 走 env 认证 | opencode |
| `CLAUDE_BIN` | Claude CLI 路径 | claude |
| `CODEX_BIN` | Codex CLI 路径 | codex |
| `DSH_BIN` | DSH 入口路径 | dsh |
| `DSH_PATCH` | DSH patch 配置 | dsh |
| `OPENCODE_BIN` | opencode CLI 路径 | opencode |
| `ANTHROPIC_AUTH_TOKEN` | Claude 认证 token | claude |
| `QWEN_BASE_URL` | Qwen 端点 URL | qwen |
| `DASHSCOPE_API_KEY` | 通义千问 API Key | qwen |
| `QWEN_DEFAULT_MODEL` | Qwen 默认模型 | qwen |
| `QODER_DEFAULT_MODEL` | Qoder 默认模型 | qoder |
| `QODER_CN_DEFAULT_MODEL` | Qoder CN 默认模型 | qoder_cn |
| `OPENCODE_DISABLE_MODELS_FETCH` | 跳过模型列表拉取 | opencode |

### 12.4 相关文档

- **部署接入**：[DSH 安装与接入指南](./dsh-integration-guide.md) — DSH CLI / MCP 接入 / dsh-panel 完整流程
- **经验食谱**：[异常处理 Cookbook](../cookbook/exception-handling.md) — 跨项目普适的工程经验与设计原则
- **变更日志**：[CHANGELOG.md](../../CHANGELOG.md) — 各版本功能变更

---

## 13. 获取技术支持

1. **查变更日志**：`CHANGELOG.md` 可能包含版本间行为变化
2. **搜 Issue**：GitHub Issues 中可能有相同问题
3. **提 Issue 请附**：
   - 操作系统与 Node.js 版本
   - multi-agent-bridge 版本号
   - 完整错误信息与上下文
   - `bridge_stats` 输出
   - 最小复现步骤

---

> 本文档随项目版本同步更新。如发现内容有误或有补充建议，欢迎提交 PR。
