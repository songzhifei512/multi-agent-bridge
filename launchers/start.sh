#!/usr/bin/env bash
# 启动 multi-agent-bridge 桥服务（Linux/macOS）。Ctrl+C 停止。
# 用法：bash launchers/start.sh [--panel]
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HOME}/.agents/.env"

if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
else
  echo "[提示] 未找到 $ENV_FILE，先跑 launchers/install.sh。" >&2
fi

if [ "${1:-}" = "--panel" ]; then
  (nohup node "$ROOT/bridge/mcp/bridge-web-panel.mjs" >/tmp/bridge-panel.log 2>&1 &)
  echo "[OK] 已启动面板（端口 3000）。日志 /tmp/bridge-panel.log"
fi

echo "[OK] 启动桥服务 (Ctrl+C 停止)..."
exec node "$ROOT/bridge/mcp/shared-context-server.mjs"