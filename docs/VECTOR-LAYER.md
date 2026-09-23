# Vector Memory Layer

The bridge's **cross-agent memory recall** (memory_search / memory_add /
task_sediment) has two modes:

- **Pure-text fallback** (always works): keyword + substring matching against
  the shared KV/notes store. The bridge core keeps working without any
  vector layer installed.

- **Semantic search** (opt-in): ONNX-embedded query → sqlite-vec KNN →
  ranked by cosine similarity. Higher recall, especially for Chinese.

This document covers the **opt-in install path**. Defaults are conservative:
nothing is downloaded unless you ask.

---

## When do you need it?

| Use case | Need vector layer? |
|---|---|
| Pure coordination / task DAG / message bus | No — text fallback is enough |
| memory_search across agents by *meaning* | Yes |
| Long-running project that needs to recall past decisions semantically | Yes |
| Compliance / air-gapped installation | No — and you can disable it via env |

---

## One-shot install

Both entrypoints delegate to the same `assets-optional/install-vector-layer.mjs`:

### Windows

```powershell
# Default: idempotent install. Existing files (model / vec.db / vec0.dll)
# are PRESERVED; nothing is overwritten unless you pass --force etc.
powershell -ExecutionPolicy Bypass -File assets-optional\install-vector-layer.ps1

# Just probe, no install
powershell -ExecutionPolicy Bypass -File assets-optional\install-vector-layer.ps1 -CheckOnly

# Fail-loud on any missing piece
powershell -ExecutionPolicy Bypass -File assets-optional\install-vector-layer.ps1 -Strict

# Machine-readable one-line JSON summary (for CI)
powershell -ExecutionPolicy Bypass -File assets-optional\install-vector-layer.ps1 -Json

# Destructive (use sparingly — see "Safety guarantees" below)
powershell -ExecutionPolicy Bypass -File assets-optional\install-vector-layer.ps1 -Force             # re-download
powershell -ExecutionPolicy Bypass -File assets-optional\install-vector-layer.ps1 -WipeExistingModel # delete model dir first
powershell -ExecutionPolicy Bypass -File assets-optional\install-vector-layer.ps1 -PurgeDb           # delete vec.db
```

### Linux / macOS

```bash
bash assets-optional/install-vector-layer.sh
bash assets-optional/install-vector-layer.sh --check-only
bash assets-optional/install-vector-layer.sh --strict
bash assets-optional/install-vector-layer.sh --json
bash assets-optional/install-vector-layer.sh --force
bash assets-optional/install-vector-layer.sh --wipe-existing-model
bash assets-optional/install-vector-layer.sh --purge-db
```

The installer walks **all 4 hard deps** in one pass:

1. `vec0.<dll|so>` — sqlite-vec native library in `~/.agents/vector/`
2. `onnxruntime-node` — npm binding for embedding inference
3. `sqlite-vec` JS wrapper — npm, lets node load `vec0`
4. `model_quantized.onnx` — ≥100 MB MiniLM-L12 multilingual model

If anything already exists locally, it's kept (idempotent).

---

## Override defaults (env vars)

| Env var | Effect |
|---|---|
| `VECTOR_ENABLED=0` | Disable semantic search at runtime (kernel falls back to text) |
| `VECTOR_ENABLED=1` | Force semantic search on (default if unset) |
| `VECTOR_DIR=/path` | Override `~/.agents/vector` (must contain vec.db + model) |
| `VECTOR_MODEL_URL=https://...` | Override HuggingFace source for the model download |
| `VECTOR_MODEL_MIRROR=https://...` | Fallback mirror (default: `hf-mirror.com`) |
| `VECTOR_MODEL=/path/model.onnx` | Skip auto-discovery; use a specific model |
| `VECTOR_TOK=/path/tokenizer.json` | Same for tokenizer |

`VECTOR_ENABLED` is consumed both by the bridge at runtime (see
`bridge/mcp/vec_memory.mjs`) and by `scripts/probe-vector.mjs` so the
status output reflects your toggle immediately.

---

## Status probe

```bash
node scripts/probe-vector.mjs            # human
node scripts/probe-vector.mjs --json     # machine
```

Sample `--json` output (everything green):

```json
{
  "node": "v24.19.0",
  "platform": "win32",
  "vectorDir": "C:\\Users\\you\\.agents\\vector",
  "vec0Native":         { "present": true,  "path": "...\\vec0.dll" },
  "onnxruntimeNode":    { "present": true },
  "sqliteVecJs":        { "present": true },
  "embeddingModel":     { "present": true,  "bytes": 118308126, "path": "...\\model_quantized.onnx" },
  "vecDb":              { "present": true,  "path": "...\\vec.db" },
  "vectorEnabled": true,
  "vectorEnabledSource": "default-on",
  "vectorLayerReady": true,
  "semanticSearchEnabled": true,
  "status": "ready"
}
```

`status` has three legal values:

- `ready`              — hard deps present + VECTOR_ENABLED on → mem_search uses vector
- `installed-disabled` — hard deps present but VECTOR_ENABLED=0 → falls back to text-only
- `missing`            — one or more hard deps absent → falls back to text-only

---

## Install-time integration

Both `launchers/install-win.bat` and `launchers/install.sh` now:

1. Run `probe-vector.mjs` first → show 4-axis status
2. Ask once: *"Install vector layer (download + npm install)?"*
3. If yes, defer to `install-vector-layer.mjs`
4. Final summary prints `ENABLED` or `OFF` based on `semanticSearchEnabled`

So `install-win.bat / install.sh` reflect the same state machine as
manual installs.

---

## Safety guarantees (important)

The installer is **idempotent and non-destructive by default**. Specifically:

| Resource | Default behaviour | To override |
|---|---|---|
| `~/.agents/vector/model_quantized.onnx` | **skip** if already present | `--force` (re-download) or `--wipe-existing-model` (delete first) |
| `~/.agents/vector/tokenizer.json` | **skip** if already present | `--force` / `--wipe-existing-model` |
| `~/.agents/vector/vec0.dll` | **never touched** | (not managed by us — created by sqlite-vec npm install) |
| `~/.agents/vector/vec.db` | **never read or written** by installer; only created lazily on first `memory_add` | `--purge-db` (deletes at end; you lose saved memories) |
| npm packages (`onnxruntime-node`, `sqlite-vec`) | `npm install` is itself idempotent; re-running is safe | (no destructive flag) |

What this means:

- **Re-running the installer never overwrites the user's model files.**
- **Re-running the installer never touches `vec.db`** — your saved memories are
  safe even if you reinstall multi-agent-bridge itself, even if you upgrade
  Node versions, even if you blow away the workspace.
- The only way to lose data is to **explicitly** pass `--purge-db`. The
  installer prints a warning banner before doing so.

The model mirror logic:

- If `~/.agents/vector/model-multilingual/model_quantized.onnx` already
  exists and is ≥100 MB, the installer uses it and the `model OK` line
  reflects that. No re-download.
- The first file on the model list (`config.json`, `tokenizer_config.json`)
  is never overwritten (`overwrite=false` in the manifest).
- Failed downloads leave whatever partial files exist for the next run to
  inspect / resume.

## Uninstall / disable

Two clean exit ramps:

```bash
# Soft: keep files, disable semantic search
export VECTOR_ENABLED=0

# Hard: wipe everything we put down
rm -rf ~/.agents/vector
rm -rf ./node_modules/onnxruntime-node ./node_modules/sqlite-vec
```

After the hard wipe, re-running `install-vector-layer.{ps1,sh}` rebuilds
from scratch.

---

## Architecture (for the curious)

```
                       +-----------------+
        bridge runtime  |  vec_memory.mjs | --lazy--> onnxruntime-node (N-API)
        ---------->    +--------+--------+
                              |
                              v
                       +-----------------+
                       |  sqlite-vec KNN | <-- node:sqlite + vec0.dll/.so
                       +-----------------+
                              |
                              v
                       ~/.agents/vector/
                         - vec.db
                         - vec0.dll|.so
                         - model-multilingual/
                             - model_quantized.onnx
                             - tokenizer.json
                             - config.json
                             - tokenizer_config.json
```

When `vec_memory.mjs` is required by the bridge, it **lazy-imports** all
native deps on the first call to `memory_search / memory_add`. If anything
fails to load, the bridge silently falls back to text-only filtering.

---

## Verification (CI)

`scripts/verify-vector-install.mjs` exercises the full path:

1. fake `$HOME/.agents/vector/` with a 100MB+ placeholder ONNX
2. run `install-vector-layer.mjs --no-download --no-install`
3. assert `status == ready` and `semanticSearchEnabled == true`
4. assert `VECTOR_ENABLED=0` flips `semanticSearchEnabled` to false

Run it:

```bash
node scripts/verify-vector-install.mjs
```
