// vec_memory.mjs — 向量记忆层（路线 B：Node + ONNX + sqlite-vec + MiniLM-L6-v2）
//
// 封装文本嵌入（onnxruntime-node 跑 MiniLM ONNX）+ sqlite-vec 向量检索，供
// shared-context-server.mjs 的 memory_search / memory_add 工具懒加载调用。
//
// 环境约束：
//  - onnxruntime-node 需 LD_PRELOAD 定制 librt，否则 __clock_nanosleep 符号未定义。
//    bridge 启动脚本（codex config.toml / claude.json env）必须带
//    LD_PRELOAD=<LIBRT_PATH>
//  - 用 node:sqlite（内置）加载 vec0.so，不依赖 better-sqlite3。
//  - BERT WordPiece 分词器手写，从 tokenizer.json 加载 30522 词表。
//
// 懒加载：模块加载时不初始化 ONNX/sqlite，首次 memory_search/memory_add 才建会话，
// 避免无向量调用时占内存 + 拖慢 server 启动。
//
// 说明：分发包将私有 SoC/项目代号从平台词典与示例中剔除（用公共厂商分类 + <PROJECT>
// 占位替代），公共厂商（spreadtrum/unisoc/展锐/mtk/qualcomm/hisilicon）保留。

import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 路径（可被 env 覆盖，便于测试/换模型）----
// 跨平台：sqlite-vec 原生库在 Linux 是 vec0.so，Windows 是 vec0.dll。
// 默认按 process.platform 选扩展名；可用 VEC0_LIB env 显式覆盖（兼容旧 VEC0_SO）。
const VECTOR_DIR = process.env.VECTOR_DIR || join(homedir(), ".agents", "vector");
// 默认用多语言模型（paraphrase-multilingual-MiniLM-L12-v2，中文检索显著优于英文 MiniLM）。
// 英文原版 MiniLM 仍保留在 model/，可用 VECTOR_MODEL/VECTOR_TOK 指回降级。
const MODEL_PATH = process.env.VECTOR_MODEL || join(VECTOR_DIR, "model-multilingual", "model_quantized.onnx");
const TOK_PATH = process.env.VECTOR_TOK || join(VECTOR_DIR, "model-multilingual", "tokenizer.json");
const VEC0_LIB = process.env.VEC0_LIB || process.env.VEC0_SO ||
  join(VECTOR_DIR, `vec0.${process.platform === "win32" ? "dll" : "so"}`);
const DB_PATH = process.env.VECTOR_DB || join(VECTOR_DIR, "vec.db");
const EMBED_DIM = 384; // 模型输出维度（MiniLM-L6-v2 / paraphrase-multilingual-MiniLM-L12-v2 均 384）

// ---- 作用域分层（10）：单库 + 分层 category 实现项目隔离与平台共性复用 ----
// category 命名：<scope>:<domain> 或 <scope>:<platform>:<domain>
//   scope = global | platform:<name> | project:<name>
// 检索时按 scope 展开成允许的 category 前缀集合，前缀匹配过滤（逻辑隔离）。
//
// 平台关键词词典：从内容猜平台副标签。初始覆盖常见平台，后续按实际项目扩充。
// 只含【公共厂商分类器】；如需扩展，可在自有分支的 PLATFORM_KEYWORDS 里追加关键词。
const PLATFORM_KEYWORDS = {
  spreadtrum: ["spreadtrum", "sprd", "uis", "展锐", "unisoc"],
  mtk:        ["mtk", "mediatek", "联发科", "mt67", "mt68"],
  qualcomm:   ["qualcomm", "qcom", "msm", "sm8", "sm7", "sm6", "高通", "snapdragon"],
  hisilicon:  ["hisilicon", "hi36", "hi37", "海思"],
};
function _guessPlatform(text) {
  const lower = (text || "").toLowerCase();
  for (const [plat, kws] of Object.entries(PLATFORM_KEYWORDS)) {
    for (const kw of kws) if (lower.includes(kw.toLowerCase())) return plat;
  }
  return null;
}

// 从 cwd 推断当前 project name（取工作副本最后一段目录名）。
// cwd 不在已知工作副本根下 → 返回 null（归 global）。
// 工作副本根约定：~/work/ 下的子目录。可被 VECTOR_WORK_ROOT env 覆盖。
const WORK_ROOT = process.env.VECTOR_WORK_ROOT || join(homedir(), "work");
function _inferProjectName(cwd) {
  if (!cwd) return null;
  const abs = resolve(cwd);
  const root = resolve(WORK_ROOT);
  if (!abs.startsWith(root + "/") && abs !== root) return null;
  // 取 root 下第一段作 project name（如 work/<PROJECT>/ → <PROJECT>，取最后一段更直观）
  const rel = abs.slice(root.length + 1);
  const segs = rel.split("/");
  return segs.length ? segs[segs.length - 1] : null;
}

// ---- 懒加载单例 ----
let _ort = null, _sess = null, _tok = null, _db = null, _initError = null;

// ---- BERT WordPiece 分词器（从 tokenizer.json 加载）----
// special token id 从 added_tokens 优先读取（多语言模型把 <s>/</s>/<pad>/<unk>/<mask>
// 放在 added_tokens，不并入 model.vocab），退化到从 vocab 查 [CLS]/[SEP]/[PAD]/[UNK]。
// vocab 兼容两种形状：
//   经典 BERT（MiniLM）：  {token: id}
//   句法分词多语言（mBert/XLM-R 导出）： {KEY_STRING: [piece, magnitude]}，id=KEY_STRING 数值
// 统一归一化成 {piece: id} 再查询。
class BertTokenizer {
  constructor(jsonPath) {
    const t = JSON.parse(readFileSync(jsonPath, "utf8"));
    this.maxLen = 512;
    const raw = t.model.vocab;
    this.vocab = {};
    for (const k of Object.keys(raw)) {
      const val = raw[k];
      const piece = Array.isArray(val) ? val[0] : k;
      const id = Array.isArray(val) ? parseInt(k, 10) : val;
      // 保持不可见关键词的原文（XLM-R 的 ▁ 表示词边界），不与 added specials 冲突
      this.vocab[piece] = Number.isFinite(id) ? id : null;
    }
    const specials = { cls: ["<s>","[CLS]"], sep: ["</s>","[SEP]"], pad: ["<pad>","[PAD]"], unk: ["<unk>","[UNK]"] };
    const added = new Map((t.added_tokens || []).map((a) => [a.content, a.id]));
    const pick = (names) => { for (const n of names) { if (added.has(n)) return added.get(n); if (this.vocab[n] !== undefined && this.vocab[n] !== null) return this.vocab[n]; } return null; };
    this.clsId = pick(specials.cls);
    this.sepId = pick(specials.sep);
    this.padId = pick(specials.pad);
    this.unkId = pick(specials.unk);
  }
  _clean(text) {
    text = text.toLowerCase();
    let out = "";
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === 0 || cp === 0xfffd || cp < 32 || cp === 0x7f) continue;
      if (cp >= 0x4e00 && cp <= 0x9fff) out += " " + ch + " "; // CJK 两边加空格
      else out += ch;
    }
    return out;
  }
  _isPunct(ch) {
    const cp = ch.codePointAt(0);
    return (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) ||
           (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126) ||
           (cp >= 0x2000 && cp <= 0x206f) || (cp >= 0x2e00 && cp <= 0x2e7f);
  }
  _isWs(ch) { return /[\s ]/.test(ch) || ch.codePointAt(0) === 0; }
  _split(text) {
    const tokens = [];
    let cur = "";
    for (const ch of text) {
      if (this._isWs(ch)) { if (cur) { tokens.push(cur); cur = ""; } }
      else if (this._isPunct(ch)) { if (cur) { tokens.push(cur); cur = ""; } tokens.push(ch); }
      else cur += ch;
    }
    if (cur) tokens.push(cur);
    return tokens;
  }
  _wordpiece(word) {
    if (word.length > 100) return [this.unkId];
    const chars = [...word];
    let tokens = [], start = 0;
    while (start < chars.length) {
      let end = chars.length, found = null;
      while (start < end) {
        let sub = chars.slice(start, end).join("");
        if (start > 0) sub = "##" + sub;
        if (this.vocab[sub] !== undefined) { found = sub; break; }
        end--;
      }
      if (!found) return [this.unkId];
      tokens.push(this.vocab[found]);
      start = end;
    }
    return tokens;
  }
  encode(text, maxLen = 128) {
    maxLen = Math.min(maxLen, this.maxLen - 2);
    const words = this._split(this._clean(text));
    let ids = [];
    for (const w of words) {
      if (ids.length >= maxLen) break;
      ids.push(...this._wordpiece(w));
    }
    ids = ids.slice(0, maxLen);
    const inputIds = [this.clsId, ...ids, this.sepId];
    return {
      input_ids: inputIds,
      attention_mask: inputIds.map(() => 1),
      token_type_ids: inputIds.map(() => 0),
    };
  }
}

// ---- 启动自愈 doctor（A1：防被异源覆盖/损坏后丢数据，与 Plugin/agent-shared-memory 版同步）----
// 检测 vec.db 是否存在且为合规 SQLite 库：新库→交 _init 建；非 SQLite / 损坏 / 被异源文件顶名
// → 备份改名成 <db>.doctor-bak-<ts> 后重建，绝不静默覆盖已有向量数据。
function _doctorDb() {
  if (!existsSync(DB_PATH)) return;            // 全新库，交 _init 建
  let buf = null;
  try { buf = readFileSync(DB_PATH); } catch { buf = null; } // 读失败=非 sqlite/损坏
  // SQLite 库 magic = 前16字节 "SQLite format 3\x00"
  const isSqlite = !!buf && buf.length >= 16 &&
    buf.subarray(0, 16).equals(Buffer.from("SQLite format 3\x00"));
  if (isSqlite) return;                        // 合法库，交给 _init（CREATE IF NOT EXISTS）
  const bak = `${DB_PATH}.doctor-bak-${Date.now()}`;
  try {
    renameSync(DB_PATH, bak);
    console.warn(`[doctor] vec.db 非 SQLite/异源/损坏, 备份改名 ${basename(bak)}, 重建新库`);
  } catch (e) {
    console.warn(`[doctor] 备份改名失败(${e.message}), 转复制备份`);
    try {
      writeFileSync(bak, readFileSync(DB_PATH));
      rmSync(DB_PATH, { force: true });
      console.warn(`[doctor] 已复制备份 ${basename(bak)} 并移除坏库`);
    } catch (e2) { console.warn(`[doctor] 坏库清理失败: ${e2.message}`); }
  }
}

// ---- 初始化（懒加载，首次调用触发）----
async function _init() {
  if (_initError) throw _initError;
  if (_sess) return;
  try {
    _doctorDb(); // A1: 打开前自愈，杜绝被覆盖的坏库静默吞数据
    // onnxruntime-node 动态 import（避免无向量调用时强加载 native）
    _ort = (await import("onnxruntime-node")).default;
    _tok = new BertTokenizer(TOK_PATH);
    _sess = await _ort.InferenceSession.create(MODEL_PATH);
    // sqlite + vec0 扩展（node:sqlite 22.5+ 才内置；懒加载，避免 Node20 顶层静态 import 直接 ERR_UNKNOWN_BUILTIN_MODULE）
    const { DatabaseSync } = await import("node:sqlite");
    _db = new DatabaseSync(DB_PATH, { allowExtension: true });
    _db.enableLoadExtension(true);
    _db.loadExtension(VEC0_LIB);
    _db.enableLoadExtension(false);
    _db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      embedding FLOAT[${EMBED_DIM}], content TEXT, category TEXT, source TEXT, created_at TEXT)`);
    // ---- 跨进程写锁归属（ 加固，2026-08-21）----
    // vec.db 被 bridge(memory_add/memory_search) 与 DSH(mcp-shared-memory) 多进程并发读写。
    // 开启 WAL + busy_timeout，让 SQLite 自身串行化写者、读者不被写者阻塞；相比 memory.json 的
    // O_EXCL 应用层锁，这里是「借 SQLite WAL 收敛跨仓竞争」的归属方案。WAL 伴生文件(*-wal/shm)
    // 不影响 _fetchScribe/doctor 对主库 SQLite magic 的判定。
    _db.exec("PRAGMA journal_mode=WAL");
    _db.exec("PRAGMA busy_timeout=5000");
  } catch (e) {
    _initError = new Error(`vec_memory init failed: ${e.message}`);
    throw _initError;
  }
}

// ---- 文本 → 384 维归一化向量（mean pooling + L2）----
async function _embedInternal(text) {
  await _init();
  const enc = _tok.encode(text, 128);
  const len = enc.input_ids.length;
  const feeds = {
    input_ids: new _ort.Tensor("int64", BigInt64Array.from(enc.input_ids.map(BigInt)), [1, len]),
    attention_mask: new _ort.Tensor("int64", BigInt64Array.from(enc.attention_mask.map(BigInt)), [1, len]),
    token_type_ids: new _ort.Tensor("int64", BigInt64Array.from(enc.token_type_ids.map(BigInt)), [1, len]),
  };
  const out = await _sess.run(feeds);
  const hidden = out.last_hidden_state.data;
  const vec = new Float32Array(EMBED_DIM);
  let count = 0;
  for (let i = 0; i < len; i++) {
    if (enc.attention_mask[i] === 0) continue;
    for (let d = 0; d < EMBED_DIM; d++) vec[d] += hidden[i * EMBED_DIM + d];
    count++;
  }
  let norm = 0;
  for (let d = 0; d < EMBED_DIM; d++) { vec[d] /= count; norm += vec[d] * vec[d]; }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < EMBED_DIM; d++) vec[d] /= norm;
  return vec;
}

// ---- memory_add：写入记忆（带嵌入）----
// content: 记忆正文
// category: 分类（若已是分层名 "scope:domain" 直接用；否则按 scope+platform 构造）
// source: 来源（agent 名/文件名）
// scope: 写入作用域 — "global" | "project:<name>" | 缺省则从 cwd 推断 project
// cwd: 调用方工作目录（用于推断 project name；MCP server 自身 cwd 固定，须由调用方传入）
// 返回 {id, dims, category}。id 用 rowid。
export async function memoryAdd({ content, category = null, source = "unknown", scope = null, cwd = null }) {
  await _init();
  const vec = await _embedInternal(content);
  // 构造分层 category：调用方传了完整分层名直接用；否则按 scope 推断
  let cat = category;
  if (!cat) {
    let s = scope;
    if (!s) {
      const proj = _inferProjectName(cwd);
      s = proj ? `project:${proj}` : "global";
    }
    const plat = _guessPlatform(content);
    // project 作用域且猜出平台 → project:<name>:<platform>:general（平台副标签便于第二步提级）
    // global 作用域且猜出平台 → global:<platform>:general
    // 无平台 → <scope>:general
    cat = plat ? `${s}:${plat}:general` : `${s}:general`;
  }
  const ins = _db.prepare(
    `INSERT INTO vec_memories(embedding, content, category, source, created_at) VALUES (?, ?, ?, ?, ?)`
  );
  // created_at 存 ISO 字符串（vec0 元数据列用 INTEGER 会报 float 绑定错，TEXT 最稳）
  const now = new Date().toISOString();
  ins.run(Buffer.from(vec.buffer), content, cat, source, now);
  const id = _db.prepare("SELECT last_insert_rowid() AS id").get().id;
  return { id, dims: EMBED_DIM, category: cat };
}

// ---- memory_search：语义检索 ----
// query: 查询文本
// top_k: 返回条数（默认 5）
// category: 可选类别过滤（精确匹配，向后兼容）
// scope: 检索作用域 — "global" | "project:<name>" | 缺省则从 cwd 推断
//   传 scope 时按"当前 project + 猜出 platform + global"展开允许前缀集合，前缀匹配过滤
// cwd: 调用方工作目录（推断 project name）
// min_length: 可选，过滤掉 content 长度 < min_length 的段（默认 0=不过滤）。
//   兜底用：重沉淀后短结构段已少，但调用方可传如 40 进一步过滤稀薄段。
// 返回 [{content, category, source, distance}]，按距离升序。
export async function memorySearch({ query, top_k = 5, category = null, scope = null, cwd = null, min_length = 0 }) {
  await _init();
  const vec = await _embedInternal(query);
  const k = Math.min(Math.max(1, top_k | 0), 50);
  const minLen = Math.max(0, min_length | 0);
  const vecBuf = Buffer.from(vec.buffer);
  const knn = _db.prepare(
    `SELECT content, category, source, distance FROM vec_memories
     WHERE embedding MATCH ? AND k = ? ORDER BY distance`
  );

  // 分组 KNN + 保底配额：每层 scope 至少占 ceil(k/n) 条，保证项目知识不被 global 短段挤掉。
  // 解决"短中文 global 段落虚高相似度挤掉相关 project learnings"——纯 distance 排序下
  // global 短段永远赢；保底配额让 project/platform 知识必有代表。
  let groups;
  if (category) {
    groups = [{ filter: (r) => r.category === category, label: category }];
  } else {
    const prefixes = _expandScope(scope, query, cwd);
    groups = prefixes.map((p) => ({ filter: (r) => r.category.startsWith(p), label: p }));
  }
  // min_length 过滤叠加到每组 filter（兜底过滤短结构段）
  if (minLen > 0) {
    groups = groups.map((g) => ({ filter: (r) => g.filter(r) && r.content.length >= minLen, label: g.label }));
  }

  const nGroups = groups.length;
  const quota = Math.max(1, Math.ceil(k / nGroups)); // 每组保底
  // KNN 取全表足够大的候选池（库小，取 50 近乎全扫），确保各 scope 层的条目都进得来
  // —— 否则短中文 global 段虚高相似度占满小候选池，project learnings 进不了。
  const knnK = Math.max(k * 3, 50);
  const perGroup = groups.map((g) => {
    const rows = knn.all(vecBuf, knnK).filter(g.filter).slice(0, k);
    return rows;
  });

  // 去重（同一条可能命中多组，如 project:X:platform:general 同时匹配 project:X: 和 platform:）
  const seen = new Set();
  // 第 1 轮：每组取保底 quota 条
  const result = [];
  for (const rows of perGroup) {
    let taken = 0;
    for (const r of rows) {
      const key = r.content + r.category;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(r);
      if (++taken >= quota) break;
    }
  }
  // 第 2 轮：剩余按 distance 全局排序补满 k
  const remaining = [];
  for (const rows of perGroup) {
    for (const r of rows) {
      const key = r.content + r.category;
      if (!seen.has(key)) remaining.push(r);
    }
  }
  remaining.sort((a, b) => a.distance - b.distance);
  for (const r of remaining) {
    if (result.length >= k) break;
    seen.add(r.content + r.category);
    result.push(r);
  }
  result.sort((a, b) => a.distance - b.distance);
  return result.slice(0, k);
}

// ---- memory_list：列记忆（不返回向量，省传输；memory_list 工具）----
// category: 精确匹配（向后兼容 memory_search 的 category 语义）；为空则列全部。
// category_prefix: 前缀匹配（如 "project:<PROJECT>:" 列某项目全部）。
//   二者互斥：都传以 category 精确为准。
// limit/offset: 分页（默认 50，上限 200，避免一次拉爆调用方上下文）。
// 返回 [{id, category, source, created_at, content_preview}]，content 截前 120 字。
export async function memoryList({ category = null, category_prefix = null, limit = 50, offset = 0 }) {
  await _init();
  const lim = Math.min(Math.max(1, limit | 0), 200);
  const off = Math.max(0, offset | 0);
  let rows;
  if (category) {
    rows = _db
      .prepare(`SELECT rowid AS id, category, source, created_at, content FROM vec_memories WHERE category = ? ORDER BY id LIMIT ? OFFSET ?`)
      .all(category, lim, off);
  } else if (category_prefix) {
    rows = _db
      .prepare(`SELECT rowid AS id, category, source, created_at, content FROM vec_memories WHERE category LIKE ? ORDER BY id LIMIT ? OFFSET ?`)
      .all(category_prefix + "%", lim, off);
  } else {
    rows = _db
      .prepare(`SELECT rowid AS id, category, source, created_at, content FROM vec_memories ORDER BY id LIMIT ? OFFSET ?`)
      .all(lim, off);
  }
  return rows.map((r) => ({
    id: r.id, category: r.category, source: r.source,
    created_at: r.created_at, content_preview: r.content.slice(0, 120),
  }));
}

// ---- memory_delete：删记忆（memory_delete 工具）----
// 三种模式互斥，优先级 id > category > category_prefix：
//   id: 按 rowid 单删（最安全，精确清掉某条）。
//   category: 按 category 精确删（删该 category 下全部）。
//   category_prefix: 按前缀批量删（如 "test:" 清测试条目，或迁移后清旧项目）。
// 返回 {deleted, mode}。无匹配 → deleted=0（幂等，非错误）。
// 安全：三选一分支挡住无 WHERE 的全表 DELETE——不传任何参数 → mode=noop, deleted=0。
export async function memoryDelete({ id = null, category = null, category_prefix = null }) {
  await _init();
  if (id != null) {
    const r = _db.prepare(`DELETE FROM vec_memories WHERE rowid = ?`).run(id);
    return { deleted: r.changes, mode: "id" };
  }
  if (category) {
    const r = _db.prepare(`DELETE FROM vec_memories WHERE category = ?`).run(category);
    return { deleted: r.changes, mode: "category" };
  }
  if (category_prefix) {
    const r = _db.prepare(`DELETE FROM vec_memories WHERE category LIKE ?`).run(category_prefix + "%");
    return { deleted: r.changes, mode: "category_prefix" };
  }
  return { deleted: 0, mode: "noop" };
}

// ---- memory_promote：手动提级记忆 category（memory_promote 工具）----
// usage-based promotion 的手动版：Agent/用户判断某条 project 记忆其实是跨项目共性知识，
// 手动把它的 category 改成更宽的 scope（project:X → platform:Y 或 global），下次检索按新 scope 走。
// 为何手动：自动 promotion 需 memory_hits 表 + 真实检索数据积累，当前零 project 段刚补上、
// 无跨项目命中数据；手动工具立即满足"让共性知识跨项目复用"的需求，零误提级风险。
//
// 参数：
//   id (必需): 要提级的记忆 rowid（用 memory_list 查到）
//   to_scope (必需): 目标作用域 — "global" | "platform:<name>" | "project:<name>"
//     platform:<name> 的 <name> 可填 "auto"（按 content 猜平台，猜不出回退 global）
//   dry_run (可选，默认 true): 只报告将提级到什么 category，不真改。安全第一——先 dry_run 看预览再确认。
// 返回 {id, old_category, new_category, promoted, dry_run}。
//   promoted=false 的情况：id 不存在、to_scope 非法、新旧 category 相同（无需提级）。
export async function memoryPromote({ id, to_scope, dry_run = true }) {
  await _init();
  if (id == null) return { id: null, old_category: null, new_category: null, promoted: false, dry_run, error: "id required" };
  if (!to_scope) return { id, old_category: null, new_category: null, promoted: false, dry_run, error: "to_scope required" };

  const row = _db.prepare(`SELECT rowid, category, content FROM vec_memories WHERE rowid = ?`).get(id);
  if (!row) return { id, old_category: null, new_category: null, promoted: false, dry_run, error: "id not found" };

  const oldCat = row.category;

  // 构造新 category
  let newCat;
  if (to_scope === "global") {
    newCat = "global:general";
  } else if (to_scope.startsWith("platform:")) {
    let plat = to_scope.slice("platform:".length);
    if (plat === "auto" || !plat) {
      plat = _guessPlatform(row.content) || ""; // 猜不出 → 回退 global
    }
    newCat = plat ? `platform:${plat}:general` : "global:general";
  } else if (to_scope.startsWith("project:")) {
    const proj = to_scope.slice("project:".length);
    newCat = proj ? `project:${proj}:general` : null;
  } else {
    return { id, old_category: oldCat, new_category: null, promoted: false, dry_run, error: `to_scope must be 'global' | 'platform:<name>' | 'project:<name>'` };
  }
  if (!newCat) return { id, old_category: oldCat, new_category: null, promoted: false, dry_run, error: "invalid to_scope" };

  // 新旧相同 → 无需提级
  if (newCat === oldCat) return { id, old_category: oldCat, new_category: newCat, promoted: false, dry_run, note: "already at target category" };

  if (!dry_run) {
    _db.prepare(`UPDATE vec_memories SET category = ? WHERE rowid = ?`).run(newCat, id);
  }
  return { id, old_category: oldCat, new_category: newCat, promoted: !dry_run, dry_run };
}

// 把检索 scope 展开成允许的 category 前缀集合。
// scope="project:X" → ["global:", "platform:<猜>:", "project:X:"]
// scope="global" 或无 → ["global:"]（只搜全局，不串扰其它项目）
// scope 已是 "platform:X" → ["global:", "platform:X:"]
//
// 平台推断三路（零配置自动发现项目所属平台）：
//   1) 查询词内容猜（_guessPlatform）—— 查询含"展锐"/"mtk" 等平台关键词时直接命中
//   2) 该 project 下已有记忆的 platform 副标签（扫 category 去重）
//      —— 项目下存过 spreadtrum 标签知识 → 此项目属 spreadtrum → platform:spreadtrum: 纳入搜索
//   3) 该 project 下已有记忆的【内容】猜平台
//      —— 项目记忆 category 多为 project:X:general（无平台副标签），但内容常提平台
//      （实测某项目 54 段中 39 段提 spreadtrum）。仅靠 category 副标签（路径2）
//      永远发现不了平台，须扫内容。按多数/计数阈值取主平台，避免单段误提。
function _expandScope(scope, query, cwd) {
  const plats = new Set();
  const p1 = _guessPlatform(query);
  if (p1) plats.add(p1);

  let proj = null;
  if (scope && scope.startsWith("project:")) proj = scope.slice("project:".length);
  else if (!scope) { const p = _inferProjectName(cwd); if (p) proj = p; }

  // 路径2 + 路径3：扫该项目已有记忆，从 category 副标签 AND 内容猜平台
  if (proj && _db) {
    try {
      const rows = _db.prepare(
        `SELECT content, category FROM vec_memories WHERE category LIKE ?`
      ).all(`project:${proj}:%`);
      // 路径2：category 副标签（project:X:<platform>:general → 第3段）
      const platCounts = {}; // 平台 → 命中段数（路径2 + 路径3 合并计）
      for (const r of rows) {
        const segs = r.category.split(":");
        if (segs.length >= 3 && segs[2] && PLATFORM_KEYWORDS[segs[2]]) {
          platCounts[segs[2]] = (platCounts[segs[2]] || 0) + 1;
        }
        // 路径3：内容猜平台（项目记忆内容常提平台，category 副标签却为 general）
        const cp = _guessPlatform(r.content);
        if (cp) platCounts[cp] = (platCounts[cp] || 0) + 1;
      }
      // 阈值：平台需有 ≥2 段支持 且 ≥ 该项目记忆总数的 20%，取命中最多的平台。
      // 避免单段误提（如一段偶然提 mtk 不该把整个项目归 mtk）。
      const total = rows.length;
      let best = null, bestN = 0;
      for (const [pl, n] of Object.entries(platCounts)) {
        if (n >= 2 && n >= Math.ceil(total * 0.2) && n > bestN) { best = pl; bestN = n; }
      }
      if (best) plats.add(best);
    } catch {}
  }

  const prefixes = ["global:"];
  for (const pl of plats) prefixes.push(`platform:${pl}:`);
  if (proj) prefixes.push(`project:${proj}:`);
  return prefixes;
}

// ---- 统计（诊断用，memory_stats 工具）----
// 返回总段数 + 按 category 分组计数 + 维度 + 模型路径。分组计数让调用方一眼看清
// 作用域分层分布（global vs platform vs project 各多少），不用手开 sqlite。
export async function memoryStats() {
  await _init();
  if (!_db) return { initialized: false };
  const c = _db.prepare("SELECT count(*) AS c FROM vec_memories").get();
  const cats = _db
    .prepare("SELECT category, count(*) AS n FROM vec_memories GROUP BY category ORDER BY n DESC")
    .all();
  return { initialized: true, count: c.c, dim: EMBED_DIM, model: MODEL_PATH, categories: cats };
}

// ---- 文本→向量（测试/诊断用）----
export function _embed(text) {
  return _embedInternal(text);
}

// ---- 关闭（测试用）----
export function _close() {
  try { if (_db) _db.close(); } catch {}
  _db = null; _sess = null; _ort = null; _tok = null; _initError = null;
}