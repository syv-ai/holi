# The board, slice 2 — the detail view, the filter bar, the heartbeat

> **For agentic workers:** use the executing-plans skill. Steps are checkboxes. This plan is **lean by design** — it states contracts, decisions and gotchas. Derive the code.

**Goal:** the board becomes comfortable. Click a card and edit the task; narrow the board with search / tags / a done-toggle; and when *you* type, your teammates see "Nicolai is editing this task" — the mirror of what the agent already emits.

**Slice 1** (`docs/plans/2026-07-14-board-slice1.md`) shipped the pipe, the grid, drag, quick-add, virtual labels and presence *rendering*. This finishes the surface.

**Spec:** `prd/tasks.md` §Board UX · §Task file projection (presence).

---

## Decisions

| # | Decision |
|---|---|
| **D43** | **The lane-depth control is deferred, and not for effort reasons.** The PRD offers a depth control that collapses `projects/a` and `projects/b` into one `projects` lane. Grouping is trivial; **dropping is not** — a collapsed lane has **no unambiguous `area` to write**. Dragging a card into a merged `projects` lane cannot say *which* folder it lands in, so the horizontal axis (a real write, and the whole reason `area` is settable) becomes undefined exactly when the control is on. Shipping it would mean either a silent guess or a lane that accepts no drops. Deferred until there is an answer; the lane machinery does not design it out. |

## Contract

**Detail view** (`TaskDetail.tsx`, a right-hand panel or overlay — not a modal that traps focus).
- Opens on card click (slice 1 left the click inert). Closes on Escape / a close button.
- Edits `title`, `status`, `area`, `due`, `priority`, `tags`, `description`. `reminder` and `recurrence` are **text fields carrying the grammar verbatim** — the shared parser already rejects bad input and its error string doubles as the format doc; do not build a rule builder UI.
- **Sends no `version`** — the board is plain last-writer-wins, exactly as `prd/tasks.md` specifies and as slice 1's drag already does. The version token is for *file* writes, where the writer edited a snapshot that may have moved.
- **`description` is a plain `<textarea>`.** It is a plain column, **not a CRDT doc** — do not reach for Yjs, and do not route it through the DocBridge. Debounce the save (~600ms of quiet).
- **`area` is a folder picker** over `foldersAtom`, plus "(no area)". The record stores a folder **id**; the UI shows the **path**.
- Delete lives here, not on the card.

**Filter bar** — exactly three controls (settled, `prd/tasks.md` §Board UX): **text search**, **tag filter**, **done toggle**. Nothing else.
- **One vocabulary:** the tag filter matches **virtual labels and real tags identically** (`allLabels`, D41). "Show me the overdue p1s" is a tag query, not a bespoke control — that is the whole point of computing the labels.
- Search matches `title` **and** `description`.
- The done toggle hides the Done column's contents, not the column.
- **No "N excluded" count.** Nothing is hidden into unselected buckets; the empty state distinguishes "no tasks yet" from "nothing matches your filters".
- Filtering is **pure and testable**: `matchesFilter(task, filter, today) -> boolean` next to the other reducers. The component only wires it.

**The heartbeat** (the renderer half of presence — the agent's half shipped in slice 2 of the projection).
- `tasks.heartbeat({ taskId })` while the user is **actually editing** in the detail view — driven by **keystrokes/changes, not focus**. Merely having the panel open is not editing, and a heartbeat that fires on focus would light up a card because someone glanced at it.
- Cadence ~4s while typing, against the server's 10s TTL — comfortably inside it, and it simply stops when the typing does. **A heartbeat that stops arriving IS the release.** Do not send a "stopped" event; there is no such thing and adding one would rebuild the lock lifecycle presence exists to avoid.
- Never `await` it into a write path: presence failing must not cost the user an edit.

## Tasks

- [x] **1** `matchesFilter` in `state/tasks.ts` + tests (search hits title and description; the tag filter matches a *virtual* label; the done toggle). Pure.
- [x] **2** `FilterBar.tsx` + a `filterAtom`; `BoardView` filters its cells through it. Empty state distinguishes "no tasks" from "nothing matches".
- [x] **3** `TaskDetail.tsx`: the fields above, debounced description, folder picker, delete. Card click opens it.
- [x] **4** The heartbeat: fires on edit, ~4s cadence, stops on its own. Test it is **not** sent on mere focus.
- [x] **5** `pnpm -r test` + `pnpm -r typecheck` + `pnpm --filter @holi/desktop build`. Then the **real app**: type in the detail view and assert a `presence` frame reaches a *second* subscriber (the SSE stream) carrying the user's identity — i.e. what a teammate would see.
- [x] **6** Docs: close the lane-depth question in `prd/tasks.md` with D43; record D43 in `docs/decisions.md` (next free is D43 → after this, D44).

## Gotchas

- **A user and their agent are one identity** (D37). The heartbeat carries no `actor`, and the card must not try to say "Claude" vs "Nicolai" — "Nicolai is editing this task" is *true* when Nicolai's Claude is editing it.
- **The description is not a CRDT.** Character-merging it would drag the whole merge problem back in for the least structured field of the least contended record.
- **Completing still goes through `tasks.complete`** — from the detail view too. A `status: 'done'` patch skips the recurrence roll.
- **Do not add a version to board writes.** Last-writer-wins per field is the specified rule here; the token belongs to the *file* path.
- **Do not widen `TasksEvent`** (D36).
