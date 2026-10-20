# Sidebar

The sidebar sits on the window's own ground, flush beside the content, with one hairline between
them. It has two modes, **Documents** and **Agents**, and stays deliberately small: the vault, the
mode, the mode's own list, and who is signed in. Everywhere else is one keystroke away in the
[command palette](command-palette.md) (⌘P, ⌘⇧P).

## How it works

- **Vault switcher** (after shadcn's team switcher), the full width of the sidebar: the vault's
  initial on a tile, its name and owner, and a menu of the vaults with Add vault.
- **Mode toggle** (`features/nav/ModeToggle.tsx`): Documents and Agents as two wide `Tabs`
  segments, the active one raised in place, with no thumb travelling between them: it is pressed
  all day, and a switch that moves is one that lags. Arrow keys move it. The Agents segment reports the
  agents from either mode: an amber count while something needs you (`motion-pulse`), a turning
  ring (`motion-orbit`) and a count while
  agents work, both in its accessible name. The mode is `appModeAtom`, remembered across launches;
  opening anything into the panes (a note from the palette, a link, Settings) brings Documents
  back, since the panes are where it opens.
- **The Agents side is a plugin's.** `RendererPlugin.agentsMode` gives a sidebar, a main view and a
  status atom. In Agents mode the sidebar body is its sidebar, and its view covers the panes, which
  stay mounted underneath so nothing open is lost. The agent plugin provides it: the vault's
  scheduled Holis and [Holis](holis.md), then its live background sessions by what they need from you
  ([agent sessions](agent-sessions.md)); with no plugin providing it there is one mode and no
  toggle. **Other plugins add to it without the agent knowing them**: `RendererPlugin.agentsSlot`
  gives rows for its sidebar, a main view for those rows and a status the toggle adds in. What is
  shown is core's `agentsSelectionAtom`, `{owner, id}`, so a plugin's row opens its own view. The
  optional [chat](chat.md) plugin is one.
- **Documents** is three destinations, then what you pinned, then the files:
  - **Home** opens the vault's [library](home.md), always. The "Home is" setting decides what a
    vault opens on, not where this row goes: a row named Home that opened the board read as a
    broken link.
  - **Board** opens the [board](tasks.md) and shows how many tasks are open (in the destructive
    colour when one is late). Under the pointer or focus the count gives way to a **+** that opens
    the board and starts a task in Todo; it is its own control beside the row, not inside it.
  - **Search** opens the [command palette](command-palette.md) (⌘P): files, notes and commands.
  - **Pinned** is absent until something is pinned. A row's context menu in the tree pins or
    unpins it (Pin to Sidebar). Pins are per vault and machine-local (`state/pins.ts`, local
    storage): what one person keeps at hand is not a decision about the vault. A pin whose path
    has gone is hidden, not removed, so an undone rename brings it back.
  - **Files** is the [file tree](file-tree.md) under a band with two controls: "+" makes a note,
    and "⋯" holds the rest (New folder, New task, what an app makes, the task-files and
    hidden-files filters as checkable rows, Collapse all). The everyday act is one press,
    everything else one menu away.
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

**The seam is the toggle** (after ReUI's app shell, `DrawerShell`'s `onToggle`). The hairline
between sidebar and content shows a grip under the pointer: dragging it resizes the sidebar, a
click without moving hides it, and hidden, the seam stays at the window's edge with its grip
showing, so a click brings it back. ⌘B toggles too, and for the keyboard the seam takes Enter or
Space to toggle and the arrow keys to resize. There is no separate toggle button: it would be a
second control for one thing, and the seam is where the sidebar's edge already is.
