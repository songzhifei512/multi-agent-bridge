# SDD ledger — plan: docs/superpowers/plans/2026-09-21-ui-optimization.md

## Pre-flight scan

| Pair | Produces | Consumes | Finding |
|------|----------|----------|---------|
| T1 → T2-7 | CSS classes (`ma-header`, `ma-wf`, `ma-task`, etc.) | className strings in components | ✅ All class names in component code match CSS definitions in T1 |
| T3 → T5 | `<TaskRow step shortId isBlocked />` | WorkflowCard imports TaskRow | ✅ Props match: step (Step), shortId (string), isBlocked (boolean) |
| T4 → T5 | `<InlineDag dag shorts />` | WorkflowCard imports InlineDag | ✅ Props match: dag (Dag), shorts (Map<string,string>) |
| T2 → T7 | `<StickyHeader stat connected controller controllerLabel />` | index.tsx imports StickyHeader | ✅ Props match |
| T5 → T7 | `<WorkflowCard wf memberLabel isActive />` | index.tsx imports WorkflowCard | ✅ Props match |
| T6 → T7 | `<FAB onClick />`, `<DispatchOverlay workers open onClose onDispatch onDispatched />`, `<Toast message onDone />` | index.tsx imports all three | ✅ Props match |
| T7 → T8 | New index.tsx (no old imports) | Deletes old component files | ✅ T7 removes old imports before T8 deletes files |

Internal consistency:
- T3 Step interface (step, id, status, claimed_by, assigned_to) matches T5's Step interface ✅
- T4 Dag interface matches T5's Dag interface ✅
- T6 onDispatch signature `(worker: string, prompt: string) => Promise<string | undefined>` matches T7's handleDispatch ✅

**Scan result: clean. No conflicts.**

## Progress

(No tasks started yet)
