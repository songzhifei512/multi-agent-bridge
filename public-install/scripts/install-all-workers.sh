#!/usr/bin/env bash
# ============================================================================
# multi-agent-bridge - 一键安装所有 worker CLI 脚本（公网版）
# ============================================================================
# 用法：bash install-all-workers.sh
# 说明：会从公网 npm 安装所有支持的 worker CLI
# ============================================================================

set -e

echo "============================================================================"
echo " multi-agent-bridge | 一键安装所有 worker CLI（公网 npm）"
echo "============================================================================"
echo

# 检查 npm
if ! command -v npm > /dev/null 2>&1; then
  echo "[X] 未检测到 npm。请先安装 Node.js 18+ (https://nodejs.org)"
  exit 1
fi

echo "[OK] npm $(npm --version)"
echo

# 安装 Claude CLI
echo "---- 安装 Claude CLI (@anthropic-ai/claude-code) ----"
if command -v claude > /dev/null 2>&1; then
  echo "[跳过] claude 已安装：$(claude --version 2> /dev/null || echo '未知版本')"
else
  echo "安装中..."
  npm install -g @anthropic-ai/claude-code
  echo "[OK] claude 安装完成"
fi
echo

# 安装 Codex CLI
echo "---- 安装 Codex CLI (@openai/codex) ----"
if command -v codex > /dev/null 2>&1; then
  echo "[跳过] codex 已安装：$(codex --version 2> /dev/null || echo '未知版本')"
else
  echo "安装中..."
  npm install -g @openai/codex
  echo "[OK] codex 安装完成"
fi
echo

# 安装 opencode
echo "---- 安装 opencode (opencode-ai) ----"
if command -v opencode > /dev/null 2>&1; then
  echo "[跳过] opencode 已安装：$(opencode --version 2> /dev/null || echo '未知版本')"
else
  echo "安装中..."
  npm install -g opencode-ai
  echo "[OK] opencode 安装完成"
fi
echo

# 安装 DSH CLI
echo "---- 安装 DSH CLI (@deepseek-ai/dsh) ----"
if command -v dsh > /dev/null 2>&1; then
  echo "[跳过] dsh 已安装：$(dsh --version 2> /dev/null || echo '未知版本')"
else
  echo "安装中..."
  npm install -g @deepseek-ai/dsh
  echo "[OK] dsh 安装完成"
fi
echo

# Qwen 无需安装 CLI（端点方式）
echo "---- Qwen (端点方式，无需 CLI) ----"
echo "[说明] Qwen 通过 QWEN_BASE_URL 和 QWEN_API_KEY 配置端点"
echo "详见 public-install/ENV_SETUP.md"
echo

echo "============================================================================"
echo " 安装完成！"
echo "============================================================================"
echo
echo "下一步："
echo "  1. 配置 API 密钥：见 public-install/ENV_SETUP.md"
echo "  2. 运行探测脚本：node scripts/probe-cli.mjs"
echo "  3. 运行安装向导：bash launchers/install.sh"
echo
