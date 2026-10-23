# Planning

The vault is one ongoing project. The sidebar's **Board** opens it as a page after gr8r's project
view: a header with the project's name, status and people, over four tabs, **Overview**, **Board**,
**List** and **Table**. There is no project list and no second project per vault: a vault that needs
two projects is two vaults.

## How it works

- **The project file.** `.holi/project.md`, committed, so everyone who clones the vault sees the
  same project. YAML frontmatter holds `name`, `status` (`planning | active | at-risk | on-hold |
complete`), `lead` (a GitHub login), `start` and `due` (stamps, as on a task) and `milestones`
  (a list of `{name, date}`, `date` a `YYYY-MM-DD`); the markdown body is the project's About.
  Every key is optional, and so is the file: without one the project is named after the vault
  and is `planning`. Unknown keys are written back as they were. A wrong value is dropped with a
  warning instead of failing, because there is only one project file and a typo in it must not
  take the Overview with it (`project-file.ts` in shared).
- **The statuses** are the vault's own, in `.holi/statuses.yaml` (committed): the Board's columns
  and the List's and Table's groups, in the file's order. Each has an `id` (what a task file's
  `status` says), a `name` (what the column is called) and a fixed `category`, `backlog`,
  `unstarted`, `started`, `review` or `completed`. The app reasons only with categories, so a
  vault can rename, reorder and add statuses without teaching Holi what they mean. Without the
  file a vault has gr8r's five: Backlog, To do, In progress, Review, Done, whose ids include
  Holi's old `todo`, `doing` and `done`. See [tasks](tasks.md) for what a status means to a task.
- **Both files are read through main** like any vault file and re-read whenever the snapshot says
  one changed, so an edit made in the editor, by the agent or by a teammate reaches the view the
  way a task edit does. They are loaded once in the shell (`state/planning.ts`), because the
  sidebar's Board count needs the statuses before the view is ever opened.
- **Overview.** About, Progress and Coming up on the left; Details, Milestones and Recent activity
  on the right. Progress is the share of tasks in a `completed` status, the days until the
  project's `due`, how many open tasks are overdue, and a bar split by status with each status's
  count (a count opens the List). Coming up is the next six open tasks with a due date. Details
  are the project's status, lead, start, due and its members, the people tasks are assigned to.
  Recent activity is git's log: commits that touched a task file or the project file, newest
  first. Autosave commits say only `Update <path>`, so every entry reads "changed"; it reads
  more once commits say more. **Edit project** opens one form over the whole file; saving writes
  it whole and autosave commits it.
- **Board.** One column per status. A card shows its tags, title, priority (Urgent in the
  destructive colour, above High), due date (red once overdue), assignees and estimate; its title
  opens the task as a tab. Dragging between columns writes `status` through the same task write
  the rest of Holi uses, so a drop into a `completed` column is completion and a recurring task
  rolls forward. Dragging within a column ranks the card (`order`, [tasks](tasks.md)); under any
  sort but Manual the column orders itself, so a drop there writes only the status. A task whose
  status the vault does not list shows in a column (`columnFor`) and its file keeps its word
  until someone moves it. Each column ends in **Add task**, a one-line title field that creates
  in that status and stays open for the next.
- **List** is the tasks grouped by status under collapsible group rows, with Task, Status,
  Assignee, Priority, Due and Tags, and an Add task line in each group. **Table** is the same
  groups under a header with every field, Start and Estimate included, and Display switches
  columns on and off. A row's status is a menu that moves the task.
- **One toolbar** across Board, List and Table: Search, Filter (priority, assignee, tags), Sort
  (Manual, Due date, Priority, Start date, Title) and **New task**, a form for the title and the
  fields worth setting before a task exists; the new task opens. The tab, search, filter and sort
  are kept for the session, so leaving the Board and coming back finds them as they were.
- **New tasks go to the vault root.** The planning view has no folders; a task can be moved into
  one from the tree.
- **Every region has its three states**: a skeleton in its shape while it loads, an empty state
  with the one thing to do next, and an inline error with Retry. Task files that do not parse are
  listed above the board with Retry, never hidden.

## Rules

- The project is the vault; its file is committed content, edited like any other.
- The app never writes a status a person did not choose. A status the vault does not list is
  shown, not corrected.
- Avatars are GitHub's (`github.com/<login>.png`), falling back to initials offline; the git
  log's authors are names, not logins, and show as initials.

## Rejected

- Several projects per vault: a vault is already the unit people share, sync and clone.
- Statuses in `.holi/settings/app.yaml`: that file is rewritten whole on every write, so the
  comments a team writes beside its columns would not survive.
- Seeding `.holi/statuses.yaml`: a seeded file is frozen at seeding, and the defaults in code reach
  every vault, old ones included.
- Folder lanes on the planning board: the project is one list of work; folders are where a task
  is filed, not how far along it is.
- Subtasks, label colours and task ids.

## Code

- `packages/shared/src/statuses.ts`, `project-file.ts`, `estimate.ts`: the two files and the
  estimate format.
- `apps/desktop/src/renderer/src/state/planning.ts`: the files, loaded once; the view's tab,
  filter and sort.
- `apps/desktop/src/renderer/src/lib/planning.ts`: filtering, sorting, grouping, progress.
- `apps/desktop/src/renderer/src/components/blocks/planning/`: the view, the Overview, the toolbar,
  the dialogs; built on ReUI's `navbar-1`, `stats-9`, `card-7`, `timeline-4`, `kanban-board-1`
  and `data-grid-grouping-1`, under `components/blocks/`.
