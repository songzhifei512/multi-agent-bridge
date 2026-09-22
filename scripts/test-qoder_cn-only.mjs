// 单独验证 qoder_cn：验证 SDK env 剥除是否生效
import { runAgent } from '../bridge/mcp/run-driver.mjs';
import { loadMem } from '../bridge/mcp/state-store.mjs';
import { cleanProcessEnv } from '../bridge/mcp/agents-registry.mjs';

// Sanity: 检查当前 process.env 是否被污染
const polluted = Object.keys(process.env).filter(k => k.startsWith('QODER_AGENT_SDK_'));
console.log('污染键:', polluted);
const cleaned = Object.keys(cleanProcessEnv()).filter(k => k.startsWith('QODER_AGENT_SDK_'));
console.log('cleanProcessEnv 后残留:', cleaned);

async function waitForTask(taskId, maxMs = 90000) {
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

const r = runAgent('qoder_cn', { prompt: '只回复：PONG。绝对不要其它内容。', timeout_sec: 60, max_retries: 0 });
const taskId = r && r.task_id;
console.log(`dispatched task_id=${taskId}`);
const t = await waitForTask(taskId, 90000);
console.log(`status=${t?.status} exit=${t?.exit_code}`);
console.log(`result head: ${(t?.result || '').slice(0, 300).replace(/\n/g, '\n')}`);
