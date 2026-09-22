// 4-worker dispatch validation (2026-09-23 v1.0.1+ 修复验证)
// 派发简短中文 prompt 给 5 个 worker（claude/codex/opencode/dsh/qoder_cn），
// 验证：1) auto-probe gate 不误杀；2) envStrip 不报「Not logged in」；3) 占位符
// 模型不传时不报「unexpected argument」；4) 孤儿回收器对死 pid 能立即标 failed。
import { runAgent } from '../bridge/mcp/run-driver.mjs';
import { loadMem } from '../bridge/mcp/state-store.mjs';

async function waitForTask(taskId, maxMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const m = loadMem();
    const t = m.tasks[taskId];
    if (t && (t.status === 'completed' || t.status === 'failed' || t.status === 'interrupted' || t.status === 'superseded')) {
      return t;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return loadMem().tasks[taskId] || null;
}

const prompt = '只回复：PONG。绝对不要其它内容。';
const workers = ['claude', 'codex', 'opencode', 'dsh', 'qoder_cn'];
const summary = [];

for (const name of workers) {
  console.log(`\n=== dispatching to ${name} ===`);
  const start = Date.now();
  try {
    const r = runAgent(name, { prompt, timeout_sec: 90, max_retries: 0 });
    const text = r && r.content && r.content[0] && r.content[0].text;
    const taskId = r && r.task_id;
    console.log(`  dispatched in ${Date.now()-start}ms, task_id=${taskId || '?'}`);
    if (taskId) {
      const t = await waitForTask(taskId, 120000);
      if (t) {
        console.log(`  status=${t.status} exit=${t.exit_code} dur=${Date.now()-start}ms`);
        const resultHead = (t.result || '').slice(0, 100).replace(/\n/g, '\n');
        console.log(`  result head: ${resultHead}`);
        summary.push({ name, status: t.status, exit: t.exit_code, dur: Date.now()-start });
      } else {
        console.log(`  timeout waiting for terminal state`);
        summary.push({ name, status: 'TIMEOUT', dur: Date.now()-start });
      }
    } else {
      console.log(`  no task_id, text: ${text?.slice(0, 200)}`);
      summary.push({ name, status: 'NO_TASK_ID', dur: Date.now()-start });
    }
  } catch (e) {
    console.log(`  ${name}: error:`, e.message);
    summary.push({ name, status: 'ERROR', err: e.message });
  }
}

console.log('\n=== summary ===');
for (const r of summary) console.log(' ', JSON.stringify(r));
