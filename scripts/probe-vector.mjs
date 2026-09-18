#!/usr/bin/env node
// probe-vector.mjs — 向量记忆层（可选依赖）探测脚本（分发包通用版）。
//
// bridge 核心是零三方依赖（仅 node: 内建 + 交叉 import）。向量记忆层（sqlite-vec +
// onnxruntime 原生 embedding）是【可选】附加：装了才有语义检索，不装核心照常工作（纯文本兜底）。
//
// 本脚本只读探测向量层是否可用，供安装向导决定要不要拉取 assets-optional 原生包。
//
// 用法：
//   node scripts/probe-vector.mjs            # 人读输出
//   node scripts/probe-vector.mjs --json     # 机器可读
//
// 判定依据（与 state-store.mjs 的懒加载失败回退一致）：
//   vec0.<dll|so> 位于 ~/.agents/vector/ 且能被 node:sqlite 加载扩展；onnxruntime-node 可 require。
// 缺任一 → 表示向量层不可用，应走 assets-optional/README.md 里的 `npm install` 引导。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const HOME = homedir();
const VEC_DIR = join(HOME, ".agents", "vector");
const VEC_LIB = join(VEC_DIR, `vec0.${process.platform === "win32" ? "dll" : "so"}`);

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

const result = {
  node: process.version,
  platform: process.platform,
  vectorDir: VEC_DIR,
  vec0Native: { present: hasVecLib, path: VEC_LIB },
  onnxruntimeNode: { present: hasOrt },
  sqliteVecJs: { present: hasVecExt },
  vectorLayerReady: hasVecLib && (hasOrt || hasVecExt),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`node          : ${result.node} (${result.platform})`);
  console.log(`vector dir    : ${result.vectorDir}`);
  console.log(`vec0 原生库   : ${result.vec0Native.present ? "✔ 存在" : "✖ 缺失"}  ${result.vec0Native.path}`);
  console.log(`onnxruntime   : ${result.onnxruntimeNode.present ? "✔ 可用" : "✖ 缺失（可选）"}`);
  console.log(`sqlite-vec js : ${result.sqliteVecJs.present ? "✔ 可用" : "✖ 缺失（可选）"}`);
  console.log(
    result.vectorLayerReady
      ? "\n向量记忆层已备妥：语义检索可用。"
      : "\n向量记忆层未备妥：核心仍可纯文本运行。需要语义检索时，按 assets-optional/README.md 的 `npm install` 引导补齐。"
  );
}
process.exit(0);