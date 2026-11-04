# Nav menu

The nav's items: the places that are not files, each with its state (`useNavItems`). The sidebar
shows Home from them ([sidebar](sidebar.md)); the rest are reached from the
[command palette](command-palette.md). `NavMenu`, a dropdown menu of them, and `useNavItems` are not in the renderer today (the code is gone, see [not-built](../not-built.md)); the sidebar and ⌘K reach the same places. They are the surfaces that are not files: Home, Search, the vault's apps, the board,
settings, and, once Google is connected, email and the agenda.

## How it works

- **Items, in order:** Home, Search, Apps, Board, Mail, Agenda, Agents, Sync, Update, Settings, so
  Settings always ends the list. The surface items are rail items from the surface registry
  (`{surface, order, visible?, badge?}`, label and icon from the surface; see [tabs and panes](tabs-panes.md)),
  sorted by `order` among core's own Search (10) and Sync (70), with Apps (20) the apps plugin's rail item,
  Board (30) the tasks plugin's and Agents (60) the agent's; `visible` and `badge` (a count and a tone,
  or null for none) are atoms, read by one derived atom. Home goes Home (below); Search opens quick open
  ([command palette](command-palette.md)); Board opens the board and carries its badge, the open-task count,
  red while any task is overdue (the board's own `overdue` label); Mail, Agenda and Settings open
  their tabs. Agents goes to Claude Code's agent list, the tab ⌘J goes to, and is green while any
  of the vault's sessions is running ([agent sessions](agent-sessions.md)). Sync is the vault's sync state as a glyph whose colour and turning carry it, and opens
  a panel with the state in words, its action and the history ([vaults and sync](vaults-sync.md)).
  Update (75) is there only while an update to Holi is ready or failed to download, or this release
  has newer skills for the open vault, and opens a panel with Restart to update, Try again, or
  Update skills and Not now ([updates](updates.md)).
- **An item may carry a state on its glyph:** `tone` colours it (busy, warn, alert, live) and
  `motion` loops it (`orbit`, `pulse`), only while that state is in flight.
- **Apps is a drill-down.** A rail item whose surface has `instances` is one: Apps is the `app`
  surface's, and its children are the vault's finished apps, most recently opened first (the
  recents), then the rest by name ([vault apps](vault-apps.md)); in the menu it is a submenu. It is
  absent when the vault has no finished apps.
- **Mail and Agenda** appear only while a Google account is connected. `undefined` (not asked
  main yet) hides them too, so they never flash in.
- **The menu** is the house `DropdownMenu` behind one icon button, Go to: one row per item with
  its glyph, label and count; a group (Apps) or a panel (Sync, Update) opens as a submenu. Its
  motion is every popup's (`motion-in-origin`, `motion-out-origin`).
- **The active surface** reads as current (`aria-current`), and an app's parent Apps item with it.
- **Sessions** are one row each directly above the menu, under the file tree, only while running:
  no header, nothing to resize or collapse ([agent sessions](agent-sessions.md)).
- **Home** goes where the vault's `home` setting says ([settings](settings.md)). By default it
  is the vault overview: the Home tab (the `home` surface, opened leftmost like the board) lists the
  last eight notes, files, apps and views opened, under "Recently opened", each opening as the
  palette would open it. Above them, when the vault has a `README.md`, it shows read-only, with an
  Open button that opens the file: a new member sees what the vault is for first. It is read again
  whenever the file changes, rendered by the same `MarkdownText` as release notes, so it never
  becomes HTML. A folder document named there (an app) shows in the Home tab instead,
  in its own surface, found through the claims ([vault apps](vault-apps.md)); today's note, a
  view that can be Home (the board, agenda, mail) or a file open as themselves. When the target
  is not there, the Home tab says so.

## Rules

- The items are built from shared state only (the rail's items with their badges, the workspace,
  the palette), so the sidebar and the menu can never disagree about where you can go.
- **An item can carry a panel** instead of an action or children (Sync, Update): it gets `close`
  to close its menu when its work is done.
- Home is a destination, not "close everything": a tab of its own, so it can become a dashboard
  without changing what opening it means, and it closes nothing.

## Rejected

- A morphing dock (a bar of shortcuts that springs open into the list, rows cascading in): its own
  motion language beside every other popup's, for the job a dropdown does.
- The sidebar's Apps section: Finish this app is on the tree's app row, and Show App Files there
  replaces its Edit Source.
- Home as closing all tabs or emptying the pane: the first destroys the working set, and neither
  can grow into a dashboard.

## Where it lives

- `apps/desktop/src/renderer/src/state/plugins.ts`: the rail items plugins contribute (`railAtom`), the surfaces they open.
- `apps/desktop/src/renderer/src/state/home.ts`, `lib/home-target.ts`: Home, where the vault's `home` setting says.
- `apps/desktop/src/renderer/src/features/sidebar/app-sidebar.tsx`: where the destinations are today.
