# Tasks

A task is a markdown file named `task.<name>.md`, living in the folder it is about. There is no
record, index or task id: the file is the whole task. The board shows every task in the vault as
Todo / Doing / Done, with one swim lane per folder.

## How it works

- **The file.** The filename prefix makes a file a task, so `**/task.*.md` finds them all. The
  path is the identity and the folder is the lane. Frontmatter holds `status`
  (`todo | doing | done`, default `todo`), `due`, `priority` (`low | medium | high`), `tags`,
  `assignees`, `reminder`, `recurrence` and `order`, all optional. Unknown keys are written back verbatim. The body is the
  description, and its first heading is the title, falling back to the filename
  (`task.fix-login.md` reads "Fix login"). There is no `title:` key.
- **A plugin.** Tasks is the plugin `src/plugins/tasks/`, on by default. In a vault with it off
  (`tasks: false` under `plugins` in `.holi/settings/plugins.yaml`, or this machine's `.local`
  twin), a task file is a plain note: there is no board, quick add, New Task, task chip, task
  frontmatter row or reminder, `holi tasks` answers "no such method", and Google's Link to task
  buttons hide. The files stay as they are.
- **Claimed in the snapshot.** Tasks claim `task.*.md` (`taskClaim`): main's scanner parses each
  into `snapshot.claimed.tasks`, as `items` and the `broken` ones that did not parse, and keeps
  them out of the notes. The `normalize-md` commit transform writes a task's frontmatter in
  canonical key order through the claim's `normalize`, which the editor also recognises as Holi's
  own tidy. The renderer's claim draws a link to a task as a chip with its status orb, offers open
  tasks in the `@` menu, gives a task its frontmatter rows and narrower column, marks task files in
  the tree and the tabs, adds New Task to the explorer, and keeps task files out of the tree until
  Show task files.
- **Dates are stamps**: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, local, no timezone. The time is
  optional on `due` and `reminder`, and its absence means "that day", not midnight.
- **Editing a task is editing its file.** A card click opens it beside the board as a preview,
  with frontmatter drawn as typed rows ([frontmatter](frontmatter.md)). Its body is a narrower
  column than a note's, as wide as those rows.
- **Board.** Todo, Doing and Done are three column surfaces; lanes are groups inside each: the
  vault root (always present, unlabelled), then folders alphabetically. A lane group with no cards in a column
  rests hidden and springs open while a drag is on, so every cell can take a drop. A folder's
  name folds its group shut in that column alone, its count at the row's end; a folded group still
  takes a drop, at its top. Hovering a folder's group shows a + on its row that opens quick add
  with that folder as its lane. The root lane has no name, so it does not fold. Cards are
  tinted (`--muted` on the column's `--card`, both faint), with no edge, and a title stays on one line; Done
  cards recede to flat rows. Each
  column counts its cards. `overdue` and `p1`–`p3` are labels computed at render, drawn as
  coloured text and filtered like tags; clicking a label or tag on a card toggles it in the
  filter, and each active one floats as a chip above the dock whose click takes it off. A todo card's check is a plain ring, a doing card's a dotted one in `--task-doing`. A
  timed due is late after its minute; a timeless one once
  its day has passed. Task files that fail to parse show in a "could not be read" strip.
- **The board reflows as one motion.** A pane opening or closing beside it, or Hide done, springs
  the columns, headers, cards and dock to their new widths together: the board's real width
  follows its container on a spring, so nothing is scaled. A window resize or splitter drag
  follows the pointer instead. The lane a drag aims at lights its name.
- **The dock.** One dock floats at the board's foot (the [nav menu](nav-menu.md)'s morph): Search,
  Filter and Hide done, still the only three narrowing controls, each growing the dock into its
  panel, and quick add. Filter lists the folders that hold tasks (a task in any chosen one) and
  the tags (a task carrying every chosen one); a filter or search moves the board on one spring,
  cards and lane groups together.
- **Completing plays before it moves.** The check fills and ticks, the strike runs across the
  title, the card flicks, and then it flies to Done, over everything it crosses. The write goes out as the tick starts; the
  card is parked in its column until the sequence and the write are both done. A recurring task
  ticks and strikes, then unwinds in place with its next due date. Unticking runs it backwards.
- **Deleting** is Delete in the card's ⋯ menu (on hover), whose row turns into a solid Delete
  that a second pick commits, or the card's context menu. Done's header has a bin of its own that empties the column: it grows
  into a solid Delete pill, a shade crossing it from the right over four seconds. Nothing is
  deleted unless the pill is pressed; when the shade reaches the end it folds back, or waits
  while the pointer is on it. It deletes every done task the column shows. Git keeps them.
- **Dragging.** The card folds out of its cell and a gap springs open where it would land, in any
  cell. Between columns rewrites `status` (into Done means complete). Between lanes moves the file
  through the rename that rewrites inbound [wiki-links](wiki-links.md). **The drop lands at the
  gap**: the card takes a sparse `order` rank between its new neighbours, and the rank rides with
  the status or the move, so a drag writes one file. Unranked cards sort last and by title, so a
  drop below one ranks the unranked cards above it too, in the order shown: that happens once per
  cell. The gap holds until the writes land, then the card unfolds into it. A no-op drop writes
  nothing.
- **Quick add (⌘T)** is the card it will make: a small note editor (mentions, wiki-links, live
  preview) whose first line is the title, set larger, and whose later lines are the description. It
  opens one line tall and grows when Shift+Enter starts a description. On the board it grows out of
  the dock and rises to just under the middle of the view, and the new card flies to its cell;
  anywhere else it opens centred at the top, on the palette's surface. Tab is a wizard: it swaps the
  whole panel for the next field (lane, due, priority, tags) and cycles back to the text; Shift+Tab
  goes back. On a field, ↑/↓ move, and Space, → or a click picks; a single choice then moves on to
  the next field, a tag toggles and stays. Enter on a field returns to the text; Enter in the text
  adds; Shift+Enter is a new line. Escape on a field returns to the text, then closes. The bar at
  the foot is the fields as icons, centred, each opening out to show its value once set. Everything
  is created in Todo. Lane is any folder, defaulting to the active note's; typing on lane or tags
  narrows the list or names a new one; an add closes quick add, the text clears and the lane stays.
  ⌘⇧T is the full-create dialog, which opens the result. Both write the whole task in one create.
  The agent writes the file.
- **Completing** is setting status to done, from the checkbox, a drop into Done, or the status
  row; `completeTask` in `packages/shared` says what that writes. A
  recurring task with a `due` rolls forward: `due` advances to on-or-after today via
  `nextDueCatchup`, keeping its time; the reminder shifts by the same whole-day delta, keeping its
  own time; status returns to `todo`. Otherwise it becomes `done`.
- **Date picker.** `DateTimePicker` edits `due`, `reminder` and a recurrence's `endDate`. Presets
  resolve to a stamp on choosing: reminders are relative to `due` when set ("1 day before"), to now
  otherwise ("tomorrow 09:00"). The month grid is one tab stop with arrow and PageUp/Down keys.
- **Reminders.** While some registered vault runs tasks, closing the window leaves Holi in the
  tray, and Settings > Updates > Open at login starts it at login. Every 60s, and once at launch
  as catch-up, main sweeps every registered vault that runs tasks, open or not, and fires each
  reminder that is due and newer than its watermark. Every notification names the vault its task
  is in. More than 3 in one sweep become a summary per vault ("3 reminders in notes"), never one
  across vaults, and a vault with a single fire keeps its own. A timeless reminder fires at 09:00.
  Clicking a notification opens the task through the same arrival as a Holi link, switching vault
  if needed; that is the only way the sweep reaches the open window. Each vault's tasks are read
  from its own clone at every sweep and kept nowhere, and the per-path watermark lives under
  `reminders` in that vault's machine-local `.holi/settings/app.local.yaml`.
- **Assignees** are GitHub logins (`assignees: [ada]`), the identity a vault already has:
  its members are its repo's collaborators. Like `tags`, a task's assignees are always a list,
  empty when the task is no one's, and an empty list is no key at all. A hand-written `@login` or
  a single login without a list reads the same. One rule in shared says which logins are one
  person (`sameLogin`: GitHub ignores case) and makes every list of them (`cleanLogins`: no `@`,
  no blanks, each person once in the spelling given first). The file reader, the pickers, the
  filter and the reminder sweep all go through it, so `Ada` and `ada` are never two people.
  People to pick come from the collaborators (`github.collaborators`, the ten-minute cache), plus
  the signed-in login and every login a task already names, so the list works offline; it is
  loaded once in the shell (`state/members.ts`). They are offered as a task's `assignees` row,
  quick add's Assignees step (and `@login` in its title, which assigns a member and leaves the
  title without it, while an `@` that names no member stays as written), and the full create's
  Assignees field. A card shows `@login` after its labels, and clicking it filters by them; the
  Filter panel lists everyone some task is assigned to, the signed-in person first, and a task
  matches any chosen person. A login is a name and not an identity: a renamed account stops
  matching, the trade GitHub's own `@mentions` make.
- **An assigned task reminds its assignees only.** The sweep skips a task with assignees unless
  this machine is signed in as one of them (`remindsViewer`, case-insensitive), and does not mark
  it delivered, so handing the task to this person later still fires its reminder. A task with
  no assignees reminds every member running Holi.
- **Between machines** tasks sync like any file ([vaults and sync](vaults-sync.md)).

## Rules

- The marker is in the filename, never frontmatter. A pasted `type: task` must not make tasks.
- Done is completion wherever the app writes it: `tasks.update` (the board's and a vault
  app's `holi.tasks.update`) and `tasks.move` apply `completeTask`, and the
  frontmatter widget writes its result into the buffer, as does the agent's
  `holi tasks complete <path>`. Only a hand edit of the file can write a bare
  `status: done`, and that ends a recurring series. A vault app's note write
  (`docs.write`) to a task file changes its body only: the frontmatter must parse to the
  same fields as the file's, or it is refused and names `tasks.update`.
- Task writes (`tasks.create`, `tasks.update`, `tasks.complete`) each check and write a file
  under that file's lock in main (`withFileLock`), so two at once cannot both
  read the same text, and two creates with one title take two names.
- A reminder is an absolute moment. A non-stamp reminder is inert, never an error, so a legacy
  `1d` costs a notification rather than the task. `due` is strict.
- Virtual labels are never stored: `overdue` would be a commit per task at midnight.
- The delivery watermark never enters a committed file, or every fire is a commit and a push.
- A heading edit never renames the file; that would rewrite inbound links on a typo fix.
- A lane move refuses an existing destination rather than suffixing it.
- A reminder on a task with no assignees notifies every member running Holi; with assignees, only
  them.

## Rejected

- A task record with a file projection: two laptops each hold a private record, nothing arbitrates.
- A task index, or MCP task ops: a glob and native file tools are enough.
- Relative reminders (`1d`): cannot say "the evening before", hide an anchor hour, die with no
  `due`. Also a separate `reminder-time` field and a structured reminder map.
- A day-granular `overdue`: it makes the hour on `due` decorative.
- A date library: the grid is small arithmetic in `calendar.ts`.
- A detail panel beside the board: a second buffer over one path races autosave.
- Time-bucket views, per-user columns, presence, task ids, `related[]`.
- Assignees by account id: stable across a rename, but unreadable in the file and unknown to the
  agent and to GitHub's own `@mentions`.
- People in the editor's `@` popup: picking one would only type their name, which on a task looks
  like an assignment that is not one, and a team's names would push every note down the list.
  They belong there once `@login` does something.
- Collapsing lanes by depth: a collapsed lane has no single folder to drop into.
- Syncing note checkboxes with tasks: it couples notes to tasks again.
- A cross-cell drop that keeps the card's old rank: the gap would show one place and the card land
  in another.
- Moving the card to Done as the check is pressed: the reader never sees it complete.

## Code

Everything is in `apps/desktop/src/plugins/tasks/`.

- `info.ts`: what the plugin is, with the `archive-done` transform's toggle.
- `shared/task-file.ts`, `completion.ts`, `labels.ts`, `recurrence.ts`, `reminder.ts`, `rank.ts`,
  `types.ts`: the format and all the pure rules. Dates, the calendar grid and who is one person
  (`logins.ts`) are core, in `packages/shared`.
- `main/capabilities.ts`: `tasks.list`, `tasks.complete`, `tasks.create` (the UI and app doors,
  which the board, the Google views and vault apps create tasks through), `tasks.update` (the
  board's field edits and a vault app's), and the board's `tasks.move` and `tasks.delete`, which
  apply completion.
- `main/reminders/`: the sweep, tick, watermark and notifications, started as the plugin's work
  across vaults (`start.ts`). The tray is core's (`main/tray.ts`).
- `main/archive-done.ts`, `main/task-done.ts`, `main/seed.ts` and `main/vault/shipped/`: the commit
  transform, completing one file, and the seeded `using-tasks` skill with its deny rules.
- `renderer/state.ts`: task set, filter, drops, writes.
- `renderer/`: the board (`BoardView`, `BoardCard`, `BoardDock`), the completion sequence
  (`use-check-sequence.ts`) and the drag (`use-board-drag.ts`), quick add (`QuickAdd`,
  `QuickAddHost`), the full create (`CreateTask`), the claim (`claim.tsx`), its frontmatter
  controls (`fields.tsx`, `RecurrenceField.tsx`), `TaskIcon` and `board-order.ts`.
- Core keeps what other features use too: `state/clock.ts` (`nowAtom`, `todayAtom`),
  `lib/date-presets.ts`, `composites/DateTimePicker.tsx`, the primitives `TaskCheck`,
  `StrikeText`, `ConfirmInPlace`, `RollingCount` and `Choice`, the board's springs in
  `springs.ts`, and the `task-*` theme tokens.
