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
  --fab-shadow:0 2px 8px rgba(79,70,229,.2);
  --fab-shadow-hover:0 4px 16px rgba(79,70,229,.3);
  --dag-node-fill:#ffffff; --dag-edge:#c0c4d0;
  --dag-text-done:#9ca0ad; --dag-text-active:#1a1a2e;
  --toast-bg:rgba(22,163,74,.1); --toast-border:rgba(22,163,74,.3); --toast-color:#16a34a;
  --arch:#b45309; --restore:#15803d;
  --arch-border:rgba(180,83,9,.5); --arch-bg:rgba(180,83,9,.1);
  --restore-border:rgba(21,128,61,.5); --restore-bg:rgba(21,128,61,.1);
  color-scheme:light;
}
.ma-root[data-theme="eye-care"]{
  --bg:#e8f2e8; --card:#f0f7f0; --hover:#e0efe0;
  --border:#b8d0b8; --border2:#a0c4a0;
  --txt:#2d4a2d; --mut:#5a7a5a; --dim:#8aaa8a;
  --acc:#2e7d32; --ok:#3d8b40; --run:#2e7d9c; --pend:#b8860b; --warn:#c47b1f; --warn-border:rgba(196,123,31,.45); --err:#c0392b;
  --overlay-bg:rgba(45,74,45,.3);
  --shadow-panel:0 1px 3px rgba(46,125,50,.08), 0 0 0 1px rgba(46,125,50,.04) inset;
  --fab-shadow:0 2px 8px rgba(46,125,50,.2);
  --fab-shadow-hover:0 4px 16px rgba(46,125,50,.3);
  --dag-node-fill:#f0f7f0; --dag-edge:#a0c4a0;
  --dag-text-done:#8aaa8a; --dag-text-active:#2d4a2d;
  --toast-bg:rgba(61,139,64,.1); --toast-border:rgba(61,139,64,.3); --toast-color:#2e7d32;
  --arch:#b8860b; --restore:#3d8b40;
  --arch-border:rgba(184,134,11,.5); --arch-bg:rgba(184,134,11,.1);
  --restore-border:rgba(61,139,64,.5); --restore-bg:rgba(61,139,64,.1);
  color-scheme:light;
}
.ma-root[data-theme="sepia"]{
  --bg:#f5eddc; --card:#faf6ed; --hover:#f0e8d8;
  --border:#d8c9a8; --border2:#c8b890;
  --txt:#5c4a2a; --mut:#8b7355; --dim:#b8a67e;
  --acc:#8b5a2b; --ok:#6b8e23; --run:#4682b4; --pend:#c49a3a; --warn:#c0702a; --warn-border:rgba(192,112,42,.45); --err:#a0522d;
  --overlay-bg:rgba(92,74,42,.3);
  --shadow-panel:0 1px 3px rgba(139,90,43,.08), 0 0 0 1px rgba(139,90,43,.04) inset;
  --fab-shadow:0 2px 8px rgba(139,90,43,.2);
  --fab-shadow-hover:0 4px 16px rgba(139,90,43,.3);
  --dag-node-fill:#faf6ed; --dag-edge:#c8b890;
  --dag-text-done:#b8a67e; --dag-text-active:#5c4a2a;
  --toast-bg:rgba(107,142,35,.1); --toast-border:rgba(107,142,35,.3); --toast-color:#6b8e23;
  --arch:#c49a3a; --restore:#6b8e23;
  --arch-border:rgba(196,154,58,.5); --arch-bg:rgba(196,154,58,.1);
  --restore-border:rgba(107,142,35,.5); --restore-bg:rgba(107,142,35,.1);
  color-scheme:light;
}
.ma-root[data-theme="high-contrast"]{
  --bg:#000000; --card:#0a0a0a; --hover:#1a1a1a;
  --border:#ffffff; --border2:#cccccc;
  --txt:#ffffff; --mut:#cccccc; --dim:#999999;
  --acc:#ffff00; --ok:#00ff00; --run:#00bfff; --pend:#ffff00; --warn:#ffa500; --warn-border:rgba(255,165,0,.6); --err:#ff4444;
  --overlay-bg:rgba(0,0,0,.7);
  --shadow-panel:0 0 60px rgba(255,255,0,.08), 0 0 0 1px rgba(255,255,255,.1) inset;
  --fab-shadow:0 4px 16px rgba(255,255,0,.4);
  --fab-shadow-hover:0 6px 24px rgba(255,255,0,.55);
  --dag-node-fill:#0a0a0a; --dag-edge:#cccccc;
  --dag-text-done:#999999; --dag-text-active:#ffffff;
  --toast-bg:rgba(0,255,0,.15); --toast-border:rgba(0,255,0,.4); --toast-color:#00ff00;
  --arch:#ffff00; --restore:#00ff00;
  --arch-border:rgba(255,255,0,.5); --arch-bg:rgba(255,255,0,.13);
  --restore-border:rgba(0,255,0,.5); --restore-bg:rgba(0,255,0,.13);
  color-scheme:dark;
}
.ma-root[data-theme="mono"]{
  --bg:#e8e8e8; --card:#f0f0f0; --hover:#e0e0e0;
  --border:#cccccc; --border2:#bbbbbb;
  --txt:#333333; --mut:#666666; --dim:#999999;
  --acc:#666666; --ok:#555555; --run:#777777; --pend:#999999; --warn:#8a6d3b; --warn-border:rgba(138,109,59,.5); --err:#333333;
  --overlay-bg:rgba(51,51,51,.3);
  --shadow-panel:0 1px 3px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.04) inset;
  --fab-shadow:0 2px 8px rgba(102,102,102,.2);
  --fab-shadow-hover:0 4px 16px rgba(102,102,102,.3);
  --dag-node-fill:#f0f0f0; --dag-edge:#bbbbbb;
  --dag-text-done:#999999; --dag-text-active:#333333;
  --toast-bg:rgba(85,85,85,.1); --toast-border:rgba(85,85,85,.3); --toast-color:#555555;
  --arch:#999999; --restore:#555555;
  --arch-border:rgba(153,153,153,.5); --arch-bg:rgba(153,153,153,.1);
  --restore-border:rgba(85,85,85,.5); --restore-bg:rgba(85,85,85,.1);
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
.ma-prog-wrap{position:relative;padding:4px 0;margin:0 12px 4px;cursor:default}
.ma-prog-tip{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:4px;background:var(--txt);color:var(--bg);font-size:10px;padding:4px 8px;border-radius:4px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .15s;z-index:5}
.ma-prog-wrap:hover .ma-prog-tip{opacity:1}
.ma-prog-tip::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:4px solid transparent;border-top-color:var(--txt)}

.ma-task{display:flex;flex-direction:column;gap:0;border-radius:var(--radius-sm);font-size:11px;transition:background .15s;border:1px solid transparent}
.ma-task:hover{background:var(--hover)}
.ma-task.stale{border-color:rgba(245,158,11,.45)}
.ma-task-head{display:flex;align-items:center;gap:6px;padding:5px 6px;cursor:pointer;min-width:0}
.ma-task-icon{width:14px;height:14px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px;flex-shrink:0;border:1.5px solid transparent;transition:background .3s, border-color .3s}
.ma-task-icon.completed{background:var(--ok);color:#fff;border-color:var(--ok)}
.ma-task-icon.running{background:var(--run);border-color:var(--run);box-shadow:0 0 4px rgba(59,130,246,.4)}
.ma-task-icon.pending{background:transparent;border-color:var(--pend)}
.ma-task-icon.failed{background:var(--err);color:#fff;border-color:var(--err)}
.ma-task-icon.waiting{background:transparent;border-color:var(--dim)}
.ma-task-tid{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;font-weight:500;color:var(--dim);width:20px;flex-shrink:0}
.ma-task-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.ma-task-title.done{color:var(--mut)}
.ma-task-who{font-size:10px;color:var(--dim);white-space:nowrap;flex-shrink:0}

.ma-dag-toggle{font-size:10px;color:var(--mut);cursor:pointer;padding:4px 12px;user-select:none;transition:color .15s}
.ma-dag-toggle:hover{color:var(--txt)}
.ma-dag-icon-btn{appearance:none;border:1px solid var(--border2);background:var(--bg);color:var(--dim);font-size:12px;border-radius:6px;padding:2px 6px;cursor:pointer;flex-shrink:0;transition:all .15s;line-height:1}
.ma-dag-icon-btn:hover{color:var(--txt);border-color:var(--acc)}
.ma-dag-icon-btn.active{color:var(--acc);border-color:var(--acc)}
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
.ma-dispatch-btn{appearance:none;border:none;border-radius:8px;background:var(--acc);color:#fff;font-size:12px;font-weight:600;padding:8px 14px;cursor:pointer;width:100%;transition:background .15s, transform .1s}
.ma-dispatch-btn:hover{filter:brightness(1.1)}
.ma-dispatch-btn:active{transform:scale(.97);filter:brightness(.95)}
.ma-dispatch-btn:disabled{background:var(--border2);color:#6b7280;cursor:not-allowed;border:1px solid var(--border2);filter:none;transform:none}
.ma-toast{position:absolute;top:12px;left:12px;right:12px;z-index:40;background:var(--toast-bg);border:1px solid var(--toast-border);color:var(--toast-color);border-radius:var(--radius-sm);padding:8px 12px;font-size:11px;display:flex;align-items:center;gap:6px;transform:translateY(-120%);opacity:0;transition:transform .25s ease-out, opacity .25s}
.ma-toast.show{transform:translateY(0);opacity:1}

.ma-section{font-size:10px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;padding:8px 4px 4px}
.ma-empty{color:var(--dim);font-size:12px;padding:8px 0;text-align:center}
.ma-body{flex:1;overflow-y:auto;padding:0 12px 56px;position:relative}


/* ── Markdown 结果样式 ── */
.md-result{position:relative;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;font-size:11px;line-height:1.6;max-height:100px;overflow:hidden;color:var(--txt);transition:max-height .3s ease}
.md-result.expanded{max-height:240px;overflow-y:auto}
.md-result.has-more::after{content:'';position:absolute;left:0;right:0;bottom:0;height:40px;background:linear-gradient(to bottom, transparent, var(--bg));pointer-events:none;transition:opacity .3s}
.md-result.expanded.has-more::after{opacity:0}
.md-expand-btn{position:absolute;bottom:6px;right:8px;z-index:2;appearance:none;border:1px solid var(--border2);background:var(--card);color:var(--mut);font-size:10px;border-radius:999px;padding:1px 8px;cursor:pointer;transition:color .15s, border-color .15s}
.md-expand-btn:hover{color:var(--txt);border-color:var(--acc)}
.md-copy-btn{position:absolute;top:6px;right:6px;z-index:2;appearance:none;border:1px solid var(--border2);background:var(--card);color:var(--txt);font-size:10px;font-weight:600;border-radius:999px;padding:2px 10px;cursor:pointer;opacity:0;transition:opacity .15s}
.md-result:hover + .md-copy-btn, .md-copy-wrap:hover .md-copy-btn{opacity:1}
.md-result .md-p{margin:0 0 8px}
.md-result .md-h1{font-size:14px;font-weight:600;margin:12px 0 6px;border-bottom:1px solid var(--border);padding-bottom:4px}
.md-result .md-h2{font-size:13px;font-weight:600;margin:10px 0 5px}
.md-result .md-h3{font-size:12px;font-weight:600;margin:8px 0 4px}
.md-result .md-h4{font-size:11px;font-weight:600;margin:6px 0 3px}
.md-result .md-ul,.md-result .md-ol{margin:0 0 8px;padding-left:16px}
.md-result .md-li{margin:2px 0}
.md-result .md-pre{background:var(--card);border:1px solid var(--border2);border-radius:4px;padding:6px 8px;margin:6px 0;overflow-x:auto;font-size:10px}
.md-result .md-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:1.5}
.md-result .md-p .md-code{background:var(--card);padding:1px 5px;border-radius:3px;border:1px solid var(--border)}
.md-result .md-quote{border-left:3px solid var(--acc);padding-left:8px;margin:6px 0;color:var(--mut);font-style:italic}
.md-result .md-hr{border:none;border-top:1px solid var(--border);margin:8px 0}
.md-result a{color:var(--acc);text-decoration:none}
.md-result a:hover{text-decoration:underline}
.md-result .md-table{width:100%;border-collapse:collapse;margin:6px 0;font-size:10px}
.md-result .md-table th,.md-result .md-table td{border:1px solid var(--border);padding:4px 6px;text-align:left}
.md-result .md-table th{background:var(--card);font-weight:600}
.md-result .md-thead{}
.md-result .md-tbody{}
.md-result .md-tr{}
.md-result .md-th{}
.md-result .md-td{}

/* ── 归档 / 恢复 ── */
.ma-wf-arch{appearance:none;border:1px solid var(--border2);background:var(--bg);color:var(--dim);font-size:10px;border-radius:999px;padding:1px 8px;cursor:pointer;flex-shrink:0;transition:all .15s}
.ma-wf-arch:hover{color:#fbbf24;border-color:rgba(245,158,11,.5);background:rgba(245,158,11,.14)}
.ma-restore{appearance:none;border:1px solid var(--border2);background:var(--bg);color:var(--dim);font-size:10px;border-radius:999px;padding:1px 8px;cursor:pointer;flex-shrink:0;transition:all .15s}
.ma-restore:hover{color:var(--ok);border-color:rgba(34,197,94,.5);background:rgba(34,197,94,.12)}
.ma-wf-arch-line{padding:6px 12px;display:flex;align-items:center;gap:7px;border:1px dashed var(--border2);border-radius:var(--radius-sm);margin-bottom:6px;background:var(--card)}
.ma-wf-arch-line .ma-wf-name{font-size:11px}
.ma-arch-section{font-size:10px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;padding:8px 4px 4px;cursor:pointer;user-select:none;display:flex;align-items:center;gap:4px}
.ma-arch-section .ma-arch-chev{font-size:10px;transition:transform .2s;display:inline-block}
.ma-arch-section.collapsed .ma-arch-chev{transform:rotate(-90deg)}
.ma-arch-list{overflow:hidden;max-height:1000px;transition:max-height .3s ease-out}
.ma-arch-list.collapsed{max-height:0}

/* ── 任务展开详情 + 生命周期时间线 ── */
.ma-task-body{padding:2px 8px 8px;border-top:1px dashed var(--border);margin:0 4px;display:flex;flex-direction:column;gap:6px}
.ma-kv{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:10px;color:var(--mut)}
.ma-kv b{color:var(--txt);font-weight:600}
.ma-log{display:flex;flex-direction:column;gap:2px;font-size:10px;color:var(--mut)}
.ma-log-row{display:flex;gap:6px;align-items:baseline}
.ma-log-t{color:var(--dim);font-family:ui-monospace,Consolas,monospace;font-size:9px;flex-shrink:0}
.ma-pre{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 8px;font-size:10px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow-y:auto;color:var(--txt);margin:0}
.ma-hb-ok{color:var(--ok)} .ma-hb-stale{color:#fbbf24}
@keyframes dashBreathe{0%,100%{stroke-width:2;opacity:1}50%{stroke-width:3.2;opacity:.55}}

/* ── DAG 边着色(ok/fail/wait) ── */
.ma-dag-edge.ok{stroke:var(--ok)} .ma-dag-edge.fail{stroke:var(--err)} .ma-dag-edge.wait{stroke:var(--dag-edge);stroke-dasharray:4 3;opacity:.6}

/* ── DAG 节点心跳停滞预警(running 且 heartbeat 超 90s → 琥珀呼吸) ── */
.ma-dag-node.stale{stroke:#f59e0b;stroke-width:2;animation:dashBreathe 1.6s ease-in-out infinite}

/* ── 主题下拉菜单 ── */
.ma-theme-dropdown{position:relative;flex-shrink:0}
.ma-theme-btn{appearance:none;border:1px solid var(--border2);background:var(--card);color:var(--txt);font-size:13px;line-height:1;border-radius:6px;padding:3px 7px;cursor:pointer;display:flex;align-items:center;gap:4px;transition:border-color .15s}
.ma-theme-btn:hover{border-color:var(--acc)}
.ma-theme-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:100;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:4px;min-width:140px;box-shadow:0 4px 12px rgba(0,0,0,.15);opacity:0;pointer-events:none;transform:translateY(-4px);transition:opacity .15s, transform .15s}
.ma-theme-menu.open{opacity:1;pointer-events:auto;transform:translateY(0)}
.ma-theme-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--txt);transition:background .1s}
.ma-theme-item:hover{background:var(--hover)}
.ma-theme-item.active{background:var(--hover);color:var(--acc)}
.ma-theme-item .ma-theme-icon{font-size:14px;width:16px;text-align:center}
.ma-theme-item .ma-theme-label{flex:1}
.ma-theme-group{font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;padding:6px 8px 2px}
`;

let injected = false;
export function injectStyles(container?: HTMLElement) {
  if (injected || typeof document === 'undefined') return;
  const el = document.createElement('style');
  el.setAttribute('data-ma-panel', '');
  el.textContent = CSS;
  // 优先插入容器内部（Qoder CN webview 可能限制 document.head 写入）
  if (container && container.parentNode) {
    container.insertBefore(el, container.firstChild);
  } else {
    document.head.appendChild(el);
  }
  injected = true;
}
