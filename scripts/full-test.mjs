// 完整功能压测脚本：遍历多 Agent 桥接核心工具
// 用法：node scripts/full-test.mjs
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SERVER = resolve("bridge/mcp/shared-context-server.mjs");
const proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
let pending = new Map();
let seq = 0;
let pass = 0, fail = 0;

proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function call(method, params) {
  return new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// 记录结果，然后继续
async function t(name, fn) {
  try {
    const r = await fn();
    const ok = r && !r.error && !(r.result && r.result.isError);
    if (ok) { pass++; console.log(`[PASS] ${name}`); }
    else { fail++; console.log(`[FAIL] ${name}: ${JSON.stringify(r).slice(0,120)}`); }
  } catch (e) {
    fail++; console.log(`[FAIL] ${name}: ${e.message}`);
  }
}

async function run() {
  await call("initialize", {});

  // 1. 共享记忆
  await t("shared_memory_set", () => call("tools/call", { name: "shared_memory_set", arguments: { key: "full", value: "v" } }));
  await t("shared_memory_get", () => call("tools/call", { name: "shared_memory_get", arguments: { key: "full" } }));
  await t("shared_memory_list", () => call("tools/call", { name: "shared_memory_list", arguments: {} }));

  // 2. 共享笔记
  await t("shared_notes_append", () => call("tools/call", { name: "shared_notes_append", arguments: { note: "full test", tag: "full" } }));
  await t("shared_notes_read", () => call("tools/call", { name: "shared_notes_read", arguments: { tag: "full" } }));

  // 3. 任务生命周期：create -> claim -> complete
  const created = await call("tools/call", { name: "task_create", arguments: { title: "full test" } });
  const taskText = created?.result?.content?.[0]?.text;
  const taskId = taskText?.match(/task-[\w-]+/)?.[0];
  await t("task_create", () => created);
  if (taskId) {
    await t("task_claim", () => call("tools/call", { name: "task_claim", arguments: { task_id: taskId } }));
    await t("task_complete", () => call("tools/call", { name: "task_complete", arguments: { task_id: taskId, result: "done" } }));
  } else {
    console.log(`[SKIP] task_claim/complete (无 task_id)`);
  }
  await t("task_list", () => call("tools/call", { name: "task_list", arguments: {} }));

  // 4. 工作流编排
  await t("workflow_start", () => call("tools/call", { name: "workflow_start", arguments: { workflow_id: "w-1", title: "full test wf", stages: [{ title: "s1", th: 60 }] } }));

  console.log(`\n==== 完整压测：${pass} 通过, ${fail} 失败 ====`);
  proc.kill();
}

run().catch((e) => { console.error(e); process.exit(1); });