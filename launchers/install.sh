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

# ---- AUTO_YES support ----
# If AUTO_YES=1 (or --yes arg) is set, every interactive prompt defaults to y
# and the script runs to completion. Useful for CI / first-time installs.
AUTO_YES="${AUTO_YES:-}"
case "${1:-}${AUTO_YES}" in
  *--yes*|*"1"*|*"true"*)
    AUTO_YES=1
    echo "[AUTO_YES=1] 所有提示将默认 y，向导自动跑完。"
    ;;
esac

prompt_default_yes() {
  # Usage: prompt_default_yes var_name prompt
  # If AUTO_YES=1, sets var to y; otherwise reads stdin.
  local var="$1" prompt="$2"
  if [ "${AUTO_YES}" = "1" ]; then
    eval "$var=y"
    return
  fi
  read -r -p "$prompt" "$var" || true
}

# ---- 2. 确认安装位 ----
echo
echo "---- 安装位置 ----"
echo "当前解包目录：$(pwd)"
prompt_default_yes CONFIRM "确认使用该目录？(y/N): "
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
  if [ "${AUTO_YES}" = "1" ]; then
    AUTH="<YOUR_ANTHROPIC_API_KEY>"
    echo "[AUTO_YES] 跳过 token 输入；写入占位符 $AUTH（CI/初次安装）。"
  else
    read -r -p " ANTHROPIC_AUTH_TOKEN (必填，从 https://console.anthropic.com 获取): " AUTH
    if [ -z "$AUTH" ]; then
      echo "[警告] 未提供 API Token。bridge 将无法工作。请后续手动编辑 $ENV_FILE"
      AUTH="<YOUR_ANTHROPIC_API_KEY>"
    fi
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

# ---- 4.2 DSH 侧边栏面板（自动安装）----
echo
echo "---- DSH 侧边栏面板 ----"
DSH_ROOT="${HOME}/.dsh"
DSH_PLUGINS="${DSH_ROOT}/plugins"
PANEL_SRC="$(pwd)/dsh-panel"
PANEL_NAME="dsh-bridge-panel"
PANEL_LINK="${DSH_PLUGINS}/${PANEL_NAME}"

if [ ! -d "$DSH_ROOT" ]; then
  echo "[跳过] 未检测到 DSH（$DSH_ROOT 不存在）。"
  echo "       安装 DSH Desktop 后重跑本向导即可自动挂面板。"
else
  echo "[DSH] 检测到 DSH：$DSH_ROOT"

  # 检查构建产物
  if [ ! -f "$PANEL_SRC/dist/index.js" ]; then
    echo "[跳过] dsh-panel 未构建（dist/index.js 不存在）。"
    echo "       请先执行：cd dsh-panel && npm install && npm run build"
  else
    # 检查是否已安装
    if [ -e "$PANEL_LINK" ] || [ -L "$PANEL_LINK" ]; then
      echo "[跳过] 已安装：$PANEL_LINK"

      # 检查是否有重复安装（profile 依赖）
      for profile in desktop headless; do
        if [ -f "${DSH_ROOT}/profiles/${profile}/package.json" ]; then
          if grep -q "$PANEL_NAME" "${DSH_ROOT}/profiles/${profile}/package.json" 2>/dev/null; then
            echo "[警告] 在 profile \"${profile}\" 的 package.json 中也发现了 $PANEL_NAME"
            echo "       可能导致 \"duplicate loader entry id\" 错误。"
            echo "       如使用插件目录方式，请从 profile 依赖中移除。"
          fi
        fi
      done
    else
      echo
      prompt_default_yes INSTALL_PANEL "安装 DSH 侧边栏面板？(Y/n): "
      case "$INSTALL_PANEL" in
        n|N) echo "[跳过] 已取消 DSH 面板安装。" ;;
        *)
          mkdir -p "$DSH_PLUGINS" 2>/dev/null || true
          if ln -s "$PANEL_SRC" "$PANEL_LINK" 2>/dev/null; then
            echo "[OK] 已安装：$PANEL_LINK"
          else
            echo "[提示] 软链失败，改为复制方式..."
            cp -R "$PANEL_SRC" "$PANEL_LINK" 2>/dev/null && echo "[OK] 已复制安装：$PANEL_LINK" || echo "[错误] 安装失败，请手动执行：node $PANEL_SRC/link-dev.mjs"
          fi

          # ---- 4.3 DSH profile 注册（pnpm workspace + cordis patch 合并）----
          # 老式 ~/.dsh/plugins/ 软链对 DSH 2.0.13 不够；它真正扫
          # ~/.dsh/profiles/<profile>/node_modules 由 pnpm 工作区解析，并把每个
          # bundle 的 package.json#dsh.bundle.patch 合并到该 profile 的 cordis.patch.yml。
          # 必须 (a/b/c) 三件事都做才生效：
          #   (a) dsh-panel/package.json exports 暴露 ./cordis.patch.yml
          #   (b) profile/package.json dependencies + dsh.profile.bundles 都加 dsh-bridge-panel
          #   (c) profile cordis.patch.yml 追加 dsh-bridge-panel insert 段
          DESKTOP_PROFILE="${DSH_ROOT}/profiles/desktop"
          PROFILE_PKG="${DESKTOP_PROFILE}/package.json"
          PROFILE_PATCH="${DESKTOP_PROFILE}/cordis.patch.yml"
          PANEL_PKG="${PANEL_SRC}/package.json"
          PANEL_PATCH="${PANEL_SRC}/cordis.patch.yml"

          if [ ! -d "$DESKTOP_PROFILE" ]; then
            echo "[跳过] 未发现 desktop profile: $DESKTOP_PROFILE"
          else
            echo
            echo "---- DSH desktop profile 注册 ----"

            if ! grep -q '"./cordis.patch.yml"' "$PANEL_PKG" 2>/dev/null; then
              echo "[警告] $PANEL_PKG 未暴露 ./cordis.patch.yml export"
              echo "       DSH 找不到 bundle 的 patch 文件，侧边栏仍不会显示"
            fi

            # 用 node 做 JSON 编辑（POSIX shell 改 JSON 易出错）
            SCRIPTS_DIR="$(cd "$(dirname "$0")/.." && pwd)/scripts"
            node "$SCRIPTS_DIR/install-dsh-profile.mjs" \
              --profile "$DESKTOP_PROFILE" \
              --panel-pkg "$PANEL_PKG" \
              --link "$PANEL_SRC" || echo "[警告] profile/package.json 更新失败"

            # 追加 dsh-bridge-panel insert 到 cordis.patch.yml（若还没有）
            if [ -f "$PROFILE_PATCH" ] && [ -f "$PANEL_PATCH" ]; then
              if grep -q 'dsh-bridge-panel' "$PROFILE_PATCH"; then
                echo "[跳过] cordis.patch.yml 已含 dsh-bridge-panel 段"
              else
                {
                  printf '\n'
                  cat "$PANEL_PATCH"
                } >> "$PROFILE_PATCH"
                echo "[OK] cordis.patch.yml 已追加 dsh-bridge-panel 段"
              fi
            fi
            echo "     重启 DSH Desktop，侧边栏面板会出现。"
          fi
          ;;
      esac
    fi
  fi
fi

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

# ---- 5. 向量层：探测状态 + 可选一键装 ----
echo
echo "---- 向量记忆层（可选；受 VECTOR_ENABLED 控制）----"

# 先探测当前 4 项状态
node "$SCRIPTS/probe-vector.mjs" || true
echo

INSTALL_VECTOR_DEFAULT="n"
if node "$SCRIPTS/probe-vector.mjs" --json 2>/dev/null | grep -q '"semanticSearchEnabled": true'; then
  echo "[状态] semantic search 已开启，跳过。"
else
  prompt_default_yes INSTALL_VECTOR_DEFAULT "下载模型并安装 onnxruntime-node / sqlite-vec？(y/N): "
fi

case "$INSTALL_VECTOR_DEFAULT" in
  y|Y)
    ASSETS_DIR="$(cd "$(dirname "$0")/.." && pwd)/assets-optional"
    if node "$ASSETS_DIR/install-vector-layer.mjs" --strict --json 2>/dev/null | grep -q '"ok": true'; then
      echo "[OK] 向量层已完整安装（语义检索默认开启）"
    else
      # 不要 strict 也跑一遍，给 human-readable 输出
      node "$ASSETS_DIR/install-vector-layer.mjs" || true
    fi
    ;;
  *)
    echo "[跳过] 如需稍后启用，运行： bash assets-optional/install-vector-layer.sh"
    ;;
esac

# 最终状态汇总
echo
if node "$SCRIPTS/probe-vector.mjs" --json 2>/dev/null | grep -q '"semanticSearchEnabled": true'; then
  echo "[OK] Semantic search: ENABLED  (VECTOR_ENABLED=0 可关闭)"
else
  echo "[提示] Semantic search: OFF (文本模式生效)。设置 VECTOR_ENABLED=1 重新启用。"
fi

# ---- 6. 下一步 ----
echo
echo "---- 下一步 ----"
echo "  启动桥服务： node $BRIDGE_DIR/mcp/shared-context-server.mjs"
echo "  校验 CLI　： node $SCRIPTS/probe-cli.mjs"
echo "  DSH 面板 ： $DSH_PLUGINS/$PANEL_NAME"
echo "  配置指南　： 见 public-install/ENV_SETUP.md"
echo
echo "安装向导完成。"
exit 0