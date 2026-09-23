#!/usr/bin/env node
// probe-vector.mjs -- status of the optional vector layer.
//
// Outputs (human / --json) include both hard requirements (vec0, onnx,
// sqlite-vec, model) AND the runtime gate `vectorEnabled` derived from:
//   - VECTOR_ENABLED env: '0' / 'false' / 'no' / 'off' => disabled
//   - everything else (including '1' / 'true' / unset) => enabled
//
// Final verdict `vectorLayerReady` = hard deps present AND vectorEnabled.
//
// semanticSearchEnabled is what the bridge actually uses to decide whether
// to call memory_search; falls back to keyword-only memory_search when false.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const HOME = homedir();
const VEC_DIR = process.env.VECTOR_DIR || join(HOME, ".agents", "vector");
const VEC_LIB = join(VEC_DIR, `vec0.${process.platform === "win32" ? "dll" : "so"}`);
const MODEL_DIR = join(VEC_DIR, "model-multilingual");
const MODEL_FILE = join(MODEL_DIR, "model_quantized.onnx");

// --- runtime toggle (VECTOR_ENABLED) ---
const rawFlag = (process.env.VECTOR_ENABLED ?? "").toString().trim().toLowerCase();
const DISABLED_TOKENS = new Set(["0", "false", "no", "off", "n", "f", "disable", "disabled"]);
const vectorEnabledByEnv = !(rawFlag && DISABLED_TOKENS.has(rawFlag));

function tryRequire(mod) {
  const req = createRequire(import.meta.url);
  try {
    req(mod);
    return true;
  } catch {
    return false;
  }
}

const hasVecLib = existsSync(VEC_LIB);
const hasOrt = tryRequire("onnxruntime-node");
const hasVecExt = tryRequire("sqlite-vec");

const modelStat = existsSync(MODEL_FILE) ? statSync(MODEL_FILE).size : 0;
const hasModel = modelStat >= 100 * 1024 * 1024; // >=100MB heuristic for the quantized model
const hasVecDb = existsSync(join(VEC_DIR, "vec.db"));

const hardReady = hasVecLib && hasOrt && hasVecExt && hasModel;
const vectorLayerReady = hardReady && vectorEnabledByEnv;
const semanticSearchEnabled = vectorLayerReady;

const result = {
  node: process.version,
  platform: process.platform,
  vectorDir: VEC_DIR,
  // hard deps
  vec0Native: { present: hasVecLib, path: VEC_LIB },
  onnxruntimeNode: { present: hasOrt },
  sqliteVecJs: { present: hasVecExt },
  embeddingModel: { present: hasModel, bytes: modelStat, path: MODEL_FILE },
  vecDb: { present: hasVecDb, path: join(VEC_DIR, "vec.db") },
  // runtime toggle
  vectorEnabled: vectorEnabledByEnv,
  vectorEnabledSource: rawFlag === "" ? "default-on" : (vectorEnabledByEnv ? "env-on" : "env-off"),
  // derived
  vectorLayerReady,
  semanticSearchEnabled,
  // backward-compatible field name
  status: vectorLayerReady ? "ready" : (hardReady ? "installed-disabled" : "missing"),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const fmt = (label, ok, extra) => `  ${label.padEnd(28)} : ${ok ? "[OK]" : "[--]"}  ${extra}`;
  console.log("");
  console.log("=== vector layer probe ===");
  console.log(`  node                        : ${result.node} (${result.platform})`);
  console.log(`  vector dir                  : ${result.vectorDir}`);
  console.log(fmt("vec0 native (sqlite-vec)",    hasVecLib,    "vec0.dll|.so " + (hasVecLib ? "" : "(install sqlite-vec)")));
  console.log(fmt("onnxruntime-node",            hasOrt,       "(npm install onnxruntime-node)"));
  console.log(fmt("sqlite-vec js wrapper",       hasVecExt,    "(npm install sqlite-vec)"));
  console.log(fmt("embedding model (>=100MB)",   hasModel,     "model_quantized.onnx"));
  console.log(fmt("vec.db",                       hasVecDb,    "(none yet -- memory_add creates)"));
  console.log("");
  console.log(`  runtime toggle              : VECTOR_ENABLED=${rawFlag === "" ? "(unset)" : rawFlag}  ->  ${vectorEnabledByEnv ? "ENABLED" : "DISABLED"}`);
  console.log("");
  if (vectorLayerReady) {
    console.log("  >>> vector memory layer READY  (semantic search ENABLED) <<<");
  } else if (hardReady && !vectorEnabledByEnv) {
    console.log("  >>> vector deps installed but DISABLED via env. Set VECTOR_ENABLED=1 (or unset) to turn it on. <<<");
  } else if (hardReady) {
    console.log("  >>> partial; check runtime toggle. <<<");
  } else {
    console.log("  >>> text-only fallback active (core features intact). Run assets-optional/install-vector-layer.{ps1,sh} to enable. <<<");
  }
}
process.exit(0);
