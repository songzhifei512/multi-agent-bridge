#!/usr/bin/env bash
# ============================================================================
# multi-agent-bridge 分发包 —— Linux/macOS 安装向导（交互式）
# 分发版 v1.0.0 · 通用 · 可选择性注册 worker
#
# 特性：
#   - $(dirname "$0") 实时解析安装位，不写死绝对路径
#   - 探测 worker CLI，缺失可选择跳过
#   - 私有配置写入 ${HOME}/.agents/.env（不入包/不入仓库）
#   - 可选向量层按需补齐（默认纯文本）
# 用法：bash launchers/install.sh
# ============================================================================
set -u
cd "$(dirname "$0")/.." || exit 1
BRIDGE_DIR="$(pwd)/bridge"
SCRIPTS="$(pwd)/scripts"

echo
echo "============================================================================"
echo "  multi-agent-bridge | 分发包 v1.0.0 安装向导 | Linux/macOS"
echo "============================================================================"
echo

# ---- 前置检查 node ----
if ! command -v node > /dev/null 2>&1; then
  echo "[X] 未检测到 node。请安装 Node.js 18+ (https://nodejs.org) 后重跑。" >&2
  exit 1
fi
echo "[OK] node $(node --version)"

# ---- 1. 探测 worker CLI ----
echo
echo "---- 探测本机 worker CLI（可选择性安装/跳过）----"
node "$SCRIPTS/probe-cli.mjs" || true
echo "[说明] 缺项均可选：控制主控不依赖其中任意单个。"
echo "[提示] 一键安装所有 worker: bash ../public-install/scripts/install-all-workers.sh"

# ---- 2. 确认安装位 ----
echo
echo "---- 安装位置 ----"
echo "当前解包目录：$(pwd)"
read -r -p "确认使用该目录？(y/N): " CONFIRM
case "$CONFIRM" in
  y|Y) ;;
  *) echo "[X] 已取消。"; exit 1 ;;
esac

# ---- 3. 私有配置 ----
ENV_FILE="${HOME}/.agents/.env"
mkdir -p "${HOME}/.agents" 2> /dev/null || true
echo
echo "---- 私有配置（端点+token，写入 ${ENV_FILE}）----"
echo "[提示] 仅写个人配置目录，不入分发包/仓库。"
echo "[说明] 默认使用 Anthropic 官方云端点 (https://api.anthropic.com)"
echo "[提示] 如需使用其他 provider，可后续手动编辑 $ENV_FILE"
echo

# 检查是否已有配置
if [ -f "$ENV_FILE" ] && grep -q '^ANTHROPIC_BASE_URL=' "$ENV_FILE"; then
  echo "[保留] 检测到既有 ANTHROPIC_BASE_URL，未覆盖。手动编辑 $ENV_FILE 即可变更。"
else
  # 使用默认公网端点
  ENDPOINT_URL="https://api.anthropic.com"
  echo " ANTHROPIC_BASE_URL: $ENDPOINT_URL"
  read -r -p " ANTHROPIC_AUTH_TOKEN (必填，从 https://console.anthropic.com 获取): " AUTH
  if [ -z "$AUTH" ]; then
    echo "[警告] 未提供 API Token。bridge 将无法工作。请后续手动编辑 $ENV_FILE"
    AUTH="<YOUR_ANTHROPIC_API_KEY>"
  fi
  {
    echo "ANTHROPIC_BASE_URL=$ENDPOINT_URL"
    echo "ANTHROPIC_AUTH_TOKEN=$AUTH"
    echo "BRIDGE_CONTROLLER=claude"
  } >> "$ENV_FILE"
  echo "[OK] 已写入 $ENV_FILE"
fi

# ---- 4. 注册 MCP 提示 ----
echo
echo "---- 注册 MCP ----"
echo "  将以下 server 加入你的 CLI MCP 配置（命令=node，参数=$BRIDGE_DIR/mcp/shared-context-server.mjs）："
echo "  - Claude : 见 config/claude-mcp-config.json.tmpl"
echo "  - Codex  : 见 config/codex-mcp-config.toml.tmpl（追加 ~/.codex/config.toml）"

# ---- 4.5 技能软链（把 multi-agent 技能链接到各 CLI 技能根，可选）----
echo
echo "---- 技能软链（可选：让 claude/codex/DSH 识别 multi-agent 技能）----"
SKILL_SRC="$(pwd)/skills/multi-agent"
if [ ! -f "$SKILL_SRC/SKILL.md" ]; then
  echo "[提示] 未发现技能包 skills/multi-agent，跳过。"
else
  link_skill() {
    local root="$1"
    local dest="${root}/multi-agent"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      echo "[跳过] 已存在：$dest"
      return
    fi
    mkdir -p "$root" 2> /dev/null || true
    if ln -s "$SKILL_SRC" "$dest" 2> /dev/null; then
      echo "[OK] 已软链：$SKILL_SRC -> $dest"
    else
      echo "[提示] 软链失败（可手工复制 skills/multi-agent 到 $dest）"
    fi
  }
  link_skill "${HOME}/.claude/skills"
  link_skill "${HOME}/.codex/skills"
  link_skill "${HOME}/.agents/skills"   # DSH 默认扫描的共享 agent 根
fi

# ---- 5. 向量层：先部署包内模型，再探测 ----
echo
echo "---- 向量记忆层（可选）----"
# 若已下载 MiniLM 模型（assets-optional/model-multilingual，见 download-vector-assets.sh），部署到用户级 ~/.agents/vector/
if [ -f "$(pwd)/assets-optional/model-multilingual/model_quantized.onnx" ]; then
  mkdir -p "${HOME}/.agents/vector/model-multilingual" 2> /dev/null || true
  cp -f "$(pwd)/assets-optional/model-multilingual/"*.onnx "${HOME}/.agents/vector/model-multilingual/" 2> /dev/null
  cp -f "$(pwd)/assets-optional/model-multilingual/"*.json "${HOME}/.agents/vector/model-multilingual/" 2> /dev/null
  echo "[OK] 已部署向量模型到 ${HOME}/.agents/vector/model-multilingual"
else
  echo "[注意] 未发现模型。需要语义检索时运行: bash assets-optional/download-vector-assets.sh"
fi
if node "$SCRIPTS/probe-vector.mjs" --json 2> /dev/null | grep -q '"vectorLayerReady": true'; then
  echo "[OK] 向量层已就绪：语义检索可用。"
else
  echo "[提示] 缺原生依赖（onnxruntime-node / sqlite-vec）。按 assets-optional/README.md 的 npm install 补齐后即启用；否则纯文本兜底，核心完整。"
fi

# ---- 6. 下一步 ----
echo
echo "---- 下一步 ----"
echo "  启动桥服务： node $BRIDGE_DIR/mcp/shared-context-server.mjs"
echo "  校验 CLI　： node $SCRIPTS/probe-cli.mjs"
echo "  配置指南　： 见 public-install/ENV_SETUP.md"
echo
echo "安装向导完成。"
exit 0