# Offline task edits — reconcile on reconnect (closes the PRD's one real gap)

> **For agentic workers:** use the executing-plans skill. Steps are checkboxes. This plan is **lean by design** — it states contracts, decisions and gotchas. Derive the code.

**Goal:** an edit to a task file made while the app is running but **disconnected** lands on the record when the connection comes back — instead of sitting on disk until the next app launch. Closes the gap `prd/tasks.md` §Edge cases marks as ⚠️ KNOWN GAP.

**The reframing this plan rests on: there is no patch queue, and there must not be one.** The PRD says offline edits "queue as patches and are applied on reconnect". A queue is redundant state. The **working copy is already the queue** — the edit is on disk — and the **`ProjectionStore` is already the diff base** — the exact bytes the writer edited against, persisted. A patch is therefore reconstructible at any later moment from two things we already durably hold. A second queue would duplicate them and add a way for the two to disagree. **Do not build one.**

**Spec:** `prd/tasks.md` §Task file projection · slice 1: `docs/plans/2026-07-14-task-file-projection.md` · slice 2: `docs/plans/2026-07-14-task-file-git-mirror.md`.

---

## The bug is a missing wire, and it is bigger than the documented gap

`vault-manager.ts:117`:

```
onReconnect: () => void mirror.refresh()   // notes only. The projector is never touched.
```

`TaskProjector` already owns exactly the right routine — `start()` reconciles disk against the record and routes `disk != store` back through the inbound path as a real per-field patch. **Nothing calls it on reconnect.** So the consequence is not only "the offline edit doesn't land":

- missed `tasks` SSE events are **never** recovered — after any gap, task files are stale against the server (missed upserts, deletes, recurrence rolls, reminder fires) until the app restarts;
- an offline **`rm`** is silently **resurrected** (below);
- the offline edit does eventually land — at next launch — so the handoff's "the edit is lost" is wrong. It is *deferred*, invisibly, to the next app start.

## Decisions

| # | Decision |
|---|---|
| **D39** | **The reconcile path sends its patch with NO version guard.** It diffs against the `ProjectionStore` — the true base, the exact bytes the writer edited — so the per-field patch is *exact*, and a version check adds nothing while destroying legitimate edits. **Why it matters:** `version` bumps on every mutation, *including a reminder firing server-side with no human involved*. With the guard, going offline, editing `title`, and having a reminder fire means your edit is thrown away and the file rewritten — nobody touched `title`. Untouched fields are never sent, so a teammate's concurrent change to another field still survives. This is the identical argument D34 already accepted for git ingress, and it makes the desktop's offline path and the git path agree. Agreed with Nicolai 2026-07-14. |
| **D40** | **A failed offline delete is retried on reconnect; a delete is never *inferred* from a missing file.** `rm` while disconnected fails its mutation, so the record survives while the file is gone — and reconcile's `write()` re-materializes it, silently undoing the `rm`. Track attempted-but-failed deletes in an **in-memory** `pendingDeletes` set and retry them at reconcile. It is dropped on restart **on purpose**: at that point the existing, deliberate rule takes over — a file missing at `start()` is *re-materialized*, not treated as a delete (`write()`'s `existsSync` check). Inferring deletes from absent files would make a half-synced working copy destroy records. |

## Contract

- **`reconcile()`** — extract the body of `start()`. `start()` becomes `projected = await store.load()` then `reconcile()`. Reconnect calls `reconcile()` **without** reloading the store: the in-memory map is authoritative and fresher (it is saved after every change).
- **Unguarded inbound.** Thread a `guard: boolean` from the caller down to `inboundPatch`. Live watcher events (`onTaskFileEvent`) stay **guarded**; everything reconcile drives is **unguarded** (D39). `updateTask`/`completeTask` already take an optional `version` server-side (D34 left it optional) — pass `undefined`. **No server change is needed.**
  - Note this also un-guards the *app-closed* reconcile in `start()`, which is the same situation and the same bug. That is intended.
- **`TaskProjectorApi`** — widen `version` to `number | undefined` on `updateTask` / `completeTask` / `deleteTask`.
- **Reconnect wiring** — `onReconnect` fires `mirror.refresh()` **and** `projector.reconcile()`. Both, independently caught; a projector failure must not take out the notes refresh.
- **Re-entrancy.** `reconcile()` must not interleave with itself or with a live `applyTasksEvent`. A single in-flight promise (skip if already running) is enough; do not build a scheduler.

## Tasks

- [x] **1** Extract `reconcile()` from `start()`; `start()` = load store + `reconcile()`. Pure refactor — the existing desktop suite must pass **untouched**. Commit separately so the behavior change diffs clean.
- [x] **2** **D39:** thread `guard` through `onTaskFileEvent` → `inboundWrite` → `inboundPatch`. Reconcile-driven writes pass `guard: false` and send no version. Widen the api types.
  - Test: store base at v7, record moved to v8 by an **unrelated** field (simulate a reminder fire), an offline edit to `title` → reconcile → `title` lands, the other field survives, **no CONFLICT, no rewrite-from-truth**. Under the old guarded rule this test fails — watch it fail first.
  - Test: the *live* path is still guarded — a stale live write still conflicts and still rewrites from truth (the slice-1 CONFLICT test must keep passing).
- [x] **3** **D40:** `pendingDeletes` set; `inboundDelete` records a taskId when the mutation fails for a **non-CONFLICT** reason; `reconcile()` retries each (only while the file is still absent) before the main loop, and clears on success.
  - Test: disconnected `rm` → mutation throws → reconnect → the record is deleted and the file is **not** resurrected. Without the fix, reconcile re-materializes it — watch that fail first.
- [x] **4** Wire `onReconnect` in `vault-manager.ts` to call both. Test: a `tasks` upsert missed during the gap is materialized on reconnect.
- [x] **5** `pnpm -r test` + `pnpm -r typecheck` + `pnpm --filter @holi/desktop build`. Then the real Electron round-trip: kill the server mid-session, edit a task file, bring the server back, confirm the edit lands with no restart.
- [x] **6** Update `prd/tasks.md` — the ⚠️ KNOWN GAP bullet becomes shipped behavior, and state that **the disk + the store are the queue** (there is no patch queue) so nobody "adds the missing one" later. Add D39/D40 to `docs/decisions.md` (next free is D39 → after this, D41).

## Gotchas

- **`write()` re-materializes a missing file on purpose.** Do not "fix" that to mean delete — see D40. The rule protects a half-synced working copy from destroying records.
- **Offline creates already work** and need no code: `createTask` fails, the id-less file stays on disk, and reconcile's `adoptUnknownFiles()` picks it up. Add the test, not the feature.
- **The echo guard is text equality against the store.** Reconcile writes truth back through `write()`, which updates the store *before* touching disk — the ordering that makes our own watcher events inert. Do not reorder it.
- **Do not widen `TasksEvent`** to carry a "reconnected" signal. That union is read as `if (upserted) … else remove(taskId)`; a third variant deletes the task's file (D36).
