# Task file projection — implementation plan (slice 1: local)

> **For agentic workers:** use the executing-plans skill. Steps are checkboxes. This plan is **lean by design** — it states contracts, decisions and gotchas. Derive the code.

**Goal:** project every task record into the vault working copy as `tasks/<slug>-<id>.md`, writable — the local agent works tasks with `Read`/`Edit`/`Write`/`rm` instead of an op surface.

**Architecture:** the record stays the truth. Record → file is a **rewrite**; file → record is a **per-field patch** through the *same* tRPC mutations the board calls, guarded by a `version` token. Stale or unparseable writes lose and the file is rewritten from truth. Task files are **not CRDT docs** — they get their own materialization path, not a `DocBridge`.

**Spec:** `docs/prd/tasks.md` §Task file projection (owning doc) · `docs/prd/server-data.md` (`tasks` table) · `docs/specs/2026-07-13-agent-drawer-design.md` §Superseded.

**Slice 2 (separate plan, not here):** git-mirror export + ingress (remote agents), presence heartbeat.

---

## Decisions locked before writing this plan

| # | Decision |
|---|---|
| D1 | **Description = the markdown body = a plain `description` text column.** Not a CRDT. Keeps "task files are never CRDT docs" absolute, so the mirror exclusion is a clean path rule and not a byte-offset split. |
| D2 | **A title edit moves the file** (slug re-derives). The `-<id>` suffix keeps identity; git renders it as a rename. |
| D3 | **Presence = short-TTL heartbeat on the existing `tasks` SSE channel.** Slice 2. |
| D4 | **`yaml` package added to `packages/shared`** (pure JS, browser-safe). Hand-rolling was rejected: `recurrence` is a nested map with an array, and the *model* writes this frontmatter — it will not stay inside a hand-rolled subset. Real parse errors are what the "unparseable writes lose" rule stands on. |
| D5 | **parse/serialize = one implementation in `packages/shared`, called from several places.** `server-data.md`'s "exactly one place" means *the parser never answers a question* — it runs only on an **inbound write**. Both call sites (local watcher, git ingress) are inbound writes, so this honors it. Nothing ever globs `tasks/` to read state. |
| D6 | **Task files are not docs → they are not bridged.** They get a `TaskProjector`, a sibling of `VaultMirror`, fed by `tasks.list` + the SSE `tasks` channel — *not* by the relay. |
| D7 | **The last-known projection is persisted to disk**, not held in memory. It is the exact analogue of `DocBridge`'s `BaseStore` and exists for the exact same reason: without it, a file edited **while the app was closed** cannot be diffed, so the inbound path cannot compute a *per-field* patch. It would have to either patch every field (destroying a teammate's concurrent change to a field the writer never touched — the whole point of per-field LWW) or discard the edit. Both are wrong; persisting the projection makes restart and offline well-defined. |

## The landmine this plan exists to defuse

`VaultMirror` has **no direct write path** — every byte on disk today goes through a `DocBridge`, which needs a `Y.Doc`. And an unknown file under the working root is **adopted as a note doc** (`vault-mirror.ts:303`, `adoptFile`). So without Task 7, the instant the agent writes `tasks/foo.md` it becomes a **CRDT note**, and a server-driven rewrite (a recurrence roll landing the moment the agent marks something done) arrives as a *foreign write* that opens a spurious agent turn — mid-turn.

Task files must be: materialized, watched, **never adopted, never bridged, no base, no turn, no merge, no pre-turn snapshot, no `agentEditing` presence.**

## File structure

**Create**
- `packages/shared/src/task-file.ts` — `serializeTaskFile` / `parseTaskFile` / `taskFilePath` / `taskSlug` / `isTaskFilePath`
- `packages/shared/test/task-file.test.ts`
- `apps/desktop/src/main/vault/task-projector.ts` — the whole projection, both directions
- `apps/desktop/src/main/vault/projection-store.ts` — the persisted last-known projection (D7); mirror `base-store.ts`'s shape and its `userData` location
- `apps/desktop/test/task-projector.test.ts`

**Modify**
- `packages/shared/src/types.ts` (`Task` gains `description?`, `version`), `src/index.ts`, `package.json` (+`yaml`)
- `apps/server/src/db/schema.ts` (+`version`, +`description`), `src/db/mappers.ts` (`toTask`), `src/routers/tasks.ts` (`taskFields`, `finishMutation`, version guard)
- `apps/desktop/src/main/vault/vault-mirror.ts` (task-path exclusion + disk-event forwarding), `vault-manager.ts` (SSE `tasks` payload — today **discarded**), `vault-files.ts` if `isIgnoredPath` is the cleanest seam
- `apps/desktop/src/main/agent/mcp-ops.ts` (7 ops → 3), `mcp-server.ts` (`INSTRUCTIONS`), `system-prompt.ts`, `seed-content.ts` (AGENTS.md body)

---

## Task 1 — `packages/shared`: the file format

**Files:** create `src/task-file.ts` + `test/task-file.test.ts`; modify `package.json`, `src/index.ts`.

**Contract:**
```ts
serializeTaskFile(task: Task, notePathFor: (docId: string) => string | undefined): string
parseTaskFile(text: string): ParsedTaskFile   // throws TaskFileError on malformed
taskFilePath(task: Pick<Task,'id'|'title'>): string   // tasks/<slug>-<id>.md
isTaskFilePath(rel: string): boolean                  // tasks/**.md
```
`ParsedTaskFile` carries the **fields actually present** (so "absent" ≠ "cleared" is decidable by the caller), the `id` (may be absent = a create), the `version` (may be absent), and `description` = the body.

- [ ] **1.1** Add `yaml` to `packages/shared` deps. Note `@holi/shared` is *bundled* into Electron main (`externalizeDepsPlugin({ exclude: ['@holi/shared'] })`) while `yaml` stays external — confirm main still boots after this lands (`pnpm --filter @holi/desktop build`).
- [ ] **1.2** Write the failing round-trip test: `serialize → parse` is identity over a task exercising every field, incl. `recurrence` (nested map + weekday array), `tags`, `related`, a title with a colon and unicode, and a multi-paragraph body.
- [ ] **1.3** Tests that pin the **losing** cases — each must throw `TaskFileError`, never partially apply: no frontmatter fence; unterminated fence; frontmatter that isn't a map; `status` outside the enum; `due` not `YYYY-MM-DD`; `id` present but not a UUID; garbage YAML. These are the "the model wrote bad frontmatter" cases and they are the point of the whole guard.
- [ ] **1.4** Implement. Body is everything after the closing fence, verbatim (leading blank line stripped, trailing newline normalized) — it is `description`.
- [ ] **1.5** `taskSlug`: lowercase, non-alphanumerics → `-`, collapse runs, trim, cap length, and **fall back to a constant when the title slugs to empty** (a title of `"???"` must not yield `tasks/-<id>.md` with a leading dash). Test that.
- [ ] **1.6** Green. Commit.

**Gotcha:** `packages/shared` has **no `vitest.config.ts`** — it runs on defaults, tests live in `test/` and import via relative paths (`'../src'`), never `@holi/shared`.

## Task 2 — `packages/shared`: the note path ↔ docId seam

**Files:** modify `src/task-file.ts` (or a sibling), `test/task-file.test.ts`; later deleted from `apps/desktop/src/main/agent/mcp-ops.ts:47-60`.

The record stores **stable docIds**; the file renders **paths** (`{ kind: note, path: meetings/x.md }`). This translation exists today inside `mcp-ops.ts` (`toServerRef` / `render`) and must move to shared so the projector and (slice 2) the git ingress share it.

- [ ] **2.1** Contract: `relatedToFile(refs, pathForDocId)` and `relatedFromFile(fileRefs, docIdForPath)`. Non-note kinds pass through untouched.
- [ ] **2.2** The two unresolvable cases are **not symmetric**. Test both:
  - **serialize, docId → no path** (the note was deleted): render a **tombstone** that the parser round-trips back to the same docId. It must *not* drop the ref — dropping it would silently delete the link on the next inbound write. This matches the PRD: a dangling ref renders as a tombstone, it does not cascade.
  - **parse, path → no docId** (the agent invented or typo'd a path): **reject the whole file** — it takes the unparseable path (discard + rewrite from truth). *Why the harsh option:* dropping just the bad ref and applying the rest is silent data loss the user cannot see, whereas rejection is visible, self-healing (the agent re-reads the corrected file), and is exactly the rule the projection already commits to. A legitimately deleted note is the tombstone case above and parses fine — so this only fires on a genuinely bogus path.
- [ ] **2.3** Green. Commit.

**Note:** `RelatedRef` in code is `{ kind, id }` (`packages/shared/src/types.ts:42`), **not** the richer per-variant union the PRD prints. Do not reshape it in this plan; just bridge it.

## Task 3 — server: `version` + `description`

**Files:** `apps/server/src/db/schema.ts:142-163`, `src/db/mappers.ts:31`, `src/routers/tasks.ts:22`, `packages/shared/src/types.ts:58`.

A new column needs **four** edits: schema, `taskFields`, `toTask`, shared `Task`. (`toTask` deliberately drops `completedAt`/`remindedAt` — leave that alone; **do** add `version` and `description`.)

- [ ] **3.1** `schema.ts`: `version integer NOT NULL DEFAULT 1`, `description text` (nullable).
- [ ] **3.2** `pnpm --filter @holi/server db:generate` → commit the generated `drizzle/NNNN_*.sql` **and** the `meta/_journal.json` entry. Do not hand-write the SQL.
- [ ] **3.3** `Task` in shared gains `version: number` and `description?: string`. Typecheck the repo — this will light up every construction site.
- [ ] **3.4** **Bump `version` on every mutation** in `finishMutation` (`tasks.ts:45-51`) — the single choke point every task mutation already funnels through. Test: two `update`s → version 1 → 2 → 3, and the bump is visible on the `bus.emitTasks` payload.
- [ ] **3.5** Green (`pnpm --filter @holi/server test`; needs `pnpm db:up` — live Postgres on **5433**). Commit.

## Task 4 — server: the stale-write guard

**Files:** `apps/server/src/routers/tasks.ts`.

- [ ] **4.1** `update` / `complete` / `delete` inputs gain an **optional** `version?: number`. **Optional is load-bearing:** the board sends no version (plain last-writer-wins, unchanged behavior); only *file*-originated writes send one.
- [ ] **4.2** When `version` is supplied and ≠ the row's, throw tRPC `CONFLICT`. Test: supply a stale version → CONFLICT, and assert **the record did not change** (a partial apply here is the bug that silently diverges disk from truth).
- [ ] **4.3** Green. Commit.

## Task 5 — desktop: stop discarding the SSE task payload

**Files:** `apps/desktop/src/main/vault/vault-manager.ts:75-78`, the `VaultObserver` interface (`:18-26`), `agent-manager.ts:260`.

Today `channel === 'tasks'` calls `observer?.onTasksEvent()` with the **payload thrown away** — it is a pure invalidation ping for ContextSnapshot. The projector needs the actual `TasksEvent` (`{type:'upserted', task}` | `{type:'deleted', taskId}`).

- [ ] **5.1** Widen `onTasksEvent(event: TasksEvent)`. ContextSnapshot ignores the argument and keeps behaving exactly as now — no behavior change there.
- [ ] **5.2** Typecheck + existing desktop tests green. Commit.

## Task 6 — desktop: `TaskProjector`, record → file

**Files:** create `apps/desktop/src/main/vault/projection-store.ts`, `task-projector.ts`, `apps/desktop/test/task-projector.test.ts`.

Sibling of `VaultMirror`, **not** a branch inside it. Owns the `tasks/` subtree of the working root.

**Contract:** `start()` (fetch `tasks.list`, reconcile disk against the persisted projection, write, prune), `applyTasksEvent(e)`, `stop()`. Writes via the existing `writeAtomic` (`vault-files.ts:33`) — the agent's `Read` must never see a torn file.

- [ ] **6.1** **`ProjectionStore` first (D7).** Persist `taskId → { rel, text, version }` under `userData`, alongside `BaseStore` and in the same shape — read `base-store.ts` and follow it rather than inventing a second convention. It is written **at every projection write**, and it is the only thing that makes the inbound path (Task 8) able to compute a per-field diff after a restart. Unit-test load/save/delete round-trips, including a corrupt store file degrading to empty rather than throwing.
- [ ] **6.2** Test: `start()` against a fake `tasks.list` of 2 tasks writes both files and populates the store; a task with no `area`/`due`/`tags` omits those keys rather than emitting `null`s.
- [ ] **6.3** `upserted` writes/overwrites. `deleted` unlinks. Both update the store. Test both.
- [ ] **6.4** **D2 — a title change moves the file:** unlink the old rel, write the new one, re-key the store. Test it, and test that the *content* is right at the new path.
- [ ] **6.5** **`start()` reconciliation.** With the store, the three startup cases are decidable — without it they are not. For each `tasks/*.md` on disk carrying an `id`:
  - id known to the server, text == store ⇒ nothing happened while we were away.
  - id known to the server, text != store ⇒ **an edit happened while the app was closed.** Hand it to Task 8's inbound path (diff vs the *stored* text ⇒ a real per-field patch). This is the case the in-memory design silently got wrong.
  - id **absent** from the server list ⇒ present in the store means the server deleted it ⇒ **prune the file**; absent from the store means it was created offline ⇒ **create it** (Task 8.7).
  Test all three, plus "a file with no `id` at all is a create, never a prune."
- [ ] **6.6** Green. Commit.

**Gotcha:** the store is *also* the echo-suppression guard in Task 8 — the projector's own `writeAtomic` fires a chokidar `change` for a file it just wrote. Text-equal to the stored text ⇒ echo ⇒ ignore. Don't invent a second mechanism.

## Task 7 — desktop: the mirror exclusion ⚠️

**Files:** `apps/desktop/src/main/vault/vault-mirror.ts` (`onDiskEvent:258`, `adoptUnknownFiles:315`, `adoptFile:303`, `refresh:119`), `vault-files.ts:28`.

**This is the one that isn't cosmetic.** Task files must be visible to the watcher but invisible to the doc machinery.

- [ ] **7.1** Failing test, in the existing `vault-mirror.test.ts` style (its neighbours: *"local-only and junk files are never adopted"* `:148`, *"agent rm deletes the doc server-side"* `:160`): **writing `tasks/foo-<id>.md` into the working root must NOT create a doc.** On today's code this fails — `adoptFile` turns it into a note. That failure is the whole point of the task; watch it fail before fixing it.
- [ ] **7.2** Add a `onTaskFileEvent(rel, kind)` dep to `VaultMirror`. In `onDiskEvent`, `isTaskFilePath(rel)` ⇒ forward to that dep and **return** — never `bridgeForPath`, never `adoptFile`, never `scheduleLifecycle`. Exclude the same paths from `adoptUnknownFiles`'s startup scan.
- [ ] **7.3** Assert the negatives explicitly, because they are the spec: no `DocBridge` is constructed for a task path; `bridgeForPath('tasks/…')` is `null`; `endOpenTurns()` skips them; **no pre-turn snapshot is taken** (the fake API records `snapshots` — assert it stays empty); no `agentEditing` awareness is set.
- [ ] **7.4** Green. Commit.

**Gotcha (do not re-derive — it cost a session):** chokidar **coalesces a delete-then-recreate into a single `change`**; the `unlink` never arrives. A guard keyed on the unlink event is unimplementable. This bites D2's rename (unlink old + write new) — treat the pair as independent path events, never as a correlated "move".

**Test ports:** 5611/5612/5614 are taken by existing suites. Use **5615+**.

## Task 8 — desktop: file → record

**Files:** `apps/desktop/src/main/vault/task-projector.ts`, `apps/desktop/test/task-projector.test.ts`.

The inbound half. Every path here ends in *either* a tRPC mutation *or* a rewrite-from-truth. There is no third outcome and no conflict UI.

- [ ] **8.1** Echo guard: text equals the **stored** projection ⇒ ignore. Test that a projector-initiated write does not loop back into a mutation.
- [ ] **8.2** **Parse → diff vs the stored projection → per-field patch** via the *existing* `tasks.update`. Only changed fields are sent. Test the money case: **two writers, different fields, both survive** (agent edits `title` while the board moved `status`). Note this only works *because* the diff is against the stored projection rather than against the current record — diffing against the record would show the teammate's `status` change as a field this writer "changed back."
- [ ] **8.2b** **The restart case (D7).** Stop the projector, edit a task file on disk behind its back, start it again: the edit must land as a **per-field patch**, not a full-record overwrite. Assert a field the writer never touched, but which the server changed while the app was closed, **survives**. This test fails against an in-memory-only projection — it is the reason the store exists.
- [ ] **8.3** `status: done` routes to **`tasks.complete`**, not `update` — the server owns recurrence roll-forward, and it is the single completion path. (This is why `task_set` survives as an op: a file *cannot* express "end the series" vs "roll it".) Test that completing a recurring task via the file rolls the due date and the file is rewritten with the new due.
- [ ] **8.4** Send the file's `version` on the patch. **Stale ⇒ CONFLICT ⇒ discard the write and rewrite the file from truth.** Test that disk ends up matching the record — *never* left in the writer's rejected state.
- [ ] **8.5** **Unparseable ⇒ discard + rewrite from truth.** Same test shape. This is the `verify-parse-after-write` guard the old app needed; the model *will* trip it.
- [ ] **8.6** **`rm tasks/….md` ⇒ `tasks.delete`** — the note symmetry (`propagateDelete`, `vault-mirror.ts:294`) applied to records. Re-read disk first and bail if the file came back (that's a rewrite, not a delete).
- [ ] **8.7** **A well-formed file with no `id` ⇒ `tasks.create`**, then rewrite it at its canonical `tasks/<slug>-<id>.md` path (the agent wrote `tasks/whatever.md`; the record's id is what names it). Test the rename lands.
- [ ] **8.8** Green. Commit.

## Task 9 — agent: 7 ops → 3

**Files:** `apps/desktop/src/main/agent/mcp-ops.ts`, `mcp-server.ts:19` (`INSTRUCTIONS`), `system-prompt.ts`, `seed-content.ts`, `apps/desktop/test/system-prompt.test.ts:77`.

Surviving surface: **`task_set`**, **`task_list`**, **`note_rename`**. Retire `task_new` / `task_get` / `task_link` / `task_delete` — each is now a plain file operation.

- [ ] **9.1** Delete the four ops and the now-duplicated path↔docId helpers (they live in shared as of Task 2).
- [ ] **9.2** Rewrite the prompt surface — it currently *steers the agent away from the thing we just built*:
  - `TOOLS` (`system-prompt.ts:74-81`) enumerates 7 ops and says *"Tasks are server records, not files. There is nothing to `Read` or `Edit` for a task"* — now false.
  - `VAULT_CONVENTIONS` (`:136-140`) says *"Reference tasks by their id … not by path — they have no path"* — now false.
  - `VAULT_SYSTEM` (`:127-134`), `AGENDA_HEURISTICS` (`:88-92`), `mcp-server.ts` `INSTRUCTIONS`, and the AGENTS.md body in `seed-content.ts` all name the 7-op surface.
  - Say plainly: tasks are files under `tasks/`; read/edit/create/delete them natively; `task_set` exists for completion (roll vs end-the-series) and field clears; `task_list` exists because filtering is a server query — **never glob and parse the folder to answer a question**.
- [ ] **9.3** Update `system-prompt.test.ts:77` ("retargets guidance to the 7 ops") to pin the 3-op surface.
- [ ] **9.4** Green. Commit.

**Note:** AGENTS.md is *seeded vault content*, idempotent create-if-missing. Existing dev vaults keep the stale text — reseed or hand-edit when smoke-testing, or you will debug a prompt that isn't the one you wrote.

## Task 10 — verify it for real

- [ ] **10.1** `pnpm -r test` + `pnpm -r typecheck` + `pnpm --filter @holi/desktop build`.
- [ ] **10.2** Extend the fake-`claude` e2e (`apps/desktop/e2e/`): agent writes a task file → record appears; board moves the card → the agent's file updates; agent `rm`s → task gone. Assert **no spurious turn opened** for any of it (the drawer's turn state is observable via `onTurnActivity`).
- [ ] **10.3** Real-`claude` smoke in the drawer, per the handoff's dev loop. The invariant to watch with your own eyes: **complete a recurring task from the file** and confirm the server's roll-forward rewrite lands as a plain file update — no turn, no snapshot, no `agentEditing` badge.

---

## Deliberate deferrals (stated, not overlooked)

- **Offline patch queue.** `docs/prd/tasks.md:229` says offline task-file edits "queue as patches and are applied on reconnect." **This plan does not implement the queue.** A mutation attempted while offline fails, and the projector rewrites the file from its last-known truth — the edit is lost, not queued. That is a real gap against the PRD and it should be a conscious call, not a surprise. D7's persisted store is the prerequisite that makes the queue implementable later (it already knows what changed and what version it was based on); wiring the retry is a contained follow-up. **Edits made while the app is closed and reconciled at next `start()` (Task 6.5) *do* work** — it is only edits made while the app is *running but disconnected* that drop.
- **Version churn on the projection.** Every mutation bumps `version`, and `version` lives in the frontmatter — so a reminder firing rewrites the task file purely to change one integer, even though `remindedAt` is not a frontmatter field. Harmless locally; once slice 2 lands it means **the git mirror commits on reminder fires**. Accept for now; the fix (omit `version` from the file and carry it out-of-band in the store) is available if the commit noise is bad.

## Follow-ups (not this plan)

- **Slice 2:** git-mirror export (`buildExportFiles` at `apps/server/src/git/exporter.ts:14` reads *only* the `docs` table — tasks need a **second source**, not a filter) + ingress (clean chokepoint at `ingester.ts:109`, after the path-safety/local-only guards, before the A/M/D/R dispatch; note `createDoc` hardcodes `kind:'note'`, so a task file must never fall through to it). Then presence (D3).
- **Pre-existing flaky test:** `apps/desktop/test/vault-mirror.test.ts` fails intermittently under `pnpm -r test` (four vitest instances → CPU starvation → chokidar delivery blows past the 8s waits). Verified pre-existing. Fix by raising allowances or `--pool=forks --poolOptions.forks.singleFork` — **not** by weakening assertions.

## Open questions this plan does not settle

Left in `docs/prd/tasks.md`, none of them blocking: reminder anchor timezone; filter-bar minimal set; missed-reminder collapse; board card affordances.
