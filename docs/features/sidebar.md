# Sidebar

The sidebar sits on the window's own ground, and the content floats beside it as one rounded panel
(the content panel). It has two modes, **Documents** and **Agents**, and stays deliberately small: the vault, the
mode, the mode's own list, and who is signed in. Everywhere else is one keystroke away in the
[command menu](command-palette.md) (⌘K).

## How it works

- **Vault switcher** (after shadcn's team switcher), the full width of the sidebar: the vault's
  initial on a tile, its name and owner, and a menu of the vaults with Add vault. It sits just
  under the window's band.
- **The window's band** is the sidebar's top row: on macOS the traffic lights, then the sidebar's
  toggle beside them, the rest of the row a handle to drag the window by. Fullscreen hides the
  lights, and main says so (`window:fullscreen`), so the toggle moves to the band's start.
- **Mode toggle** (`features/sidebar/app-sidebar.tsx`): Documents and Agents as two wide `Tabs`
  segments, the active one raised in place, with no thumb travelling between them: it is pressed
  all day, and a switch that moves is one that lags. Arrow keys move it. The Agents segment wears a Holi's pixel face (idle it bobs, working it hops, waiting on
  you it gets an idea) and reports the
  agents from either mode: an amber count while something needs you (`motion-pulse`), a turning
  ring (`motion-orbit`) and a count while
  agents work, both in its accessible name. The mode is `appModeAtom`, remembered across launches;
  opening anything into the panes (a note from the palette, a link, Settings) brings Documents
  back, since the panes are where it opens.
- **The Agents side is a plugin's.** `RendererPlugin.agentsMode` gives a sidebar, a main view and a
  status atom. In Agents mode the sidebar body is its sidebar, and its view covers the panes, which
  stay mounted underneath so nothing open is lost. The built-in agent provides it: the Inbox, then its live background sessions under Sessions
  ([agent sessions](agent-sessions.md)); with no plugin providing it there is one mode and no
  toggle. **Other plugins add to it without the agent knowing them**: `RendererPlugin.agentsSlot`
  gives a row for the top group beside the Inbox (`nav`: [Automations](scheduled-agents.md)), a
  section (`sidebar`: [Holis](holis.md)) placed by its `order` (the sessions are at 100; a slot with
  none comes after them), rows in the Inbox (`inbox`), a main view for its rows, the
  mode's main view while nothing is selected (`home`, the first running slot's wins; the Inbox is
  its own row, never the home) and a status the toggle adds in. What is shown is core's `agentsSelectionAtom`,
  `{owner, id}`, so a plugin's row opens its own view. With no slot's `home`, the home is the
  agent's own, which says no session is open there and offers one. In the shell the sidebar's Agents tab is the mode
  (`sidebarSectionAtom` is `appModeAtom`), and it switches the sidebar only. **Agents opens tabs**
  ([tabs and split view](tabs-panes.md)): a row picked, an Inbox card or a session started is a
  session tab (in the focused member while a split is active), selected where it already is, never
  opened twice; the mode's `main` draws one tab's selection (`{selection}`), so a split can show
  two sessions. The selection follows the view in front back, so the list marks the session in
  front. + on the Agents side
  starts a session in the default agent (the mode's `newSession`), in a tab of its own; one
  started from an Agents home tab takes that tab's place. A row's menu offers Open to the side (`openTabAtom` with
  `beside`). The mode's `tabLook` names a session tab and gives its dot (working, needs you,
  done) and its mark (a Holi's face, an automation's bolt, else the agent's). The mode's views paint no ground of
  their own: on macOS the window is glass and `<main>` tints it as the vault's Transparency asks,
  so only controls, cards, menus and overlays inside them carry a background.
- **Documents** is a search field and two destinations, then what you pinned, then the files:
  - **Search** is a field at the top (a grey fill, as every text field is) that opens the
    [command menu](command-palette.md) (⌘K): files, notes and actions. It is a press, not a
    field that filters here, so there is one search and not two.
  - **Home** opens the vault's [library](home.md), always. The "Home is" setting decides what a
    vault opens on, not where this row goes: a row named Home that opened the board read as a
    broken link.
  - **Board** opens the [board](tasks.md) and shows how many tasks are open (in the destructive
    colour when one is late). Under the pointer or focus the count gives way to a **+** that opens
    the board and starts a task in Todo; it is its own control beside the row, not inside it.
  - **Pinned** is absent until something is pinned. A row's context menu in the tree pins or
    unpins it (Pin to Sidebar). Pins are per vault and machine-local (local storage): what one person keeps at hand is not a decision about the vault. A pin whose path
    has gone is hidden, not removed, so an undone rename brings it back.
  - **Files** is the [file tree](file-tree.md) under a band with two controls: "+" makes a note,
    and "⋯" holds the rest (New folder, New task, what an app makes, the task-files and
    hidden-files filters as checkable rows, Collapse all). The everyday act is one press,
    everything else one menu away. A folder can be coloured on this machine, and shows how many
    files it holds ([file tree](file-tree.md)).
- **Type and alignment.** Every row is `text-nav` (13px on an 18px line, medium, muted until
  hovered or current), a step under body text so the chrome reads quieter than the page; section
  labels are `text-xs`. A row shows its press on pointer-down; current is a fill, never an outline.
- **Profile** (after ReUI's app-shell nav-user): the avatar, name and handle, with a dot on the
  avatar while an update waits or sync needs a hand. Its menu: Settings, the GitHub profile, Theme
  as a three-way pill (light, dark, system: the machine-local `colorScheme`; arrow keys move it),
  one row for the machine (sync in words with its glyph, the running version and an update or
  up-to-date mark, opening the sync and update panels), and Sign out, which goes to Settings'
  Account, where the sign-out dialog asks about the clones.
- **Settings in front:** the sidebar's body becomes Back and Settings' sections (see
  [settings](settings.md)).

**The toggle sits beside the window's lights** (`features/shell/title-bar.tsx`), where
the window's own controls already are, and ⌘B does the same. Hidden, the sidebar collapses to a
80px **rail** rather than to nothing: the lights and the toggle at its top, the two modes, Home, the
board and Search as icons with tooltips (a mode button switches the mode without opening the
sidebar), and the avatar's menu at its foot. The rail slides in as the sidebar slides out, on the
drawer's own width transition. 80px is the lights' width and the panel's 8px margin, so they never sit
over the content panel. The sidebar's edge still resizes it by dragging, and the arrow keys.

## Rejected

- The seam as the toggle, with no button: a hairline is hard to find as a control, and hidden, the
  sidebar left only a grip at the window's edge. A button beside the window's own controls is
  where people look for one.
- Hiding the sidebar to nothing: the destinations went with it, and the lights then sat over the
  first pane's tabs.
- The content flush beside the sidebar on one hairline: sidebar and page read as one surface. A
  panel floating on the ground tells them apart at a glance, as the knowledge bases this follows
  do.

**Not built in the fresh sidebar:** the Pinned group and Pin to Sidebar, the 80px icon rail the sidebar collapses to (hidden, it goes to nothing and the toggle in the title band brings it back), and folder colours and counts in the Files group ([not-built](../not-built.md)).

## Code

- `apps/desktop/src/renderer/src/features/sidebar/`: `app-sidebar.tsx` (the sidebar and its modes), `vault-switcher.tsx`, `files-section.tsx` (Files, the tree) and `documents-nav.tsx`, `sidebar-apps.tsx` (a plugin's sidebar apps), `account-menu.tsx` (the profile).
- `apps/desktop/src/renderer/src/features/shell/title-bar.tsx`, `app-shell.tsx`: the window's band, the toggle and the content panel.
- `apps/desktop/src/renderer/src/composites/sidebar-nav-item.tsx`, `section-label.tsx`: the shared row and label.
