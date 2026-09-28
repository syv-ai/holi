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
- **Board.** Todo, Doing and Done are three column surfaces; lanes are groups inside each: the
  vault root (always present, unlabelled), then folders alphabetically. A lane group with no cards in a column
  rests hidden and springs open while a drag is on, so every cell can take a drop. Cards are
  tinted (`--muted` on the column's `--card`, both faint), with no edge, and a title stays on one line; Done
  cards recede to flat rows. Each
  column counts its cards. `overdue` and `p1`–`p3` are labels computed at render, drawn as
  coloured text and filtered like tags. A timed due is late after its minute; a timeless one once
  its day has passed. Task files that fail to parse show in a "could not be read" strip.
- **The board reflows as one motion.** A pane opening or closing beside it, or Hide done, springs
  the columns, headers, cards and dock to their new widths together: the board's real width
  follows its container on a spring, so nothing is scaled. A window resize or splitter drag
  follows the pointer instead. The lane a drag aims at lights its name.
- **The dock.** One dock floats at the board's foot (the [nav menu](nav-menu.md)'s morph): Search,
  Tags and Hide done, still the only three narrowing controls, each growing the dock into its
  panel, and quick add.
- **Completing plays before it moves.** The check fills and ticks, the strike runs across the
  title, the card flicks, and then it flies to Done. The write goes out as the tick starts; the
  card is parked in its column until the sequence and the write are both done. A recurring task
  ticks and strikes, then unwinds in place with its next due date. Unticking runs it backwards.
- **Deleting** is the card's bin, which grows into Delete / ✕ before anything is removed, or the
  card's context menu.
- **Dragging.** The card folds out of its cell and a gap springs open where it would land, in any
  cell. Between columns rewrites `status` (into Done means complete). Between lanes moves the file
  through the rename that rewrites inbound [wiki-links](wiki-links.md). **The drop lands at the
  gap**: the card takes a sparse `order` rank between its new neighbours, and the rank rides with
  the status or the move, so a drag writes one file. Unranked cards sort last and by title, so a
  drop below one ranks the unranked cards above it too, in the order shown: that happens once per
  cell. The gap holds until the writes land, then the card unfolds into it. A no-op drop writes
  nothing.
- **Creating.** A column header's `+` grows into a new card in that column's first lane; Tab
  moves it to the next lane, Enter adds and stays open.
- **Quick add (⌘T)** is the card it will make: a tall field (the first line is the title, the
  rest the description) and a token bar for lane, column, due, priority and tags. On the board it
  grows out of the dock and the new card flies to its cell; anywhere else it opens centred at the
  top, on the palette's surface. Keys set everything: Tab walks the tokens, ←/→ step a token's
  choices with the value following, Space toggles a tag, Backspace clears due or priority, typing
  on lane finds a folder or names a new one, Enter adds, Escape folds a token then closes. Lane is
  any folder, defaulting to the active note's; after an add the text clears and lane and column
  stay. ⌘⇧T is the full-create dialog, which opens the result. Both write the whole task in one
  create. The agent writes the file.
- **Completing** is setting status to done, from the checkbox, a drop into Done, or the status
  row; `completeTask` in `packages/shared` says what that writes. A
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
- Done is completion wherever the app writes it: `tasks.update` and `tasks.move` apply
  `completeTask`, and the frontmatter widget writes its result into the buffer. Only a hand or
  agent edit of the file can write a bare `status: done`, and that ends a recurring series.
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
- A cross-cell drop that keeps the card's old rank: the gap would show one place and the card land
  in another.
- Moving the card to Done as the check is pressed: the reader never sees it complete.

## Code

- `packages/shared/src/task-file.ts`, `completion.ts`, `dates.ts`, `calendar.ts`, `labels.ts`,
  `recurrence.ts`, `reminder.ts`, `rank.ts`: the format and all the pure rules.
- `apps/desktop/src/main/router.ts`: `tasks.*` and `patched`, which applies completion.
- `apps/desktop/src/main/reminders/`, `main/tray.ts`: the sweep, tick, watermark, notifications.
- `apps/desktop/src/renderer/src/state/tasks.ts`: task set, filter, drops, writes.
- `apps/desktop/src/renderer/src/state/clock.ts`: `nowAtom` and `todayAtom`, the minute the overdue labels and the daily note read.
- `apps/desktop/src/renderer/src/features/tasks/`: the board (`BoardView`, `BoardCard`,
  `BoardDock`), the completion sequence (`use-check-sequence.ts`) and the drag
  (`use-board-drag.ts`), quick add (`QuickAdd`, `QuickAddHost`); `lib/board-order.ts`, `lib/date-presets.ts`,
  `composites/DateTimePicker.tsx`, `composites/RecurrenceField.tsx`.
- `apps/desktop/src/renderer/src/primitives/TaskCheck.tsx`, `StrikeText.tsx`, `ConfirmInPlace.tsx`,
  `RollingCount.tsx`, `Choice.tsx`, and the board's springs in `springs.ts`.
- `apps/desktop/src/main/agent/skills/using-tasks/SKILL.md`: the seeded agent skill.
