#!/usr/bin/env bash
# ============================================================================
# multi-agent-bridge - Codex CLI安装脚本（公网版）
# ============================================================================
#用法：bash install-codex-cli.sh
#说明：从公网 npm安装 OpenAI Codex CLI
# ============================================================================

set -e

echo "============================================================================"
echo " multi-agent-bridge | Codex CLI安装（公网 npm）"
echo "============================================================================"
echo

#检查 npm
if ! command -v npm >/dev/null2>&1; then
  echo "[X]未检测到 npm。请先安装 Node.js18+ (https://nodejs.org)"
  exit1
fi

echo "[OK] npm $(npm --version)"
echo

#检查是否已安装
if command -v codex >/dev/null2>&1; then
  echo "[跳过] codex已安装：$(codex --version2>/dev/null || echo '未知版本')"
  echo "如需重新安装，请先运行：npm uninstall -g @openai/codex"
  exit0
fi

#安装
echo "安装 OpenAI Codex CLI (@openai/codex) ..."
npm install -g @openai/codex

echo
echo "[OK] Codex CLI安装完成！"
echo
echo "下一步："
echo "1.运行 codex login登录（或配置 OPENAI_API_KEY环境变量）"
echo "2.运行 node scripts/probe-cli.mjs验证安装"
echo
