#!/usr/bin/env bash
# install-vector-layer.sh -- thin wrapper that delegates to install-vector-layer.mjs.
#
# Usage:
#   bash assets-optional/install-vector-layer.sh                # full install
#   bash assets-optional/install-vector-layer.sh --strict       # fail on missing
#   bash assets-optional/install-vector-layer.sh --check-only   # probe only
#   bash assets-optional/install-vector-layer.sh --json         # machine summary
#
# Override source: VECTOR_MODEL_URL=https://your-mirror bash ./install-vector-layer.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MJS="$SCRIPT_DIR/install-vector-layer.mjs"

if ! command -v node >/dev/null 2>&1; then
  echo "[X] node is required (>=18). Install: https://nodejs.org" >&2
  exit 1
fi

echo "==> multi-agent vector-layer installer (bash entry)"
echo "    Note: model downloads are skipped if files already exist."
echo "    Override source: VECTOR_MODEL_URL=\"https://your-mirror/\" ./install.sh"
echo ""

exec node "$MJS" "$@"
