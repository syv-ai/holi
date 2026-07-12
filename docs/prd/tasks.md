# PRD — Tasks

Tasks in Holi are **structured server records** surfaced on a **stripped board**. A task is not a file: it lives on the Syv server — queryable, shareable, real-time. The data spine is in [`../architecture.md`](../architecture.md) §5 and the storage tables in [`server-data.md`](server-data.md).

Simplicity is a primary goal of this design, and this document specifies what tasks *are* and — just as deliberately — what the design excludes.

## Summary

A task is a first-class **structured record on the Syv server**. The trimmed shape is `title, status, area, due, priority, tags, reminder, recurrence, related[]`. `area` is a **real, settable folder reference** driving swim lanes. The default surface is a **stripped kanban board** — Todo / Doing / Done, swim lanes by `area`, a simple filter bar. Recurrence and reminder **rules** live in `packages/shared` as pure functions; the **server** evaluates reminders and pushes fire events that clients raise as native notifications. Roll-forward runs server-side on completion. The agent manipulates tasks via a handful of role-gated MCP ops (see [`agent.md`](agent.md)).

**Why records, not files:** tasks are inherently structured, and the agent already manipulates them via ops rather than file edits; server records make shared task boards and real-time updates trivial. A file representation is the source of exactly the parsing, scanning, and dual-persistence complexity this design avoids. **Rejected:** markdown-file tasks; structured records with inline note-checkbox sync (reintroduces note↔task coupling).

**One consequence, accepted for v1:** tasks never appear in the vault's git-mirror repo, so remote Claude Code (cloud) sessions can't see or edit tasks. A read-only task export is a possible future addition.

## Goals / Non-goals

**Goals**

- **Simple by construction:** one board layout, one relation list, one persistence path, one settable `area`, no derived fields, no full-vault file scans, no client-side scheduler loop. Every item in [What the design deliberately excludes](#what-the-design-deliberately-excludes) is a goal.
- Tasks are **live** across a shared vault: creating/moving/completing a task on one member's board appears on everyone's within a round-trip (tRPC + server push).
- `area` is a **real field you can set and drag** — cross-lane drops actually move the task.
- Recurrence + reminder **math is ported verbatim** from the old repo (it's well-tested) into `packages/shared`, evaluated server-side for reminders.
- The agent creates/updates/completes/links tasks through typed, role-gated ops.

**Non-goals (v1)**

- **No time-grouped board view** ("Today / This week / Later") and **no multi-bucket date system** — deferred, see [Deferred](#deferred).
- **No inline note-checkbox ↔ task sync** — explicitly rejected: it reintroduces note↔task coupling.
- **No content import** — v1 starts empty; a markdown-task-folder → record importer is deferred, bundled with the generic markdown import.
- **No per-op capability modes** — permissions are role-gated server-side by vault membership, not a safe/power-user toggle.
- **No remote-agent task access** — tasks aren't in the git mirror; the local agent's ops are the only agent path to tasks.

## What the design deliberately excludes

Each of these is a feature of the design, not an omission:

- **No task files.** A task has no on-disk representation, so there is nothing to parse, scan, or watch. Records are queried from Postgres — no full-vault walks, no parse-failure warnings to surface.
- **No derived `area`.** `area` is a stored, settable folder reference. **Why:** a derived area (the parent folder of an owning note) can't be set and makes cross-lane drag impossible — lanes become un-draggable, and "moving" a task's area would mean re-pointing a note. **Rejected:** a per-vault defined area list and free-text areas — the folder-reference model preserves the doc-centric organization the swim lanes exist for.
- **No "home note".** A task belongs to no note; note links are ordinary `related[]` entries. Deleting a note therefore can't orphan a task — a dangling ref just renders as a tombstone. No orphan-rescue flow exists because orphans can't.
- **One relation list.** `related[]` is a single tagged union covering notes, tasks, emails, and events.
- **One write path.** Every mutation is a tRPC call, and the server push is the single authoritative update — no parallel cache-rebuild path. Recurrence roll-forward runs once, server-side on completion; there is no file-edit backdoor requiring a reconciliation sweep.
- **One board layout.** No view modes, no date buckets, no per-user column configuration. **Why:** a multiplied config space (view modes × date buckets × swim lanes × a stack of filters) is the interaction-level source of "not simple"; a single default layout with lanes is the biggest intuitiveness win.
- **No hidden-bucket bookkeeping.** Nothing on the board silently drops tasks into unselected buckets, so there is no "N tasks excluded" count to reconcile.
- **No client-side reminder scheduler.** The server evaluates and pushes; clients only raise the notification.
- **Status vocabulary:** `todo | doing | done` (glossary).

## User stories

- As a member, I open a vault and see the board — Todo / Doing / Done, one lane per area — with no configuration.
- I drag a card from Todo to Doing; the status changes and every other member's board updates live.
- I drag a card from the `projects/q2` lane to the `personal` lane; the task's `area` is re-set to `personal`.
- I create a task from a note; its `area` defaults to that note's folder, and the note is linked in `related[]`. I can change the area.
- I quick-add "Call the vendor" from the board with nothing else filled in; it lands in Todo with no area.
- I `@`-mention a task inside a note; the note is added to the task's `related[]` and the task shows the note as a related link.
- I set a recurring task (weekly, Mon/Wed/Fri); when I complete it, the server rolls it to the next occurrence and it reappears in Todo.
- I set a reminder "1d" on a due-dated task; the server fires a native notification the day before at 09:00, even if my app was closed at the moment.
- I ask the agent "make me a task to review the Q2 doc, due Friday, high priority"; it creates the record and it appears on my board.
- As a member, I can create and mutate tasks; the agent can too on my behalf (gated to vault members and owners). There is no read-only role — everyone with vault access can edit (see [`vaults-collaboration.md`](vaults-collaboration.md)).

## Data & types

The **canonical `Task` type lives in `packages/shared`**, imported by both `apps/desktop` and `apps/server` — no codegen across the client↔server seam. Storage tables (`tasks`, `reminders`) are specified in [`server-data.md`](server-data.md); this section is the domain shape.

```ts
// packages/shared
type TaskStatus = 'todo' | 'doing' | 'done'
type Priority   = 'low' | 'medium' | 'high'

type Task = {
  id: string
  vaultId: string
  title: string
  status: TaskStatus
  area?: string          // stable folder ID, displayed as the folder's path — drives swim lanes
  due?: string           // YYYY-MM-DD
  priority?: Priority
  tags: string[]
  reminder?: string      // Nd | Nw | YYYY-MM-DDTHH:MM  (see Recurrence & reminders)
  remindedAt?: string    // RFC3339 of last fire; server-written (see reminders)
  recurrence?: Recurrence
  related: RelatedRef[]  // unified: note | task | email | event
  createdAt: string
  updatedAt: string
}

type Recurrence = {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number       // default 1
  weekdays: Weekday[]     // weekly-with-weekdays; empty = plain interval
  endDate?: string        // YYYY-MM-DD; rolling stops past this
}
type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

type RelatedRef =
  | { kind: 'note';  docId: string }                             // stable doc ID, rendered as the current path
  | { kind: 'task';  taskId: string }
  | { kind: 'email'; accountId: string; threadId: string; subject: string }
  | { kind: 'event'; accountId: string; calendarId: string; eventId: string; title: string; startUnix: number }
```

Notes on the shape:

- **`title`/`description`.** A task has no markdown body; it *is* its structured fields. A short optional free-text `notes`/`description` string may be kept as a plain column if the detail view needs it — but it is *not* a markdown document and has no wiki-link semantics. (Open question below.)
- **`related[]` is one unified list.** `RelatedRef` is a tagged union; every variant references its target by **stable ID** — doc ID for notes, task ID, account/thread/event IDs for email/event — with the UI resolving to the current path/title at render time. The principle: machine references use stable IDs; human prose uses paths. Note renames therefore never touch task records. **Rejected:** path references in records plus a cross-store transactional rewrite on rename (distributed-transaction machinery across the doc store and SQL — the exact fragile seam to avoid), and a background path reconciler (transient dangling refs). The email/event variants carry cached `subject`/`title` fields for offline rendering — email/event linking arrives with the phase-2 Gmail/Calendar sync, but the variants are reserved now so the board and ops don't reshape later.
- **`area` is optional and settable.** Empty/absent = the root lane ("no area"). It stores a **stable folder ID**, displayed as the folder's path; the vault's real folder hierarchy (needed anyway for wiki-links and the file tree, architecture §6) is what it references. Folder renames cascade to lane labels automatically — no task record is touched. Nothing derives it.
- **`remindedAt` is server-written** and re-armable — see reminders.

## Board UX

Default and only board layout in v1.

- **Columns:** **Todo / Doing / Done**, fixed. No time-bucket view mode; no date-group system; no per-user column customization.
- **Swim lanes by `area`:** one horizontal lane per area (folder). A **lane-depth** control groups by the first *N* path segments — depth 1 collapses `projects/a` and `projects/b` into one `projects` lane; higher depth splits them. The "(no area)" lane sorts first, then alphabetical by path. Lanes are the organizing concept the user values; they are the *only* grouping axis in v1.
- **Filter bar:** a **simple** bar — text search, tag filter, and a done/hide toggle at minimum. It deliberately excludes overdue-only, high-priority-only, recurrence-window, and time-bucket-selection controls unless a specific one earns its place; the bar is a search-and-narrow aid, not a second configuration surface.
- **Drag semantics (both axes are real writes):**
  - **Vertical (between columns):** drag sets `status` (`todo`↔`doing`↔`done`). Dropping into Done triggers completion (recurrence roll-forward, server-side).
  - **Horizontal (between lanes):** drag **re-sets `area`** to the target lane's folder (stored by its stable ID). This works precisely because `area` is a settable field, not a derivation.
  - **No "N excluded" count.** Because v1 doesn't hide tasks into unselected buckets, the board shows what's there; the empty state distinguishes "no tasks yet" from "nothing matches your filters."
- **Live:** the board subscribes to server task pushes for the active vault, so a teammate's drag/create/complete reflows lanes and columns in real time.

## Task lifecycle & flows

**Create — entry points:**

- **From the board:** a quick-add on any column/lane creates a task with that column's `status` and that lane's `area` prefilled; title only, everything else optional.
- **From a note:** creates a task with `area` defaulting to the note's folder and the note added to `related[]` (`kind: 'note'`). Area is freely changeable afterward.
- **From an `@`-mention in a note:** mentioning an existing task links the note into that task's `related[]` (idempotent), implemented as a task op — port the link-on-mention behavior from the old repo's `linkTaskToActiveNoteAtom`.
- **From the agent:** `task_create` MCP op (below).
- **Quick-add (global):** create a bare task from anywhere; no area, Todo status.

**Edit:** any field via the detail view or inline board affordances; each edit is a tRPC mutation. Optimistic UI is fine (patch the atom, roll back on failure) but the server push is the **one** authoritative path.

**Complete:** setting `status = done`. If the task is recurring, the server rolls it forward instead of persisting `done` (see below) and it returns to Todo at its next occurrence.

**Delete:** removes the record. A deleted task simply disappears from any note's backref view; a deleted *note* leaves its `related[]` entry dangling, rendered as a tombstone ("[deleted note]") — no cascade, no orphan rescue.

**Drag:** covered under [Board UX](#board-ux) — status change (vertical) and area change (horizontal), both real mutations.

## Recurrence & reminders

The **pure rule functions port verbatim** from the old repo's Rust into `packages/shared` (TS), with their existing test suites carried over — the recurrence and reminder math is well-tested; do not rewrite it from scratch. The rules run identically on client and server.

**Recurrence (rules in `packages/shared`; roll-forward server-side):**

- `nextDue(currentDue, rule)` → next `YYYY-MM-DD` or `null` (bad date / past `endDate`). Handles daily/weekly/monthly/yearly with `interval`, weekly-with-weekdays (same-week scan for interval 1; jump-to-target-week for interval > 1), month/year day-clamping (Jan 31 + 1mo → Feb 28; Feb 29 → Feb 28), and `endDate` cutoff.
- `nextDueCatchup(currentDue, rule, today)` → advances until on-or-after `today` for a stale/overdue completion, using the closed-form leap + bounded iteration (so a decade-stale daily task doesn't silently vanish). Port both, and the leap/clamp edge cases the old tests pin.
- **Roll-forward** runs **server-side on completion**: when a recurring task is marked `done`, the server advances `due` via `nextDueCatchup`, shifts an **absolute** reminder by the same day-delta (relative reminders re-resolve against the new `due` on their own), and flips status back to `todo`. This is the *single* roll-forward path — there is no file-edit backdoor, so no secondary sweep exists.

**Reminders (rules in `packages/shared`; evaluation + push server-side):**

- **Grammar (ported):** relative `Nd` / `Nw` = *N* days/weeks before `due`, resolving to the **09:00 anchor** on the resolved date; or absolute local `YYYY-MM-DDTHH:MM` (seconds optional). Parsing rejects `+1d`/`-1d`/`1h`/bare dates — the parse error string doubles as the agent-facing format doc. A relative reminder with no parseable `due` is **inert**, never an error.
- **Pending rule (ported):** a reminder is pending when the task is open (`status != done`) ∧ the reminder resolves ∧ `remindedAt < resolvedFireTime`. Re-arming after recurrence rollover falls out of this automatically (a rolled-forward due moves the fire-time past the last `remindedAt`); nothing is ever cleared on rollover. **Setting** a reminder clears `remindedAt` so a re-set earlier time can fire again.
- **Server-side evaluation + push:** because tasks are server records, the **server** owns reminder scheduling — it computes the earliest pending fire across a vault's tasks, and on fire **pushes** an event to the members it concerns; the client raises a **native Electron notification**. There is no client-side scheduler loop, no per-client fire bookkeeping, and no client-side missed-reminder pass — the server does this once, centrally, and clients that were offline get the pending/missed fire on reconnect. `remindedAt` is written by the server when it fires.

## Agent integration

The agent manipulates tasks through **typed MCP ops** served by the local MCP server in Electron main, proxying to the Syv tRPC API (see [`agent.md`](agent.md)). Tasks are the canonical example of "not a plain file, so it needs an op" — the MCP surface exists only for what the agent's native file tools can't reach. Five ops:

- **`task_create`** — title (+ optional status, area, due, priority, tags, reminder, recurrence). Recurrence accepts an ergonomic dual encoding (a bare frequency word `daily|weekly|monthly|yearly` **or** a full JSON object); due accepts sugar (`today`, `+3d`, `+1w`, ISO). Port the natural-value parsing from the old repo so the agent passes `"done"`/`"high"` without seeing enum names.
- **`task_list`** — role-gated read; filter by status / priority / due window / tags; default excludes `done` (the agent overwhelmingly wants open work); a slim projection that drops empty fields to protect context.
- **`task_set`** — update fields; empty-string clears; add/remove arrays mutate `tags` and `related[]`. Re-setting a reminder clears `remindedAt`.
- **`task_complete`** — convenience for `status = done` (triggers server-side roll-forward for recurring tasks).
- **`task_link`** — unified linker: add a `RelatedRef` (note — stored by stable doc ID; the op accepts a path and resolves it / task id / — phase 2 — email/event) to `related[]`.

**Role gating:** all task ops are gated **server-side by vault membership** — any **member** (or owner) can read and write tasks; a non-member is rejected. There is **no viewer/read-only role**, and no per-op capability flags or safe/power-user mode — membership is the whole permission model. The client can't grant the agent access the signed-in user doesn't have (architecture §3, §9).

**Remote agents:** tasks are not exported to the vault's git mirror ([`../specs/2026-07-13-vault-git-mirror-design.md`](../specs/2026-07-13-vault-git-mirror-design.md)), so Claude Code cloud sessions operating on the mirrored repo can neither see nor edit tasks. Accepted for v1; a read-only task export into the mirror is a possible future addition (see [Deferred](#deferred)).

## Edge cases & risks

- **Deleting a note that a task links to:** the `related[]` entry goes dangling and renders as a tombstone ("[deleted note]"); the task survives (no cascade, no orphan rescue). Backrefs are a server query over the link index / task records, not a full scan.
- **Folder renamed or deleted:** `area` stores a stable folder ID, so a rename cascades to the lane label automatically — no task record is touched, and `note_rename` is a docs-only operation that never rewrites task refs. A *deleted* folder's lane renders by its last-known path (tombstone-style); the task isn't lost.
- **Offline task edits:** unlike notes (CRDT auto-merge), tasks are last-writer-wins per field over tRPC. Two members editing the *same* field of the *same* task while one is offline → last write wins on reconnect; different fields/tasks don't collide. No conflict UI — consistent with the notes philosophy (offline changes merge automatically; the UI shows only a sync-status indicator, never a conflict dialog), though tasks aren't CRDTs.
- **Reminder fires while all clients offline:** server records the fire (`remindedAt`) and pushes the missed reminder on next connect; no client-side missed-pass needed. Decide whether a flood of missed reminders collapses to a summary — server-side now. (Open question.)
- **Recurrence math parity:** client and server both import the shared rules, but only the **server** rolls forward on completion — the client must not also roll forward optimistically (double-advance risk). Keep roll-forward server-authoritative; the client just shows the returned record.
- **Stale/decade-old recurring task completed:** `nextDueCatchup` must land on-or-after today (ported edge cases: closed-form leap, month-clamp back-off, iteration cap). Carry the old regression tests.
- **Timezone:** the rules are pure, with `now`/`today` passed in and TZ conversion at the scheduler edge. Server-side evaluation must fix the anchor timezone (per-user vs vault) — the 09:00 anchor is *local wall-clock*; decide whose local. (Open question.)

## Dependencies

- **[`server-data.md`](server-data.md)** — the `tasks` and `reminders` tables, the tRPC task router (create/list/set/complete/link + the push/subscription channel), and role checks. Task sync + reminder evaluation live here.
- **[`notes-editor.md`](notes-editor.md)** — vault folder hierarchy (what `area`'s folder IDs resolve against) and the `[[wiki-link]]` grammar for prose note links. `note_rename` is **docs-only** — it never touches task records.
- **[`agent.md`](agent.md)** — the MCP ops server, per-run bearer token, and role gating that the task ops plug into.
- **[`vaults-collaboration.md`](vaults-collaboration.md)** — membership/roles that gate every task mutation and the presence/live-update expectation for shared boards.

## Open questions

- **Task `description`/`notes`:** a task record has no markdown body — keep a short free-text field, or none at all? Does the detail view need any prose, and if so is it plain text or does it get wiki-link/mention rendering? (Leaning: optional plain-text `notes`, no document semantics.)
- **Reminder anchor timezone** for server-side evaluation: the user's local, the vault owner's, or a per-user setting? The 09:00 anchor is wall-clock and needs a fixed frame.
- **Filter bar minimal set:** exactly which controls survive beyond search + tags + done-toggle? Does `priority` or `overdue` earn a slot, or does that reintroduce config creep?
- **Missed-reminder collapse:** should more than a handful of missed reminders collapse into a single summary notification, and is that per-user or per-vault?
- **Board card affordances:** what inline edits (priority, due, complete-checkbox) live on the card vs. only in the detail view, to keep the card scannable?

## Deferred

- **Time-grouped secondary board view** ("Today / This week / Later") — can return post-v1 as an *option*, not a mode the user must configure. If it returns, the target is a small fixed set of groups, not a large date-bucket taxonomy with overlapping-predicate bucketing.
- **Email/Calendar `related[]` linking** — the `RelatedRef` email/event variants are reserved now, but wiring them up depends on the **phase-2 Gmail/Calendar sync** (built on Google APIs under the same OAuth).
- **Inline note-checkbox ↔ task sync** — explicitly rejected for v1; would reintroduce note↔task coupling.
- **Markdown task import** — an importer that maps old task files (`.holi/tasks/*.md`) to records, bundled with the generic markdown-import path.
- **Read-only task export to the git mirror** — would let remote Claude Code sessions at least *read* tasks; write access would re-open the file↔record round-trip complexity and is not planned.
