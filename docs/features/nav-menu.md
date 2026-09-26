# Nav menu

The foot of the sidebar is one menu: a dock of icon shortcuts that morphs into the full,
labelled list (D108). It is the way to the surfaces that are not files: Home, Search, the vault's
apps, the board, settings, and, once Google is connected, email and the agenda. With the nav
hidden, the same menu runs down the rail.

## How it works

- **Items, in order:** Home, Search, Apps, Board, Settings, Email, Agenda. Home opens the home
  tab; Search opens quick open ([command palette](command-palette.md)); Board opens the board and
  carries the open-task count; Settings, Email and Agenda open their tabs.
- **Apps is a drill-down.** Its children are the vault's finished apps by name
  ([vault apps](vault-apps.md)); from the dock it opens straight into them, from the list it
  drills in, and Back returns. It is absent when the vault has no finished apps.
- **Email and Agenda** appear only while a Google account is connected. `undefined` (not asked
  main yet) hides them too, so they never flash in.
- **The dock takes what fits.** Items fill it in order for as far as the sidebar's width allows,
  32px each, and More always ends it. More opens the full list, where every item has its label and
  the ones the dock had no room for live. At the default 320px width all seven fit.
- **On the rail** the dock is vertical and fits along the rail's height under the session orbs.
- **One surface.** The collapsed bar and the open list are one element that resizes between them
  with a spring (a squeeze, then the grow), with the rows cascading in. Open, it is pinned
  `position: fixed` at the dock's corner so it can grow out of the drawer and the 44px rail over
  the panes; it returns to the dock's box once the collapse lands. It is floating, so it takes
  `--popover` and its shadow in both states.
- **The active surface** reads as current (`aria-current`, the accent background), and an app's
  parent Apps item with it.
- **Sessions** keep their resizable, collapsible **chats** panel, now directly above the menu
  ([agent sessions](agent-sessions.md)).
- **Home** is a singleton tab (`home`), opened leftmost like the board. Today it shows the empty
  editor's state.

## Rules

- The menu is two layers: `primitives/MorphingMenu` owns the dock, the morph, focus and dismissal
  and knows nothing of Holi; `features/nav/NavMenu` builds the items from shared state only
  (`appPathsAtom`, `openTaskCountAtom`, `googleAccountAtom`, the workspace, the palette).
- Home is a destination, not "close everything": a tab of its own, so it can become a dashboard
  without changing what opening it means, and it closes nothing.
- The items are memoised: a change of item identity restarts the menu's layout pass.
- Escape steps back from a drill-down to the list, then collapses; a press outside or tabbing
  away dismisses without choosing. Opened from the keyboard, closing returns focus to the shortcut
  it came from, or to More when the dock had no room for it.
- Reduced motion snaps: no squeeze, spring, blur or cascade.

## Rejected

- A separate Radix dropdown for the apps: two popup styles side by side, when the menu already
  has a one-level drill-down.
- The sidebar's Apps section: Finish this app is on the tree's app row, and Show Contents there
  replaces its Edit Source.
- Home as closing all tabs or emptying the pane: the first destroys the working set, and neither
  can grow into a dashboard.
- A fixed short dock: the sidebar is 150 to 560px wide, and a dock that ignores it either wastes
  the room or overflows it.

## Where it lives

- `apps/desktop/src/renderer/src/primitives/MorphingMenu.tsx`: the menu, a port of Danny
  Williams's morphing menu (dannyjpwilliams.com/playground/morphing-menu) on `motion`.
- `apps/desktop/src/renderer/src/features/nav/NavMenu.tsx`: the items.
- `apps/desktop/src/renderer/src/features/home/HomeView.tsx`: the home tab.
- `apps/desktop/src/renderer/src/components/Shell.tsx`: the sidebar and rail placement.
