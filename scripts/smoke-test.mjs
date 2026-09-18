// 压测脚本：对 multi-agent-bridge MCP server 做多次工具调用压测
// 用法：node scripts/smoke-test.mjs
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SERVER = resolve("bridge/mcp/shared-context-server.mjs");
const proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
let pending = new Map();
let seq = 0;

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

async function run() {
  await call("initialize", {});
  console.log("[OK] initialize");

  // 压测 5 轮共享记忆读写
  let pass = 0, fail = 0;
  for (let i = 0; i < 5; i++) {
    const k = `perf_${i}`;
    await call("tools/call", { name: "shared_memory_set", arguments: { key: k, value: "x".repeat(100) } });
    const got = await call("tools/call", { name: "shared_memory_get", arguments: { key: k } });
    if (got.result.content[0].text.length === 100) pass++; else fail++;
  }
  console.log(`[压测] shared_memory SET/GET: ${pass} 通过, ${fail} 失败`);

  // 压测任务队列
  for (let i = 0; i < 5; i++) {
    const created = await call("tools/call", { name: "task_create", arguments: { title: `压测任务${i}` } });
    console.log(`  创建: ${created.result.content[0].text}`);
  }

  // 压测共享笔记
  await call("tools/call", { name: "shared_notes_append", arguments: { note: "smoke test note", tag: "smoke" } });
  const notes = await call("tools/call", { name: "shared_notes_read", arguments: { tag: "smoke" } });
  console.log(`[压测] shared_notes 读写成功，读取长度: ${notes.result.content[0].text.length}`);

  // 汇总
  console.log("==== 压测完成 ====");
  proc.kill();
}

run().catch((e) => { console.error(e); process.exit(1); });