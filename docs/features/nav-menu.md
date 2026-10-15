# Nav menu

The foot of the sidebar is one menu: a dock of icon shortcuts that morphs into the full,
labelled list. Its first icons sit centred on the file tree's chevrons above it. It is the way to the surfaces that are not files: Home, Search, the vault's
apps, the board, settings, and, once Google is connected, email and the agenda. With the nav
hidden, the same menu runs down the rail.

## How it works

- **Items, in order:** Home, Search, Apps, Board, Mail, Agenda, Agents, Sync, Settings, so
  Settings always ends the dock. The surface items are rail items from the surface registry
  (`{surface, order, visible?}`, label and icon from the surface; see [tabs and panes](tabs-panes.md)),
  sorted by `order` among core's own Search (10), Agents (60) and Sync (70), with Apps (20) the apps plugin's rail item; `visible`
  is an atom, read by one derived atom. Home goes Home (below); Search opens quick open
  ([command palette](command-palette.md)); Board opens the board and carries the open-task count,
  red while any task is overdue (the board's own `overdue` label); Mail, Agenda and Settings open
  their tabs. Agents goes to Claude Code's agent list, the tab ⌘J goes to, and is green while any
  of the vault's sessions is running ([agent sessions](agent-sessions.md)). Sync is the vault's sync state as a glyph whose colour and turning carry it, and opens
  a panel with the state in words, its action and the history ([vaults and sync](vaults-sync.md)).
- **An item may carry a state on its glyph:** `tone` colours it (busy, warn, alert, live) and
  `motion` loops it (`orbit`, `pulse`), only while that state is in flight.
- **Apps is a page** while the workspace plugin runs (`replaces` the apps plugin's own Apps item,
  which holds its open apps as a list). The Apps item opens the `apps` surface, a page of cards, one per finished app,
  most recently opened first, then the rest by name ([vault apps](vault-apps.md)); a card opens that
  app in a tab of its own. It is always on the menu: with no apps the page says what one is and how
  to get one. (It was a drill-down of the menu, which listed names with no room to read them.) The
  menu has no drill-down now.
- **Mail and Agenda** appear only while a Google account is connected. `undefined` (not asked
  main yet) hides them too, so they never flash in.
- **The dock wraps.** Every item has a 32px shortcut, in rows as wide as the
  sidebar allows: one row at the default width, three columns at the 150px minimum. When a resize
  moves a shortcut to another cell it springs there with a little bounce (`motion`'s layout
  animation) rather than jumping. A shortcut grows slightly under the pointer; the growth is a
  `scale`, which takes no layout, so a hover never re-wraps the rows. Since everything has a
  shortcut, there is no More; the labels are the shortcuts' tooltips.
- **On the rail** the dock is one column and takes the shortcuts that fit along the rail's height.
  Only when some do not fit does More take the last slot, and its list
  holds just those, so nothing is offered twice.
- **As the window's dock.** With the workspace plugin on (`plugins: workspace-ui: true`, off by default),
  the menu leaves the sidebar and the rail and sits centred at the foot of the window, in a row of
  its own under the sidebar and the panes, on the popover surface (`anchor="bottom-center"`,
  `surface="float"`, as the board's dock is). It is one row and opens upward from its middle. The
  rail is then empty. The plugin only says so (`RendererPlugin.layout`,
  `{hub: 'dock'}`); `Shell` places the menu, from `hubPlacementAtom`.
- **The open tabs, its second section.** The workspace plugin also takes the tabs out of the panes
  (`{tabs: 'hub'}`, [tabs and panes](tabs-panes.md)) and they become a **second section of the same
  bar**, after the shortcuts and a thin vertical line that sets the two apart
  (`features/nav/OpenTabs`, in `MorphingMenu`'s `trailing`); in the sidebar and the rail, where the
  dock wraps, they wrap above the menu instead. One icon per tab, the one its pane is showing
  marked, its name its tooltip; a note, which has no mark of its own, wears the file's. Pressing an
  icon goes to its tab. **Resting the pointer on a tab opens a small label above the bar** (`primitives/HoverCard`):
  the tab's name (its path, for a file) and a close button. It floats over the pane, so the bar
  never changes size and nothing covers the icon; the pointer can move up into it to press close.
  A middle press closes too, and the keyboard closes the focused tab with ⌘W. The section lists
  every file, every tab of a surface that is one per thing (an app, an agent's terminal), and a
  page no menu item goes to (Settings, History), so each can be closed. A surface that is a menu item's one page (Home, the board, mail) is not listed: its item
  is the way to it. With nothing to list there is no section and no line. **A tab that opens pops up** into its place (up from a little
  below, small and clear, with a bounce: `pop`), while the bar springs wider to make room
  (`dockResize`): the bar inside the shell springs with it and the section takes what is left, so
  the shortcuts stay put and the room opens at the end. A tab that closes shrinks away, the rest
  close up, and the bar springs back. Reduced motion snaps. Apps reads as current
  while an app is showing (`RailItem.tabs`). Past twelve tabs the section scrolls.
- **Settings and sync in the sidebar's header.** The workspace plugin moves the two that are rarely
  pressed out of the menu (`{utilities: 'header'}`, `features/nav/Utilities`): two icons beside the
  vault's name, and at the head of the rail while the sidebar is hidden, so they are at the window's
  top left either way. The sync icon is the menu's glyph, with its colour and turning, and opens the
  same panel in a popover (`SyncButton`); the gear opens Settings.
- **One surface.** The collapsed bar and the open list are one element that resizes between them
  with a spring (a squeeze, then the grow), with the rows cascading in. Open, it is pinned
  `position: fixed` at the dock's corner so it can grow out of the drawer and the 44px rail over
  the panes; it returns to the dock's box once the collapse lands. The dock at rest has no surface,
  only its icons (or `--background` with `surface`, for a toolbar over rows); the open menu floats,
  so it takes `--popover` and its shadow while open, fading back as soon as the collapse starts
  rather than when it lands. A top-right menu grows leftward from its corner, unless that would
  cross the window's left edge (a narrow sidebar): then it grows rightward from the dock's left
  edge.
- **The active surface** reads as current (`aria-current`, the accent background), and an app's
  parent Apps item with it.
- **Sessions** are one row each directly above the menu, under the file tree, only while running:
  no header, nothing to resize or collapse ([agent sessions](agent-sessions.md)).
- **Home** goes where the vault's `home` setting says ([settings](settings.md)). By default it
  is the recents: the Home tab (the `home` surface, opened leftmost like the board) lists the
  last eight notes, files, apps and views opened, under "Recently opened", each opening as the
  palette would open it. A folder document named there (an app) shows in the Home tab instead,
  in its own surface, found through the claims ([vault apps](vault-apps.md)); today's note, a
  view that can be Home (the board, agenda, mail) or a file open as themselves. When the target
  is not there, the Home tab says so.

## Rules

- The menu is two layers: `primitives/MorphingMenu` owns the dock, the morph, focus and dismissal
  and knows nothing of Holi. It also serves the [file tree](file-tree.md)'s toolbar, anchored
  `top-right` so it opens downward, with `pressed` toggles, and the [board](tasks.md)'s dock,
  anchored `bottom-center` with `surface="float"`; `features/nav/NavMenu` builds the items from
  shared state only (`appPathsAtom`, `openTaskCountAtom`, `googleAccountAtom`, the workspace, the
  palette).
- **An item can carry a panel** instead of an action or children: selecting it grows the menu into
  that panel exactly as a group grows into its rows (squeeze, spring, cascade of the panel's
  `data-morph-row` elements), focus goes to the panel's first control, and the panel gets `close`
  to fold the menu when its work is done. `openPanel(id)` on the menu's ref opens one from outside,
  for a hotkey. A panel opens from the dock, so Back and Escape close the menu.
- Home is a destination, not "close everything": a tab of its own, so it can become a dashboard
  without changing what opening it means, and it closes nothing.
- The items are memoised: a change of item identity restarts the menu's layout pass.
- Escape does what Back does (a panel's own Escape handling runs first), then collapses from the
  list; a press outside or tabbing
  away dismisses without choosing. Opened from the keyboard, closing returns focus to the shortcut
  it came from, or to More when the dock had no room for it.
- Reduced motion snaps: no squeeze, spring, blur, cascade or reflow.
- The reflow spring sits on a wrapper around each shortcut, not the button: the button's
  `motion-respond` transitions `transform`, which would lag every frame the spring writes.

## Rejected

- The dock floating over the panes: it covers a note's last lines and lands on the board's and
  the history's own centred docks. A row of its own costs 48px and covers nothing.
- One dock item per open file: twenty files are twenty items with no icon to tell them apart (a
  note has no glyph). They are the bar's second section instead, which scrolls and takes nothing
  from the menu.
- The open tabs in a bar of their own beside the dock: two pills read as two things, and the gap
  between them as a mistake. One bar with a line reads as one dock in two parts.
- Settings and sync at the foot of the Home page: only there while Home shows, and floating over
  nothing in particular. The sidebar's header is always there and is where the vault is named.
- A card of previews over an item, opened by resting the pointer on it (bubbles of pictures of each
  tab, taken with `capturePage`): it opened when you only passed over the dock, hid the tabs behind
  a hover, needed an Open files item to hold the files, and photographed the window every few
  seconds. The section shows what is open at a glance.
- A close button on a tab's corner: on a 32px icon it covers the icon it closes.
- A close button that opens beside the tab's icon, inside the bar: the bar grows under the
  pointer and the dock shifts, even held at one edge. The label above the bar costs no room, and
  names the tab, which an app's icon alone does not (every app wears the same glyph).
- A plugin rendering the menu itself: the items, the sync panel and the hotkeys are core's, and a
  second copy would drift. A plugin says where; core draws.
- A drill-down of the apps in the menu: a list of bare names with a Back row, which the Apps page
  does better.
- The sidebar's Apps section: Finish this app is on the tree's app row, and Show App Files there
  replaces its Edit Source.
- Home as closing all tabs or emptying the pane: the first destroys the working set, and neither
  can grow into a dashboard.
- A dock that drops what does not fit into the list: it hides destinations. A fixed column count:
  the sidebar is 150 to 560px wide, and a fixed grid either wastes the room or overflows it.

## Where it lives

- `apps/desktop/src/renderer/src/primitives/MorphingMenu.tsx`: the menu, a port of Danny
  Williams's morphing menu (dannyjpwilliams.com/playground/morphing-menu) on `motion`.
- `apps/desktop/src/renderer/src/primitives/springs.ts`: its springs, shared with the
  [command palette](command-palette.md).
- `apps/desktop/src/renderer/src/features/nav/NavMenu.tsx`: the items.
- `apps/desktop/src/renderer/src/components/core-surfaces.tsx` (whose Home surface picks Home's
  folder document or `HomeView`), `features/home/HomeView.tsx` (the recents, or why Home is not there).
- `apps/desktop/src/renderer/src/components/Shell.tsx`: the sidebar, rail and dock placement.
- `apps/desktop/src/renderer/src/features/nav/OpenTabs.tsx`: the section of open tabs;
  `composites/tab-look.tsx` names and marks a tab there and in the strip.
- `apps/desktop/src/renderer/src/features/nav/SyncItem.tsx`: the sync item, and the header's
  `SyncButton`; `features/nav/Utilities.tsx` is it and Settings, placed by `Shell`.
- `apps/desktop/src/plugins/workspace-ui/`: the plugin that docks it, puts the tabs in it and adds the Apps page.
