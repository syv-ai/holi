# Tasks

A task is a markdown file named `task.<name>.md`, living in the folder it is about. There is no
record, index or task id: the file is the whole task. The vault's statuses are its columns, and
the [planning](planning.md) view shows every task in the vault by them.

## How it works

- **The file.** The filename prefix makes a file a task, so `**/task.*.md` finds them all. The
  path is the identity and the folder is the lane. Frontmatter holds `status` (default `todo`),
  `start` and `due` (stamps), `priority` (`low | medium | high | urgent`), `estimate`, `tags`,
  `assignees`, `reminder`, `recurrence` and `order`, all optional, written in that order. Unknown
  keys are written back verbatim.
- **Statuses are the vault's.** `status` is any word; which words are columns is
  `.holi/statuses.yaml`'s to say ([planning](planning.md)), each status with a fixed category
  (`backlog`, `unstarted`, `started`, `review`, `completed`) that is all the app reasons with.
  Without that file a vault has Backlog, To do, In progress, Review and Done, whose ids are
  `backlog`, `todo`, `doing`, `review` and `done`, so a task written before statuses were the
  vault's needs nothing rewritten. A status the vault does not list still shows (`columnFor` in
  shared): `todo`, `doing` and `done` in the first status of what they meant, anything else in the
  first `unstarted` one, and the file keeps its word until someone moves the task. Open means any
  status not filed under `completed`: the sidebar's Board count, `overdue`, Progress. The file
  format holds only that a status is a word, since the vocabulary is per vault.
- **Urgent** sits above high, and reads as the `p0` label. **`estimate`** is how much work a task
  is: a number and `m`, `h`, `d` or `w` (`30m`, `2h`, `1.5d`, `1w`), a day being eight working
  hours and a week five days when estimates are added up (`estimate.ts`). **`start`** is when work
  begins, a stamp like `due`. The body is the
  description, and its first heading is the title, falling back to the filename
  (`task.fix-login.md` reads "Fix login"). There is no `title:` key.
- **Claimed in the snapshot.** Tasks claim `task.*.md` (`taskClaim` in shared): main's scanner
  parses each into `snapshot.claimed.tasks`, as `items` and the `broken` ones that did not parse,
  and keeps them out of the notes. The `normalize-md` commit transform writes a task's frontmatter
  in canonical key order through the claim's `normalize`, which the editor also recognises as
  Holi's own tidy. Tasks is still a core part, so
  the claim runs in every vault; with a claim absent its files are plain notes.
- **Dates are stamps**: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, local, no timezone. The time is
  optional on `due` and `reminder`, and its absence means "that day", not midnight.
- **Editing a task is editing its file.** A card click opens it beside the board as a preview,
  with frontmatter drawn as typed rows ([frontmatter](frontmatter.md)). Its body is a narrower
  column than a note's, as wide as those rows.
- **Board.** ReUI's kanban (`primitives/Kanban.tsx`): Todo, Doing and Done are three column
  surfaces (`bg-muted`, rounded, full height, `gap-4` apart in `p-4`), each headed by its name, a
  count `Badge` and a + that opens quick add creating in that column. Inside a column the cards
  are grouped by lane: the vault root first (unlabelled), then folders alphabetically, each
  folder's name heading its first card, with a + on hover that opens quick add in that folder. A
  card is a surface on the column (`--background`, `shadow-xs`) with one-line title; a done card's
  title is struck through and muted. `overdue` and `p1`–`p3` are labels computed at render, drawn
  as coloured text and filtered like tags; clicking a label or tag on a card toggles it in the
  filter. A todo card's check is a plain ring, a doing card's a dotted one in `--task-doing`. A
  timed due is late after its minute; a timeless one once its day has passed. An empty column says
  so inside itself: Todo with "No tasks" (or "Nothing matches" under a filter) and an Add task
  button, the others a quiet "Nothing here". Task files that fail to parse show in a "could not
  be read" strip.
- **The toolbar.** A row across the board's top, in the panel header's style: Search, Filter
  and View (Show Done), still the only three narrowing controls, then a chip per active filter
  whose click takes it off, and New task on the right. Filter is a menu of checkboxes: the folders
  that hold tasks (a task in any chosen one), the people tasks are assigned to (any chosen one),
  and the tags (a task carrying every chosen one). Turning Show Done off drops the whole Done
  column, not just its cards.
- **The check** on a card fills at once, a single calm fade, and strikes the title;
  the status write goes out on the same click and the card moves to Done when the vault re-reads.
  A recurring task rolls forward instead: its check empties again and its due date moves.
  Unticking a done card reopens it to Todo.
- **Deleting** is Delete… in the card's ⋯ menu (on hover) or its context menu, and Delete every
  done task… in Done's header menu; each asks once in a dialog. Git keeps them.
- **Dragging** is the kanban's: a press that moves 10px picks the card up (a click without
  moving opens it), its neighbours make room, and a copy follows the pointer. Between columns
  rewrites `status` (into Done means complete). Dropped among another lane's cards (the lane of
  the card above it, or below it at the top), it moves the file through the rename that rewrites
  inbound [wiki-links](wiki-links.md). **The drop lands where it is shown**: the card takes a
  sparse `order` rank between its new neighbours in that cell, and the rank rides with the status
  or the move, so a drag writes one file. Unranked cards sort last and by title, so a drop below
  one ranks the unranked cards above it too, in the order shown: that happens once per cell. The
  board keeps the dropped arrangement until the writes land. A no-op drop writes nothing.
- **Quick add (⌘T)** is the card it will make: a small note editor (mentions, wiki-links, live
  preview) whose first line is the title, set larger, and whose later lines are the description. It
  opens one line tall and grows when Shift+Enter starts a description. It is a dialog anchored
  near the top of the window, as the palette is, wherever it is opened from. Tab is a wizard: it swaps the
  whole panel for the next field (lane, due, priority, tags) and cycles back to the text; Shift+Tab
  goes back. On a field, ↑/↓ move, and Space, → or a click picks; a single choice then moves on to
  the next field, a tag toggles and stays. Enter on a field returns to the text; Enter in the text
  adds; Shift+Enter is a new line. Escape on a field returns to the text, then closes. The bar at
  the foot is the fields as icons, centred, each showing its value once set. It creates in Todo, or
  in the column whose + opened it. Lane is any folder, defaulting to the active note's; typing on lane or tags
  narrows the list or names a new one; an add closes quick add, the text clears and the lane stays.
  ⌘⇧T is the full-create dialog, which opens the result. Both write the whole task in one create.
  The agent writes the file.
- **Completing** is setting a status filed under `completed`, from the checkbox, a drop into a
  completed column, or the status row; `completeTask` in `packages/shared` says what that writes,
  and main reads the vault's statuses to know which ones complete (`main/vault/statuses.ts`). A
  recurring task with a `due` rolls forward: `due` advances to on-or-after today via
  `nextDueCatchup`, keeping its time; the reminder shifts by the same whole-day delta, keeping its
  own time; status returns to the vault's first `unstarted` status. Otherwise it takes the
  completed status it was set to (`holi tasks complete` uses the first one).
- **Date picker.** `DateTimePicker` edits `due`, `reminder` and a recurrence's `endDate`. Presets
  resolve to a stamp on choosing: reminders are relative to `due` when set ("1 day before"), to now
  otherwise ("tomorrow 09:00"). The month grid is one tab stop with arrow and PageUp/Down keys.
- **Reminders.** Closing the window leaves Holi in the tray, and first launch asks once about
  starting at login. Every 60s, and once at launch as catch-up, main sweeps every registered vault
  and fires each reminder that is due and newer than its watermark. More than 3 in one sweep
  become one summary. A timeless reminder fires at 09:00. Clicking a notification opens the task,
  switching vault if needed. The per-path watermark lives under `reminders` in the vault's
  machine-local `.holi/settings/app.local.yaml`.
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
- Done is completion wherever the app writes it: `tasks.update` and `tasks.move` apply
  `completeTask` to any status the vault files under `completed`, and the frontmatter widget writes
  its result into the buffer, as does the agent's `holi tasks complete <path>`. Only a hand edit
  of the file can write a bare completed status, and that ends a recurring series.
- A status is never rewritten for not being listed: showing a task somewhere is display, and only
  a person moving it writes a new status.
- The reminder sweep, `archive-done` and the editor's status row still know only Holi's default
  ids: a vault whose completed status is not `done` keeps reminding of finished tasks and does not
  archive them.
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
- A floating dock at the board's foot for its controls: it covered the last cards and hid what
  the board was narrowed by; a toolbar across the top shows both.
- Syncing note checkboxes with tasks: it couples notes to tasks again.
- A cross-cell drop that keeps the card's old rank: the gap would show one place and the card land
  in another.
- Moving the card to Done as the check is pressed: the reader never sees it complete.

## Code

- `packages/shared/src/task-file.ts`, `statuses.ts`, `estimate.ts`, `completion.ts`, `dates.ts`,
  `calendar.ts`, `labels.ts`, `recurrence.ts`, `reminder.ts`, `rank.ts`: the format and all the
  pure rules.
- `apps/desktop/src/main/router.ts`: `tasks.*` and `patched`, which applies completion.
- `apps/desktop/src/main/vault/task-capabilities.ts`: `tasks.list`, `tasks.complete`, and
  `tasks.create` (the UI door), which the board and the Google views create tasks through.
- `apps/desktop/src/main/reminders/`, `main/tray.ts`: the sweep, tick, watermark, notifications.
- `apps/desktop/src/renderer/src/state/tasks.ts`: task set, filter, drops, writes.
- `apps/desktop/src/renderer/src/state/clock.ts`: `nowAtom` and `todayAtom`, the minute the overdue labels and the daily note read.
- `apps/desktop/src/renderer/src/features/tasks/`: the board (`BoardView`, `BoardCard`,
  `BoardToolbar`, `ConfirmDelete`), quick add (`QuickAdd`, `QuickAddHost`); `lib/board-order.ts`,
  `lib/date-presets.ts`, `composites/DateTimePicker.tsx`, `composites/RecurrenceField.tsx`.
- `apps/desktop/src/renderer/src/primitives/Kanban.tsx` (ReUI's kanban, on dnd-kit) and
  `TaskCheck.tsx`.
- `apps/desktop/src/plugins/agent/main/claude/vault/shipped/.claude/skills/using-tasks/SKILL.md`: the seeded agent skill.
