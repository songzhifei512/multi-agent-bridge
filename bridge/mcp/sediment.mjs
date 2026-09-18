// sediment.mjs — 向量记忆层沉淀脚本（多源 learnings + 增量沉淀）
//
// 增量沉淀：按文件内容哈希判定变更，只重 embed 变更文件，未变段 rowid 保留。
// 全量重沉淀仍可用（--full），用于切分逻辑/模型变更时强制重建。
// 复用 vec_memory.mjs 的 memoryAdd（已处理 scope/category/嵌入）。
//
// learnings 源从单路径硬编码改多源 + env 覆盖 + 平台自动发现。
//   旧 LEARNINGS_DIR 硬编码导致 Windows 零 project 段（~ 下路径不存在）。新 LEARNINGS_DIRS
//   支持 env LEARNINGS_DIRS="path1;path2" 多源，每源用各自项目名。详见 resolveLearningsDirs()。
//
// 用法：
//   node sediment.mjs --dry-run    # 只打印切分结果 + 变更判定，不写库
//   node sediment.mjs              # 增量：只重 embed 变更文件
//   node sediment.mjs --full       # 全量：清空 + 重 embed（切分逻辑/模型变更时用）
//   env LEARNINGS_DIRS="p1;p2" node sediment.mjs  # 指定 learnings 源（; 或 : 分隔）
//
// 需 LD_PRELOAD=<LIBRT_PATH>（ONNX 运行时）

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { memoryAdd, memoryStats } from "./vec_memory.mjs";

const MEMORIES_DIR = join(homedir(), ".agents", "memories");
const VEC_DB = join(homedir(), ".agents", "vector", "vec.db");
// 跨平台：sqlite-vec 原生库 Windows=vec0.dll / Linux=vec0.so；可用 VEC0_LIB env 覆盖。
const VEC0_SO = process.env.VEC0_LIB || process.env.VEC0_SO ||
  join(homedir(), ".agents", "vector", `vec0.${process.platform === "win32" ? "dll" : "so"}`);
const MANIFEST_PATH = join(homedir(), ".agents", "vector", "sediment-manifest.json");

// ---- learnings 源解析（修路径硬编码）----
// 学习沉淀目录由 env 覆盖（LEARNINGS_DIRS，; 或 : 分隔多路径）。分发包不含任何本机项目路径/代号。
// 不设置 LEARNINGS_DIRS 时，自动发现 ~/.claude/projects/*/.learnings（跨机器安全、无硬编码路径），无则跳过。
// 返回 [{dir, projName}]，projName 用于 category=project:<projName>:general。
function cleanProjName(rawName) {
  // .claude/projects 编码格式：把路径 \ : 都换成 --，如 C--Users-...-<proj>。取末段做项目名，剥残留前导 -。
  if (rawName.includes("--")) {
    const segs = rawName.split("--").filter(Boolean);
    const last = segs[segs.length - 1].replace(/^-+/, "");
    if (last && /^[a-zA-Z0-9_-]+$/.test(last)) return last;
  }
  return rawName;
}
function resolveLearningsDirs() {
  const env = process.env.LEARNINGS_DIRS;
  if (env && env.trim()) {
    return env.split(/[;:]/).map((s) => s.trim()).filter(Boolean).map((dir) => ({
      dir,
      projName: cleanProjName(basename(dirname(dir))),
    }));
  }
  const home = homedir();
  const out = [];
  // 兜底（跨平台）：仅自动发现 ~/.claude/projects/*/.learnings，无硬编码项目路径。
  const claudeProjRoot = join(home, ".claude", "projects");
  if (existsSync(claudeProjRoot)) {
    try {
      for (const sub of readdirSync(claudeProjRoot)) {
        const ld = join(claudeProjRoot, sub, ".learnings");
        if (existsSync(ld)) out.push({ dir: ld, projName: cleanProjName(sub) });
      }
    } catch {}
  }
  return out;
}
const LEARNINGS_DIRS = resolveLearningsDirs();

// ---- manifest 读写：{source: contentHash} 状态跟踪 ----
// contentHash = 文件全文 sha256 取前 16 hex（零依赖，node:crypto）。
// 为何 hash 非 mtime：mtime 不可靠（git checkout/版本控制 update 改 mtime 但内容可能未变 → 浪费重 embed；
// cp -p 保留旧 mtime 但内容已变 → 漏重 embed）。文件反正要读来切分，hash 无额外 I/O，是 ground truth。
function loadManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    // 不存在或 JSON 损坏 → 退化全量（视为首次跑），不崩
    return {};
  }
}
function saveManifest(hashes) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(hashes, null, 2));
}
function contentHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// domain 映射：文件名 → category domain 段
const DOMAIN_MAP = {
  "README": "general",
};

// 平台副标签：从内容猜（复用 vec_memory 的 _guessPlatform 逻辑，这里内联简化）
const PLATFORM_KEYWORDS = {
  spreadtrum: ["spreadtrum", "sprd", "展锐", "unisoc"],
  mtk: ["mtk", "mediatek", "联发科", "mt67", "mt68"],
  qualcomm: ["qualcomm", "qcom", "msm", "高通", "snapdragon"],
  hisilicon: ["hisilicon", "hi36", "海思"],
};
function guessPlatform(text) {
  const lower = text.toLowerCase();
  for (const [plat, kws] of Object.entries(PLATFORM_KEYWORDS)) {
    for (const kw of kws) if (lower.includes(kw.toLowerCase())) return plat;
  }
  return null;
}

// ---- 切分：按 `## 章节` 合并，跳过 frontmatter，代码块内不切 ----
// 返回 [{title, content}]。content = 章节标题 + 正文 + 代码块（一起）。
function splitBySection(text) {
  // 跳过 frontmatter（首个 --- 块）
  let body = text;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end >= 0) body = body.slice(end + 4);
  }
  const lines = body.split("\n");
  const sections = [];
  let cur = null;        // 当前 {title, lines:[]}
  let intro = [];        // 文件级 # 标题 + 引言（## 之前），prepend 到首个 ## 章节
  let inCode = false;

  for (const line of lines) {
    // 代码块配对（``` 开头切换），代码块内不识别 ## 标题
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      if (cur) cur.lines.push(line);
      else intro.push(line);
      continue;
    }
    // ## 章节标题（不在代码块内）→ 开始新段
    if (!inCode && /^##\s/.test(line) && !/^###\s/.test(line)) {
      if (cur) sections.push(cur);
      // 首个 ## 章节：把前面累积的 intro（# 标题+引言）prepend 进来，让首段含完整语义
      const introLines = intro.length ? intro : [];
      intro = [];
      cur = { title: line.replace(/^##\s+/, "").trim(), lines: [...introLines, line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      // ## 之前的内容（# 标题 + 引言）累积到 intro
      intro.push(line);
    }
  }
  // 末尾若有 cur 推入；若全文无 ##（只有 # 标题），intro 作为唯一段
  if (cur) sections.push(cur);
  else if (intro.length) sections.push({ title: "(intro)", lines: intro });

  // 组装 content + 过滤纯结构段
  return sections
    .map((s) => ({ title: s.title, content: s.lines.join("\n").trim() }))
    .filter((s) => {
      // 过滤纯结构段：
      // - L<30 且不含代码块（孤立标题/页脚/frontmatter 残片）
      // - 纯 Tags 段（标题是 Tags 且内容只有反引号标签列表，无实质语义）
      if (s.content.length < 30 && !s.content.includes("```")) return false;
      if (/^Tags/i.test(s.title) && /^`[\w-]+`([,，]?\s*`[\w-]+`)*\s*$/.test(s.content.replace(/^##\s+Tags\s*/i, "").trim())) return false;
      return true;
    });
}

// ---- learnings 切分：按 `## [LRN-/ERR-/FR-` entry ----
function splitLearnings(text) {
  const lines = text.split("\n");
  const entries = [];
  let cur = null;
  for (const line of lines) {
    if (/^##\s+\[(LRN|ERR|FR)-/.test(line)) {
      if (cur) entries.push(cur);
      cur = { id: line.match(/\[(LRN|ERR|FR)-[^\]]+\]/)?.[0] || line, lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) entries.push(cur);
  return entries
    .map((e) => ({ id: e.id, content: e.lines.join("\n").trim() }))
    .filter((e) => e.content.length >= 30);
}

// ---- 主流程 ----
const dryRun = process.argv.includes("--dry-run");
const fullRebuild = process.argv.includes("--full");

// 收集所有要沉淀的段，同时建 fileHashes（source → 内容哈希）和 currentSources 集合
const allSegments = [];
const fileHashes = {};      // source → contentHash（当前所有源文件）
const currentSources = new Set();

// 1. memories/*.md
const memFiles = readdirSync(MEMORIES_DIR).filter((f) => f.endsWith(".md"));
for (const f of memFiles) {
  const base = f.replace(/\.md$/, "");
  const domain = DOMAIN_MAP[base] || "general";
  const text = readFileSync(join(MEMORIES_DIR, f), "utf8");
  const source = `memory/${f}`;
  fileHashes[source] = contentHash(text);
  currentSources.add(source);
  const sections = splitBySection(text);
  for (const s of sections) {
    const plat = guessPlatform(s.content);
    // 分层 category：global 知识归 global:<domain>
    let category = `global:${domain}`;
    allSegments.push({ content: s.content, category, source, title: s.title });
  }
}

// 2. .learnings/*.md（多源：遍历 LEARNINGS_DIRS，每个源 {dir, projName}）
const fixedLearnFiles = ["LEARNINGS.md", "ERRORS.md", "FEATURE_REQUESTS.md"];
for (const { dir: learnDir, projName } of LEARNINGS_DIRS) {
  if (!existsSync(learnDir)) continue;
  // 扫该目录下所有 .md：固定 3 个 + 额外（vendor report 等）
  const learnFiles = [...fixedLearnFiles];
  try {
    for (const f of readdirSync(learnDir)) {
      if (f.endsWith(".md") && !learnFiles.includes(f)) learnFiles.push(f);
    }
  } catch {}
  for (const f of learnFiles) {
    const path = join(learnDir, f);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const source = `.learnings/${projName}/${f}`;
    fileHashes[source] = contentHash(text);
    currentSources.add(source);
    const entries = splitLearnings(text);
    for (const e of entries) {
      allSegments.push({
        content: e.content,
        category: `project:${projName}:general`,
        source,
        title: e.id,
      });
    }
  }
}

// ---- 增量判定：对比 manifest，区分 unchanged/changed/new/deleted ----
const manifest = loadManifest();
const changedSources = [];   // 内容变更或新增的 source（需重 embed）
const unchangedCount = {};
let newCount = 0, changedCount = 0, unchangedFileCount = 0;
for (const source of currentSources) {
  if (fullRebuild || manifest[source] !== fileHashes[source]) {
    changedSources.push(source);
    if (manifest[source] === undefined) newCount++;
    else changedCount++;
  } else {
    unchangedFileCount++;
  }
}
// manifest 里有但当前文件系统没有 → 已删除的源文件
const deletedSources = Object.keys(manifest).filter((s) => !currentSources.has(s));

// ---- dry-run：打印切分结果 + 变更判定，不写库 ----
if (dryRun) {
  console.log(`=== DRY RUN: ${allSegments.length} 段（${currentSources.size} 源文件）===\n`);
  console.log(`learnings 源（LEARNINGS_DIRS，${LEARNINGS_DIRS.length} 个）:`);
  for (const { dir, projName } of LEARNINGS_DIRS) console.log(`  ${existsSync(dir) ? "✓" : "✗(不存在)"} [${projName}] ${dir}`);
  console.log("");
  console.log(`变更判定${fullRebuild ? "（--full 强制全量）" : ""}:`);
  console.log(`  unchanged: ${unchangedFileCount} 文件（rowid 保留）`);
  console.log(`  changed:   ${changedCount} 文件（将重 embed）`);
  console.log(`  new:       ${newCount} 文件（将 embed）`);
  console.log(`  deleted:   ${deletedSources.length} 文件（将清掉旧段）`);
  if (changedSources.length) {
    console.log(`  将重 embed 的源: ${changedSources.join(", ")}`);
  }
  if (deletedSources.length) {
    console.log(`  将删除的源: ${deletedSources.join(", ")}`);
  }
  // 按 category 分组统计
  const byCat = {};
  for (const s of allSegments) byCat[s.category] = (byCat[s.category] || 0) + 1;
  console.log("\n按 category 分组:");
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}: ${n}`);
  }
  // 长度分布
  const buckets = { "<30": 0, "30-100": 0, "100-500": 0, "500-2000": 0, ">2000": 0 };
  for (const s of allSegments) {
    const L = s.content.length;
    if (L < 30) buckets["<30"]++;
    else if (L < 100) buckets["30-100"]++;
    else if (L < 500) buckets["100-500"]++;
    else if (L < 2000) buckets["500-2000"]++;
    else buckets[">2000"]++;
  }
  console.log("\n长度分布:", JSON.stringify(buckets));
  process.exit(0);
}

// ---- 执行 ----
const segmentsToEmbed = fullRebuild
  ? allSegments
  : allSegments.filter((s) => changedSources.includes(s.source));

if (fullRebuild) {
  console.log(`=== 全量重沉淀（--full）：${allSegments.length} 段，清空旧库 + 重 embed ===`);
  console.log("清空 vec_memories...");
  const cleanDb = new DatabaseSync(VEC_DB, { allowExtension: true });
  cleanDb.enableLoadExtension(true);
  cleanDb.loadExtension(VEC0_SO);
  cleanDb.enableLoadExtension(false);
  cleanDb.exec("DELETE FROM vec_memories");
  cleanDb.close();
  console.log("已清空");
} else if (changedSources.length === 0 && deletedSources.length === 0) {
  console.log(`=== 增量沉淀：无变更（${allSegments.length} 段，${currentSources.size} 源文件全部 unchanged）===`);
  console.log("nothing to do, rowid 全部保留");
  saveManifest(fileHashes);
  const st = await memoryStats();
  console.log(`当前：${st.count} 段`);
  process.exit(0);
} else {
  console.log(`=== 增量沉淀：${changedSources.length} 文件变更（${segmentsToEmbed.length} 段重 embed）+ ${deletedSources.length} 文件删除 ===`);
  // 用独立连接删变更/删除文件的旧段（运维脚本有此权限；memoryDelete 按 source 删不暴露给工具层）
  const cleanDb = new DatabaseSync(VEC_DB, { allowExtension: true });
  cleanDb.enableLoadExtension(true);
  cleanDb.loadExtension(VEC0_SO);
  cleanDb.enableLoadExtension(false);
  const delStmt = cleanDb.prepare("DELETE FROM vec_memories WHERE source = ?");
  for (const source of [...changedSources, ...deletedSources]) {
    const r = delStmt.run(source);
    if (r.changes) console.log(`  清除 ${source} 旧段 ${r.changes} 条`);
  }
  cleanDb.close();
}

if (segmentsToEmbed.length > 0) {
  console.log("重 embed 中...");
  let count = 0;
  for (const s of segmentsToEmbed) {
    process.stdout.write(`\r  ${count + 1}/${segmentsToEmbed.length}`);
    await memoryAdd({ content: s.content, category: s.category, source: s.source });
    count++;
  }
  console.log("\n");
}

// 写 manifest（只含当前 source，已删的自动剔除；--full 也重写以反映最新哈希）
saveManifest(fileHashes);

const st = await memoryStats();
console.log(`完成：${st.count} 段`);
console.log("新分布:");
for (const c of st.categories) console.log(`  ${c.category}: ${c.n}`);
