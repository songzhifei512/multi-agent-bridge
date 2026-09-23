const CSS = `
.ma-root{
  /* 暗色主题（默认） */
  --bg:#0a0a0f; --card:#12121a; --hover:#1a1a26;
  --border:#1e1e2e; --border2:#2a2a3e;
  --txt:#e4e4ed; --mut:#8b8b9e; --dim:#7d7d94;
  --acc:#6366f1; --ok:#22c55e; --run:#3b82f6; --pend:#eab308; --warn:#f59e0b; --warn-border:rgba(245,158,11,.45); --err:#ef4444;
  --overlay-bg:rgba(5,5,10,.7);
  --shadow-panel:0 0 60px rgba(99,102,241,.06), 0 0 0 1px rgba(255,255,255,.03) inset;
  --fab-shadow:0 4px 16px rgba(99,102,241,.35);
  --fab-shadow-hover:0 6px 24px rgba(99,102,241,.5);
  --dag-node-fill:#12121a; --dag-edge:#44445a;
  --dag-text-done:#6b6b80; --dag-text-active:#e4e4ed;
  --toast-bg:rgba(34,197,94,.12); --toast-border:rgba(34,197,94,.3); --toast-color:#86efac;
  --arch:#fbbf24; --restore:#86efac;
  --arch-border:rgba(245,158,11,.5); --arch-bg:rgba(245,158,11,.13);
  --restore-border:rgba(34,197,94,.5); --restore-bg:rgba(34,197,94,.13);
  --radius:10px; --radius-sm:6px;
  color-scheme:dark;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  background:var(--bg); color:var(--txt);
  height:100%; display:flex; flex-direction:column; font-size:13px; line-height:1.45;
  position:relative; /* FAB/遮罩/Toast 的锚定层（悬浮件挂在 root 而非滚动 body） */
  transition:background .3s, color .3s;
}
.ma-root[data-theme="light"]{
  --bg:#f5f6fa; --card:#ffffff; --hover:#eef0f5;
  --border:#e2e4ea; --border2:#d0d3dc;
  --txt:#1a1a2e; --mut:#6b7080; --dim:#9ca0ad;
  --acc:#4f46e5; --ok:#16a34a; --run:#2563eb; --pend:#ca8a04; --warn:#d97706; --warn-border:rgba(217,119,6,.45); --err:#dc2626;
  --overlay-bg:rgba(0,0,0,.3);
  --shadow-panel:0 1px 3px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.04) inset;
  --fab-shadow:0 4px 12px rgba(79,70,229,.25);
  --fab-shadow-hover:0 6px 20px rgba(79,70,229,.35);
  --dag-node-fill:#ffffff; --dag-edge:#c0c4d0;
  --dag-text-done:#9ca0ad; --dag-text-active:#1a1a2e;
  --toast-bg:rgba(22,163,74,.1); --toast-border:rgba(22,163,74,.3); --toast-color:#16a34a;
  --arch:#b45309; --restore:#15803d;
  --arch-border:rgba(180,83,9,.5); --arch-bg:rgba(180,83,9,.1);
  --restore-border:rgba(21,128,61,.5); --restore-bg:rgba(21,128,61,.1);
  color-scheme:light;
}

.ma-root *{box-sizing:border-box}
.ma-root ::-webkit-scrollbar{width:6px;height:6px}
.ma-root ::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}
.ma-root ::-webkit-scrollbar-track{background:transparent}

.ma-header{position:sticky;top:0;z-index:10;background:var(--bg);padding:14px 14px 10px;border-bottom:1px solid var(--border);transition:background .3s, border-color .3s}
.ma-header-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.ma-header-title{font-size:13px;font-weight:600;flex:1}
.ma-ctrl{font-size:10px;color:var(--mut);background:var(--card);border:1px solid var(--border);border-radius:999px;padding:2px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%;transition:background .3s, border-color .3s, color .3s}
.ma-conn{width:7px;height:7px;border-radius:50%;background:var(--dim);flex-shrink:0;transition:background .3s}
.ma-conn.on{background:var(--ok);box-shadow:0 0 6px var(--ok)}
.ma-stats-row{display:flex;gap:5px;flex-wrap:wrap}
.ma-stat{display:flex;align-items:baseline;gap:4px;padding:2px 8px;border-radius:999px;background:var(--card);border:1px solid var(--border);font-size:10px;color:var(--mut);transition:background .3s, border-color .3s, color .3s}
.ma-stat b{font-size:12px;font-weight:600}
.ma-stat.run b{color:var(--run)} .ma-stat.pend b{color:var(--pend)} .ma-stat.ok b{color:var(--ok)} .ma-stat.err b{color:var(--err)}

.ma-wf{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);overflow:hidden;margin-bottom:8px;transition:background .3s, border-color .3s}
.ma-wf-head{display:flex;align-items:center;gap:7px;padding:10px 12px;cursor:pointer;user-select:none;transition:background .15s}
.ma-wf-head:hover{background:var(--hover)}
.ma-wf-dot{width:7px;height:7px;border-radius:50%;background:var(--dim);flex-shrink:0;transition:background .3s}
.ma-wf-dot.running{background:var(--run);box-shadow:0 0 5px var(--run)}
.ma-wf-dot.completed{background:var(--ok)} .ma-wf-dot.failed{background:var(--err)}
.ma-wf-name{font-size:12px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-wf-dots{display:flex;gap:3px;flex-shrink:0}
.ma-wf-dots i{width:6px;height:6px;border-radius:50%;display:block}
.ma-wf-count{font-size:10px;color:var(--mut);white-space:nowrap;flex-shrink:0}
.ma-wf-chev{font-size:10px;color:var(--dim);flex-shrink:0;transition:color .3s}
.ma-wf-done-line{padding:7px 12px}
.ma-wf-done-line .ma-wf-head{padding:6px 12px}
.ma-prog{display:flex;height:2px;margin:0 12px 8px;border-radius:1px;overflow:hidden;background:var(--border)}
.ma-prog i{display:block;height:100%;transition:width .3s}
.ma-prog i.ok{background:var(--ok)} .ma-prog i.run{background:var(--run)}
.ma-prog i.pend{background:var(--pend)} .ma-prog i.err{background:var(--err)}

.ma-task{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:var(--radius-sm);font-size:11px;transition:background .15s}
.ma-task:hover{background:var(--hover)}
.ma-task-icon{width:14px;height:14px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px;flex-shrink:0;border:1.5px solid transparent;transition:background .3s, border-color .3s}
.ma-task-icon.completed{background:var(--ok);color:#fff;border-color:var(--ok)}
.ma-task-icon.running{background:var(--run);border-color:var(--run);box-shadow:0 0 4px rgba(59,130,246,.4)}
.ma-task-icon.pending{background:transparent;border-color:var(--pend)}
.ma-task-icon.failed{background:var(--err);color:#fff;border-color:var(--err)}
.ma-task-icon.waiting{background:transparent;border-color:var(--dim)}
.ma-task-tid{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;font-weight:600;color:var(--acc);width:20px;flex-shrink:0}
.ma-task-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-task-title.done{color:var(--mut)}
.ma-task-who{font-size:10px;color:var(--dim);white-space:nowrap;flex-shrink:0}

.ma-dag-toggle{font-size:10px;color:var(--mut);cursor:pointer;padding:4px 12px;user-select:none;transition:color .15s}
.ma-dag-toggle:hover{color:var(--txt)}
.ma-dag-wrap{overflow:hidden;max-height:0;transition:max-height .25s ease-out}
.ma-dag-wrap.open{max-height:400px}
.ma-dag-inner{overflow-x:auto;border-top:1px solid var(--border);background:var(--bg);padding:8px;transition:background .3s, border-color .3s}
svg.ma-dag{display:block}
.ma-dag-edge{stroke:var(--dag-edge);stroke-width:1.5;fill:none;opacity:.75}
.ma-dag-node{fill:var(--dag-node-fill);stroke:var(--dag-edge);stroke-width:1.5}
.ma-dag-node.stk-running{stroke:var(--run)} .ma-dag-node.stk-completed{stroke:var(--ok)}
.ma-dag-node.stk-failed{stroke:var(--err)} .ma-dag-node.stk-pending{stroke:var(--pend)}
.ma-dag-node.stk-awaiting_approval,.ma-dag-node.stk-escalating{stroke:var(--pend)}
.ma-dag-node.stk-superseded,.ma-dag-node.stk-cancelled,.ma-dag-node.stk-interrupted{stroke:var(--dim)}
.ma-dag-txt{fill:var(--txt);font-size:9px}
.ma-dag-txt.tid{fill:var(--acc);font-weight:700}
.ma-dag-evolve{fill:var(--pend);font-size:8px}

.ma-fab{position:absolute;bottom:16px;right:16px;width:40px;height:40px;border-radius:50%;background:var(--acc);color:#fff;border:none;font-size:20px;font-weight:300;cursor:pointer;z-index:20;box-shadow:var(--fab-shadow);transition:transform .15s, box-shadow .3s, background .3s}
.ma-fab:hover{transform:scale(1.08);box-shadow:var(--fab-shadow-hover)}
.ma-fab:active{transform:scale(.95)}
.ma-overlay-mask{position:absolute;inset:0;background:var(--overlay-bg);backdrop-filter:blur(4px);z-index:25;opacity:0;pointer-events:none;transition:opacity .25s}
.ma-overlay-mask.open{opacity:1;pointer-events:auto}
.ma-dispatch{position:absolute;bottom:0;left:0;right:0;z-index:30;background:var(--card);border-top:1px solid var(--border);border-radius:12px 12px 0 0;padding:14px;display:flex;flex-direction:column;gap:8px;transform:translateY(100%);transition:transform .25s ease-out, background .3s, border-color .3s}
.ma-dispatch.open{transform:translateY(0)}
.ma-dispatch-head{display:flex;align-items:center;justify-content:space-between}
.ma-dispatch-head h4{margin:0;font-size:12px;font-weight:600}
.ma-dispatch-close{background:none;border:none;color:var(--mut);font-size:16px;cursor:pointer;padding:0 4px}
.ma-dispatch-close:hover{color:var(--txt)}
.ma-dispatch select,.ma-dispatch textarea{background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius-sm);color:var(--txt);padding:7px 9px;font-size:12px;font-family:inherit;outline:none;width:100%;transition:background .3s, border-color .3s, color .3s}
.ma-dispatch select:focus,.ma-dispatch textarea:focus{border-color:var(--acc)}
.ma-dispatch textarea{resize:vertical;min-height:72px}
.ma-dispatch label{font-size:10px;color:var(--mut);display:flex;flex-direction:column;gap:4px}
.ma-dispatch-btn{appearance:none;border:none;border-radius:8px;background:var(--acc);color:#fff;font-size:12px;font-weight:600;padding:8px 14px;cursor:pointer;width:100%;transition:background .3s}
.ma-dispatch-btn:hover{filter:brightness(1.1)}
.ma-dispatch-btn:disabled{background:var(--border2);color:var(--mut);cursor:not-allowed}
.ma-toast{position:absolute;top:12px;left:12px;right:12px;z-index:40;background:var(--toast-bg);border:1px solid var(--toast-border);color:var(--toast-color);border-radius:var(--radius-sm);padding:8px 12px;font-size:11px;display:flex;align-items:center;gap:6px;transform:translateY(-120%);opacity:0;transition:transform .25s ease-out, opacity .25s}
.ma-toast.show{transform:translateY(0);opacity:1}

.ma-section{font-size:10px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;padding:8px 4px 4px}
.ma-empty{color:var(--dim);font-size:12px;padding:8px 0;text-align:center}
.ma-body{flex:1;overflow-y:auto;padding:0 12px 56px;position:relative}
`;

let injected = false;
export function injectStyles() {
  if (injected || typeof document === 'undefined') return;
  const el = document.createElement('style');
  el.setAttribute('data-ma-panel', '');
  el.textContent = CSS;
  document.head.appendChild(el);
  injected = true;
}
