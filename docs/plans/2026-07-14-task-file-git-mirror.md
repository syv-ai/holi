# Task file projection, slice 2 — git mirror + presence

> **For agentic workers:** use the executing-plans skill. Steps are checkboxes. This plan is **lean by design** — it states contracts, decisions and gotchas. Derive the code.

**Goal:** task files reach the **git mirror** in both directions, so a remote Claude Code session working a clone of the repo can read, edit, create and delete tasks exactly as the local agent does. Plus **presence** (D3): "Nicolai is editing this task", so the two writers slice 1 deliberately left unlocked can at least see each other.

**Architecture:** the record is still the truth. The exporter gains a **second source** (the `tasks` table) alongside `docs`; the ingester gains a **branch before its A/M/D/R dispatch** that routes `tasks/**.md` to the record path instead of the doc path. The inbound diff base is the **git base blob** — git hands us "what the writer edited against" for free, which is the one thing the desktop needed a persisted `ProjectionStore` to reconstruct.

**Spec:** `docs/prd/tasks.md` §Task file projection (owning doc) · `docs/specs/2026-07-13-vault-git-mirror-design.md` · slice 1: `docs/plans/2026-07-14-task-file-projection.md`.

---

## Decisions locked before writing this plan

| # | Decision |
|---|---|
| D8 | **`version` leaves the frontmatter.** It is carried out-of-band in `ProjectionStore` (which already stores it). **Why:** every mutation bumps `version`, so a reminder firing rewrites the file to change one integer — and once the mirror is on, *the bot commits on every reminder fire*. It also puts a machine token in the agent's face for no benefit: the agent must never hand-edit it, and the desktop already knows it. Slice 1 flagged this as the fix to apply "if the commit noise is bad" — the mirror is what makes it bad, so it lands here. **This edits slice-1 code** (`serializeTaskFile`, `inboundPatch`). |
| D9 | **Git ingress diffs base-blob vs head-blob — no version guard.** The commit *is* its own diff base, so the per-field patch is exact, and a version check would only reject a legitimate remote edit whose commit predates an unrelated local change. This is the identical rule notes already ingest under (`applyTextDiff` against the git base = per-field LWW), so tasks and notes get the same conflict story. Consequence: `tasks.update`'s `version` stays **optional**, exactly as slice 1 built it, and git simply never sends one. |
| D10 | **Task mutations move out of the router into `src/tasks/mutations.ts`**, called by *both* `routers/tasks.ts` and `git/ingester.ts`. **Why:** `finishMutation` is where `recomputeReminder` + `bus.emitTasks` + `wakeEvaluator` live. An ingester that writes `tasks` directly would skip all three — a git-ingested task would fire no reminder, and **no SSE would reach the desktop, so the projector would never rewrite the file**. `server-data.md`'s "exactly one place a task changes" is the rule; today the router is that place only by accident of being the only caller. |
| D11 | **Task files win a path collision with a doc at `tasks/**.md`.** The desktop mirror can't create one (slice 1 excluded the path from adoption), but a foreign commit could have, before this slice existed. The exporter overwrites; the ingester never lets a `tasks/` path reach `createDoc`. |
| D12 | **Presence is a new `presence` frame on the existing per-vault SSE stream** — a new bus topic, *not* a new `TasksEvent` variant and *not* a new relay room. **Why not widen `TasksEvent`:** `TaskProjector.applyTasksEvent` is `if (upserted) … else remove(event.taskId)` — a third variant would fall into the `else` and **delete the task's file**. Widening a union that an exhaustive-by-accident consumer reads is how you get that bug. A sibling channel on the same connection satisfies the PRD ("rides the existing per-vault `tasks` event channel" = same stream, no new plumbing) with no trap. |
| D13 | **Presence is fire-and-forget, server-stateless.** The server stamps an `expiresAt` and emits; it stores nothing. Clients drop an entry when it expires. **Why:** this is the whole reason locks were rejected (`prd/tasks.md` §Concurrency) — there is no acquire, no release, no TTL sweep, no stale holder, no steal path. A heartbeat that stops arriving *is* the release. |

## The landmine this plan exists to defuse

`createDoc` (`ingester.ts:51`) hardcodes `kind: 'note'`. Every inbound git path that isn't explicitly routed elsewhere ends up there. So the instant the mirror carries `tasks/`, a remote commit touching a task file makes it a **CRDT note** — the exact failure slice 1's Task 7 spent its whole existence preventing on the desktop side, arriving through the other door. The branch must sit **before** the A/M/D/R dispatch, not inside it, because `A`, `M` and `R`-treated-as-`A` each reach `createDoc` by a different route.

Second landmine, quieter: the export loop and the ingest loop are the **same loop**. `syncPass` exports right after it ingests. If ingest writes a record and export re-serializes it to bytes that differ from what the commit contained (a field order, a dropped default, a trailing newline), the bot commits a "correction" on every single sync — forever, on an idle vault. `serializeTaskFile`'s fixed key order exists for this; the round-trip test in Task 1 is what proves it.

## File structure

**Create**
- `apps/server/src/tasks/mutations.ts` — `createTask` / `patchTask` / `completeTask` / `deleteTask`, each ending in `finishMutation`. The one place a task changes (D10).
- `apps/server/src/git/task-ingest.ts` — the `tasks/**.md` branch of the ingester.
- `apps/server/test/git-tasks.test.ts` — export + ingress, real Postgres, real git.
- `apps/server/test/task-presence.test.ts`

**Modify**
- `packages/shared/src/task-file.ts` — drop `version` from serialize (D8); add `taskIdFromPath`
- `apps/desktop/src/main/vault/task-projector.ts` — take `version` from the store, not the file (D8)
- `apps/server/src/git/exporter.ts` — the second source
- `apps/server/src/git/ingester.ts` — the branch, at `:109`
- `apps/server/src/routers/tasks.ts` — thin down onto `tasks/mutations.ts`
- `apps/server/src/db/schema.ts` — `GitWarning['kind']` gains `task-file-unparseable`
- `apps/server/src/bus.ts`, `src/events.ts` — the presence channel

---

## Task 1 — `version` leaves the file (D8)

**Files:** `packages/shared/src/task-file.ts`, `test/task-file.test.ts`; `apps/desktop/src/main/vault/task-projector.ts`, `apps/desktop/test/task-projector.test.ts`.

Do this **first**. It shrinks the file format before two more call sites start depending on it.

- [ ] **1.1** `serializeTaskFile` stops emitting `version`. `parseTaskFile` keeps **accepting** it (an old file on disk, or a hand-written one, must still parse) — it just goes nowhere. Update the round-trip test.
- [ ] **1.2** `inboundPatch` takes the version from `previous.version` (the store) instead of the file. The `version === undefined` arm of its guard disappears; `!previous` still means "nothing to diff against ⇒ rewrite from truth".
- [ ] **1.3** The slice-1 tests that assert a version in the frontmatter now assert it in the **store**. `apps/desktop/test/task-projector.test.ts` — the stale-write CONFLICT test is the one that matters: it must still conflict, now on the store's token.
- [ ] **1.4** Green (`pnpm --filter @holi/shared test`, `pnpm --filter @holi/desktop test`). Commit.

**Gotcha:** existing dev vaults have `version:` sitting in every task file on disk. Parse still accepts it, and the first rewrite drops it — but the *first* rewrite is a byte change on every task, so expect one noisy commit the first time the mirror runs. That is correct and one-time; don't chase it.

## Task 2 — server: one place a task changes (D10)

**Files:** create `apps/server/src/tasks/mutations.ts`; modify `apps/server/src/routers/tasks.ts`.

Pure refactor, no behavior change. Do it as its own commit so the git work that follows diffs clean.

- [ ] **2.1** Move `taskInVault`, `touch`, `atVersion`, `staleConflict`, `finishMutation` and the bodies of `create` / `update` / `complete` / `delete` into `tasks/mutations.ts`. They take `(db, bus, vaultId, …)` explicitly rather than a tRPC `ctx` — the ingester has no `ctx`.
- [ ] **2.2** The router becomes input validation + a call. `taskFields` (the zod shape) stays in the router; the mutations module takes already-validated values.
- [ ] **2.3** **While you are in here, fold `vaultId` into `atVersion`'s WHERE.** Today the vault scope rests entirely on the `taskInVault` SELECT that precedes the UPDATE, which makes the "the guard is atomic" claim in its comment true only of the version, not of the tenancy. Cheap to fix, and the ingester is about to become a second caller.
- [ ] **2.4** `pnpm --filter @holi/server test` — the existing 113 must pass **untouched**. If a task test needed editing, the refactor changed behavior. Commit.

## Task 3 — server: the exporter's second source

**Files:** `apps/server/src/git/exporter.ts`; `apps/server/test/git-tasks.test.ts`.

`buildExportFiles` (`:14`) reads `docs ⋈ yjsDocs` and nothing else. Tasks are a separate table with no `path` column: they are absent from the mirror **by construction**, so this is a second query, not a filter.

**Contract:** `buildExportFiles` also selects `tasks`, `folders` and the `docs` id→path map, then for each task sets `files.set(taskFilePath(task), serializeTaskFile(task, resolvers))` — the *same* `serializeTaskFile` from `packages/shared`. (Compliant with D5: "exactly one place" means the parser never *answers a question*; both call sites are inbound writes and this one is an outbound render.)

Resolvers come from the two maps you just fetched: `notePathFor` = docId → `docs.path`, `folderPathFor` = folderId → `folders.path`.

- [ ] **3.1** Failing test: a vault with one task exports `tasks/<slug>-<id>.md`, and its content `parseTaskFile`s back to the same fields.
- [ ] **3.2** **The idle-loop test, and it is the important one:** export → ingest the bot's own commit → export again produces **no second commit**. `exportCommit` returns `null` on an unchanged tree, so assert that. This is what proves serialize/parse round-trips byte-exactly; without it the bot commits a correction to itself on every sync forever.
- [ ] **3.3** Implement. Task files **win** any collision with a doc at the same path (D11) — set them last.
- [ ] **3.4** Test: a task whose `area` folder was deleted exports the raw folder id (the tombstone), not a dropped key. A task with a `related[]` note ref exports the note's **path**.
- [ ] **3.5** Green. Commit.

## Task 4 — server: the ingress branch ⚠️

**Files:** create `apps/server/src/git/task-ingest.ts`; modify `apps/server/src/git/ingester.ts:106-109`, `src/db/schema.ts` (`GitWarning`).

**This is the one that isn't cosmetic.** The chokepoint is `ingestEntry`, immediately after the path-safety and local-only guards and **before** `opts.skipExisting` and the A/M/D/R dispatch — it still has `entry.status`, `path`, `base`, `head`, `cloneDir`, `warnings`, `opts` in hand.

```
if (isTaskFilePath(path)) return ingestTaskEntry(deps, vaultId, cloneDir, base, head, entry, warnings, opts)
```

- [ ] **4.1** **Failing test first, and watch it fail:** commit `tasks/foo-<uuid>.md` to the bare repo as a foreign author, sync, and assert **no row appears in `docs`**. On today's code this fails — the file becomes a `kind:'note'` CRDT doc via `createDoc`. That failure is the whole point of the task.
- [ ] **4.2** Add `taskIdFromPath(rel): string | undefined` to `packages/shared/src/task-file.ts` (the `-<uuid>.md` suffix; `undefined` when absent). Unit-test it, including a slug that itself contains something uuid-shaped.
- [ ] **4.3** `ingestTaskEntry`, by status. The id in the **filename** is the identity; the id in the frontmatter is a cross-check.
  - **D** — `taskIdFromPath` → `deleteTask`. No version (D9). Unknown id ⇒ no-op, not an error.
  - **A** — parse the head blob. No `id` ⇒ **create** (the remote agent hand-wrote a task; the next export renames it to its canonical path, and git renders that as a rename). Has an `id` that exists ⇒ fall through to **M**. Has an `id` that does *not* exist ⇒ the vault deleted it; **skip + warn**, do not resurrect — the export will remove the file on this same pass.
  - **M** — parse **both** blobs, diff per field, patch. This is D9: the base blob is the diff base, so a field the commit never touched is never sent, and a teammate's concurrent change to it survives.
  - **R** — the id is in the filename and stable, so a rename is just a title change that already re-derived the slug. Ingest as **M** against the base blob at `entry.oldPath`. If the old and new ids differ, it isn't a rename at all — treat as **D**(old) + **A**(new).
- [ ] **4.4** **Unparseable head blob ⇒ `warnings.push(warning('task-file-unparseable', path))` and skip.** It must **never** reach `createDoc`. Add the kind to `GitWarning` in `schema.ts`. Test that a task file with garbage YAML leaves both `tasks` and `docs` untouched and surfaces a warning.
- [ ] **4.5** `opts.skipExisting` (initial-connect, vault-wins) applies to tasks too: the task already exists ⇒ leave it, the export overwrites the remote. Test it.
- [ ] **4.6** Assert the negatives, because they are the spec: no `docs` row, no `yjs_docs` row, no snapshot, no `link_index` entry is created for any `tasks/` path.
- [ ] **4.7** Green. Commit.

**Gotcha:** an unresolvable `area` path or `related[]` note path in a *remote* commit must **not** reject the whole write the way the desktop does — the desktop can rewrite the file from truth and let the agent re-read it, but a git commit has already happened and there is nobody to correct it. Warn and drop the unresolvable ref, keep the rest. This is the one place the two inbound paths deliberately differ, and slice 1's `relatedFromFile` throws — so catch it here rather than changing shared.

**Gotcha:** the bot's own export commits are filtered out upstream by author email (`sync.ts:122`), so a task the exporter wrote never ingests back. Do not add a second guard; if you find yourself needing one, the author filter is broken and *that* is the bug.

## Task 5 — presence (D3, D12, D13)

**Files:** `apps/server/src/bus.ts`, `src/events.ts:32-44`, `src/routers/tasks.ts`; `apps/server/test/task-presence.test.ts`; `apps/desktop/src/main/vault/vault-manager.ts`.

- [ ] **5.1** `bus.ts`: `PresenceEvent = { taskId, userId, name, expiresAt }` + `emitPresence(vaultId, event)`. `events.ts`: subscribe `presence:${vaultId}`, send as `event: presence`. Unsubscribe in the existing `req.on('close')` — it is easy to add the `on` and forget the `off`, and the leak is invisible until a long-lived server has thousands of dead listeners.
- [ ] **5.2** `tasks.heartbeat({ taskId })` — a `vaultProcedure` **mutation that touches no row**. It resolves the actor from `ctx`, stamps `expiresAt = now + PRESENCE_TTL_MS` (10s), emits, returns. Test: it emits with the caller's identity, and it does **not** bump `version` (a heartbeat that bumped the version would rewrite every task file, and with the mirror on, commit it).
- [ ] **5.3** The desktop emits one when the projector receives an inbound task-file change — that is the "Claude is editing this task" signal, and it is the case the PRD actually cares about. Fire it from `onTaskFileEvent` **before** the patch is applied, so it precedes the write rather than trailing it. Never `await` it into the write path.
- [ ] **5.4** Green. Commit.

**Note:** the board's own "user is typing in the task editor" heartbeat is a **renderer** concern and is not in this plan — the server surface (5.2) is what it will call. Wire it when the board editor lands.

## Task 6 — verify it for real

- [ ] **6.1** `pnpm -r test` + `pnpm -r typecheck` + `pnpm --filter @holi/desktop build`.
- [ ] **6.2** The round-trip that is the entire point of the slice, against a real bare repo: **clone the mirror, edit a task file in the clone as a foreign author, push, sync — the record changes and the desktop's file updates**. Then the reverse: move the card on the board, sync, and the clone's file has the new status.
- [ ] **6.3** Watch the idle vault for two sync passes and confirm **zero commits**. Task 3.2 tests this, but D8 and the serializer make it a property of the whole loop, and a real Postgres round-trip through `jsonb` is where a field order can still surprise you.

---

## Deliberate deferrals (stated, not overlooked)

- **The offline patch queue is still not implemented.** Unchanged from slice 1 (`docs/prd/tasks.md:229`). Nothing here makes it harder; D8 makes it slightly easier, since the store is now the *only* holder of the version and is already the queue's natural home.
- **The board's presence UI.** 5.2 ships the server surface and 5.3 the agent's emitter; rendering "Nicolai is editing" on a card belongs with the board work.
- **A remote agent's `task_set` equivalent.** A remote session working the clone has files and nothing else — so it cannot express "end the series" vs "roll it forward" on a recurring task, and `status: done` in a commit takes the roll-forward reading (same rule as slice 1's file path). Ending a series remotely means editing `recurrence` out of the frontmatter, which works and is discoverable. Good enough; a remote op surface is not worth an MCP transport.

## Open questions this plan does not settle

- Unchanged from slice 1: reminder anchor timezone; filter-bar minimal set; missed-reminder collapse.

## Settled during execution

| # | Decision |
|---|---|
| D14 | **A user and their agent are one identity for presence.** Presence emits under the user's identity whether the write came from the board or from Claude working on that user's behalf, and there is **no `actor` field**. The agent acts with the user's token and is not a separate party — "Nicolai is editing this task" is true when Nicolai's Claude is editing it, because Nicolai set it going. (This is *not* the same question the drawer answers on notes: "Claude is editing…" there tells **you** what **your own** agent is doing to a doc you are looking at. Presence tells **someone else** that **this task is in motion**, and for that purpose the distinction is noise.) |
| D15 | **A deleted folder unfiles its tasks (`ON DELETE SET NULL`); there is no folder tombstone.** Found while writing the export tests: `tasks.area`'s un-cascaded FK made Postgres *refuse* to delete any folder a task pointed at, so folders were silently undeletable and the PRD's "the task isn't lost" tombstone was unreachable code. A task is allowed to exist without an area — that is what the "(no area)" lane **is** — so the folder delete wins and the task falls into it. The raw-id fallback in `serializeTaskFile` survives but is **not** a tombstone: it is a guard against a *stale resolver* (the desktop snapshots the folder map), and it emits the id rather than omitting the key because an absent `area:` reads as "cleared" to the inbound diff. |
