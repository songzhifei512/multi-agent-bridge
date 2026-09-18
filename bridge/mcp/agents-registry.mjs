// agents-registry.mjs — Agent 注册表 + env 配置 + CLI 输出解析器
// 从 shared-context-server.mjs 拆出（ 模块拆分第一步，2026-08-28）。
// 自包含：env 常量、解析器、AGENTS 描述子注册表。导出 AGENTS / extractJsonObject / parseClaudeOut。
// 启动副作用（ANTHROPIC env 校验 + applyAutoController）仍留主文件（依赖 STATE_DIR）。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const IS_WIN = process.platform === "win32";

// ---- env 读取（与主文件同源，process.env 谁读都一样，避免循环依赖）----
const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;

const CLAUDE_AUTH_ENV = {
  ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || "<MODEL_AUTO>",
  ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || "<MODEL_AUTO>",
  ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || "<MODEL_MEDIUM>",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "<MODEL_FLASH>",
};

// ---- opencode worker env (备路 worker / 单发长文档互补) ----
// opencode 是备路 worker（<PROVIDER> OpenAI 兼容端点 + --format json 解析）。
// 关键实测（见部署指南《九、Worker Agent 替代与排查》）：<PROVIDER> 必须走 OpenAI 兼容端点
// （@ai-sdk/openai-compatible + /v3/openai/model），不能走 Anthropic 端点（连不上/慢）。
// 启动提速：OPENCODE_DISABLE_MODELS_FETCH=1（跳过 models.dev 在线拉取，省启动时间，主要提速点）
// → opencode 启动明显提速。⚠ 不带 --pure：--pure 与 --format json 不兼容（跳过
// oh-my-openagent 插件致回复正文不写 stdout，只剩 step_start 就 exit=0），见 opencodeBase() 注释。
const OPENCODE_ENV = {
  ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_BASE_URL,
  OPENAI_API_KEY: ANTHROPIC_AUTH_TOKEN,          // opencode 读 OPENAI_API_KEY
  // 公网分发包：endpoint 走 env（OPENAI_BASE_URL），无硬编码默认。
  // 未配置时为空串，调用 opencode 线程上游明确失败（绝不 fallback 明文端点，见 ENV_SETUP.md）。
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || "",
  OPENCODE_DISABLE_MODELS_FETCH: "1",            // 跳过 models.dev 在线拉取（省启动时间）
  OPENCODE_MODEL_PROVIDER: process.env.OPENCODE_MODEL_PROVIDER || "",
};

// ---- qwen worker env (qwen 端点, 写文档/PPT + 图像互补) ----
// qwen CLI（Qwen Code）作 opencode 写文档互补 + vision_analyze 图像互补。--auth-type openai 走
// OPENAI_API_KEY/OPENAI_BASE_URL env（源码 authType==="openai" && model.baseUrl），指 qwen 端点 OpenAI 兼容端点。
// 密钥从 env 读（QWEN_API_KEY/QWEN_BASE_URL），fallback 到 qwen 端点 默认值（与 vision_analyze 读 opencode.json
// 不同，但更直接；如需统一不落盘可改读 opencode.json 的 qwen provider）。
// 注意：qwen CLI 模型名不带 qwen/ 前缀（Qwen3.5-397B-A17B-FP8），与 opencode（带 qwen/ 前缀）相反。
// ---- qwen worker env (qwen 端点, 写文档/PPT + 图像互补) ----
//  修复（2026-08-21）：消除硬编码明文 sk- key。读取顺序：① QWEN_API_KEY env → ② opencode.json
// 的 qwen provider apiKey（与 vision_analyze:1339 同源，避免两处 key 漂移）→ ③ 两者皆空返回空 key，
// 由上游 401 明确失败，绝不静默用明文。key 轮换 = 改 env/config 即生效，不动代码。
function qwenApiKey() {
  const envKey = process.env.QWEN_API_KEY;
  if (envKey) return envKey;
  try {
    const CFG = JSON.parse(readFileSync(join(homedir(), ".config", "opencode", "opencode.json"), "utf8"));
    const key = CFG?.provider?.qwen?.options?.apiKey;
    if (key) return key;
  } catch { /* opencode.json 不可读 → 空 key，上游明确失败 */ }
  return "";
}
const QWEN_ENV = {
  OPENAI_API_KEY: qwenApiKey(),
  OPENAI_BASE_URL: process.env.QWEN_BASE_URL || "",
};

// qwen 默认模型：qwen CLI 内置默认模型在 qwen 端点不存在 → 500，
// 故调用方未传 model 时显式钉这个 qwen 端点 真实模型。QWEN_DEFAULT_MODEL env 可覆盖。
// Qwen3.6-35B-A3B-FP8 稳；Qwen3.5-397B-A17B-FP8 偶发慢/超时。
const QWEN_DEFAULT_MODEL = process.env.QWEN_DEFAULT_MODEL || "Qwen3.6-35B-A3B-FP8";

// codex 默认模型：调用方未传 model 时，codex 会走本地 config.toml
// 的默认——可能走外网模型，导致超时/无法连 <PROVIDER> 端点。
// 这里显式钉 <PROVIDER>-Medium（用户指定），codex model 名不带 provider 前缀（本地配置统一路由）。
// CODEX_DEFAULT_MODEL env 可覆盖；fallback 在重试时代入（见 fallbackModels）。
const CODEX_DEFAULT_MODEL = process.env.CODEX_DEFAULT_MODEL || "<MODEL_MEDIUM>";

// ---- opencode worker runtime ----
// opencode 是备路 worker（无状态单发文本/代码 + 限流并发备路 + 单发长文档互补）。
// 入口可用 OPENCODE_BIN 覆盖，默认 `opencode`（npm .cmd shim，spawn 走 cmd.exe）。
// opencode 默认模型 <MODEL_PROVIDER_PREFIX>/<PROVIDER>-Auto（<PROVIDER> OpenAI 兼容端点最快最稳）；可切 <MODEL_PROVIDER_PREFIX>/<PROVIDER>-Medium
// 或 qwen/Qwen3.5-397B-A17B-FP8（qwen 端点，写文档紧扣素材不跑题，v7 实跑）。
const OC_ENTRY = process.env.OPENCODE_BIN || "opencode";
const OC_DEFAULT_MODEL = process.env.OPENCODE_MODEL || "<MODEL_PROVIDER_PREFIX>/<MODEL_AUTO>";

// claude worker binary. On Linux: resolve by absolute path, NOT by PATH (multiple claude trees
// may exist; PATH may resolve `claude` to a fragile copy). Pin to a known-good bin/claude.
// On Windows: claude is an npm .cmd shim on
// PATH; spawn with shell:true (handled in runOnce) resolves it. Override with CLAUDE_BIN.
// claude worker binary. Windows: claude is an npm .cmd shim on PATH (spawn with shell:true
// resolves it). Linux/macOS: prefer HOME/.local/bin or npm global prefix; override with CLAUDE_BIN.
const CLAUDE_BIN = process.env.CLAUDE_BIN || (IS_WIN ? "claude" : join(homedir(), ".local", "bin", "claude"));

// dsh worker: DeepSeek DSH headless 一次性执行（answer → print → exit，无登录、无常驻）。
// 路径含空格 → build 命令里用引号包裹。headless 不支持 stdin，prompt 走 argv（与 run_claude 同转义面）。
// DSH_HOME 复用主 ~/.dsh（settings 默认 <PROVIDER>，key 已配）；--patch 覆盖 headless 默认 read-only+ask
// 为 workspace-write+never，使其能在 spawn cwd（= 调用方传的 workdir = 工作区沙箱）内真写文件而不卡审批。
// ⚠️ 权限 write+never：只在 workdir 内可信；调用方务必传限定范围的工作目录，勿指向主仓库/敏感盘。
// 公网分发包：DSH 二进制路径走 env（DSH_BIN/DSH_PATCH），默认取命令行同名（npm 全局 .cmd shim）。
const DSH_BIN = process.env.DSH_BIN || "dsh";
const DSH_PATCH = process.env.DSH_PATCH || "";

// Extract the first balanced {...} object from a string that may carry leading
// AND trailing log/diagnostic lines around the JSON. Some CLIs print a trailing
// "[agents/agent-command] ... ended" line after the object (merged via stderr),
// which made JSON.parse(out.slice(i)) throw and fall back to raw output. String-
// aware brace counting so braces inside JSON string values don't throw off depth.
// Returns the slice, or null if no balanced object. Shared by both parsers.
export function extractJsonObject(out) {
  const start = out.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < out.length; i++) {
    const c = out[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return out.slice(start, i + 1); }
  }
  return null;
}

// ---- Session ID capture ----
// Both CLIs print a session id to stdout. Codex: "session id: <uuid>".
// Claude prints a UUID in its output too. We scan the captured output for a UUID
// so the caller can resume the same session later via the session_id param.
// Prefer the explicit "session id:" marker (Codex); fall back to any bare UUID.
function captureSessionId(out) {
  const m = out.match(/session id:\s*([0-9a-fA-F-]{36})/i);
  if (m) return m[1];
  const m2 = out.match(/\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/);
  return m2 ? m2[1] : null;
}

// Parse qwen `-o json` output into { text, sessionId }. qwen 的 -o json 输出一个 JSON 数组，
// 末尾是 {"type":"result","result":"...","session_id":"..."} 事件——比 opencode 的 NDJSON 流更干净
// （整体一个 JSON 数组，非逐行事件）。取 result 事件拿正文 + session_id（可 --resume 恢复）。
// 解析失败回退原始输出 + 正则抓 session id。
function parseQwenOut(out) {
  try {
    const arr = JSON.parse(out);
    if (Array.isArray(arr)) {
      const r = arr.find((e) => e && e.type === "result");
      if (r) return { text: (r.result || "").trim() || out, sessionId: r.session_id || null };
    } else if (arr && arr.type === "result") {
      return { text: (arr.result || "").trim() || out, sessionId: arr.session_id || null };
    }
  } catch { /* 非 JSON（日志/进度行混入），回退 */ }
  return { text: out, sessionId: captureSessionId(out) };
}

// Parse claude `-p --output-format json` output into { text, sessionId }. The JSON
// object has `session_id` (resumable) and `result` (the reply text). Use the shared
// balanced-object extractor in case log lines precede or trail it; fall back to raw
// + regex capture on malformed.
export function parseClaudeOut(out) {
  const json = extractJsonObject(out);
  if (!json) return { text: out, sessionId: null };
  try {
    const d = JSON.parse(json);
    const text = typeof d.result === "string" ? d.result : (d.result && d.result.text) || out;
    const sessionId = d.session_id || null;
    return { text, sessionId };
  } catch {
    return { text: out, sessionId: captureSessionId(out) };
  }
}

// Parse opencode `run --format json` NDJSON stream into { text, sessionId }.
// opencode 的 --format json 输出 NDJSON（每行一个事件）；`type:"text"` 事件的 `part.text` 就是回复正文。
// 忽略 reasoning/progress/日志行（含经 stderr 合入的非 JSON 行）。多行回复按行 join。sessionId 无法从
// NDJSON 事件可靠恢复（opencode 消费者 session 与 bridge 的 --session-id 模型不对应），故 opencode 的
// resume 退化为 fresh（见 opencodeAgent.buildResume）。
function parseOpenCodeOut(out) {
  const parts = [];
  for (const line of String(out).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t);
      if (ev && ev.type === "text" && typeof ev.part?.text === "string" && ev.part.text.trim()) {
        parts.push(ev.part.text);
      }
    } catch { /* 非 JSON 行（日志/进度）跳过 */ }
  }
  const text = parts.join("\n").trim();
  if (text) return { text, sessionId: null };
  return { text: out, sessionId: captureSessionId(out) };
}

// ---- Agent Registry (N-Agent full landing) ----
// Each agent is a descriptor capturing the 6 axes the old hand-written run_* handlers
// diverged on: buildFresh/buildResume (command construction), env (auth injection),
// parse (output → {text,sessionId}), hasAuto (only codex). The generic runAgent() driver
// holds the shared skeleton (task record, exit/timeout race guard, return format); the
// descriptor fills in the differences. Adding an agent = add a descriptor, no driver change.
//
// Command construction uses two small functions per agent (fresh / resume) rather than a
// "base args + resume flag" data shape: codex's `resume <id>` is a SUBCOMMAND that
// reorders where -m and the prompt go (--skip-git-repo-check must precede resume), which a
// flat data shape can't express. A function expresses it honestly.

// opencode base command: opencode CLI on PATH（npm .cmd shim，spawn 走 cmd.exe）。OPENCODE_BIN 可覆盖。
function opencodeBase() {
  // 不带 --pure：实测 --pure 跳过 oh-my-openagent 插件，而该插件正是 --format json 模式下
  // 把最终回复写成 NDJSON `text` 事件的输出链路一环。带 --pure → 只有 step_start、无 text 事件、
  // exit=0（模型调用成功但正文不写 stdout）→ parseOpenCodeOut 回退返回截断的原始流。
  // 提速靠 OPENCODE_ENV 里的 OPENCODE_DISABLE_MODELS_FETCH=1（跳 models.dev 在线拉取，显著提速），
  // --pure 只再多省几秒却丢全部回复，得不偿失，故移除。
  return [OC_ENTRY, "run"];
}
function opencodeAgent(modelDefault) {
  // opencode 描述子（备路 worker / 单发长文档互补）。
  // opencode 无 resume（消费者 session 与 bridge 的 --session-id 模型不对应，见 parseOpenCodeOut），
  // 故 buildResume 退化为 fresh——这是 opencode 的真短板，迭代文档/PPT 应派 qwen（有真 resume）。
  return {
    env: OPENCODE_ENV,
    parse: parseOpenCodeOut,
    hasAuto: false,
    //  能力标签：opencode 经 <PROVIDER> provider 调 <PROVIDER>，作 codex/claude 限流时的并发备路
    // + 单发长文档互补（紧扣素材不跑题）。
    capabilities: ["reasoning", "light-codegen", "concurrent-fallback", "doc-single-shot"],
    strengths: `无状态单发文本/代码、限流并发备路、单发长文档互补（紧扣素材不跑题，默认 ${modelDefault}）`,
    // 429 限流自动切换 model 池（实测切换 model 可绕过 <PROVIDER> 单 model 限流）。
    // opencode model 名带 <MODEL_PROVIDER_PREFIX>/ 前缀（<PROVIDER> OpenAI 兼容端点）；切文档可换 qwen/Qwen3.5-397B-A17B-FP8（qwen 端点）。
    fallbackModels: ["<MODEL_PROVIDER_PREFIX>/<PROVIDER>-Flash", "<MODEL_PROVIDER_PREFIX>/Qwen3-Coder-Flash", "<MODEL_PROVIDER_PREFIX>/<PROVIDER>-Medium"],
    // 长 prompt 走 stdin（needsStdin）：分派时 workdir 用作 cwd，opencode 会扫描项目上下文并把 argv
    // 长中文 prompt 拆分吞掉 → 误把审计/评估任务重解释成"做 PPT"。buildFresh 用 "-" 让 prompt 从 stdin 读
    // （实测 opencode run 支持 `-` 从 stdin 取完整 prompt），runOnce 对 needsStdin 打开 stdin 写入 args.prompt。
    needsStdin: true,
    buildFresh: (a) => {
      const m = a.model || modelDefault;
      // opencode run --model <m> --format json - ，prompt 经 stdin 读；"-" 避免 Windows argv 截断长中文。
      return [...opencodeBase(), "--model", m, "--format", "json", "-"];
    },
    buildResume: (a) => {
      const m = a.model || modelDefault;
      // 退化为 fresh：opencode 的消费者 session 与 bridge 的 --session-id 模型不对应，
      // 无法从 --format json 的 NDJSON 事件可靠恢复 session（见 parseOpenCodeOut）。
      return [...opencodeBase(), "--model", m, "--format", "json", "-"];
    },
  };
}

export const AGENTS = {
  codex: {
    name: "codex",
    // codex exec --skip-git-repo-check [--sandbox workspace-write] [-m M] <prompt>
    // 调优经验：
    //  a) --dangerously-bypass-approvals-and-sandbox 必须：codex 默认 workspace-write 沙箱会禁网络、
    //     禁访问网络盘/UNC 路径（CreateProcessWithLogonW 267），导致无法 SSH 读远程代码。
    //     auto 时给真写盘语义（--sandbox workspace-write）会触发沙箱，故 bypass 该沙箱以解锁
    //     网络/跨盘访问——代价是放弃隔离，属已知取舍（codex 本就在本机跑）。
    //  b) -c model_reasoning_effort=low：降 codex reasoning token 消耗，显著降 <PROVIDER> 429 概率
    //     （high → 真实长任务必 429；low + 内联上下文 → 成功产出）。
    //  c) 默认 model 用 <PROVIDER>-Auto（最快最稳）；fallback 按负载低→高排，<PROVIDER>-Medium 偶发限流不稳放后。
    buildFresh: (a) => {
      const cmd = ["codex", "exec", "--skip-git-repo-check"];
      if (a.auto) cmd.push("--dangerously-bypass-approvals-and-sandbox");
      // 默认降 reasoning 抑制 429；调用方可显式 args.reasoning 覆盖（如 /codex reasoning=high）。
      if (a.reasoning) cmd.push("-c", `model_reasoning_effort=${a.reasoning}`);
      else cmd.push("-c", "model_reasoning_effort=low");
      if (a.model) cmd.push("-m", a.model);
      else cmd.push("-m", CODEX_DEFAULT_MODEL); //  默认钉 <PROVIDER>-Auto，避免走 config.toml 默认外网模型
      cmd.push("-"); // 长 prompt 经 stdin 读（needsStdin）；"-" 让 codex exec 从 stdin 取完整 prompt
      return cmd;
    },
    // codex exec --skip-git-repo-check resume <id> [-m M] <prompt>
    //   --skip-git-repo-check is a flag of `codex exec`, must precede the `resume` subcommand
    //   (putting it after makes resume treat it as the session id).
    buildResume: (a) => {
      const cmd = ["codex", "exec", "--skip-git-repo-check", "resume", a.session_id];
      if (a.auto) cmd.push("--dangerously-bypass-approvals-and-sandbox");
      if (a.reasoning) cmd.push("-c", `model_reasoning_effort=${a.reasoning}`);
      else cmd.push("-c", "model_reasoning_effort=low");
      if (a.model) cmd.push("-m", a.model);
      else cmd.push("-m", CODEX_DEFAULT_MODEL); //  默认钉 <PROVIDER>-Auto
      cmd.push("-"); // 同上：resume 也经 stdin 读 prompt
      return cmd;
    },
    env: null,                       // no auth env — codex uses ~/.codex/config.toml
    parse: (out) => ({ text: out, sessionId: captureSessionId(out) }), // raw output + regex session id
    hasAuto: true,
    //  能力标签：供调用方/未来 Orchestrator 选型，不自动派单。
    capabilities: ["batch-codegen", "patches", "long-running", "test-exec"],
    strengths: "执行强、批量代码生成、非交互长流程、跑测试",
    // 429 限流自动切换 model 池（不同 model 走 <PROVIDER> 不同限流路由，切换可绕过 429）。
    // 排序：<PROVIDER>-Auto（最快最稳）> Qwen3-Coder-Flash > <PROVIDER>-Medium > <PROVIDER>-Flash（最慢）。
    // 默认 model 应传 <PROVIDER>-Auto（最快最稳）；fallback 按负载低→高排，<PROVIDER>-Flash 最慢放最后。
    // codex model 名不带 provider 前缀（本地配置统一路由）。
    fallbackModels: ["<MODEL_MEDIUM>", "Qwen3-Coder-Flash", "<MODEL_FLASH>"],
    // 长 prompt 走 stdin（needsStdin）：Windows argv 会把含空格/中文的长 prompt 拆分吞掉
    // （codex 报 unexpected argument '<首词>'），受控实测须 `cat p.txt | codex exec ... -`。
    // bridge runOnce 对 needsStdin 的 agent 打开 stdin 并写入 args.prompt，buildFresh 用 "-" 让
    // codex 从 stdin 读完整 prompt（"If - is used, instructions are read from stdin"）。
    needsStdin: true,
  },
  claude: {
    name: "claude",
    // CLAUDE_BIN -p --output-format json [--model M] <prompt>  (--output-format json so session_id is structured)
    // Uses the pinned claude binary (CLAUDE_BIN), not PATH-resolved `claude` — see the
    // CLAUDE_BIN comment above for why PATH resolution is unreliable here.
    buildFresh: (a) => {
      const c = [CLAUDE_BIN, "-p", "--output-format", "json", "--permission-mode", "acceptEdits"];
      if (a.model) c.push("--model", a.model);
      // 长 prompt 走 stdin（needsStdin）：Windows argv 会把含空格/中文的长 prompt 拆分截断
      // （实测 claude 只收到首词）。claude -p 无 prompt 参数时自动从 stdin 读完整指令。
      // runOnce 对 needsStdin 的 agent 打开 stdin 写入 args.prompt，故这里不再用 argv 传 prompt。
      return c;
    },
    // CLAUDE_BIN -p --output-format json --resume <id> [--model M] <prompt>
    buildResume: (a) => {
      const c = [CLAUDE_BIN, "-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--resume", a.session_id];
      if (a.model) c.push("--model", a.model);
      // 同上：resume 也经 stdin 读 prompt（needsStdin）。
      return c;
    },
    env: CLAUDE_AUTH_ENV,            // inject auth env so run_claude isn't "Not logged in"
    parse: parseClaudeOut,
    hasAuto: false,
    // 429/超时模型轮换池（2026-08-31 修复，此前 claude 无 fallbackModels → <PROVIDER>-Auto 常 429 时
    // 无法换模型，全部 attempt 超时 → 视图评估被误判失败（某次评估任务超时即此因）。
    // 池序同 codex：<PROVIDER>-Auto 常 429，首切 <PROVIDER>-Medium 最稳，<PROVIDER>-Flash 作备。claude CLI 认
    // <PROVIDER>-Medium/<PROVIDER>-Flash（用户本地可切换）；buildFresh 经 --model 注入，run-driver 同步 env
    // ANTHROPIC_*_MODEL 使 title-gen/SDK 内部调用也跟随轮换（见 run-driver model-follow-env 注释）。
    fallbackModels: ["<MODEL_MEDIUM>", "<MODEL_FLASH>"],
    needsStdin: true,                //  修复：中文长 prompt 走 stdin，避免 Windows argv 截断
    //  能力标签：推理/规划/审查派 claude。
    capabilities: ["reasoning", "architecture", "review", "planning"],
    strengths: "推理规划、上下文大、审查重构、方案设计",
    // 选型：run_claude vs run_dsh
    //   · 只要【单模型】就能做 → 用 run_claude（推理/审查/规划/方案；成熟稳定）。
    //     DSH 不带来增量，别为“能拆子代理”引 DSH（claude/codex/dsh 都有递归子代理）。
    //   · 要【同一任务多后端(<BACKEND_1>/<BACKEND_2>/<BACKEND_3>)各跑/对比/轮换】或【子代理按模型分工】
    //     → 用 run_dsh（模型中立，换 provider 即换模型；见下方已注册的 dsh 条目）。
  },
  // dsh：DeepSeek DSH headless 一次性执行（DeepSeek official agent harness，provider 化多后端）。
  // 非交互：answer → print → exit，无登录。无真 resume → buildResume 退化为 fresh（同 claude 处理）。
  // --patch = workspace-write+never：spawn cwd(调用方 workdir)=工作区沙箱，可在工作区内写文件免审批、不越界。
  // DSH_HOME 复用 ~/.dsh（默认 <PROVIDER>）；要换后端由 settings/patch 配多 provider。
  // ⚠️ 权限 write+never：调用方务必传限定的 workdir（勿指向主仓库/敏感盘）；prompt 勿含 cmd 元字符。
  dsh: {
    name: "dsh",
    buildFresh: (a) => {
      const c = ["node", `"${DSH_BIN}"`, "--profile", "headless"];
      if (DSH_PATCH) c.push("--patch", `"${DSH_PATCH}"`);
      c.push(a.prompt);
      return c;
    },
    buildResume: (a) => {
      const c = ["node", `"${DSH_BIN}"`, "--profile", "headless"];
      if (DSH_PATCH) c.push("--patch", `"${DSH_PATCH}"`);
      c.push(a.prompt);
      return c;
    },
    env: null, // 无额外 auth env；key 走主 ~/.dsh credential 解析
    parse: (out) => ({ text: out, sessionId: null }), // headless 无结构化 session 句柄
    hasAuto: false,
    capabilities: ["provider-rotation", "isolated-workdir", "recursive-subagent"],
    strengths: "异构多后端(<BACKEND_1>/<BACKEND_2>/<BACKEND_3>)同一执行逻辑轮换、工作区隔离内真实写文件、内部递归子代理",
  },
  // opencode：备路 worker / 单发长文档互补。
  opencode: { name: "opencode", ...opencodeAgent(OC_DEFAULT_MODEL) },
  // qwen：写文档/PPT 互补 opencode + 图像互补 vision_analyze（6 轴全配）。
  // --auth-type openai 走 QWEN_ENV（qwen 端点）；--approval-mode auto-edit 让 write_file 落盘（⑤hasAuto）；
  // 真 resume（--resume <id>，②不退化，胜 opencode）；-o json 出干净 JSON 数组（parseQwenOut）；
  // needsStdin 长 prompt 经 stdin（与 codex 同理，Windows argv 拆吞）。模型名不带 qwen/ 前缀。
  // 修默认模型坑：qwen CLI 内置默认 model，但 qwen 端点 /v1/models 无此模型 →
  //   HTTP 500 (no body) 假成功（isFakeSuccess 命中）。调用方未传 model 时 buildFresh 必须显式钉一个
  //   qwen 端点 真实存在的模型，不能让 qwen 回退到内置默认。QWEN_DEFAULT_MODEL 经 env 可覆盖。
  //   同时 fallbackModels 刷新为 qwen 端点 当前真实可用模型（旧 Qwen3-VL-235B-A22B-Instruct
  //   已下线，会同样 500）。2026-08-17 实测 qwen 端点 /v1/models 确认。
  qwen: {
    name: "qwen",
    buildFresh: (a) => {
      const c = ["qwen", "--auth-type", "openai", "-o", "json", "--approval-mode", "auto"];
      // 必须显式钉 model：不传则 qwen 用内置默认（qwen 端点 无此模型 → 500）。
      c.push("--model", a.model || QWEN_DEFAULT_MODEL);
      c.push("-"); // 长 prompt 经 stdin 读（needsStdin）
      return c;
    },
    buildResume: (a) => {
      const c = ["qwen", "--auth-type", "openai", "-o", "json", "--approval-mode", "auto", "--resume", a.session_id];
      c.push("--model", a.model || QWEN_DEFAULT_MODEL);
      c.push("-");
      return c;
    },
    env: QWEN_ENV,
    parse: parseQwenOut,
    hasAuto: true, // --approval-mode auto-edit = 自主执行绕审批（write_file 落盘）
    //  能力标签：迭代文档/PPT（resume+auto-edit）+ 图像（宿主自读图喂 VL）+ 限流备路。
    capabilities: ["doc-iteration", "ppt", "image-vl", "concurrent-fallback"],
    strengths: "写文档/PPT（resume+中文友好+auto-edit 落盘）、图像分析（宿主自读图喂 VL）、限流备路",
    // qwen 端点 qwen provider 模型池（不带 qwen/ 前缀，与 opencode 相反）。
    // 刷新：旧 Qwen3-VL-235B-A22B-Instruct 已下线（qwen 端点 /v1/models 无），
    // 用当前真实可用模型替换。Qwen3.6-35B-A3B-FP8 稳，放首位。
    fallbackModels: ["Qwen3.6-35B-A3B-FP8", "Qwen3-235B-A22B-Instruct-2507", "DeepSeek-V3.1"],
    needsStdin: true,
  },
};

// ---- CLI 可用性探测 + 动态挂载（agent_scan 使用）----
// 识别本地已装的 worker CLI → 检测是否可加入 → 挂载（AGENTS[name].available 标记）。
// probe 元数据独立于描述子（避免为 5 个 agent 逐个手改内部结构）；runAgent 派发前据 available 拒绝缺失 CLI。
// kind "bin" = PATH/绝对路径上有可执行文件；kind "env" = 端点方式（qwen），任一 env 变量已配置即可用。
const PROBE = {
  codex:    { kind: "bin", cmd: "codex",    hint: "npm i -g @openai/codex" },
  claude:   { kind: "bin", cmd: CLAUDE_BIN, hint: "npm i -g @anthropic-ai/claude-code（或设 CLAUDE_BIN）" },
  qwen:     { kind: "env", vars: ["QWEN_BASE_URL", "OPENAI_BASE_URL"], hint: "配置 QWEN_BASE_URL（端点方式，无独立 CLI）" },
  opencode: { kind: "bin", cmd: OC_ENTRY,   hint: "npm i -g opencode-ai" },
  dsh:      { kind: "bin", cmd: DSH_BIN,    hint: "npm i -g @deepseek-ai/dsh（或设 DSH_BIN）" },
};
for (const [name, p] of Object.entries(PROBE)) if (AGENTS[name]) AGENTS[name].probe = p;

// 判断可执行文件/命令是否存在于本机（绝对/相对路径 → existsSync；纯命令名 → where/which 查 PATH）。
function execOnPath(cmd) {
  if (!cmd) return false;
  if (cmd.includes("/") || cmd.includes("\\")) {
    return existsSync(cmd) || existsSync(cmd + ".cmd") || existsSync(cmd + ".exe");
  }
  for (const cand of [cmd, cmd + ".cmd", cmd + ".exe"]) {
    const r = spawnSync(IS_WIN ? "where" : "which", [cand], { stdio: "ignore" });
    if (r.status === 0) return true;
  }
  return false;
}

// 扫描全部注册 agent 的 CLI 可用性。返回 { name: { available, kind, cmdOrVars, hint } }。
// available=true 只是"识别到 + 快速门通过"；真实能否跑由 run_* 的实际 spawn 结果最终判定。
// 无 probe 元数据的自定义 agent 视为可用（不拦），保持向后兼容。
export function probeAgents() {
  const out = {};
  for (const [name, a] of Object.entries(AGENTS)) {
    const p = a.probe;
    if (!p) { out[name] = { available: true, kind: null, cmd: null, hint: null }; continue; }
    let available = false;
    if (p.kind === "bin") available = execOnPath(p.cmd);
    else if (p.kind === "env") available = (p.vars || []).some((v) => !!process.env[v]);
    out[name] = { available, kind: p.kind, cmd: p.vars ? p.vars : p.cmd, hint: available ? null : p.hint };
  }
  return out;
}
