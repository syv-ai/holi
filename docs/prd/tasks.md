# PRD — Tasks

Tasks in Holi are **structured server records** surfaced on a **stripped board** and **projected into the vault as files**. The record is the truth; the file is a live, writable view of it. The data spine is in [`../architecture.md`](../architecture.md) §5 and the storage tables in [`server-data.md`](server-data.md).

Simplicity is a primary goal of this design, and this document specifies what tasks *are* and — just as deliberately — what the design excludes.

## Summary

A task is a first-class **structured record on the Syv server**. The trimmed shape is `title, status, area, due, priority, tags, reminder, recurrence, related[]`. `area` is a **real, settable folder reference** driving swim lanes. The default surface is a **stripped kanban board** — Todo / Doing / Done, swim lanes by `area`, a simple filter bar. Recurrence and reminder **rules** live in `packages/shared` as pure functions; the **server** evaluates reminders and pushes fire events that clients raise as native notifications. Roll-forward runs server-side on completion.

Every task is also **projected into the working copy** as `tasks/<slug>-<id>.md` — YAML frontmatter for the fields, markdown body for the description. Members and the agent read and edit tasks as ordinary files; a write is parsed and applied to the record as a per-field patch, and the server rewrites the file from truth on any change. See [Task file projection](#task-file-projection).

**Why records *and* files (revised 2026-07-14):** the record is non-negotiable — reminders must fire while every client is closed, recurrence rolls server-side, and the board needs live cross-member queries. That forces an authoritative structured record no matter what sits on disk. Given the record exists anyway, a **file projection is purely additive**: it costs a schema, a parser, a serializer and a conflict policy, and it buys agent ergonomics (native `Read`/`Edit`/`Glob` instead of an op surface), git-mirror presence, remote-agent access, grep-ability, and plain-text portability.

**Rejected:** *files as the source of truth* (the server would have to parse and mutate markdown inside CRDT docs to evaluate reminders — the same structured record, plus a parser); *records only, no projection* (the original v1 design — cost remote-agent access and portability for an op surface we mostly don't need); *inline note-checkbox ↔ task sync* (reintroduces note↔task coupling).

**Not a CRDT.** Task files are **excluded from the CRDT doc path** — character-level merging of YAML frontmatter can converge on genuinely invalid syntax (duplicate keys, mangled dates), and there is no writer to reject it because a Yjs merge asks no one. Tasks sync as **records** (last-writer-wins per field); the file is materialized from the record, not merged.

## Goals / Non-goals

**Goals**

- **Simple by construction:** one board layout, one relation list, one persistence path, one settable `area`, no derived fields, no full-vault file scans, no client-side scheduler loop. Every item in [What the design deliberately excludes](#what-the-design-deliberately-excludes) is a goal.
- Tasks are **live** across a shared vault: creating/moving/completing a task on one member's board appears on everyone's within a round-trip (tRPC + server push).
- `area` is a **real field you can set and drag** — cross-lane drops actually move the task.
- Recurrence + reminder **math is ported verbatim** from the old repo (it's well-tested) into `packages/shared`, evaluated server-side for reminders.
- The agent works tasks as **files** with its native tools; only what a file write cannot express stays an op.
- Tasks are **portable**: plain text in the vault, in the git mirror, readable by a remote agent or any editor.

**Non-goals (v1)**

- **No time-grouped board view** ("Today / This week / Later") and **no multi-bucket date system** — deferred, see [Deferred](#deferred).
- **No inline note-checkbox ↔ task sync** — explicitly rejected: it reintroduces note↔task coupling.
- **No content import** — v1 starts empty; a markdown-task-folder → record importer is deferred, bundled with the generic markdown import.
- **No per-op capability modes** — permissions are role-gated server-side by vault membership, not a safe/power-user toggle.
- **No exclusive locks on tasks.** Concurrent safety is per-field last-writer-wins + a version check; concurrent *awareness* is presence. See [Task file projection](#task-file-projection).
- **No conflict dialog.** A stale or invalid write loses and the file is rewritten from truth — there is nothing for the user to resolve.

## What the design deliberately excludes

Each of these is a feature of the design, not an omission:

- **The file is never queried.** Task files are a *projection*, not an index: the board, the agenda, reminders and `task_list` all read Postgres. Nothing in the system walks or parses the `tasks/` folder to answer a question — the parser runs in exactly one place, on an inbound file write.
- **No derived `area`.** `area` is a stored, settable folder reference. **Why:** a derived area (the parent folder of an owning note) can't be set and makes cross-lane drag impossible — lanes become un-draggable, and "moving" a task's area would mean re-pointing a note. **Rejected:** a per-vault defined area list and free-text areas — the folder-reference model preserves the doc-centric organization the swim lanes exist for.
- **No "home note".** A task belongs to no note; note links are ordinary `related[]` entries. Deleting a note therefore can't orphan a task — a dangling ref just renders as a tombstone. No orphan-rescue flow exists because orphans can't.
- **One relation list.** `related[]` is a single tagged union covering notes, tasks, emails, and events. It is **read-and-unlink** in the task detail, never an editor: relations are authored from the other side (`@`-mention a task inside a note) and from the task file, so a picker in the detail would be a third author for the same edge. Unlink is there because a delete does not cascade — a dangling ref is permanent unless something removes it, and it renders as a **tombstone** (`[deleted note]`) rather than vanishing, because the serializer round-trips a gone note's raw id on purpose. `email`/`event` are representable but unresolvable until Gmail/Calendar land (phase 2), and are shown as-is rather than called deleted.
- **One write path.** Every mutation lands as a tRPC mutation against the record, and the server push is the single authoritative update. A file edit is not a second write path — it is *translated into* the first one (parse → per-field patch → the same mutation the board calls). Recurrence roll-forward still runs once, server-side, on completion.
- **One direction of truth.** Record → file is a rewrite; file → record is a patch. The file never "wins" a disagreement: a stale or unparseable write is discarded and the file is rewritten from the record.
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
  recurrence?: Recurrence
  related: RelatedRef[]  // unified: note | task | email | event
  description?: string   // the task file's markdown body — a plain column, NOT a CRDT doc
  version: number        // optimistic-concurrency token; bumped on every mutation
  createdAt: string
  updatedAt: string
}
// `reminded_at` (RFC3339 of last fire) is a server-only column on the `tasks` table —
// it is written by the reminder evaluator and is deliberately not on the shared type.

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

- **`title`/`description`.** **Settled 2026-07-14:** the task file's markdown body **is** the `description`, stored as a **plain `text` column** on the record — *not* a CRDT doc. It carries ordinary `[[wiki-link]]` semantics as prose, but it is never merged character-by-character: it syncs last-writer-wins per field like every other task field. **Why a plain column:** a CRDT body would drag the whole merge problem back in for the least structured field of the least contended record, and would put a task file half-in and half-out of the doc path. (This supersedes the earlier "a task has no markdown body" wording and closes the old open question.)
- **`related[]` is one unified list.** `RelatedRef` is a tagged union; every variant references its target by **stable ID** — doc ID for notes, task ID, account/thread/event IDs for email/event — with the UI resolving to the current path/title at render time. The principle: machine references use stable IDs; human prose uses paths. Note renames therefore never touch task records. **Rejected:** path references in records plus a cross-store transactional rewrite on rename (distributed-transaction machinery across the doc store and SQL — the exact fragile seam to avoid), and a background path reconciler (transient dangling refs). The email/event variants carry cached `subject`/`title` fields for offline rendering — email/event linking arrives with the phase-2 Gmail/Calendar sync, but the variants are reserved now so the board and ops don't reshape later.
- **`area` is optional and settable.** Empty/absent = the root lane ("no area"). It stores a **stable folder ID**, displayed as the folder's path; the vault's real folder hierarchy (needed anyway for wiki-links and the file tree, architecture §6) is what it references. Folder renames cascade to lane labels automatically — no task record is touched. Nothing derives it.
- **`remindedAt` is server-written** and re-armable — see reminders.

## Task file projection

The vault's working copy is *already* a projection — notes on disk are materializations of server-side CRDT docs, kept in step by the VaultMirror. Task files extend that principle to the second kind of server truth. From the user's and the agent's side a task looks like a file they own; underneath, the record is authoritative and the file is a view of it.

**Shape** — `tasks/<slug>-<id>.md`, YAML frontmatter + markdown body:

```markdown
---
id: a1b2c3d4-…          # stable task ID — the join key; never edit
title: Review the Q2 doc
status: todo            # todo | doing | done
due: 2026-07-20
priority: high
area: projects/q2       # folder *path* — paths in, folder ID stored
tags: [finance]
reminder: 1d
recurrence: { frequency: weekly, interval: 1, weekdays: [mon] }
related:
  - { kind: note, path: meetings/2026-07-13.md }   # paths in, IDs stored
---

Free-form description. This is the task's `description` — the markdown body,
with ordinary `[[wiki-link]]` semantics.
```

The **body is the description** — that answers the old open question ("does a task need prose, and where does it live?"): it lives where every other piece of prose in the vault lives.

**The concurrency token is *not* in the file** (revised 2026-07-14, during implementation). `version` is a real column on the record, but it is carried **out-of-band**: the desktop keeps the version of the record each file was rendered from in its `ProjectionStore`, and git ingress needs no token at all — a commit carries its own base blob, which *is* the diff base. **Why it left the frontmatter:** `version` bumps on every mutation, so a reminder firing would rewrite the file to change one integer — and with the git mirror on, the bot would *commit* that, forever, on an otherwise idle vault. It is also a machine token the agent must never hand-edit, sitting in the agent's face for no benefit. `parseTaskFile` still **accepts** a `version:` key so files written before this change stay readable; nothing writes one and nothing consumes it.

**`related[]` and `area` keep the ID/path seam.** The record stores stable IDs (a note or folder rename never rewrites a task); the *file* renders them as paths, and an inbound write resolves paths back to IDs. The ops that used to carry that translation (`task_new`/`task_link`) are **retired**; the seam now lives in one place, `packages/shared/src/task-file.ts`, which both inbound paths (the desktop projector and the git ingester) and the outbound serializer share. Machine references use IDs; human-facing text uses paths.

**`area` is a folder path in the file** (revised 2026-07-14, during implementation). The file cannot carry a raw folder ID: there is no folder op in the three-op surface, so **the agent has no way to discover one** — a UUID here would make `area` writable only by the board, and the "create a task from a note, area defaults to its folder" story unreachable from a file. Rendering it as a path makes it settable and readable while the record keeps the stable folder ID, so folder renames still cascade to lane labels with no task record touched. A folder the *serializer cannot resolve* (the desktop snapshots its folder map, so a folder created since it started is unknown to it) renders as the raw folder ID rather than being omitted — omitting it would read as "cleared" to the inbound diff and silently unfile the task. This is a staleness guard, **not** a deleted-folder tombstone: a deleted folder sets its tasks' `area` to null, so a task never points at one that is gone. An unresolvable folder *path* rejects the write, the same rule as a bogus note path.

**Contract:**

- **Record → file:** the server rewrites the file on any change to the record, whoever caused it (your board drag, a teammate's edit, a recurrence roll, a reminder fire touching `remindedAt`). A task file therefore **changes under you**, by design.
- **File → record:** a write is parsed, diffed against the last-known projection, and applied as a **per-field patch** — the same tRPC mutation the board uses. Fields you didn't touch are not sent, so two people editing different fields both survive.
- **Stale writes lose.** A *desktop file* write carries the version of the record its file was rendered from (out-of-band, from the `ProjectionStore` — not from the file); if the record has moved on, the write is discarded and the file is rewritten from truth. No conflict dialog, nothing to resolve. A *git* write carries no version and needs none: the commit's own base blob is the diff base, so its per-field patch is exact by construction, and a version check there would only reject a legitimate remote edit whose commit predates an unrelated local change. This is the identical rule notes already ingest under (diff against the git base = per-field last-writer-wins), so tasks and notes get the same conflict story.
- **Unparseable writes lose.** A file that doesn't parse (or whose `id` was mangled) is discarded and rewritten from the record. The model *will* occasionally write malformed frontmatter — the old app needed a `verify-parse-after-write` guard for exactly this — so the projection must be resilient to it by construction rather than by prompting.
- **`rm tasks/….md` deletes the task**, matching the note symmetry the vault mirror already implements (agent `rm` → doc delete). Creating a well-formed file with no `id` creates a task.
- **Synced + mirrored.** Task files are vault content: they materialize for every member and are exported to the git mirror. This is **built** (2026-07-14), not promised: the exporter has a second source (the `tasks` table alongside `docs`), and inbound `tasks/**.md` commits are routed to the record path by `apps/server/src/git/task-ingest.ts` — they never become CRDT notes. A remote Claude Code session on a clone reads, edits, creates and deletes tasks exactly as the local agent does. The v1 "no remote-agent task access" limitation is **gone**.

**Concurrency: presence, not locks.** Two members editing the *same field* of the *same task* is rare and cheap to undo; per-field last-writer-wins plus the version check already prevents lost updates. What people actually need is not to be *surprised* — so the board and the task file surface **presence** ("Nicolai is editing this task", the same signal the drawer already shows as "Claude is editing…" on notes).

**Presence is its own `presence` frame on the same SSE connection** — a sibling channel alongside `docs`/`tasks`/`reminders`/`membership`, *not* a `TasksEvent` variant and *not* a new relay awareness room. It must not be folded into `TasksEvent`, and the reason is a live trap: `TaskProjector.applyTasksEvent` reads that union as `if (upserted) … else remove(event.taskId)`, so a third variant falls into the `else` and **deletes the task's file**. Widening a union that an exhaustive-by-accident consumer reads is how you get that bug. The sibling channel satisfies the original intent ("rides the existing event channel" = same connection, no new plumbing) with no trap — so do not "simplify" it back. (The connection became **user-scoped** in 2026-07-16 and carries every vault; main filters `presence` to the active vault before the renderer sees it, so the trap above is now also the reason a frame from *another* vault must never reach the projector.)

**Presence is fire-and-forget and the server stores nothing.** `tasks.heartbeat({ taskId })` touches no row: the server resolves the actor, stamps an `expiresAt` (10s TTL), emits, and returns. Clients drop an entry when it expires. This is the whole reason locks were rejected — there is no acquire, no release, no TTL sweep, no stale holder from a crashed client, and no steal path. **A heartbeat that stops arriving *is* the release.** A heartbeat also never bumps `version` — one that did would rewrite every task file, and with the mirror on, commit it.

**A user and their agent are one identity.** Presence emits under the user's identity whether the write came from the board or from Claude working on that user's behalf, and there is deliberately **no `actor` field**. The agent runs on the user's token because the user set it going: "Nicolai is editing this task" is *true* when Nicolai's Claude is editing it. (This is not the question the drawer answers on notes — "Claude is editing…" there tells **you** what **your own** agent is doing to a doc in front of you. Presence tells **someone else** that this task is in motion, and for that the distinction is noise.)

**Rejected: exclusive locks.** They add a full lock lifecycle (acquire, release, TTL, stale locks from a crashed or offline holder, and a steal path that reintroduces the very conflict they exist to prevent) to protect against a narrow, low-stakes collision. Worse, the primary writer is the agent: a lock held by Claude mid-turn that blocks the user from touching their own task is a worse outcome than a last-write-wins overwrite they can see and fix.

**Interaction with the agent drawer.** Task files live in the working copy, so a server-driven rewrite (a recurrence roll landing the moment the agent marks something done) arrives as a *foreign write* and would engage the DocBridge turn protocol. Task files are not CRDT docs, so they must be **excluded from the bridge's turn path** — the mirror materializes them, but they carry no base, no turn, and no merge. This is the same exclusion `isLocalOnlyPath` already performs for machine-local files, on a different axis. Spec: [`../specs/2026-07-13-agent-drawer-design.md`](../specs/2026-07-13-agent-drawer-design.md).

## Board UX

Default and only board layout in v1.

- **Columns:** **Todo / Doing / Done**, fixed. No time-bucket view mode; no date-group system; no per-user column customization.
- **Swim lanes by `area`:** one horizontal lane per area (folder). The "(no area)" lane sorts first, then alphabetical by path. Lanes are the organizing concept the user values; they are the *only* grouping axis in v1.
- **The lane-depth control is deferred (2026-07-14), and not for effort reasons.** It would collapse `projects/a` and `projects/b` into one `projects` lane by grouping on the first *N* path segments. Grouping is trivial; **dropping is not.** A collapsed lane has **no unambiguous `area` to write** — dragging a card into a merged `projects` lane cannot say *which* folder it lands in, so the horizontal drag axis (a real write, and the entire reason `area` is settable rather than derived) becomes undefined exactly when the control is switched on. Shipping it would mean a silent guess or a lane that accepts no drops. Deferred until there is an answer; the lane machinery does not design it out.
- **Filter bar (settled 2026-07-14):** exactly three controls — **text search**, **tag filter**, **done/hide toggle**. Nothing else. No overdue-only, high-priority-only, recurrence-window or time-bucket controls: the bar is a search-and-narrow aid, not a second configuration surface.
- **Virtual labels** (settled 2026-07-14). `overdue` and `p1`/`p2`/`p3` render as chips beside a task's real tags, and the filter's tag control matches them identically — so the board reads like a labelled issue list and "show me the overdue p1s" is a tag query, not a bespoke control. **They are computed, never stored** (`packages/shared/src/labels.ts`): `overdue` from `due` + `status`, `pN` from `priority`. **Why not store them:** something would have to *write* `overdue` onto a task the moment it tipped over at midnight — and every such write bumps `version`, rewrites the task file, and with the git mirror on makes the bot **commit**. A hundred tasks going overdue is a hundred commits on an idle vault. It would also make `tags` half machine-owned, so an agent deleting `overdue` would have it silently re-added under it. `priority` and `due` stay **real fields**; the labels are a rendering of them, not a second copy.
- **The card carries exactly one affordance (settled 2026-07-14):** the **complete checkbox**. Title, `due`, labels, tags and presence are display; every other edit opens the detail view. A card stays scannable, and only one write path lives on it. **The checkbox goes through `tasks.complete`, never a `status: 'done'` patch** — complete is the single roll-forward path, so a recurring task rolls to its next occurrence instead of persisting `done`. A patch would silently skip the roll.
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
- **From the agent:** it writes a task file (`tasks/<slug>.md`) with its native tools; the projection creates the record. No op.
- **From a remote agent:** a commit to the git mirror adding a task file; ingress patches it into a record.
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
- **Delivery is a ledger, not a push-and-hope.** Pushing is not delivering: an event pushed at a client that isn't listening is gone, so "you get the missed fire on reconnect" needs the server to *remember what you have been shown*. A reminder records **when it fired** (`fired_at`; pending ⇔ `fired_at IS NULL`) and a **watermark per `(vault, user)`** records how far each member has been notified. On connect — and after a stream gap, alongside the mirror/projector reconcile — the client asks for fires past its watermark and raises them. The watermark advances on live sends too (sending *is* delivering), so reconnecting never replays what you already saw, and it only ever moves **forward**, so a late or out-of-order advance can't rewind it and re-notify everything since. It is **per member** because a fire concerns everyone in the vault — a task has no assignee — so "delivered" is a fact about a person, not about the reminder. It is **server-owned**: not `per_user_state`, which fits the shape but is client-writable, and a client that can move its own watermark can silently switch off its own reminders. A **first-ever connect** starts the watermark at *now* and replays nothing — someone who just joined should not be buried under every reminder the vault ever fired. A **superseded** fire (the reminder re-armed because the task changed) is dropped, not replayed: the task moved past it.
- **Reminders arrive for every vault you are in, open or not.** The desktop holds **one** SSE connection scoped to *you*, not to the active vault, so a fire anywhere reaches you live; the ledger means one that lands while the app is closed is still never lost. Clicking the notification **switches to that vault** and selects the task — without that the click would set a task id against whatever board was on screen and appear to do nothing. A coalesced summary speaks for several tasks so it carries no task id, but it still carries the vault, so it lands you in the right place.
  - This was a known gap until 2026-07-16, and closing it needed exactly what the gap said it needed: a user-scoped event stream replacing the per-vault one — the transport `docs`, `tasks` and `presence` all ride — in its own slice. The ledger was already per-user, so only the transport changed.

## Agent integration

**The agent works tasks as files.** It creates a task by writing `tasks/<slug>.md`, edits one with `Edit`, reads with `Read`, finds with `Glob`/`Grep`, and deletes with `rm`. There is no op for any of that, because a file write expresses it exactly.

**Two ops survive** — the ones a file write *cannot* express (see [`agent.md`](agent.md)):

- **`task_set`** — because `status: done` in a file is **ambiguous** for a recurring task: it can't distinguish "this instance is done, roll it forward" from "end the series". The op resolves that intent explicitly and is the single completion path (server-side roll-forward). It also stays the sanctioned way to clear fields and mutate arrays without a whole-file rewrite.
- **`task_list`** — because answering "what's due this week" from files means globbing and parsing every task in the vault, and filtering belongs server-side. Role-gated read; filter by status; a slim projection that drops empty fields to protect context.

Everything else — `task_new`, `task_get`, `task_link`, `task_delete`, and the note-path↔docId translation they carried — collapses into ordinary file operations against the projection.

**Why not drop MCP entirely:** we considered it. `task_list` could be a `Glob` + parse, and completion could be resolved by convention (e.g. "`done` always rolls a recurring task; to end a series, clear `recurrence` first"). Rejected: the convention makes the destructive interpretation the *default* one, and a full-vault parse is precisely the "no file scans" property this design exists to keep.

**Role gating:** all task ops are gated **server-side by vault membership** — any **member** (or owner) can read and write tasks; a non-member is rejected. There is **no viewer/read-only role**, and no per-op capability flags or safe/power-user mode — membership is the whole permission model. The client can't grant the agent access the signed-in user doesn't have (architecture §3, §9).

**Remote agents (built 2026-07-14):** task files ride the vault's git mirror ([`../specs/2026-07-13-vault-git-mirror-design.md`](../specs/2026-07-13-vault-git-mirror-design.md)), so a Claude Code cloud session on the mirrored repo reads and edits tasks exactly as the local agent does — its commits land as file writes and are patched into the records on ingress (`apps/server/src/git/task-ingest.ts`). This is the payoff that justifies the projection.

A remote session has **files and nothing else** — no MCP, no ops — so it cannot express `task_set`'s "end the series" vs "roll it forward" on a recurring task. `status: done` in a commit therefore takes the **roll-forward** reading, the same rule a local file write follows. Ending a series remotely means editing `recurrence` out of the frontmatter, which works and is discoverable. A remote op surface is not worth an MCP transport.

## Edge cases & risks

- **Deleting a note that a task links to:** the `related[]` entry goes dangling and renders as a tombstone ("[deleted note]"); the task survives (no cascade, no orphan rescue). Backrefs are a server query over the link index / task records, not a full scan.
- **Folder renamed or deleted:** `area` stores a stable folder ID, so a rename cascades to the lane label automatically — no task record is touched, and `note_rename` is a docs-only operation that never rewrites task refs. **A deleted folder unfiles its tasks** (`ON DELETE SET NULL`, revised 2026-07-14): they fall into the "(no area)" lane and are not lost. *There is no folder tombstone* — the earlier "renders by its last-known path" wording described behavior the schema made impossible (the un-cascaded FK meant Postgres refused to delete a folder any task pointed at, silently making folders undeletable). A task is allowed to exist without an area; that is what the "(no area)" lane is for, so falling into it needs no new concept.
- **Offline task edits:** unlike notes (CRDT auto-merge), tasks are last-writer-wins per field over tRPC. Two members editing the *same* field of the *same* task while one is offline → last write wins on reconnect; different fields/tasks don't collide. No conflict UI — consistent with the notes philosophy (offline changes merge automatically; the UI shows only a sync-status indicator, never a conflict dialog), though tasks aren't CRDTs.
- **Offline edits to a task *file*** are applied on reconnect (**shipped 2026-07-14**). An edit made while the app is running but disconnected fails its mutation, stays on disk, and is reconciled when the connection returns; the same reconcile also recovers everything the SSE stream missed during the gap (upserts, deletes, recurrence rolls) and retries a `rm` whose delete never reached the server. An edit made while the app is **closed** reconciles identically at the next `start()`.
- **There is no patch queue, and there must not be one.** The PRD used to promise that offline edits "queue as patches". They don't, because a queue is redundant state: **the working copy *is* the queue** (the edit is on disk) and **the `ProjectionStore` is the diff base** (the exact bytes the writer edited against, persisted). The patch is therefore reconstructible at any later moment from two things already durably held. A second queue would duplicate them and add a way for the two to disagree. If you find yourself building one, re-read this.
- **A reconcile write carries no version, deliberately.** It diffs against the store — the real base — so the per-field patch is exact and a version guard protects nothing. What the guard *would* do is destroy a legitimate offline edit whenever the record moved for a reason the writer had no part in and could not see: **a reminder firing bumps `version` on its own.** Untouched fields are never sent, so a teammate's concurrent change to a different field still survives. This is the same rule git ingress uses, so the two inbound paths now agree. *Live* watcher writes remain version-guarded — there the store's token is current, so a stale write means the record genuinely moved under the writer.
- **A delete is never inferred from a missing file.** A `rm` whose mutation failed is remembered in memory and retried on reconnect; a file that is simply *absent* at startup is **re-materialized**, not treated as a delete. Inferring deletes from absent files would let a half-synced working copy destroy records.
- **The agent's edit is reverted under it:** an agent write that loses (stale `version`, or unparseable) is discarded and the file rewritten from truth — *while the agent may still be mid-turn*. The rewrite lands as a normal foreign write, so the agent sees the corrected file on its next `Read`. Acceptable, but the projection must never leave the file in the agent's rejected state (that would silently diverge disk from truth).
- **Two writers, one file, no lock:** the agent edits `title` while a member drags the card to Doing. Both survive (different fields). Same field → last write wins, and presence is what warns them it was happening.
- **Reminder fires while all clients offline:** server records the fire (`remindedAt`) and pushes the missed reminder on next connect; no client-side missed-pass needed. Decide whether a flood of missed reminders collapses to a summary — server-side now. (Open question.)
- **Recurrence math parity:** client and server both import the shared rules, but only the **server** rolls forward on completion — the client must not also roll forward optimistically (double-advance risk). Keep roll-forward server-authoritative; the client just shows the returned record.
- **Stale/decade-old recurring task completed:** `nextDueCatchup` must land on-or-after today (ported edge cases: closed-form leap, month-clamp back-off, iteration cap). Carry the old regression tests.
- **Timezone:** the rules are pure, with `now`/`today` passed in and TZ conversion at the scheduler edge. Server-side evaluation must fix the anchor timezone (per-user vs vault) — the 09:00 anchor is *local wall-clock*; decide whose local. (Open question.)

## Dependencies

- **[`server-data.md`](server-data.md)** — the `tasks` and `reminders` tables, the tRPC task router (create/list/set/complete/link + the push/subscription channel), and role checks. Task sync + reminder evaluation live here. The projection adds a `version` column, a `description` column, and the file↔record parse/serialize pair. Every task mutation — from the board, the desktop projector, or the git ingester — goes through `apps/server/src/tasks/mutations.ts`; that is the enforcement of this PRD's "one write path" rule.
- **[`notes-editor.md`](notes-editor.md)** — vault folder hierarchy (what `area`'s folder IDs resolve against) and the `[[wiki-link]]` grammar for prose note links. `note_rename` is **docs-only** — it never touches task records.
- **[`agent.md`](agent.md)** — the MCP ops server, per-run bearer token, and role gating that the two surviving task ops plug into. The agent's main task surface is now the file projection, not MCP.
- **[`../specs/2026-07-13-vault-git-mirror-design.md`](../specs/2026-07-13-vault-git-mirror-design.md)** — the exporter must project task files into the mirror and patch inbound task-file commits into records.
- **[`../specs/2026-07-13-agent-drawer-design.md`](../specs/2026-07-13-agent-drawer-design.md)** — task files must be **excluded from the DocBridge turn path** (they are records, not CRDT docs).
- **[`vaults-collaboration.md`](vaults-collaboration.md)** — membership/roles that gate every task mutation and the presence/live-update expectation for shared boards.

## Open questions

- **Slug churn:** `tasks/<slug>-<id>.md` derives the slug from the title. Does renaming a task's title *move the file*? (Leaning: yes, the `id` suffix keeps identity stable and the git mirror shows it as a rename — but it means a title edit rewrites a path, which the agent must not be surprised by.)
- **Reminder anchor timezone** for server-side evaluation: the user's local, the vault owner's, or a per-user setting? The 09:00 anchor is wall-clock and needs a fixed frame.
- **Missed-reminder collapse:** should more than a handful of missed reminders collapse into a single summary notification, and is that per-user or per-vault?

## Deferred

- **Time-grouped secondary board view** ("Today / This week / Later") — can return post-v1 as an *option*, not a mode the user must configure. If it returns, the target is a small fixed set of groups, not a large date-bucket taxonomy with overlapping-predicate bucketing.
- **Email/Calendar `related[]` linking** — the `RelatedRef` email/event variants are reserved now, but wiring them up depends on the **phase-2 Gmail/Calendar sync** (built on Google APIs under the same OAuth).
- **Inline note-checkbox ↔ task sync** — explicitly rejected for v1; would reintroduce note↔task coupling.
- **Markdown task import** — an importer that maps old task files (`.holi/tasks/*.md`) to records, bundled with the generic markdown-import path. Now a smaller job: the projection's parser is the importer's parser.
- ~~**Read-only task export to the git mirror**~~ — superseded 2026-07-14 by the writable [Task file projection](#task-file-projection), which gives remote sessions read *and* write.
