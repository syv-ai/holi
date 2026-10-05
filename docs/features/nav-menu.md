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
- **Holding the open tabs.** The workspace plugin also takes the tabs out of the panes
  (`{tabs: 'hub'}`, [tabs and panes](tabs-panes.md)) and the menu holds them. An item holds its
  surface's open tabs, or those of the surface it names (`RailItem.tabs`: Apps is the page of apps and holds the
  `app` tabs), when the surface is one tab per thing (an app): resting the pointer on its dock shortcut opens a card of them in place of
  the tooltip (`primitives/HoverCard`, `features/nav/OpenTabs`). Each tab is a **bubble holding a small
  picture of what it looks like**, with no words (its name is its accessible name), the one its pane
  is showing outlined; pressing it goes to the tab, and a close button shows on its corner while the
  pointer is on it. The last bubble is a **+**, a new tab: the item's own page (Apps' page of cards),
  or Home for the files, which have no page of their own. A tab that has not been seen yet shows its
  mark in place of a picture. A surface that is one page (Home, the board, mail, the
  agents' overview) has nothing to list, so its item keeps its tooltip and is simply the way to
  it. Every tab no item's surface owns, which
  is the files (and History), is held by one more item, Open files (order 15, after Search),
  there only while there are any, with their count as its badge; pressing it goes back to the file
  its pane was showing. A shortcut with a card wears a dot under its glyph. The card is the
  pointer's; the keyboard reaches a tab through the palette, as before.
- **The pictures** (`state/tab-thumbs`) are the window's own pixels: a vault app is a page in a
  frame, which nothing else can read. Main takes one on request (`holi:capturePage`, the window's
  `capturePage` of the rectangle of a pane's body, shrunk to a JPEG data URL), and the renderer asks
  for the tab each pane is showing 0.7 s and 2.6 s after it arrives and every 12 s while it stays,
  never while a card, the agents' fan, a menu or a dialog is over the panes, which would be in the
  picture. A tab can only be photographed while it shows, so a tab never opened since Holi started has
  no picture yet; pictures are kept in memory only and go with their tab. The agents' bubbles that
  float over a pane's top right are in its picture.
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
  note has no glyph). One item that lists them reads the same at two files and at twenty. (The card
  of an item's tabs is bubbles of pictures, which tell them apart by what they look like.)
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
- `apps/desktop/src/renderer/src/features/nav/OpenTabs.tsx`: the card of an item's open tabs (bubbles of
  `state/tab-thumbs.ts`' pictures, taken by `main/ipc.ts`' `holi:capturePage`);
  `composites/tab-look.tsx` names and marks a tab there and in the strip.
- `apps/desktop/src/plugins/workspace-ui/`: the plugin that docks it, puts the tabs in it and adds the Apps page.
