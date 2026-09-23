#!/usr/bin/env bash
# scripts/redact-check.sh
# Multi-agent 本地修改脱敏审查 — 本地一键复跑脚本
# Deliverable: task-20260923-183038-447
# policy_version: 1.0.0
#
# 用法：
#   bash scripts/redact-check.sh                       # 扫默认目录
#   bash scripts/redact-check.sh --paths bridge,docs    # 自定义目录
#   bash scripts/redact-check.sh --report out/report.json
#
# 退出码：
#   0 = 未命中真实敏感模式
#   2 = 命中真实敏感模式（BLOCK）
#   1 = 运行错误

set -u

PATHS_DEFAULT="bridge config launchers scripts docs public-install assets-optional skills"
PATHS="$PATHS_DEFAULT"
REPORT=""
ALLOWLIST_PLACEHOLDER='<YOUR_|<INTERNAL_'

while [ $# -gt 0 ]; do
  case "$1" in
    --paths) PATHS="$2"; shift 2 ;;
    --report) REPORT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "[redact-check] unknown arg: $1" >&2; exit 1 ;;
  esac
done

# 占位符/示例白名单（出现即放行）
ALLOWLIST_REGEX='example\.com|example\.org|example\.net|<your-email>|<YOUR_[A-Z_]+>|<INTERNAL_[A-Z_]+>|sk-ant-<|sk-xxxx|sk-proj-xxxx|AKIAIOSFODNN7EXAMPLE|127\.0\.0\.1|localhost|13800000000|13800138000|13000000000'
ALLOWLIST_PLACEHOLDER_RE='<YOUR_|<INTERNAL_'

HITS=0
declare -a FINDINGS=()

scan() {
  local label="$1"; shift
  local pattern="$1"; shift
  local raw
  raw=$(grep -rEn "$pattern" $PATHS 2>/dev/null \
    | grep -Ev "$ALLOWLIST_REGEX" \
    | grep -Ev "$ALLOWLIST_PLACEHOLDER_RE" || true)
  if [ -n "$raw" ]; then
    echo "==== [$label] BLOCK HITS ===="
    echo "$raw"
    local n
    n=$(echo "$raw" | wc -l)
    HITS=$((HITS + n))
    FINDINGS+=("\"$label\":$n")
  fi
}

echo "[redact-check] paths: $PATHS"

# 1) API Key / Token / AccessKey
scan "real-api-key" 'sk-ant-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{40,}|AKIA[0-9A-Z]{16}'

# 2) 本机路径
scan "real-local-path" 'C:\\Users\\[^<]|/home/[a-z]|/(data|opt|srv|mnt)/[a-z]'

# 3) 真实邮箱（非占位符域）
EMAIL_HITS=$(grep -rEn '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' $PATHS 2>/dev/null \
  | grep -Ev "$ALLOWLIST_REGEX" || true)
if [ -n "$EMAIL_HITS" ]; then
  echo "==== [real-email] BLOCK HITS ===="
  echo "$EMAIL_HITS"
  HITS=$((HITS + $(echo "$EMAIL_HITS" | wc -l)))
fi

# 4) 真实手机号
scan "real-phone-cn" '1[3-9][0-9]{9}'

# 5) .env / .agents / 本地日志快照
if command -v git >/dev/null 2>&1; then
  ENV_HITS=$(git status --ignored --porcelain 2>/dev/null | grep -E '\.env$|\.agents/|debug\.log$|nohup\.out$' || true)
  if [ -n "$ENV_HITS" ]; then
    echo "==== [git-ignored-leak] BLOCK HITS ===="
    echo "$ENV_HITS"
    HITS=$((HITS + $(echo "$ENV_HITS" | wc -l)))
  fi
fi

# 6) 人名 / 公司名 / 内部域名 / 内部代号关键字
scan "internal-name" '内部|机密|companyname|internal\.corp|intra\.'

echo "[redact-check] total BLOCK hits: $HITS"

if [ -n "$REPORT" ]; then
  mkdir -p "$(dirname "$REPORT")"
  FINDINGS_JSON="[${FINDINGS[*]}]"
  # 用 python（POSIX 自带概率高）拼 JSON，避免依赖 jq
  if command -v python3 >/dev/null 2>&1; then
    PY=python3
  elif command -v python >/dev/null 2>&1; then
    PY=python
  else
    PY=""
  fi
  if [ -n "$PY" ]; then
    "$PY" - "$REPORT" "$HITS" "$PATHS" <<'PY'
import json, sys, datetime
report_path, hits, paths = sys.argv[1], int(sys.argv[2]), sys.argv[3]
doc = {
    "policy_version": "1.0.0",
    "task_id": "task-20260923-183038-447",
    "paths": paths,
    "block_hits": hits,
    "timestamp": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
}
with open(report_path, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
PY
  else
    {
      echo "{"
      echo "  \"policy_version\": \"1.0.0\","
      echo "  \"task_id\": \"task-20260923-183038-447\","
      echo "  \"paths\": \"$PATHS\","
      echo "  \"block_hits\": $HITS,"
      echo "  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
      echo "}"
    } > "$REPORT"
  fi
  echo "[redact-check] report: $REPORT"
fi

if [ "$HITS" -gt 0 ]; then
  exit 2
fi
exit 0