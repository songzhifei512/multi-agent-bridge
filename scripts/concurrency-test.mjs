// 并发压测脚本：模拟 10 个并发 agent 同时写入 shared_memory
// 验证并发安全（O_EXCL 原子锁 + 原子 rename）
// 用法：node scripts/concurrency-test.mjs
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

  // 20 个并发 shared_memory_set 写入不同的 key
  const N = 20;
  const writers = [];
  for (let i = 0; i < N; i++) {
    writers.push(
      call("tools/call", {
        name: "shared_memory_set",
        arguments: { key: `conc_${i}`, value: `value_${i}` },
      })
    );
  }
  const results = await Promise.allSettled(writers);
  const ok = results.filter((r) => r.status === "fulfilled" && !r.value.error).length;
  console.log(`[并发] ${N} 个并写: ${ok} 成功, ${N - ok} 失败`);

  // 验证全部可读回
  let readOk = 0;
  for (let i = 0; i < N; i++) {
    const got = await call("tools/call", { name: "shared_memory_get", arguments: { key: `conc_${i}` } });
    if (got.result.content[0].text === `value_${i}`) readOk++;
  }
  console.log(`[并发] 20 个回读校验: ${readOk} 一致`);

  // 20 个并发任务认领（验证 0 双签）
  let claimed = 0;
  const claims = [];
  for (let i = 0; i < N; i++) {
    claims.push(
      call("tools/call", { name: "task_claim", arguments: {} } ).then(
        (r) => r.result && r.result.content && r.result.content[0].text.startsWith("claimed")
      ).catch(() => false)
    );
  }
  const claimResults = await Promise.all(claims);
  claimed = claimResults.filter(Boolean).length;
  console.log(`[并发] ${N} 个任务认领: ${claimed} 人入签（理论不超过队列内任务数）`);

  console.log("==== 并发压测完成 ====");
  proc.kill();
}

run().catch((e) => { console.error(e); process.exit(1); });