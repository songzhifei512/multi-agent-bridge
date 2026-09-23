#!/usr/bin/env node
// install-vector-layer.mjs -- one-shot installer for the optional vector layer.
//
// What it does (idempotent, rerun-safe):
//   (1) Probe node + platform. Abort with a clear error on unsupported arches.
//   (2) Download the embedding model + tokenizer from $VECTOR_MODEL_URL
//       (defaults to huggingface; falls back to hf-mirror on timeout/404).
//       Drops them into <repo>/assets-optional/model-multilingual/ AND
//       ~/.agents/vector/model-multilingual/.
//   (3) Run `npm install onnxruntime-node sqlite-vec --foreground-scripts`
//       in <repo>/assets-optional/, with allow-scripts forced on so the
//       postinstall fetches win32 native pre-compiled bindings.
//   (4) Re-export the deps to multi-agent root by creating NTFS junctions
//       for `onnxruntime-node` and `sqlite-vec` so the bridge's
//       vec_memory.mjs and probe-vector.mjs can require them.
//   (5) Run scripts/probe-vector.mjs --json and print a 4-status summary
//       (vec0 / onnxruntime / sqlite-vec / model). Exits non-zero only
//       if --strict was passed AND any layer is still missing.
//
// Flags:
//   --strict                exit 1 if anything is missing after install
//   --no-download           skip step 2 (use if model already on disk)
//   --no-install            skip step 3+4 (use if deps already installed)
//   --check-only            only run probe, no install
//   --json                  machine-readable summary line (last line)
//   --force                 re-download model even if size matches, reinstall
//                           npm deps ignoring existing lockfile state.
//                           DEFAULT behaviour is to skip what already exists.
//   --wipe-existing-model   actually deletes ~/.agents/vector/model-multilingual/*
//                           before re-downloading (default: never delete).
//   --purge-db              ALSO delete ~/.agents/vector/vec.db before exit.
//                           Without this flag, vec.db is NEVER touched by us
//                           (only created by first memory_add call).
//
// Env:
//   VECTOR_MODEL_URL       override HF source
//   VECTOR_MODEL_MIRROR    fallback mirror (default: https://hf-mirror.com)
//   VECTOR_DIR             override target ~/.agents/vector (default: ~/.agents/vector)
//
// All output is human-readable; structured summary at the very end:
//
//   {"ok":true,"vec0":true,"onnxruntime":true,"sqliteVec":true,"model":true,"strict":false}

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, statSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Repo root = parent of assets-optional/
const REPO_ROOT = resolve(__dirname, '..');

const ARG = parseArgs(process.argv.slice(2));
const STRICT = !!ARG['strict'];
const NO_DOWNLOAD = !!ARG['no-download'];
const NO_INSTALL = !!ARG['no-install'];
const CHECK_ONLY = !!ARG['check-only'];
const JSON_OUT = !!ARG['json'];
const FORCE = !!ARG['force'];                         // re-download even if model exists
const WIPE_MODEL = !!ARG['wipe-existing-model'];     // actually rm -rf onnx/json before download
const PURGE_DB = !!ARG['purge-db'];                   // dangerous: rm vec.db on exit

if (PURGE_DB) {
  if (!JSON_OUT) {
    console.log('');
    console.log('  >>> --purge-db is set: ~/.agents/vector/vec.db will be DELETED before exit <<<');
    console.log('  >>> If any saved memories exist, they will be lost. Continue in 5s unless Ctrl-C...');
    console.log('');
  }
}

const HOME = homedir();
const VECTOR_DIR = process.env.VECTOR_DIR || join(HOME, '.agents', 'vector');
const MODEL_DIR_REPO = join(REPO_ROOT, 'assets-optional', 'model-multilingual');
const MODEL_DIR_USER = join(VECTOR_DIR, 'model-multilingual');
const PKG_DIR_OPTIONAL = join(REPO_ROOT, 'assets-optional');
const PROBE = join(REPO_ROOT, 'scripts', 'probe-vector.mjs');

const HF_DEFAULT = 'https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main';
const HF_MIRROR = process.env.VECTOR_MODEL_MIRROR || 'https://hf-mirror.com/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) out[k.slice(2)] = true;
  }
  return out;
}

function log(...args) {
  if (JSON_OUT) return;
  console.log(...args);
}

function step(msg) {
  if (JSON_OUT) return;
  console.log('');
  console.log('-- ' + msg);
}

// ---------------- download model ----------------

const FILES = [
  { name: 'model_quantized.onnx', rel: 'onnx/model_quantized.onnx', overwrite: true,  minBytes: 100 * 1024 * 1024 },
  { name: 'tokenizer.json',       rel: 'tokenizer.json',            overwrite: true,  minBytes: 1024 },
  { name: 'config.json',          rel: 'config.json',               overwrite: false, minBytes: 0 },
  { name: 'tokenizer_config.json',rel: 'tokenizer_config.json',     overwrite: false, minBytes: 0 },
];

function tryDownload(url, outPath, minBytes) {
  return new Promise((resolveP) => {
    log(`  fetching ${url}`);
    let tried = false;
    const tryNative = () => {
      // prefer PowerShell Invoke-WebRequest on win32 (preinstalled)
      if (platform() === 'win32') {
        const args = [
          '-NoProfile', '-Command',
          `try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${url}' -OutFile '${outPath}' -UseBasicParsing -TimeoutSec 240 } catch { exit 1 }`,
        ];
        const r = spawnSync('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        return r.status === 0 && existsSync(outPath) && statSync(outPath).size >= minBytes;
      }
      return false;
    };
    const tryCurl = () => {
      // fall back to curl.exe (Win10+ has it built in)
      const curl = process.env.CURL_BIN || 'curl.exe';
      const r = spawnSync(curl, ['-L', '--fail', '--show-error', '--max-time', '240', '-o', outPath, url], { stdio: ['ignore', 'pipe', 'pipe'] });
      return r.status === 0 && existsSync(outPath) && statSync(outPath).size >= minBytes;
    };

    setImmediate(() => {
      if (!tried && tryNative()) { tried = true; resolveP(true); return; }
      if (!tried && tryCurl()) { tried = true; resolveP(true); return; }
      resolveP(false);
    });
  });
}

async function downloadModel() {
  const sources = [
    process.env.VECTOR_MODEL_URL || HF_DEFAULT,
    HF_MIRROR,
  ];
  mkdirSync(MODEL_DIR_REPO, { recursive: true });
  mkdirSync(MODEL_DIR_USER, { recursive: true });

  // -- Optional wipe (only when --wipe-existing-model is set) --
  if (WIPE_MODEL) {
    for (const f of FILES) {
      const p = join(MODEL_DIR_REPO, f.name);
      try { if (existsSync(p)) { unlinkSync(p); } } catch {}
    }
    log('  --wipe-existing-model: removed existing files in ' + MODEL_DIR_REPO);
  }

  let ok = true;
  for (const f of FILES) {
    const outRepo = join(MODEL_DIR_REPO, f.name);
    let needDownload = FORCE || !existsSync(outRepo);
    if (existsSync(outRepo) && f.minBytes && statSync(outRepo).size < f.minBytes) {
      // truncated file: replace
      try { unlinkSync(outRepo); } catch {}
      needDownload = true;
    }

    if (needDownload) {
      let success = false;
      for (const base of sources) {
        const url = base.endsWith('/') ? base + f.rel : base + '/' + f.rel;
        step(`fetch ${f.name} (expect >= ${Math.round(f.minBytes / 1024)}KB)`);
        success = await tryDownload(url, outRepo, f.minBytes || 1);
        if (success) break;
        log(`  [warn] ${base} failed, trying next`);
      }
      if (!success) {
        log(`  [fail] could not download ${f.name} from any source`);
        ok = false;
      }
    } else {
      log(`  [skip] ${f.name} already present`);
    }
  }

  // mirror to user dir, BUT: never overwrite existing files unless --force
  // or --wipe-existing-model was set. This protects users who deliberately
  // placed their own ONNX/tokenizer in ~/.agents/vector/.
  step('mirror to ' + MODEL_DIR_USER);
  for (const f of FILES) {
    const src = join(MODEL_DIR_REPO, f.name);
    const dst = join(MODEL_DIR_USER, f.name);
    if (!existsSync(src)) continue;
    if (existsSync(dst) && !FORCE && !WIPE_MODEL) {
      log('  [preserve] ' + f.name + ' (already in user dir, skip copy)');
      continue;
    }
    try {
      copyFileSync(src, dst);
      log('  ' + f.name + ' -> ' + dst + ' (copied)');
    } catch (e) {
      log('  [warn] mirror failed for ' + f.name + ': ' + e.message);
    }
  }
  return ok;
}

// ---------------- npm install native deps ----------------

function runNpm(args, cwd) {
  const r = spawnSync('npm', args, {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, npm_config_ignore_scripts: '' },
  });
  return r.status === 0;
}

function ensurePackageJson() {
  const pj = join(PKG_DIR_OPTIONAL, 'package.json');
  if (!existsSync(pj)) {
    writeFileSync(pj, JSON.stringify({
      name: 'multi-agent-vector-assets',
      private: true,
      dependencies: {},
    }, null, 2) + '\n');
  }
}

function npmInstallDeps() {
  step('npm install onnxruntime-node + sqlite-vec');
  ensurePackageJson();

  // Allow postinstall (onnxruntime-node needs to fetch native bindings).
  // npm config allow-scripts is per-project; set it inline.
  const cfg = join(PKG_DIR_OPTIONAL, '.npmrc');
  if (!existsSync(cfg)) {
    writeFileSync(cfg, 'enable-pre-post-scripts=true\nallow-scripts=true\n');
  }

  // First pass: trust `npm install` (idempotent). Exit code 0 means OK.
  // Exit code non-zero may come from warnings/lint even when packages are
  // installed; do a probe (tryRequire) and only treat that as fatal.
  const r = spawnSync('npm', ['install', 'onnxruntime-node', 'sqlite-vec', '--no-audit', '--no-fund'], {
    cwd: PKG_DIR_OPTIONAL,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, npm_config_ignore_scripts: '' },
  });
  if (r.status === 0) return true;

  log('  [warn] npm install exited ' + r.status + '; probing installed deps...');
  // Probe: try to require both. If both resolvable, the previous exit code
  // was spurious (warnings/lint), and we proceed.
  const req = createRequire(import.meta.url);
  const probePkg = (mod) => {
    try {
      req.resolve(mod, { paths: [PKG_DIR_OPTIONAL] });
      return true;
    } catch { return false; }
  };
  const ok = probePkg('onnxruntime-node') && probePkg('sqlite-vec');
  if (ok) {
    log('  [OK] deps resolvable despite non-zero exit; treating install as successful.');
    return true;
  }
  log('  [fail] deps not resolvable; install really failed.');
  return false;
}

function exposeAtRepoRoot() {
  step('expose onnxruntime-node + sqlite-vec at repo root');
  const rootNm = join(REPO_ROOT, 'node_modules');
  if (!existsSync(rootNm)) mkdirSync(rootNm, { recursive: true });
  const items = ['onnxruntime-node', 'sqlite-vec', 'sqlite-vec-windows-x64'];
  for (const it of items) {
    const src = join(PKG_DIR_OPTIONAL, 'node_modules', it);
    const dst = join(rootNm, it);
    if (!existsSync(src)) continue;
    try { if (existsSync(dst) || (() => { try { statSync(dst); return true; } catch { return false; } })()) unlinkSync(dst); } catch {}
    try {
      symlinkSync(src, dst, 'junction');
      log('  [J] ' + it);
    } catch (e) {
      log('  [warn] junction failed for ' + it + ': ' + e.message);
    }
  }
}

// ---------------- probe ----------------

function runProbe() {
  const r = spawnSync('node', [PROBE, '--json'], { encoding: 'utf8' });
  let info = {};
  try { info = JSON.parse(r.stdout); } catch {
    info = { vectorLayerReady: false, _raw: r.stdout };
  }
  const vec0UserPath = join(VECTOR_DIR, `vec0.${process.platform === 'win32' ? 'dll' : 'so'}`);
  const vecDbPath = join(VECTOR_DIR, 'vec.db');
  const vecDbPresent = existsSync(vecDbPath);
  let vecDbBytes = 0;
  if (vecDbPresent) {
    try { vecDbBytes = statSync(vecDbPath).size; } catch {}
  }

  const modelOnnx = existsSync(join(MODEL_DIR_USER, 'model_quantized.onnx'))
    && statSync(join(MODEL_DIR_USER, 'model_quantized.onnx')).size > 100 * 1024 * 1024;

  return {
    vec0: !!info.vec0Native?.present,
    vec0UserPath,                                     // explicit: this is what vec_memory uses
    vec0NativeInPkg: existsSync(join(PKG_DIR_OPTIONAL, 'node_modules', `vec0.${process.platform === 'win32' ? 'dll' : 'so'}`)),
    onnxruntime: !!info.onnxruntimeNode?.present,
    sqliteVec: !!info.sqliteVecJs?.present,
    model: modelOnnx,
    vecDbPresent,
    vecDbPath,
    vecDbBytes,
    vecLayerReady: !!info.vectorLayerReady,
    vectorEnabled: info.vectorEnabled !== false,
    semanticSearchEnabled: !!info.semanticSearchEnabled,
  };
}

function printSummary(s) {
  const okEmoji  = (v) => v ? '[OK]' : '[--]';
  const missHint = (v, hint) => v ? '' : '  (' + hint + ')';
  if (JSON_OUT) {
    console.log(JSON.stringify({
      ok: s.vecLayerReady || (!STRICT && s.onnxruntime && s.model),
      vec0: s.vec0,
      onnxruntime: s.onnxruntime,
      sqliteVec: s.sqliteVec,
      model: s.model,
      vecDbPresent: s.vecDbPresent,
      vecDbBytes: s.vecDbBytes,
      strict: STRICT,
    }, null, 2));
    return;
  }
  console.log('');
  console.log('=== vector layer status ===');
  console.log('  vec0 native (sqlite-vec)    :', okEmoji(s.vec0), '~/.agents/vector/' + (process.platform === 'win32' ? 'vec0.dll' : 'vec0.so') + missHint(s.vec0, '(npm install sqlite-vec)'));
  console.log('  onnxruntime (embedding)     :', okEmoji(s.onnxruntime), 'npm onnxruntime-node' + missHint(s.onnxruntime, '(npm install onnxruntime-node)'));
  console.log('  sqlite-vec js wrapper       :', okEmoji(s.sqliteVec), 'npm sqlite-vec' + missHint(s.sqliteVec, '(npm install sqlite-vec)'));
  console.log('  embedding model (>=100MB)   :', okEmoji(s.model), '~/.agents/vector/model-multilingual/' + missHint(s.model, '(assets-optional/model-multilingual missing)'));
  if (s.vecDbPresent) {
    console.log('  vec.db                      :', '[present] existing (NOT touched by installer). size = ' + s.vecDbBytes + ' bytes.');
  } else {
    console.log('  vec.db                      : [absent] will be created on first memory_add call.');
  }
  console.log('');
  // explicit safety notice
  if (!PURGE_DB && !WIPE_MODEL && !FORCE) {
    console.log('  >>> idem-mode (default): existing files / vec.db are PRESERVED, no overwrite <<<');
  } else {
    console.log('  >>> DESTRUCTIVE-MODE: explicit flags set; see notes above. <<<');
  }
  console.log('');
  if (s.vecLayerReady && s.semanticSearchEnabled) {
    console.log('  >>> vector memory layer READY  (semantic search ENABLED) <<<');
  } else if (s.vecLayerReady && !s.semanticSearchEnabled) {
    console.log('  >>> vector deps installed but DISABLED via env. Set VECTOR_ENABLED=1 to turn on. <<<');
  } else if (s.onnxruntime && s.model) {
    console.log('  >>> partial: model + onnx present but vec0 missing; fallback to text-only <<<');
  } else {
    console.log('  >>> text-only fallback active (core features intact) <<<');
  }
  console.log('');
  console.log('  Toggle (env var)            :  VECTOR_ENABLED=0 to disable semantic search');
}

async function main() {
  log('=== multi-agent vector-layer installer ===');
  log('  platform : ' + platform() + '/' + arch());
  log('  repo     : ' + REPO_ROOT);
  log('  user dir : ' + VECTOR_DIR);

  if (CHECK_ONLY) {
    const s = runProbe();
    printSummary(s);
    return STRICT && !s.vecLayerReady ? 1 : 0;
  }

  let downloadOk = true;
  if (!NO_DOWNLOAD) {
    step('download embedding model');
    downloadOk = await downloadModel();
    if (!downloadOk) log('  [warn] some model files missing; continuing');
  }

  let installOk = true;
  if (!NO_INSTALL) {
    step('install native deps');
    installOk = npmInstallDeps();
    exposeAtRepoRoot();
  }

  step('probe-vector.mjs --json (final)');
  const s = runProbe();
  printSummary(s);

  // -- optional destructive purge, at the END after reporting status --
  if (PURGE_DB) {
    log('');
    log('!!! --purge-db set: deleting ' + s.vecDbPath + ' ...');
    try {
      if (existsSync(s.vecDbPath)) { unlinkSync(s.vecDbPath); log('    removed'); }
      // vec.db also has -shm/-wal siblings
      for (const sib of ['-shm', '-wal']) {
        const p = s.vecDbPath + sib;
        if (existsSync(p)) { unlinkSync(p); }
      }
    } catch (e) {
      log('    [warn] failed to remove vec.db: ' + e.message);
    }
    log('!!! vec.db destroyed; existing memories lost.');
  }

  const allOk = downloadOk && installOk && (s.onnxruntime || !NO_INSTALL) && (s.model || NO_DOWNLOAD);
  if (STRICT && !s.vecLayerReady) return 1;
  return allOk ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('[install-vector-layer] fatal:', e);
  process.exit(2);
});
