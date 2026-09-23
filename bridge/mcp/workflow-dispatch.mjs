// workflow-dispatch.mjs — workflow stage 自动派发逻辑（独立模块，避免 run-driver ↔ shared-context-server 循环依赖）
//
// 2026-09-23 修：把 autoDispatchWorkflowStages 从 shared-context-server.mjs 抽出，
//   让 run-driver.mjs（worker 完成 hook）和 shared-context-server.mjs（workflow_start hook）都能 import。
//
// 调用方：
//   - shared-context-server.mjs workflow_start 三个 return 前调一次（首段自动派发）
//   - shared-context-server.mjs task_list / task_complete handler 内调一次（dep 满足即派发）
//   - run-driver.mjs worker 跑完 status=completed 后调一次（收敛/中段 task dep 刚满足触发）

import { loadMem, BRIDGE_WORK_ROOT } from "./state-store.mjs";
import { AGENTS } from "./agents-registry.mjs";
import { runAgent } from "./run-driver.mjs";

/**
 * 扫一遍指定 workflow 中所有"assigned_to 存在 + 依赖已满足 + 不需审批"的 pending task，
 * 给它们 spawn worker。fire-and-forget。
 *
 * workdir 默认走 workflow.workdir（workflow_start({workdir:"..."}) 时可指定），
 * 否则 fallback BRIDGE_WORK_ROOT。
 *
 * @param {string} wfId
 * @returns {{ dispatched: number, skipped: number }}
 */
export function autoDispatchWorkflowStages(wfId) {
  const mem = loadMem();
  const wf = mem.workflows?.[wfId];
  if (!wf) return { dispatched: 0, skipped: 0 };
  const wfWorkdir = wf.workdir || BRIDGE_WORK_ROOT;
  const tasks = Object.values(mem.tasks || {}).filter((t) =>
    t?.workflow?.id === wfId &&
    t?.assigned_to && AGENTS[t.assigned_to] &&
    t?.status === "pending" &&
    !(t?.require_approval && t?.approved_at !== true)
  );
  let dispatched = 0, skipped = 0;
  for (const t of tasks) {
    const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
    const depsAllDone = deps.every((dId) => {
      const dt = mem.tasks[dId];
      return dt && (dt.status === "completed" || dt.status === "failed" || dt.status === "superseded");
    });
    if (!depsAllDone) { skipped++; continue; }
    // 2026-09-23 fix：prompt 必须含「任务上下文 + 上下游 + 工具能力 + 输出格式」4 件套，
    //   否则 worker 子会话会因缺上下文停在"请补充信息"。原 prompt 只说"你是阶段执行者" +
    //   任务描述，worker 不知道自己在哪个工作流 / 上游是谁 / 输出往哪写 / 该用什么工具。
    const wfStep = t.workflow?.step ?? "?";
    const wfSeq = t.workflow?.seq ?? "?";
    const wfTotal = Array.isArray(wf.stages) ? wf.stages.length : "?";
    const upstreamIds = Array.isArray(t.dependencies) ? t.dependencies : [];
    const upstreamHint = upstreamIds.length
      ? `\n【上游产物】本 task 依赖：${upstreamIds.join(", ")}（已完成，其 result 在 task.result，可通过 memory_search / shared_memory_get 召回）`
      : `\n【上游产物】无 dep，本 task 是工作流首段。`;
    const prompt = [
      `【角色】你是工作流「${wf.title || wfId}」的第 ${wfSeq} / ${wfTotal} 阶段执行者（task=${t.id}）。`,
      `\n【任务描述】`,
      `${t.description || t.title}`,
      `\n${upstreamHint}`,
      `\n【工作目录】`,
      `- 你的 spawn cwd 默认在 sandbox 隔离目录，看不到主仓库文件。`,
      `- 主仓库授权 workdir：${wfWorkdir}`,
      `- **读取主仓库文件用 worker_* 工具**（bridge 主控代理，会读后返回结果给你）：`,
      `  • worker_read_file(file_path, workdir="...")  读单个文件`,
      `  • worker_list_dir(path, workdir="...")  列目录`,
      `  • worker_glob(pattern, workdir="...")  按 glob 找文件`,
      `  • worker_grep(pattern, glob, workdir="...")  按正则搜文件内容`,
      `- worker_* 工具的 workdir 参数必须传 ${wfWorkdir}（不是 sandbox 路径）`,
      `- **不要**尝试 cd 或 ls 主仓库路径，sandbox 不让你直接看`,
      `\n【输出格式】`,
      `- 纯文本 / Markdown 报告，结论先行`,
      `- 报告末尾必须含「下一步建议」或「产物路径」让主控可观测`,
      `- 不要发无关问题、不要问主控补充信息——所有上下文都在上面`,
      `\n【约束】`,
      `- 不修改主仓库文件（除非 task 明确要求）`,
      `- 不调用 git add / git commit（主控统一 commit）`,
      `- 只读不写；需要写文件就在 sandbox 目录写`,
    ].join("\n");
    const args = {
      task_id: t.id,
      prompt,
      workflow_meta: t.workflow,
      workflow_step: t.workflow?.step,
      workflow_title: wf.title,
      workflow_id: wfId,
      workdir: t.workdir || wfWorkdir,
      // 2026-09-23 fix：auto=true 让 worker 拿到真写盘 + bypass sandbox（codex 必须，
      //   否则 sandbox=read-only 直接拒读；其他 worker hasAuto=true 也会按各自规范生效）
      auto: true,
      timeout_sec: 600,
    };
    try {
      runAgent(t.assigned_to, args);
      dispatched++;
    } catch (e) {
      skipped++;
    }
  }
  return { dispatched, skipped };
}