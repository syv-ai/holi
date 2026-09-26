# Tasks

A task is a markdown file named `task.<name>.md`, living in the folder it is about. There is no
record, index or task id: the file is the whole task. The board shows every task in the vault as
Todo / Doing / Done, with one swim lane per folder.

## How it works

- **The file.** The filename prefix makes a file a task, so `**/task.*.md` finds them all. The
  path is the identity and the folder is the lane. Frontmatter holds `status`
  (`todo | doing | done`, default `todo`), `due`, `priority` (`low | medium | high`), `tags`, `reminder`,
  `recurrence` and `order`, all optional. Unknown keys are written back verbatim. The body is the
  description, and its first heading is the title, falling back to the filename
  (`task.fix-login.md` reads "Fix login"). There is no `title:` key.
- **Dates are stamps**: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, local, no timezone. The time is
  optional on `due` and `reminder`, and its absence means "that day", not midnight.
- **Editing a task is editing its file.** A card click opens it beside the board as a preview,
  with frontmatter drawn as typed rows ([frontmatter](frontmatter.md)).
- **Board.** Lanes are the vault root (always present), then folders alphabetically. The filter
  bar has three controls: text, tags, hide done. `overdue` and `p1`–`p3` are chips computed at
  render and filter like tags. A timed due is late after its minute; a timeless one once its day
  has passed. Task files that fail to parse show in a "could not be read" strip.
- **Dragging.** Between columns rewrites `status` (into Done means complete). Between lanes moves
  the file through the rename that rewrites inbound [wiki-links](wiki-links.md). A diagonal is one
  call. Within a cell, the card gets a sparse `order` rank between its neighbours, so one drag
  writes one file; unranked cards sort last, ties break by title, a no-op drop writes nothing.
- **Creating.** A column header's `+` adds into that cell. ⌘T is quick create, ⌘⇧T shows every
  field and opens the result; both default to the active note's folder. The agent writes the file.
- **Completing** is `tasks.complete`, from the checkbox, a drop into Done, or the status row. A
  recurring task with a `due` rolls forward: `due` advances to on-or-after today via
  `nextDueCatchup`, keeping its time; the reminder shifts by the same whole-day delta, keeping its
  own time; status returns to `todo`. Otherwise it becomes `done`.
- **Date picker.** `DateTimePicker` edits `due`, `reminder` and a recurrence's `endDate`. Presets
  resolve to a stamp on choosing: reminders are relative to `due` when set ("1 day before"), to now
  otherwise ("tomorrow 09:00"). The month grid is one tab stop with arrow and PageUp/Down keys.
- **Reminders.** Closing the window leaves Holi in the tray, and first launch asks once about
  starting at login. Every 60s, and once at launch as catch-up, main sweeps every registered vault
  and fires each reminder that is due and newer than its watermark. More than 3 in one sweep
  become one summary. A timeless reminder fires at 09:00. Clicking a notification opens the task,
  switching vault if needed. The per-path watermark lives under `reminders` in the vault's
  machine-local `.holi/settings/app.local.yaml`.
- **Between machines** tasks sync like any file ([vaults and sync](vaults-sync.md)).

## Rules

- The marker is in the filename, never frontmatter. A pasted `type: task` must not make tasks.
- Completion always goes through `tasks.complete`. A bare `status: done` ends a recurring series.
- A reminder is an absolute moment. A non-stamp reminder is inert, never an error, so a legacy
  `1d` costs a notification rather than the task. `due` is strict.
- Virtual labels are never stored: `overdue` would be a commit per task at midnight.
- The delivery watermark never enters a committed file, or every fire is a commit and a push.
- A heading edit never renames the file; that would rewrite inbound links on a typo fix.
- A lane move refuses an existing destination rather than suffixing it.
- A reminder on a shared task notifies every member running Holi. There are no assignees.

## Rejected

- A task record with a file projection: two laptops each hold a private record, nothing arbitrates.
- A task index, or MCP task ops: a glob and native file tools are enough.
- Relative reminders (`1d`): cannot say "the evening before", hide an anchor hour, die with no
  `due`. Also a separate `reminder-time` field and a structured reminder map.
- A day-granular `overdue`: it makes the hour on `due` decorative.
- A date library: the grid is small arithmetic in `calendar.ts`.
- A detail panel beside the board: a second buffer over one path races autosave.
- Time-bucket views, per-user columns, assignees, presence, task ids, `related[]`.
- Collapsing lanes by depth: a collapsed lane has no single folder to drop into.
- Syncing note checkboxes with tasks: it couples notes to tasks again.

## Code

- `packages/shared/src/task-file.ts`, `dates.ts`, `calendar.ts`, `labels.ts`, `recurrence.ts`,
  `reminder.ts`, `rank.ts`: the format and all the pure rules.
- `apps/desktop/src/main/router.ts`: `tasks.*` and `rollForward`.
- `apps/desktop/src/main/reminders/`, `main/tray.ts`: the sweep, tick, watermark, notifications.
- `apps/desktop/src/renderer/src/state/tasks.ts`: task set, filter, drops, writes, `nowAtom`.
- `apps/desktop/src/renderer/src/features/tasks/`, `lib/board-order.ts`, `lib/date-presets.ts`,
  `composites/DateTimePicker.tsx`, `composites/RecurrenceField.tsx`.
- `apps/desktop/src/main/agent/skills/using-tasks/SKILL.md`: the seeded agent skill.
