// retry-safety.mjs — 重试/退避 + 安全扫描 + sleep 辅助
// 从 shared-context-server.mjs 拆出（ 模块拆分第二步，2026-08-28）。
// 自包含：429/限流/网关5xx 重试判定、假成功检测、regex blocklist 安全扫描、Retry-After 解析、sleep。
// 导出 isRetryableExit / isFakeSuccess / safetyScan / parseRetryAfter / sleep。
// 内部常量（RETRY_MARKERS/RETRY_AFTER_RE/FAKE_SUCCESS_MARKERS/DEFAULT_BLOCKLIST/safeRegExp）不导出。

// ---- Retry / backoff ----
// The bridge spawns CLI processes that themselves call the <PROVIDER> endpoint. When <PROVIDER>
// rate-limits (429 "路由服务满载" / "Too Many Requests") or times out under load, the CLI
// exits non-zero (or the spawn times out). Retrying the SAME spawn after a backoff often
// succeeds once the upstream recovers — this is client-side resilience, not rate limiting
// (we can't throttle an upstream that's already overloaded; we just avoid giving up on the
// first 429). Zero dependencies, no Redis/SQLite/token-bucket.
//
// Retryable: non-zero exit with 429/rate-limit markers in output, OR an upstream gateway
//   server-error signature (<PROVIDER> returns "Unexpected server error / <ref>" / opencode renders
//   it as {"type":"error","name":"UnknownError"}) — both mean the gateway hiccuped, same
//   recoverable class as 429, so rotate to a fallback model / different upstream and retry.
//   OR a timeout (exit=null) — retried because <PROVIDER> overload makes the CLI slow, not because
//   the task is genuinely too long; but we only retry up to maxRetries, so a truly long task
//   still fails fast enough. NOT retryable: spawn error (exit=-1, ENOENT — misconfig, retry
//   won't help), exit=0 (success), non-zero exit WITHOUT these markers (a real task failure).
const RETRY_MARKERS = ["429", "too many requests", "rate limit", "路由服务满载", "满载", "retry-after",
  // 网关/上游 5xx（opencode UnknownError、<PROVIDER> "Unexpected server error"）——只匹配精确签名，防误判真失败。
  "unexpected server error", "internal server error", "unknownerror", "check server logs", "内部服务器错误"];
const RETRY_AFTER_RE = /retry-after[:\s]+(\d+)/i;

export function isRetryableExit(code, out) {
  if (code === 0) return false;
  const lower = (out || "").toLowerCase();
  return RETRY_MARKERS.some((m) => lower.includes(m));
}

// Detect "fake success": some CLIs (notably qwen) print an upstream API error into the
// result text and still exit 0, so the bridge's code===0 → success check is blind to it.
// The canonical signature is "[API Error: <code> status code (no body)]" (qwen's format
// when <LLM_ENDPOINT_QWEN> returns 5xx). We also catch bare "API Error:" prefixes. Returns true only on
// exit 0 + an API-error marker in the PARSED text (not raw out, which carries CLI log noise),
// so a real reply that merely mentions "error" in prose is not misread as a failure.
// Marked retryable so the 429 model-rotation path kicks in (switches to a fallback model /
// different upstream) rather than silently swallowing the error as a completed task.
const FAKE_SUCCESS_MARKERS = ["[api error:", "api error:", "status code (no body)"];
export function isFakeSuccess(code, text) {
  if (code !== 0) return false;
  const lower = (text || "").toLowerCase();
  return FAKE_SUCCESS_MARKERS.some((m) => lower.includes(m));
}

//  自动安全层：regex blocklist 硬拦。用于高/硬实现 path 的产物自动审批把关——
// 命中危险模式（凭证、rm-rf、DROP TABLE、绕过审批等）即视为不可自动放行，须人工回落。
const DEFAULT_BLOCKLIST = [
  /\brm\s+-(rf|fr)\b/i,               // 删除标志性命令
  /secret\s*=\s*["'][A-Za-z0-9_+/=]{8,}/i,   // 疑似硬编码密钥
  /password\s*=\s*["'][^"']{8,}["']/i,           // 疑似明文密码
  /drop\s+table\s+/i,                 // DROP TABLE
  /grant\s+t;/i,
  /\bgit\s+push\s+--force\b/i         // 强推远端/覆盖
];
// 返回 { blocked: bool, hits: [patterns], safe: bool }——hard block: 任一命中即 blocked。
export function safetyScan(text, customBlocklist) {
  const list = (customBlocklist && customBlocklist.length) ? customBlocklist.map((r) => (r instanceof RegExp ? r : safeRegExp(r))) : DEFAULT_BLOCKLIST;
  const t = String(text || "");
  const hits = [];
  for (const r of list) { if (t.match(r)) hits.push(String(r)); }
  return { blocked: hits.length > 0, hits };
}
// 安全地用字符串构造 RegExp（避免用户传 /x/ 字面量但内容是正则文本时误报）
function safeRegExp(s) { try { return new RegExp(s, "i"); } catch { return new RegExp("\\^$\\`+"); } } // 无效正则→永不匹配

// Parse a Retry-After hint (seconds) from CLI output. <PROVIDER> may surface it.
export function parseRetryAfter(out) {
  const m = (out || "").match(RETRY_AFTER_RE);
  return m ? Math.max(0, parseInt(m[1], 10)) : null;
}

// Sleep helper (async). Uses setTimeout — only reached on the retry path, never in the
// sync withLock hot path.
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
