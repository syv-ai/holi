# PRD — Tasks

A task in Holi is **a markdown file in the vault**, surfaced on a **stripped board**. There is no record, no database, and no projection: the file is the task. The system spine is in [`../architecture.md`](../architecture.md).

Simplicity is a primary goal of this design, and this document specifies what tasks *are* and — just as deliberately — what the design excludes.

## Summary

A task is a file named **`task.<name>.md`**, living in the vault folder it is about. YAML frontmatter carries the fields; the markdown body is the description. Its **path is its identity**, its **containing folder is its swim lane**, and the `task.` filename prefix is what makes it a task.

The default surface is a **stripped kanban board** — Todo / Doing / Done, swim lanes by folder, a simple filter bar. Recurrence and reminder **rules** live in `packages/shared` as pure functions; a **tray-resident Holi** evaluates reminders locally and raises native notifications. Roll-forward runs locally on completion, by rewriting the file.

**Why the file is the task.** The earlier design made a task a server record with a file *projection*, and the reasoning was sound at the time: reminders had to fire while every client was closed, recurrence had to roll centrally, and boards needed live cross-member queries — all of which force an authoritative structured record. Every one of those premises came from having a server. Without one, a record buys nothing and costs the entire reconciliation apparatus: a `ProjectionStore`, a version token, per-field patching, a rewrite-from-truth rule, and two inbound paths that had to be argued into agreeing. Deleting the record deletes all of it.

**Rejected:** *a local SQLite record with a file projection* — keeps the most intricate code in the repo and makes it worse, because two laptops would each hold a private record of the same shared task with git in between, and nothing could arbitrate. *Files plus a rebuildable index* — a cache with an invalidation story, bought before any measurement asks for one; a vault's task set is small enough that a glob-and-parse is imperceptible.

## Goals / Non-goals

**Goals**

- **Simple by construction:** one board layout, one storage location, one write path (the file), no derived fields, no client-side scheduler beyond a single timer.
- Tasks are **portable and grep-able**: plain text in the repo, readable by any editor, any agent, and GitHub's own web UI.
- The **folder is the lane** — organization comes free from where you put the file.
- Recurrence + reminder **math is ported verbatim** from the old repo (it's well-tested) into `packages/shared`.
- The agent works tasks with its **native tools only**. There is no op surface at all.

**Non-goals (v1)**

- **No time-grouped board view** ("Today / This week / Later") and **no multi-bucket date system** — deferred.
- **No inline note-checkbox ↔ task sync** — rejected: it reintroduces note↔task coupling.
- **No assignees.** A shared vault's tasks belong to the vault; a reminder notifies everyone.
- **No locks and no presence.** Presence required a server push channel that no longer exists. Two people editing the same task file is an ordinary git conflict, handled by the ordinary conflict path.
- **No conflict dialog.** See [Concurrency](#concurrency).

## What the design deliberately excludes

Each of these is a feature of the design, not an omission:

- **No second representation.** Nothing derives from the file and nothing rewrites it from elsewhere. The whole class of bugs where a file "changes under you" is gone, because there is no other truth to change it.
- **No task ids.** Identity is the path, and a link to a task is an ordinary `[[wiki-link]]` — the same grammar notes use. There is no `[[task:…]]` form, no `RelatedRef` union, and no id for the agent to mint or mangle.
- **No `related[]` field.** A task links to things by writing wiki-links in its body, and things link to a task the same way. Backrefs are a grep. The unified relation list existed because a record could not contain prose; a file can.
- **No derived `area`.** There is no `area` field at all — the task's folder is its lane. Moving lanes moves the file, which is also what you would do by hand.
- **No "home note".** A task belongs to no note. Deleting a note can't orphan a task; a dangling wiki-link renders as a tombstone.
- **One board layout.** No view modes, no date buckets, no per-user column configuration. A multiplied config space is the interaction-level source of "not simple".
- **Status vocabulary:** `todo | doing | done`.

## User stories

- I open a vault and see the board — Todo / Doing / Done, one lane per folder — with no configuration.
- I drag a card from Todo to Doing; the file's frontmatter is rewritten and an autosave commit follows.
- I drag a card from the `projects/q2` lane to the `personal` lane; the file moves to `personal/`.
- I create a task from a note; it lands in that note's folder, and I wiki-link the note in its body.
- I quick-add "Call the vendor" from the board; it lands in Todo, in the vault root.
- I set a recurring task (weekly, Mon/Wed/Fri); completing it rewrites `due` to the next occurrence and returns it to Todo.
- I set a reminder "1d" on a due-dated task; Holi raises a native notification the day before at 09:00.
- I ask the agent "make me a task to review the Q2 doc, due Friday, high priority"; it writes a file and it appears on my board.
- I add a task; it pushes on its own; my teammates' boards show it after their next pull.

## Data & shape

The **canonical types live in `packages/shared`**, used by the board, the parser, and the serializer.

```ts
// packages/shared
type TaskStatus = 'todo' | 'doing' | 'done'
type Priority   = 'low' | 'medium' | 'high'

type Task = {
  path: string           // vault-relative, e.g. projects/q2/task.fix-login.md — the identity
  title: string          // frontmatter, falling back to the filename
  status: TaskStatus
  due?: string           // YYYY-MM-DD
  priority?: Priority
  tags: string[]
  reminder?: string      // Nd | Nw | YYYY-MM-DDTHH:MM
  recurrence?: Recurrence
  description: string    // the markdown body
}

type Recurrence = {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number       // default 1
  weekdays: Weekday[]    // weekly-with-weekdays; empty = plain interval
  endDate?: string       // YYYY-MM-DD; rolling stops past this
}
type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
```

`area` is **not a field** — it is `dirname(path)`. `version`, `id`, `vaultId`, `createdAt`/`updatedAt` and `remindedAt` are all gone: the first three were record machinery, and the timestamps are git's job.

## File format

`projects/q2/task.fix-login.md`:

```markdown
---
title: Review the Q2 doc
status: todo            # todo | doing | done
due: 2026-07-20
priority: high
tags: [finance]
reminder: 1d
recurrence: { frequency: weekly, interval: 1, weekdays: [mon] }
---

Free-form description, with ordinary `[[wiki-link]]` semantics —
including [[meetings/2026-07-13.md]], which is how a task links to a note.
```

- **`title` is optional.** Absent, it derives from the filename (`task.fix-login.md` → "Fix login"), so a task Claude creates with one `Write` and no frontmatter still reads correctly on the board.
- **An unparseable file is shown, not swallowed.** The model will occasionally write malformed frontmatter. A `task.*.md` that fails to parse renders as a card in an error state linking to the file — never silently dropped from the board, which would look like data loss, and never rewritten from somewhere else, because there is nowhere else.
- **Nothing is machine-owned.** Every key in the frontmatter is one a human or the agent may write by hand. There is no token, no id, and no field the board maintains behind your back.

## Board UX

Default and only board layout in v1.

- **Columns:** **Todo / Doing / Done**, fixed. No time-bucket view mode; no per-user column customization.
- **Swim lanes by folder:** one horizontal lane per folder containing tasks. The vault-root lane sorts first, then alphabetical by path.
- **The lane-depth control stays deferred** — and the original reason survives the pivot intact. It would collapse `projects/a` and `projects/b` into one `projects` lane. Grouping is trivial; **dropping is not**: a collapsed lane has no unambiguous folder to move the file *into*, so the horizontal drag axis becomes undefined exactly when the control is on. Deferred until there is an answer.
- **Filter bar:** exactly three controls — **text search**, **tag filter**, **done/hide toggle**. Nothing else. The bar is a search-and-narrow aid, not a second configuration surface.
- **Virtual labels.** `overdue` and `p1`/`p2`/`p3` render as chips beside a task's real tags, and the filter's tag control matches them identically — so "show me the overdue p1s" is a tag query, not a bespoke control. They are **computed at render, never stored** (`packages/shared/src/labels.ts`): `overdue` from `due` + `status`, `pN` from `priority`. **Why not store them:** something would have to write `overdue` onto a task the moment it tipped over at midnight — and now every such write is a file rewrite and an autosave commit. A hundred tasks going overdue at midnight is a hundred commits on an idle vault. It would also make `tags` half machine-owned, so an agent deleting `overdue` would have it silently re-added.
- **The card carries exactly one affordance:** the **complete checkbox**. Title, `due`, labels and tags are display; every other edit opens the detail view. The checkbox goes through the **complete** path, never a bare `status: done` write, so a recurring task rolls forward instead of persisting `done`.
- **Drag semantics (both axes are real writes):**
  - **Vertical (between columns):** rewrites `status`. Dropping into Done triggers completion (recurrence roll-forward).
  - **Horizontal (between lanes):** **moves the file** into the target folder, and rewrites inbound wiki-links to it — the same rename path the file tree uses.
  - A **diagonal** drag is one user action and must land as one: the move and the status rewrite happen together, before the autosave commit, so a card is never half-dropped.
- **Live within a machine, pulled between them.** The board watches the filesystem, so your own edits and the agent's appear instantly. A teammate's appear when auto-pull lands them — this is the concrete, accepted cost of deferring real-time collaboration.

## Task lifecycle & flows

**Create — entry points:**

- **From the board:** quick-add on any column/lane writes `task.<slug>.md` into that lane's folder with that column's status.
- **From a note:** creates the task in the note's folder, with the note wiki-linked in the body.
- **From the agent:** it writes the file with `Write`. No op, no id to mint.
- **By hand, or from anywhere:** create a file matching `task.*.md`. It is a task because of its name.

**Edit:** any field via the detail view, or by editing the file. Both are the same write.

**Complete:** setting `status = done`. If the task is recurring, Holi rolls it forward instead of persisting `done` (see below) and it returns to Todo at its next occurrence.

**Delete:** `rm` the file, or delete from the board. A deleted task leaves any inbound wiki-link dangling, rendered as a tombstone — no cascade.

**Rename/move:** moving the file changes its identity, so inbound wiki-links are rewritten in the same pass. This is the one place tasks are not simpler than before: path-as-identity buys a link rewrite that stable ids did not need. It is the same machinery notes require anyway.

## Recurrence & reminders

> **Runtime design:** the local evaluator / tray / notification shell that fires these is specified in [`../specs/2026-07-28-reminder-runtime-design.md`](../specs/2026-07-28-reminder-runtime-design.md) (realises D60 pt8). Settled there: all-vaults scope, a first-run launch-at-login prompt, a 60s tick with launch catch-up, a `>3` coalesce threshold, tray keep-alive, and a path-keyed delivery watermark behind a `DeliveredLog` seam.

The **pure rule functions port verbatim** from the old repo's Rust into `packages/shared` (TS), with their existing test suites — the math is well-tested; do not rewrite it.

**Recurrence:**

- `nextDue(currentDue, rule)` → next `YYYY-MM-DD` or `null` (bad date / past `endDate`). Handles daily/weekly/monthly/yearly with `interval`, weekly-with-weekdays (same-week scan for interval 1; jump-to-target-week for interval > 1), month/year day-clamping (Jan 31 + 1mo → Feb 28; Feb 29 → Feb 28), and `endDate` cutoff.
- `nextDueCatchup(currentDue, rule, today)` → advances until on-or-after `today` for a stale completion, using the closed-form leap + bounded iteration (so a decade-stale daily task doesn't silently vanish). Port both, and the leap/clamp edge cases the old tests pin.
- **Roll-forward** runs **locally on completion**: advance `due` via `nextDueCatchup`, shift an **absolute** reminder by the same day-delta (relative reminders re-resolve against the new `due` on their own), set status back to `todo`, rewrite the file. This is the *single* roll-forward path.
- **A recurring task with no `due` says so** in the detail view: `nextDue` has nothing to advance from, so the rule would look set and simply never fire.

**Reminders:**

- **Grammar (ported):** relative `Nd` / `Nw` = *N* days/weeks before `due`, resolving to the **09:00 anchor** on the resolved date; or absolute local `YYYY-MM-DDTHH:MM`. Parsing rejects `+1d`/`-1d`/`1h`/bare dates — the parse error string doubles as the agent-facing format doc. A relative reminder with no parseable `due` is **inert**, never an error.
- **Local evaluation.** Holi is **tray-resident and launches at login**, and evaluates pending reminders on a timer over the parsed task set. "Fires while the app is closed" becomes "fires while Holi runs", which for a tray app is nearly the same promise — and it is the honest one, stated plainly rather than implied by a sync indicator.
- **Missed fires catch up on launch**, so quitting for the weekend loses nothing.
- **The delivered-watermark is machine-local** — `.holi/settings.local.json`, gitignored, never committed. This is not a filing preference: a watermark in the repo would make **every reminder fire produce a commit**, and on a shared vault, a push. The old design reached the same conclusion for the same reason when it kept the version token out of the frontmatter.
- **A reminder on a shared task notifies every member.** Tasks have no assignee, so there is no one else it could mean. If that proves noisy, the answer is assignees, not a private reminder channel.
- **Above a coalesce threshold, raise one summary** rather than N notifications — six toasts is not six times the information, it is a wall you dismiss unread. A summary speaks for several tasks, so it carries no single task to focus.
- **The anchor timezone is the machine's local time.** With evaluation local to the device there is no other frame available, and no ambiguity to resolve — this closes an open question the server design could not.

## Concurrency

**Within one machine**, the file is the single writer target: the board, the detail view, the editor, and the agent all write the same bytes, and the last write wins. The board watches the filesystem, so it never renders a stale card for long.

**Between machines**, tasks get the vault's ordinary sync semantics and nothing bespoke:

- Two people editing **different tasks** — different files, git merges them, nobody notices.
- Two people editing **different fields of the same task** — one file, and git merges both **only when the changed lines are not adjacent**. Git needs at least one unchanged line between two changes to treat them as independent hunks; in a five-line frontmatter block neighbours are the common case, and `status` and `due` — the two fields most likely to be edited at once — sit next to each other. Adjacent edits therefore behave like the case below, even though the fields differ.
- Two people editing **the same field** — a genuine conflict, which aborts the merge and offers **Ask Claude to reconcile**, exactly like a conflict in a note. YAML frontmatter is a good case for this: the agent can read both sides and resolve on meaning rather than on line position.
- Two people creating **the same filename** — an add/add conflict, same path.

**Why this is acceptable now and wasn't before.** The old design refused to merge task files character-by-character because a CRDT merge of YAML can converge on genuinely invalid syntax *with no writer able to reject it*. Git is not a CRDT: it refuses rather than guesses, and refusing is what makes the agent-assisted resolution possible. The property the old design needed a record to guarantee, git gives by stopping.

## Agent integration

**The agent works tasks as files, and there is nothing else.** It creates with `Write`, edits with `Edit`, finds with `Glob **/task.*.md`, reads with `Read`, and deletes with `rm`.

**No MCP ops.** Both survivors of the previous design died with the server:

- **`task_list`** was a server query because a full-vault file scan was forbidden. It is now a glob over a naming convention, which is exactly what the `task.` prefix exists to make cheap.
- **`task_set`** existed because `status: done` was ambiguous for a recurring task — roll it forward, or end the series? The ambiguity is resolved by **convention, and the convention is now safe**: `done` on a recurring task rolls it forward, because Holi's own watcher does the roll whoever wrote the file. Ending a series means editing `recurrence` out of the frontmatter — discoverable, reversible, and expressible in the file. The old objection ("convention makes the destructive interpretation the default") is inverted here: roll-forward is the *conservative* reading, and the destructive one requires an explicit edit.

**No role gating**, because there is no server to gate against. The agent runs as you, on files you can already write; GitHub decides whether your push lands.

## Edge cases & risks

- **A file named `task.*.md` that isn't a task** — there isn't one; the name is the definition. This is the whole reason the marker is in the filename rather than in frontmatter, where a copy-pasted `type: task` would create tasks by accident.
- **Deleting a note a task links to:** the wiki-link dangles and renders as a tombstone. No cascade, no orphan rescue.
- **Renaming a folder** moves its tasks with it, and their lane label changes because the lane *is* the folder. Nothing to update.
- **A stale recurring task completed years late:** `nextDueCatchup` must land on-or-after today (closed-form leap, month-clamp back-off, iteration cap). Carry the old regression tests.
- **Midnight rollover:** `overdue` is computed at render, so a board left open overnight must re-render on a date change rather than waiting for an edit.
- **A conflicted task file** is not a valid task file — it contains conflict markers. Because a merge conflict aborts, this state never reaches the board unless a reconcile is in progress, and during a reconcile the board should show the vault as reconciling rather than rendering half-merged cards.
- **Autosave granularity on drag:** a drag is a burst of writes. Debounce so a drag across three lanes is one commit, not three.

## Dependencies

- **[`../architecture.md`](../architecture.md)** — the sync engine (auto-pull, autosave commits, auto-push, reconcile) that carries every task write between machines.
- **[`notes-editor.md`](notes-editor.md)** — the `[[wiki-link]]` grammar tasks use for all linking, and the rename/link-rewrite pass a lane move depends on.
- **[`agent.md`](agent.md)** — the agent's native-tools-only surface.

## Open questions

- **Slug churn on title edit.** Does renaming a task's *title* rename the file? Leaning **no**: the filename is the identity, and silently moving a file on a title edit would rewrite links on every typo fix. The title and the filename are allowed to disagree.
- **Tasks in the file tree.** Task files are ordinary markdown and will appear in the notes tree. Do they render there (with a task glyph), or are they filtered out of the tree because the board owns them? Rendering both is honest; filtering is tidier.
- **Coalesce threshold** for the reminder summary — a number nobody can pick correctly in advance.

## Deferred

- **Time-grouped secondary board view** ("Today / This week / Later") — post-v1, as an *option*, not a mode to configure.
- **Assignees**, and with them per-person reminders on shared tasks.
- **Email/Calendar linking** — arrives with the phase-2 Gmail/Calendar work; as wiki-links or a frontmatter field, decided then rather than reserved now.
- **Inline note-checkbox ↔ task sync** — rejected for v1.
