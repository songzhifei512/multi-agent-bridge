#!/usr/bin/env node
// scripts/redact-audit.public.mjs — 公网开源可发布的引导入口（不含扫描规则签名）
//
// 调用关系：pre-push hook -> redact-audit.public.mjs -> scripts/redact-audit.mjs
//
// 为什么拆 public 与 local 两份：
//   public（这份）只做"调用 + 说明"，不含 12 类正则细节/Allowlist。
//   local（scripts/redact-audit.mjs，.gitignore 内）含完整规则，本机用。
//   防扫描规则随仓库泄漏给攻击者用作规避参考（与 security-scan.mjs 同原则）。
//
// 用户安装（首次克隆后）：
//   cp scripts/redact-audit.public.mjs .git/hooks/pre-push
//   chmod +x .git/hooks/pre-push   # Linux/Mac；Windows 跳过（git-bash 仍可）
//   # scripts/redact-audit.mjs 需从源码渠道获取（仓库不发布）
//
// 若 .git/hooks/pre-push 已有其它逻辑，可改为 source 此脚本后再加自己的：
//   .git/hooks/pre-push:
//     #!/usr/bin/env bash
//     set -e
//     node scripts/redact-audit.public.mjs "$@"

import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const HERE = dirname(__filename);
const REPO_ROOT = join(HERE, "..");

console.error("[redact-audit] pre-push hook triggered");

// 1. 定位即将推送的 commit 范围
let range;
try {
  // 尝试解析 @{u}（上游跟踪分支）；找不到 fallback HEAD~1..HEAD
  execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD@{u}"], { stdio: "ignore", cwd: REPO_ROOT });
  const upstream = execFileSync("git", ["rev-parse", "--short", "HEAD@{u}"], { encoding: "utf8", cwd: REPO_ROOT }).trim();
  const local = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", cwd: REPO_ROOT }).trim();
  range = `${upstream}..${local}`;
} catch {
  // 没有上游（首次推送）→ 仅扫 HEAD
  range = "HEAD~1..HEAD";
  // 若只有一个 commit（仓库刚 init），改用 --root
  try {
    const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { encoding: "utf8", cwd: REPO_ROOT }).trim();
    if (Number(count) <= 1) range = "HEAD";
  } catch {}
}

console.error(`[redact-audit] scanning range: ${range}`);

// 2. 调本地 redact-audit.mjs（不在仓库，须本机安装）
const localScript = join(HERE, "redact-audit.mjs");
if (!existsSync(localScript)) {
  console.error(`[redact-audit] 本地脚本不存在: ${localScript}`);
  console.error(`[redact-audit] 请从源码渠道获取 scripts/redact-audit.mjs（含扫描规则，本仓库不发布）`);
  console.error(`[redact-audit] 跳过审计（安装好本地脚本后再启用拦截）`);
  process.exit(0);  // 缺本地脚本不阻塞推送
}

// 3. 跑扫描，传 range
const res = spawnSync(process.execPath, [localScript, range], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  stdio: "inherit"
});

if (res.status !== 0) {
  console.error("[redact-audit] ⚠️  发现真实敏感值！修复后再 push。");
  process.exit(1);
}

console.error("[redact-audit] ✅ 干净，继续 push");
process.exit(0);