#!/bin/bash
# dsh-panel/scripts/integration-test.sh

set -e

echo "=== DSH Bridge Panel Integration Test ==="

# 1. 启动 bridge-web-panel（如果端口未被占用）
echo "[1/4] Starting bridge-web-panel..."
if command -v lsof >/dev/null 2>&1 && lsof -i :3000 >/dev/null 2>&1; then
  echo "Port 3000 already in use, using existing instance"
  PANEL_PID=""
else
  node ../bridge/mcp/bridge-web-panel.mjs --port 3000 &
  PANEL_PID=$!
  sleep 2
fi

# 2. 测试 /api/run 端点
echo "[2/4] Testing POST /api/run..."
RESPONSE=$(curl -s -X POST http://localhost:3000/api/run \
  -H "Content-Type: application/json" \
  -d '{"worker":"dsh","prompt":"你好","session":"test-sess"}')
echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "taskId"; then
  echo "✓ /api/run works"
else
  echo "✗ /api/run failed"
  if [ -n "$PANEL_PID" ]; then kill $PANEL_PID; fi
  exit 1
fi

# 3. 测试 /api/state 端点
echo "[3/4] Testing GET /api/state..."
STATE=$(curl -s http://localhost:3000/api/state?session=test-sess)
echo "State: $STATE"

if echo "$STATE" | grep -q "tasks"; then
  echo "✓ /api/state works"
else
  echo "✗ /api/state failed"
  if [ -n "$PANEL_PID" ]; then kill $PANEL_PID; fi
  exit 1
fi

# 4. 清理
echo "[4/4] Cleaning up..."
if [ -n "$PANEL_PID" ]; then
  kill $PANEL_PID 2>/dev/null || true
  wait $PANEL_PID 2>/dev/null || true
fi

echo "=== All tests passed ==="
