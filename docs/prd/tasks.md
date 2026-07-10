# PRD — Tasks

Tasks in the rebuilt Holi. The old system made a task a markdown file on disk, and everything painful about tasks followed from that one choice. This PRD specifies the replacement: **structured server records** with a **stripped board**. Decisions referenced as **D#** live in [`../decisions.md`](../decisions.md); the data spine is in [`../architecture.md`](../architecture.md) §5 and the storage tables in [`server-data.md`](server-data.md).

Simplifying tasks is a **primary goal** of the rebuild — the old system was "not simple/intuitive enough," and this document is as much about what we *delete* as what we build.

## Summary

A task becomes a first-class **structured record on the Syv server** (D4) — queryable, shareable, real-time — instead of a `.md` file at `.holi/tasks/<uuid>.md`. The trimmed shape is `title, status, area, due, priority, tags, reminder, recurrence, related[]`. `area` is reborn as a **real, settable folder reference** driving swim lanes (D4a). The default surface is a **stripped kanban board** — Todo / Doing / Done, swim lanes by `area`, a simple filter bar — with the old two-view / ten-date-bucket config space deleted (D4b). Recurrence and reminder **rules** move to `packages/shared` as pure functions; the **server** evaluates reminders and pushes fire events that clients raise as native notifications (D19). Roll-forward runs server-side on completion. The agent manipulates tasks via a handful of role-gated MCP ops (D10).

## Goals / Non-goals

**Goals**

- **Simpler than the old system**, concretely: one board layout, one relation list, one persistence path, one settable `area`, no derived phantoms, no full-vault file scans, no client-side scheduler loop. Every item in [What we're removing](#what-were-removing) is a goal.
- Tasks are **live** across a shared vault: creating/moving/completing a task on one member's board appears on everyone's within a round-trip (tRPC + server push, D4).
- `area` is a **real field you can set and drag** — cross-lane drops actually move the task (D4a).
- Recurrence + reminder **math is ported verbatim** (it's well-tested) into `packages/shared`, evaluated server-side for reminders (D19).
- The agent creates/updates/completes/links tasks through typed, role-gated ops (D10).

**Non-goals (v1)**

- **No time-grouped board view** ("Today / This week / Later") and **no 10-bucket date system** (D4b) — deferred, see [Deferred](#deferred).
- **No inline note-checkbox ↔ task sync** — reintroduces the note↔task coupling D4 explicitly rejected.
- **No content import** — tasks start empty (D16); a `.holi/tasks/*.md` → record importer is deferred.
- **No safe/power_user task modes** — permissions are role-gated server-side (D10), not a per-op capability toggle.

## What we're removing

A concrete list against the old system (files cited from `~/repos/holi`). This is the point of the rebuild.

| Removed | What it was | Why it goes |
| --- | --- | --- |
| **File-based tasks** | `.md` at `.holi/tasks/<uuid>.md`, YAML frontmatter + markdown body; `id` from filename, `description` from body (`models/task.rs`, `task_repository.rs`). | The file representation was the *source* of the complexity (D4). Records are structured natively. |
| **The `area` phantom** | `area` was derived at read time from `source_file`'s parent folder (`task_repository::area_from_source_file`); any `area:` in YAML was ignored; you couldn't set it. | Reborn as a settable folder ref (D4a). |
| **Cross-lane drop no-op** | `KanbanView.handleCardMove` early-returned on any cross-lane drop because `area` was tied to the source note — "moving" an area meant re-pointing the note. | Drag-between-lanes now re-sets `area` (D4a). |
| **`source_file`-as-home** | Every task carried a `source_file`; it drove area derivation, daily-note badge counts, file-tree badges, mention chips. | Replaced by ordinary membership in `related[]` (D4). No task "lives inside" a note anymore. |
| **Orphan rescue** | `OrphanRescueHost` / `OrphanRescueDialog` caught tasks whose `source_file` note was deleted and forced the user to re-point or delete them (`useDetectOrphans`, `App.tsx`). | With no `source_file`-as-home, deleting a note can't orphan a task — the dangling `related[]` ref just renders as a tombstone (D27). Entire subsystem deleted. |
| **Four separate relation arrays** | `related_tasks`, `related_nodes`, `related_emails` (`RelatedEmail`), `related_events` (`RelatedEvent`) + the special `source_file` (`models/task.rs`). | Collapsed to one unified `related[]` (D4). |
| **Dual roll-forward persistence paths** | Synchronous rollover in `save_task` *and* a watcher sweep `roll_forward_completed_recurring` (fired via `FileChanged` → `reload_vault`) to catch direct `Edit`/`Write`/git-pull edits that bypassed `save_task` (`task_service.rs`). | Records have one write path (tRPC mutation) — roll-forward runs once, server-side on completion. |
| **Full-vault file scans** | `task_repository::scan` walked `.holi/tasks/` on load and on every task-file `FileChanged`; `verify_parse` re-parse guard; `scan_warnings` for unparseable files. | Records are queried from Postgres — no disk walk, no parse failures to surface. |
| **Two frontend persistence paths** | Optimistic `tasksAtom` patch in `saveTaskAtom`/`deleteTaskAtom` *plus* a `tasks:updated` listener rebuilding the cache from a fresh disk scan. | One path: mutate → server pushes the authoritative record → atoms update. |
| **The board config space** | 2 view modes (`status`/`time`) × 10 `DateGroup` buckets × swim lanes × ≥5 filters (`area`, `tags`, `search`, `highPriorityOnly`, `overdueOnly`, `showDone`, `recurrenceWindow`) + `laneDepth`, with overlapping-predicate first-match bucketing (`taskBuckets.ts`, `kanbanFilters.ts`). | The interaction-level source of "not simple." One default layout (D4b). |
| **The "N excluded" band-aid** | KanbanView computed `excludedCount` because time-view buckets and hidden columns silently dropped tasks — a UI patch over a UI problem. | No hidden-bucket drops in v1, so nothing to reconcile (D4b). |
| **Client-side reminder scheduler** | `reminder_scheduler.rs`: a tokio loop computing the min pending fire-time across vaults, sleeping/waking on a change signal, firing `tauri-plugin-notification`, persisting `reminded_at`, with a >5 missed-reminder summary pass. | Server evaluates + pushes; clients only raise the notification (D19). |
| **Status rename** | `todo \| in_progress \| done` → **`todo \| doing \| done`** (glossary). | Stripped-board vocabulary. |

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
- As a member, I can create and mutate tasks; the agent can too on my behalf (role-gated to members/owners, D10). There is no read-only role (D7).

## Data & types

The **canonical `Task` type lives in `packages/shared`** (D15), imported by both `apps/desktop` and `apps/server` — no codegen (the old `ts-rs` pipeline is gone). Storage tables (`tasks`, `reminders`) are specified in [`server-data.md`](server-data.md); this section is the domain shape.

```ts
// packages/shared
type TaskStatus = 'todo' | 'doing' | 'done'          // was todo|in_progress|done
type Priority   = 'low' | 'medium' | 'high'

type Task = {
  id: string
  vaultId: string
  title: string                                       // was `name`
  status: TaskStatus
  area?: string          // stable folder ID (D27), displayed as the folder path — drives swim lanes (D4a)
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
  | { kind: 'note';  docId: string }                             // stable doc ID (D27), rendered as the current path
  | { kind: 'task';  taskId: string }
  | { kind: 'email'; accountId: string; threadId: string; subject: string }
  | { kind: 'event'; accountId: string; calendarId: string; eventId: string; title: string; startUnix: number }
```

Notes on the shape:

- **`title`/`description`.** The old `description` was the markdown body of the task file. Records have no file body; a task is its structured fields. A short optional free-text `notes`/`description` string may be kept as a plain column if the detail view needs it — but it is *not* a markdown document and has no wiki-link semantics. (Open question below.)
- **`related[]` is one list** (D4). The four old arrays + `source_file` collapse into it. `RelatedRef` is a tagged union; every variant references its target by **stable ID** (D27) — doc ID for notes, task ID, account/thread/event IDs for email/event — with the UI resolving to the current path/title at render time. Note renames therefore never touch task records. The email/event variants keep the same cached `subject`/`title` fields the old `RelatedEmail`/`RelatedEvent` carried (for offline rendering) — email/event linking is **phase 2** (Gmail/Calendar, D17) but the variants are reserved now so the board and ops don't reshape later.
- **`area` is optional and settable.** Empty/absent = the root lane ("no area"). It stores a **stable folder ID** (D27), displayed as the folder's path; the vault's real folder hierarchy (needed for wiki-links and the file tree anyway, architecture §6) is what it references. Folder renames cascade to lane labels automatically — no task record is touched. Nothing derives it.
- **`remindedAt` is server-written** and re-armable — see reminders.

## Board UX

Default and only board layout in v1 (D4b).

- **Columns:** **Todo / Doing / Done**, fixed. No time-bucket view mode; no `DateGroup` system; no per-user column customization.
- **Swim lanes by `area`:** one horizontal lane per area (folder). A **lane-depth** control (ported concept from the old `laneDepth`) groups by the first *N* path segments — depth 1 collapses `projects/a` and `projects/b` into one `projects` lane; higher depth splits them. The "(no area)" lane sorts first, then alphabetical by path. Lanes are the organizing concept the user values (D4a); they are the *only* grouping axis in v1.
- **Filter bar:** a **simple** bar — text search, tag filter, and a done/hide toggle at minimum. It deliberately excludes the old `overdueOnly` / `highPriorityOnly` / `recurrenceWindow` / time-bucket-selection controls unless a specific one earns its place; the bar is a search-and-narrow aid, not a second configuration surface.
- **Drag semantics (both axes are now real writes):**
  - **Vertical (between columns):** drag sets `status` (`todo`↔`doing`↔`done`). Dropping into Done triggers completion (recurrence roll-forward, server-side).
  - **Horizontal (between lanes):** drag **re-sets `area`** to the target lane's folder (its stable ID, D27) (D4a). This is the headline fix — in the old board this was a silent no-op.
- **No "N excluded" band-aid.** Because v1 doesn't hide tasks into unselected buckets, the board shows what's there; the empty state distinguishes "no tasks yet" from "nothing matches your filters."
- **Live:** the board subscribes to server task pushes for the active vault, so a teammate's drag/create/complete reflows lanes and columns in real time (D4).

## Task lifecycle & flows

**Create — entry points:**

- **From the board:** a quick-add on any column/lane creates a task with that column's `status` and that lane's `area` prefilled; title only, everything else optional.
- **From a note:** creates a task with `area` defaulting to the note's folder (D4a) and the note added to `related[]` (`kind: 'note'`). Area is freely changeable afterward.
- **From an `@`-mention in a note:** mentioning an existing task links the note into that task's `related[]` (idempotent) — the port of `linkTaskToActiveNoteAtom`, now a task op, not a file write.
- **From the agent:** `task_create` MCP op (below).
- **Quick-add (global):** create a bare task from anywhere; no area, Todo status.

**Edit:** any field via the detail view or inline board affordances; each edit is a tRPC mutation. Optimistic UI is fine (patch the atom, roll back on failure) but there is **one** authoritative path — the server push — not a second disk-scan rebuild.

**Complete:** setting `status = done`. If the task is recurring, the server rolls it forward instead of persisting `done` (see below) and it returns to Todo at its next occurrence.

**Delete:** removes the record. No orphan cascade — a deleted task simply disappears from any note's backref view; a deleted *note* leaves its `related[]` entry dangling, rendered as a tombstone ("[deleted note]", D27) — no cascade, no orphan rescue.

**Drag:** covered under [Board UX](#board-ux) — status change (vertical) and area change (horizontal), both real mutations.

## Recurrence & reminders

The **pure rule functions port verbatim** from the old Rust into `packages/shared` (TS), with their existing test suites carried over (recurrence and reminder math were the well-tested parts — "carried forward" in decisions.md). They run identically on client and server.

**Recurrence (rules in `packages/shared`; roll-forward server-side):**

- `nextDue(currentDue, rule)` → next `YYYY-MM-DD` or `null` (bad date / past `endDate`). Handles daily/weekly/monthly/yearly with `interval`, weekly-with-weekdays (same-week scan for interval 1; jump-to-target-week for interval > 1), month/year day-clamping (Jan 31 + 1mo → Feb 28; Feb 29 → Feb 28), and `endDate` cutoff.
- `nextDueCatchup(currentDue, rule, today)` → advances until on-or-after `today` for a stale/overdue completion, using the closed-form leap + bounded iteration (so a decade-stale daily task doesn't silently vanish). Port both, and the leap/clamp edge cases the old tests pin.
- **Roll-forward** runs **server-side on completion** (D19-adjacent): when a recurring task is marked `done`, the server advances `due` via `nextDueCatchup`, shifts an **absolute** reminder by the same day-delta (relative reminders re-resolve against the new `due` on their own), and flips status back to `todo`. This is the *single* roll-forward path — the old dual `save_task` + watcher-sweep arrangement is gone because there's no file-edit backdoor to reconcile.

**Reminders (rules in `packages/shared`; evaluation + push server-side, D19):**

- **Grammar (ported):** relative `Nd` / `Nw` = *N* days/weeks before `due`, resolving to the **09:00 anchor** on the resolved date; or absolute local `YYYY-MM-DDTHH:MM` (seconds optional). Parsing rejects `+1d`/`-1d`/`1h`/bare dates — the parse error string doubles as the agent-facing format doc. A relative reminder with no parseable `due` is **inert**, never an error.
- **Pending rule (ported):** a reminder is pending when the task is open (`status != done`) ∧ the reminder resolves ∧ `remindedAt < resolvedFireTime`. Re-arming after recurrence rollover falls out of this automatically (a rolled-forward due moves the fire-time past the last `remindedAt`); nothing is ever cleared on rollover. **Setting** a reminder clears `remindedAt` so a re-set earlier time can fire again.
- **Server-side evaluation + push (D19):** because tasks are server records, the **server** owns reminder scheduling — it computes the earliest pending fire across a vault's tasks, and on fire **pushes** an event to the members it concerns; the client raises a **native Electron notification**. The old client-side tokio scheduler loop (`reminder_scheduler.rs`), its min-fire-time computation, per-client `reminded_at` persistence, and the missed-reminder summary pass are all **removed** — the server does this once, centrally, and clients that were offline get the pending/missed fire on reconnect. `remindedAt` is written by the server when it fires.

## Agent integration

The agent manipulates tasks through **typed MCP ops** (D10) served by the local MCP server in Electron main, proxying to the Syv tRPC API. Tasks are the canonical example of "not a plain file, so it needs an op." The old 8-op task surface (`task_new`/`task_list`/`task_get`/`task_set`/`task_link`/`task_link_email`/`task_unlink_email`/`task_delete`) collapses to the essentials:

- **`task_create`** — title (+ optional status, area, due, priority, tags, reminder, recurrence). Recurrence still accepts the ergonomic dual encoding (a bare frequency word `daily|weekly|monthly|yearly` **or** a full JSON object); due still accepts sugar (`today`, `+3d`, `+1w`, ISO). Ports the natural-value parsing so the agent passes `"done"`/`"high"` without seeing enum names.
- **`task_list`** — role-gated read; filter by status / priority / due window / tags; default excludes `done` (the agent overwhelmingly wants open work); a slim projection that drops empty fields to protect context.
- **`task_set`** — update fields; empty-string clears; add/remove arrays mutate `tags` and `related[]`. Re-setting a reminder clears `remindedAt`.
- **`task_complete`** — convenience for `status = done` (triggers server-side roll-forward for recurring tasks).
- **`task_link`** — unified linker: add a `RelatedRef` (note — stored by stable doc ID per D27, the op accepts a path and resolves it / task id / — phase 2 — email/event) to `related[]`, replacing the old separate `task_link` / `task_link_email` / `task_unlink_email`.

**Role gating (D10):** all task ops are gated **server-side by vault membership** — any **member** (or owner) can read and write tasks; a non-member is rejected. There is **no viewer/read-only role** (D7). This is the authoritative boundary; the old per-op `REQUIRES_POWER_USER` flags and the safe/power_user permission mode are **dropped**. The client can't grant the agent access the signed-in user doesn't have (architecture §3, §9).

## Edge cases & risks

- **Deleting a note that a task links to:** the `related[]` entry goes dangling and renders as a tombstone ("[deleted note]", D27); the task survives (no cascade, no orphan rescue). Backrefs are a server query over the link index / task records, not a full scan.
- **Folder renamed or deleted:** `area` stores a stable folder ID (D27), so a rename cascades to the lane label automatically — no task record is touched, and `note_rename` is a docs-only operation that never rewrites task refs. A *deleted* folder's lane renders by its last-known path (tombstone-style); the task isn't lost.
- **Offline task edits:** unlike notes (CRDT auto-merge), tasks are last-writer-wins per field over tRPC. Two members editing the *same* field of the *same* task while one is offline → last write wins on reconnect; different fields/tasks don't collide. No conflict UI (consistent with D21's philosophy, though tasks aren't CRDTs).
- **Reminder fires while all clients offline:** server records the fire (`remindedAt`) and pushes the missed reminder on next connect; no client-side missed-pass needed. Decide whether a flood of missed reminders collapses to a summary (the old >5 rule) — server-side now.
- **Recurrence math parity:** client and server both import the shared rules, but only the **server** rolls forward on completion — the client must not also roll forward optimistically (double-advance risk). Keep roll-forward server-authoritative; the client just shows the returned record.
- **Stale/decade-old recurring task completed:** `nextDueCatchup` must land on-or-after today (ported edge cases: closed-form leap, month-clamp back-off, iteration cap). Carry the old regression tests.
- **Timezone:** the old rules were pure with `now`/`today` passed in and TZ conversion at the scheduler edge. Server-side evaluation must fix the anchor timezone (per-user vs vault) — the 09:00 anchor is *local wall-clock*; decide whose local. (Open question.)

## Dependencies

- **[`server-data.md`](server-data.md)** — the `tasks` and `reminders` tables, the tRPC task router (create/list/set/complete/link + the push/subscription channel), and role checks. Task sync + reminder evaluation live here.
- **[`notes-editor.md`](notes-editor.md)** — vault folder hierarchy (what `area`'s folder IDs resolve against) and the `[[wiki-link]]` grammar for prose note links. `note_rename` is **docs-only** (D27) — it never touches task records.
- **[`agent.md`](agent.md)** — the MCP ops server, per-run bearer token, and role gating that the task ops plug into (D10).
- **[`vaults-collaboration.md`](vaults-collaboration.md)** — membership/roles that gate every task mutation and the presence/live-update expectation for shared boards (D7, D4).

## Open questions

- **Task `description`/`notes`:** keep a short free-text field on the record, or none at all? The old markdown body is gone; does the detail view need any prose, and if so is it plain text or does it get wiki-link/mention rendering? (Leaning: optional plain-text `notes`, no document semantics.)
- **Reminder anchor timezone** for server-side evaluation: the user's local, the vault owner's, or a per-user setting? The 09:00 anchor is wall-clock and needs a fixed frame.
- **Filter bar minimal set:** exactly which controls survive beyond search + tags + done-toggle? Does `priority` or `overdue` earn a slot, or does that reintroduce config creep?
- **Missed-reminder collapse:** does the server keep the old >5-missed → single-summary behavior, and is it per-user or per-vault?
- **Board card affordances:** what inline edits (priority, due, complete-checkbox) live on the card vs. only in the detail view, to keep the card scannable?

## Deferred

- **Time-grouped secondary board view** ("Today / This week / Later") — can return post-v1 as an *option*, not a mode the user must configure (D4b). The old 10-bucket `DateGroup` system and overlapping-predicate bucketing are **not** the target if it returns; a small fixed set is.
- **Email/Calendar `related[]` linking** — the `RelatedRef` email/event variants are reserved now, but wiring them up depends on **phase-2 Gmail/Calendar sync** (D17). No Mailspring (killed, D17).
- **Inline note-checkbox ↔ task sync** — explicitly rejected for v1 (D4); would reintroduce note↔task coupling.
- **`.holi/tasks/*.md` import** — a markdown-folder importer that maps old task files to records, bundled with the generic markdown-import path (D16).
