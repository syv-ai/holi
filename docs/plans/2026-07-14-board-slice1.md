# The board, slice 1 — the pipe and the grid

> **For agentic workers:** use the executing-plans skill. Steps are checkboxes. This plan is **lean by design** — it states contracts, decisions and gotchas. Derive the code.

**Goal:** the stripped kanban, live. Todo / Doing / Done × swim lanes by `area`, drag on both axes, quick-add, presence on cards. At the end of this slice a member can run their tasks from the board and see a teammate's (and Claude's) changes arrive without a refresh.

**Slice 2 (not here):** the task detail view + its description editor, the filter bar, and the renderer's own "I am typing" heartbeat (it belongs to the detail view, which is where you type).

**The one structural fact:** the SSE connection lives in **main** (`vault-manager.ts`), not the renderer. Tasks reach the UI by main **pushing** over IPC — the same `pushChannel` shape the agent PTY already uses. The renderer does not open a second stream.

**Spec:** `prd/tasks.md` §Board UX (owning doc) · presence: §Task file projection.

---

## Decisions

| # | Decision |
|---|---|
| **D41** | **`overdue` and `p1/p2/p3` are *virtual* labels, computed at render — never stored.** They render as chips beside real tags and (in slice 2) filter identically, so the board reads like GitHub's labels. But nothing writes them. **Why:** a stored `overdue` tag needs something to write it when a task tips over at midnight — and every such write bumps `version`, which rewrites the task file, which with the git mirror on makes the bot **commit**. A hundred tasks going overdue is a hundred commits on an idle vault: exactly the failure D33 exists to prevent. It would also make `tags` half machine-owned, so an agent deleting `overdue` would have it silently re-added. `priority` and `due` stay **real fields** — the board still sorts by them and the agent still writes them. Agreed with Nicolai 2026-07-14. |
| **D42** | **A board cell is `(column, lane)`, and one drop is one patch.** Dropping a card into a cell sets `status` **and** `area` together, in a single `tasks.update`. The PRD describes the two drag axes separately; implementing them as separate mutations would make a diagonal drag two writes, two pushes, two file rewrites and (mirrored) two commits — and a half-failed pair leaves the card somewhere nobody dropped it. |

## Contract

**The pipe (main → renderer).**
- `vault-manager.ts`'s SSE `onEvent` currently routes `docs` and `tasks` only — **the `presence` frame arrives today and is dropped on the floor.** Route it.
- Two new push channels, via the existing `pushChannel` helper in `preload/index.ts`: `tasks:event` (`TasksEvent`) and `tasks:presence` (`PresenceEvent`). Main forwards each SSE frame straight through; it does not reshape them.
- The renderer loads the initial set with `tasks.list` + `folders.list` on vault activate, then applies pushes. **Do not** have the renderer subscribe to SSE itself: one connection per vault, owned by main, is the invariant.

**Renderer state** (`state/tasks.ts`, jotai — the `state/sync.ts` shape):
- `tasksAtom: Map<taskId, Task>` — seeded by `tasks.list`, then `upserted` → set, else → delete. Read the union exactly as the projector does; **do not widen it** (D36).
- `foldersAtom: Map<folderId, path>` — lane labels. Folders have no SSE channel of their own, so re-fetch on vault activate (a folder appearing mid-session is the known staleness; the projector has the same snapshot problem and refreshes on demand).
- `presenceAtom: Map<taskId, PresenceEntry[]>` — each entry carries `expiresAt`. **Entries expire client-side**; a ~2s interval prunes. A heartbeat that stops arriving *is* the release — there is no "stopped editing" event and there must not be one.

**Virtual labels** — `packages/shared/src/labels.ts`, a pure function: `virtualLabels(task, today) -> string[]`.
- `overdue` when `due` is set, `due < today`, and `status !== 'done'`.
- `p1` / `p2` / `p3` from `priority` high / medium / low.
- Pure and shared because slice 2's filter bar and (possibly) `task_list` want the same answer. Unit-test the boundaries: due === today is **not** overdue; a done task is never overdue; no `priority` yields no `pN`.

**The grid.**
- Columns: **Todo / Doing / Done**, fixed. Lanes: one per `area`, **"(no area)" first**, then alphabetical by folder path.
- Lanes are drawn from the union of *folders that have tasks* and the "(no area)" lane. (The **lane-depth** control in the PRD is slice 2 — do not build the depth grouping yet, but do not design it out.)
- **Card:** title, `due`, virtual labels, real tags, presence, and exactly **one** affordance — the **complete checkbox**. Everything else opens the detail view (slice 2; until it exists, the card click is inert). Keep the card scannable.
- **Completing goes through `tasks.complete`, never a `status: 'done'` patch.** `complete` is the single roll-forward path: a recurring task must roll, not persist `done`. A patch would silently skip the roll.
- **Quick-add** per cell: title only, creating with that cell's `status` and `area` prefilled.
- **No "N excluded" count** — nothing is hidden into unselected buckets, so there is nothing to reconcile.

**Optimistic writes.** Patch the atom, roll back on failure. The server push remains the one authoritative update — do not treat the mutation's return value as truth-by-another-name; let the push land.

## Tasks

- [x] **1** `packages/shared/src/labels.ts` + tests. Pure, no deps. Commit.
- [x] **2** The pipe: route `presence` in `vault-manager`'s SSE handler; add the two push channels (main → preload → renderer). Test the routing in main (a `presence` frame reaches the sender; a `tasks` frame still reaches the projector).
- [x] **3** `state/tasks.ts`: the three atoms, seeded by `tasks.list` / `folders.list`, updated by pushes, with presence expiry. Test the reducer: upsert, delete, presence expiring on its own.
- [x] **4** `BoardView.tsx`: the grid, lanes, cards, virtual-label chips, presence indicator, complete checkbox, quick-add. A view toggle in `Shell.tsx` (Notes ↔ Board).
- [x] **5** Drag: one drop = one `tasks.update` carrying `{status, area}` (D42). Optimistic, rolled back on failure.
- [x] **6** `pnpm -r test` + `pnpm -r typecheck` + `pnpm --filter @holi/desktop build`. Then the **real app**: two changes arriving from outside the board must reflow it live — (a) edit a task **file** on disk (the agent's path) and watch the card move; (b) complete a **recurring** task from the card and watch it roll forward and return to Todo.
- [x] **7** `prd/tasks.md`: close the "filter bar minimal set" and "board card affordances" open questions; record D41/D42 in `docs/decisions.md` (next free is D41 → after this, D43).

## Gotchas

- **Do not widen `TasksEvent`** to carry presence (D36). It is read as `if (upserted) … else remove(taskId)`; a third variant would fall into the `else` — in the projector that deletes the task's **file**.
- **Presence has no release event.** Do not add one. Expiry *is* the release, and that is the whole reason tasks need no locks.
- **A user and their agent are one identity** (D37) — there is no `actor` field, so the board must not try to render "Claude" separately from "Nicolai". "Nicolai is editing this task" is true when Nicolai's Claude is editing it.
- **The complete checkbox is not a status write.** See above — it is the recurrence roll path.
- **Nothing on the board may parse a task file.** The board reads Postgres via tRPC, like everything else. The projection is one-directional and the file is never an index.
- **`area` is a folder id on the record**, rendered as the folder's path. A lane label resolves through `foldersAtom`; a task whose folder the renderer does not know yet must not vanish — fall it into "(no area)" rather than dropping the card.
