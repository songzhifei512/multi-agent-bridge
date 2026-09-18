#!/usr/bin/env node
// probe-cli.mjs —多 Agent桥接 worker CLI选择性探测注册脚本（公网分发通用版）。
//
//只读探测，不写任何文件、不改任何配置。逐项检测 claude / codex / qwen / opencode / dsh
//是否已安装，并给出「缺失时怎么办」的引导（公网 npm/官方下载源）。
//
//用法：
// node scripts/probe-cli.mjs #全量探测（默认）
// node scripts/probe-cli.mjs --json #机器可读 JSON输出（供安装向导派发决策）
// node scripts/probe-cli.mjs --cli claude #只探测指定 CLI
//
//返回码：0 =探测完成（含缺失项，缺项非错误）；2 =用法错误。

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const IS_WIN = process.platform === "win32";

// ----每个 worker的探测 +缺失引导 ----
//探测方式两种：
// type "bin" ：PATH(或常见位)上有该可执行文件即视为可能可用
// type "env" ：(qwen)走兼容端点，无独立 CLI，看 QWEN_BASE_URL / OPENAI_BASE_URL是否配置
// guide内仅示意占位，不含任何本机隐私。
const AGENTS = [
  {
    name: "claude",
    desc: "Anthropic Claude Code官方 CLI（主控/队长 worker）",
    type: "bin",
    probe: ["claude"],
    binHint: IS_WIN ? "claude" : join(homedir(), ".nvm", "versions", "node", "<version>", "bin", "claude"),
    guide: "安装：`npm install -g @anthropic-ai/claude-code`（公网 npm）。配置：从 https://console.anthropic.com获取 ANTHROPIC_AUTH_TOKEN。",
  },
  {
    name: "codex",
    desc: "OpenAI Codex CLI（worker：强执行 /批量代码生成 /非交互长跑）",
    type: "bin",
    probe: ["codex"],
    guide: "安装：`npm install -g @openai/codex`（公网 npm）或 `brew install codex`（macOS）。首次需 codex login或配置 OPENAI_API_KEY。",
    binHint: "codex",
  },
  {
    name: "qwen",
    desc: "Qwen推理 worker（端点方式：写文档/PPT +图像分析 VL）",
    type: "env",
    probe: [], // env判定，见 checkAgent()
    guide: "qwen是端点而非独立 CLI：需配置 QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1和 QWEN_API_KEY（从阿里云百炼平台获取）。详见 public-install/ENV_SETUP.md",
    binHint: "QWEN_BASE_URL环境变量",
  },
  {
    name: "opencode",
    desc: "opencode CLI（可选 worker：限流备路/轻量并发）",
    type: "bin",
    probe: ["opencode"],
    guide: "安装：`npm install -g opencode-ai`（公网 npm）。可完全跳过，bridge核心不受影响。优化启动：export OPENCODE_DISABLE_MODELS_FETCH=1",
    binHint: "opencode",
  },
  {
    name: "dsh",
    desc: "DSH CLI（DeepSeek，模型中立多后端执行者）",
    type: "bin",
    probe: ["dsh"],
    guide: "安装：`npm install -g @deepseek-ai/dsh`（公网 npm）。从 https://platform.deepseek.com获取 API密钥。",
    binHint: "dsh",
  },
];

function onPath(cmd) {
  const r = spawnSync(IS_WIN ? "where" : "which", [cmd], { stdio: "ignore", shell: IS_WIN });
  return r.status ===0;
}

function checkAgent(a) {
  if (a.type === "env") return !!(process.env.QWEN_BASE_URL || process.env.OPENAI_BASE_URL);
  return a.probe.some(onPath);
}

const only = (() => {
  const i = process.argv.indexOf("--cli");
  return i >=0 && process.argv[i +1] ? process.argv[i +1].split(",").map((s) => s.trim()) : null;
})();
const asJson = process.argv.includes("--json");

const results = AGENTS.filter((a) => !only || only.includes(a.name)).map((a) => ({
  name: a.name,
  desc: a.desc,
  installed: checkAgent(a),
  binHint: a.binHint,
  guide: a.guide,
}));

if (asJson) {
  console.log(JSON.stringify(results, null,2));
} else {
  for (const r of results) {
    console.log(`[${r.installed ? "✔已装" : "✖缺失"}] ${r.name} — ${r.desc}`);
    if (!r.installed) {
      console.log(`参考位：${r.binHint}`);
      console.log(`引导： ${r.guide}`);
    }
  }
  const missing = results.filter((r) => !r.installed);
  console.log(
    missing.length
      ? `\n缺 ${missing.length}个 worker CLI（可选安装）。bridge控制主控不依赖其中任意单个。\n一键安装：bash ../public-install/scripts/install-all-workers.sh`
      : "\n全部 worker CLI已就绪。"
  );
}
process.exit(0);
