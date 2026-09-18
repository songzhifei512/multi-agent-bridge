<div align="center">

# multi-agent-bridge

**Bridge multiple Agent CLIs into an orchestrated team — a zero-dependency MCP Server.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#requirements)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](#why)
[![MCP](https://img.shields.io/badge/MCP-Server-6e40c9.svg)](#what-is-mcp)
[![Version](https://img.shields.io/badge/version-v1.0.0-informational.svg)](CHANGELOG.md)

*Shared task queue · Shared memory · Message bus · Cross-agent orchestration*

</div>

---

## What

`multi-agent-bridge` is an **MCP Server implemented with pure Node.js standard library**. Its job is to connect otherwise-independent Agent CLIs — **Claude Code, Codex, Qwen, opencode, DSH** — into a single collaboration network.

They normally work in isolation and never talk to each other. This project gives them three shared "public utilities":

| Utility | Problem it solves |
|---------|-------------------|
| 🗂️ **Task queue** | Break a big goal into a dependency DAG of tasks, claimed and relayed by multiple Agents |
| 🧠 **Shared memory** | KV store + handoff notes + vector semantic search, so knowledge actually flows between Agents |
| ✉️ **Message bus** | Persistent inbox + real-time wakeup, so Agents can message and signal each other |

On top of that you get: **429 rate-limit avoidance, parallel multi-worker dispatch, a Web visualization panel, long-task pause/resume**, and a set of orchestration primitives that make "multiple AIs finishing one goal together" actually work.

## Why

Multi-agent collaboration usually means "writing your own glue code" — stitching shell scripts, gluing databases, hand-rolling polling, manually handling rate limits. This bridge consolidates all of that into one standardized MCP Server:

- **Zero third-party dependencies**: only Node.js built-in modules (`child_process` / `fs` / `readline` …), `npm install` pulls 0 packages, deploy = copy files.
- **One protocol**: every Agent talks through the same set of MCP tools instead of N private formats.
- **Observable**: task status, heartbeats, stats, and a panel — collaboration is no longer a black box.
- **Resilient**: rate limits (429), timeouts, false success, stuck processes — these "long-task realities" are handled by built-in mechanisms.

---

## Core Features

### 🗂️ Task queue + DAG orchestration
- Tasks carry `deliverable` (artifact path) and `acceptance_criteria`, so downstream Agents never guess "when is it done".
- Supports **dependency DAG**: a task can't be claimed before all its predecessors are terminal.
- Full lifecycle primitives: `claim / complete / fail / supersede / reassign / fork / depend`.
- **Built-in evolution**: auto-swap failed Agent (`fork`), back-insert a missing step (`insert`), redo a completed stage (`rollback`), conditional branching (`branch`) — all guarded server-side (evolution count cap + independent review gate).

### ⚡ Parallel multi-worker dispatch + fallback rerouting
- One goal can be dispatched to ≥2 perspectives in parallel; results converge through **arbitration** (majority-first → expert weighting → LLM arbiter as fallback).
- `agent_invoke` auto-reroutes to an idle fallback worker when the target is busy; the controller never spins or gets crushed by long tasks.
- Three collaboration paradigms one command away: compete / collaborate / dynamic routing.

### 🔁 429 avoidance + exponential backoff retry
- On rate-limit / timeout, retries with `Retry-After`-aware exponential backoff (default 2 retries, 3 attempts total).
- Supports **model rotation**: when one model keeps returning 429, switch to a fallback model/upstream to bypass the bottleneck.
- **False-success detection**: catches "exit 0 but body is actually an upstream 5xx" and retries instead of mis-failing.

### 🧠 Cross-agent shared memory (KV + notes + vector search)
- **KV store** (`shared_memory_*`): cross-process shared key-value, shared with the `shared-memory` plugin.
- **Handoff notes** (`shared_notes_*`): append-only with timestamp and tag, naturally fitting `handoff:<id>`.
- **Vector semantic search** (`memory_*`): ONNX + sqlite-vec; `memory_search` recalls by *meaning* rather than keywords; memories can be sedimented (`task_sediment`) and promoted (`memory_promote`). Models downloaded on demand, never committed to git.

### ✉️ Message bus (persistent inbox + real-time wakeup)
- Messages persist to disk; FIFO + 60s lease prevents double-processing.
- **Real-time wakeup**: while a receiver is suspended in `inbox_wait`, a sender's message **wakes it immediately** — no polling.
- Supports `topic` grouping, `priority` levels, `memory` auto-sedimentation, and `to="*"` broadcast.

### 📊 Web panel visualization
- Workflows shown as cards / focus graph; task status, dependency chains, quality scores, and heartbeats at a glance.

### ⏱️ Long-task management (interrupt / resume / state machine)
- `task_interrupt`: manually stop a stuck/off-course task (Windows `taskkill /T /F`, Unix `SIGTERM→SIGKILL`), preserving partial output and `session_id`.
- `task_resume`: true resume via `session_id` (context preserved); recoverable from interrupted/failed/superseded.
- Complete state machine: `pending → running → interrupted / escalating / awaiting_approval / completed / failed / superseded`.

### 🔎 Worker CLI auto-detection (`agent_scan`)
- Auto-detects locally installed worker CLIs (claude / codex / qwen / opencode / dsh), checks availability, and mounts it into the registry; missing ones get guidance.

---

## Quick Start (30 seconds)

> Requirements: Node.js ≥ 18, at least one Agent CLI installed (recommend starting with Claude Code as controller).

### Step 1: Clone

```bash
git clone https://github.com/songzhifei512/multi-agent-bridge.git
cd multi-agent-bridge
```

### Step 2: Configure environment variables

Copy the template and fill in your endpoint and keys (every `<placeholder>` is an example — replace with your own value):

```bash
cp config/env.tmpl .env        # or copy manually into ~/.agents/.env
```

Core `.env` entries (endpoints shown as placeholders — use your actual provider):

```bash
# Controller (required)
ANTHROPIC_BASE_URL=<PROVIDER_ANTHROPIC_BASE_URL>
ANTHROPIC_AUTH_TOKEN=<YOUR_ANTHROPIC_API_KEY>
BRIDGE_CONTROLLER=claude

# Optional workers: OpenAI / Qwen / DSH / opencode (enable as needed)
# OPENAI_BASE_URL=<PROVIDER_OPENAI_BASE_URL>
# OPENAI_API_KEY=<YOUR_OPENAI_API_KEY>
# QWEN_BASE_URL=<PROVIDER_QWEN_BASE_URL>
# QWEN_API_KEY=<YOUR_QWEN_API_KEY>
# DSH_BASE_URL=<PROVIDER_DSH_BASE_URL>
# DSH_API_KEY=<YOUR_DSH_API_KEY>
```

> Full guide in [`public-install/ENV_SETUP.md`](public-install/ENV_SETUP.md); sample in [`public-install/agents-config-example/.env.example`](public-install/agents-config-example/.env.example).

### Step 3: Launch and mount to an MCP client

Register the bridge as your Agent CLI's MCP Server (templates: `config/claude-mcp-config.json.tmpl` / `config/codex-mcp-config.toml.tmpl`), then start it:

```bash
node bridge/mcp/shared-context-server.mjs   # start the bridge
node bridge/mcp/bridge-web-panel.mjs        # (optional) start the Web panel
```

An install wizard is also provided (auto-substitutes path placeholders and writes config):

```bash
bash launchers/install.sh      # on Windows use launchers/install-win.bat
```

Once mounted, the controller Agent can see and invoke the whole collaboration toolkit.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                    You / Controller Agent (Claude Code)        │
│                    invokes collaboration tools over MCP        │
└──────────────────────────────┬────────────────────────────────┘
                               │ stdio (MCP)
                               ▼
┌───────────────────────────────────────────────────────────────┐
│          shared-context-server.mjs  (MCP Server)               │
│      pure Node.js stdlib · zero deps · 54 collaboration tools  │
├─────────────────┬─────────────────┬───────────────────────────┤
│   🗂️ Task queue  │   🧠 Shared mem  │      ✉️ Message bus        │
│   (DAG)         │  KV/notes/vector │   (inbox + realtime wake) │
├─────────────────┴─────────────────┴───────────────────────────┤
│            Worker dispatch (Agent Registry / agent_scan)       │
└───────┬───────────┬───────────┬───────────┬───────────┬────────┘
        ▼           ▼           ▼           ▼           ▼
   Claude Code   Codex       Qwen      opencode      DSH
   reasoning    batch code  docs/PPT   fallback     multi-backend
```

---

## Tool Overview (54 tools · 5 categories)

### 🗂️ Task orchestration
| Tool | Purpose |
|------|---------|
| `task_create` / `task_list` | Create / query tasks (status/search/sort/pagination/batch) |
| `task_claim` / `task_complete` / `task_fail` | Claim / complete / fail lifecycle |
| `task_supersede` / `task_reassign` | Mark superseded / unlock back to pending (safe handover) |
| `task_approve` | Human approval gate (blocks downstream until released) |
| `task_interrupt` / `task_resume` | Interrupt a long task / resume with session |
| `task_fork` / `task_depend` | Fork a subtask / recompute dependencies dynamically |
| `task_escalate` / `task_decide` / `task_heartbeat` | Escalate decision / push decision / milestone heartbeat |
| `task_sediment` | Auto-sediment a completed task into searchable knowledge |

### 🔀 Worker dispatch
| Tool | Purpose |
|------|---------|
| `run_claude` / `run_codex` / `run_qwen` / `run_dsh` | Async-invoke each CLI Agent (auto rate-limit retry) |
| `agent_list` / `agent_invoke` | List registered Agents / dispatch by name (busy-fallback) |
| `agent_scan` | Detect locally installed workers and mount availability |
| `agent_eval` | Per-Agent completion rate / quality / duration / retries |
| `run_verify` | LLM-as-judge quality gate (score 0–100) |
| `workflow_plan` / `workflow_start` / `workflow_evolve` | Orchestration: decompose / land DAG / adaptive replan |
| `result_arbitrate` | Arbitrate conflicting multi-worker results |

### 🧠 Shared memory
| Tool | Purpose |
|------|---------|
| `shared_memory_set` / `get` / `list` | Process-level shared KV store |
| `shared_notes_append` / `read` | Append-only handoff notes (tagged) |
| `memory_add` / `memory_search` | Write / vector-semantic recall |
| `memory_list` / `memory_delete` / `memory_stats` | Memory store management |
| `memory_promote` | Promote project-level memory to platform/global |

### ✉️ Message bus
| Tool | Purpose |
|------|---------|
| `bus_send` / `agent_send_message` | Send (incl. broadcast `to="*"`, auto-sediment to vector memory) |
| `inbox_read` / `inbox_wait` | Sync read / realtime-wakeup read (event-driven) |
| `inbox_ack` | Acknowledge consumption (release 60s lease) |
| `bus_history` | Read-only replay of signals/messages |

### ⚙️ Ops & observability
| Tool | Purpose |
|------|---------|
| `bridge_stats` | Runtime observability (per-Agent calls/success/retries/duration) |
| `bridge_checkpoint` | State snapshot: save / list / restore (audit & rollback) |
| `file_lock_acquire` / `release` / `list` | Cross-process file locks (prevent two Agents editing one file) |
| `project_search` / `read_file` / `list_dir` | Shared read-only file access |
| `safe_scan` | Artifact safety hard-block (pre-approval gate) |
| `vision_analyze` | Image understanding (scene/text, not barcode) |
| `dsh_read` | Read-only access to DSH historical sessions |

---

## Directory Structure

```
multi-agent-bridge/
├── bridge/mcp/              # Core MCP Server (9 files: 8 .mjs + 1 package.json, zero deps)
├── config/                  # Config templates (env / claude / codex)
├── launchers/               # Install / launch scripts (install-win.bat / install.sh)
├── scripts/                 # Probe / smoke / stress scripts
├── assets-optional/         # Optional vector layer (models downloaded on demand)
├── docs/                    # Docs (cookbook / releases)
├── public-install/          # Public install guide (INSTALL / ENV_SETUP / .env.example)
└── .github/                 # CI (3-platform smoke) and Release workflows
```

## Documentation

- 📦 [Install guide](public-install/INSTALL.md) — step-by-step from scratch
- 🔧 [Env config](public-install/ENV_SETUP.md) — endpoints / keys / models
- 🖼️ [Vision analysis](public-install/VISION_ANALYZE.md) — `vision_analyze` usage
- 🧭 [Exception-handling cookbook](docs/cookbook/exception-handling.md) — rate-limit / timeout / stuck recovery
- 📝 [Changelog](CHANGELOG.md) · [Contributing guide](AGENTS.md) · [中文 README](README.md)

## License

[MIT](LICENSE) © multi-agent-bridge contributors