# Command palette

One box that reaches everything, shaped like VS Code's: ⌘P opens anything in the vault, `>` runs
any command, ⌃⇥ switches tabs, and a typed sentence can go to the assistant. Behind it, every
app-level action is one row of one command table that keys, palette and menu all share.

## How it works

- **Quick open (⌘P)** lists every openable thing: markdown docs and other vault files (hidden
  paths left out, git-ignored ones dimmed), vault apps, live agent sessions, open agent tabs, and the five surfaces
  (board, agenda, mail, settings, history). A path row shows its filename with the folder beside
  it, and the tree's type glyph or the vault's emoji for that path. A session row shows the
  sidebar's status orb. Enter opens pinned, ⌘↵ opens beside. ⌘P while open steps the selection.
- **Ordering.** Empty query: recents first, across every kind, then the vault's paths by modified
  time. With a query: each row scored with `command-score` on its name, then on its path at half
  weight so a folder name still finds the file; recents break ties; the list is capped at 50.
- **Text matches.** From two typed characters, the notes whose text holds the query follow the
  name rows under "In text", with the words around the match in place of the folder. Main reads the
  bodies (`notes.search`, the same grep as an app's `holi.search`, most recently modified first,
  capped at 50) once typing pauses; an answer for a query no longer in the box is dropped. Only a
  path the palette lists by name can appear, and not twice.
- **Recents** are kept per vault in `localStorage` (`holi:recents`), capped and pruned of things
  that no longer exist. They are recorded in two places only: Shell watching the active tab,
  whatever opened it, and `runCommandAtom` for each command run.
- **Commands (`>`, or ⌘⇧P)** lists the command table with each hotkey in a `Kbd` chip, recently
  used first, then by label. Rows whose `when` is false are not listed, and neither are the
  palette's own two.
- **⌃⇥** opens the same box over the open tabs of every pane, most recent first, current one left
  out. Each further ⇥ moves down (⇧⇥ up) while Control is held, and releasing Control opens the
  selection. It means the literal Control key on every platform.
- **Ask the assistant.** With any text typed outside `>` mode, the last row sends it to the
  session the showing agent tab was opened for (else the last one opened, else a new one), where it
  lands unsent in the input box ([agent sessions](agent-sessions.md)).
- **The overlay** is its own atom, mounted once in Shell: top-anchored, no dimmed backdrop, 60vh
  list with an always-painted scrollbar, ↑ on the first row wraps. Every chosen row closes the
  palette first, then opens or runs.
- **It is the [nav menu](nav-menu.md)'s family:** the same surface, rows and springs. Opening, it
  appears as a bar the height of its input, widens to full width, shows the input, then drops to
  its full height while the rows it opened with cascade in; closing runs that backwards, in about
  a fifth of a second. A keystroke's re-rank does not cascade. Reduced motion snaps. The input is
  `text-xs`, like the app's other search fields. There are no scroll-edge shades; the
  always-painted scrollbar says there is more, and its thumb shows once the palette has its size.
- **The command table** (`state/commands.ts`): each row is an id, a label, an optional hotkey
  glyph, an optional `when`, and a Jotai write. One `keydown` listener installed by Shell matches
  the table with `lib/hotkey.ts`. The application menu sends a command id over `menu:command`.
  Rows today: open today's daily (⌘⇧D), save and sync (⌘S), split pane (⌘\), toggle sidebar
  (⌥⌘S), go to the agents (⌘J), new session, new task (⌘T), new task with details (⌘⇧T), close
  tab (⌘W), go home, open each of the five surfaces, new note (untitled, at the root), quick open (⌘P),
  command palette (⌘⇧P), and one "switch to" per other vault.
- Pane exit animation and the vault-switch confirm live in atoms, so close tab, split and switch
  vault behave the same from a key, the menu or the palette.

## Rules

- A hotkey in the table is a renderer keydown. ⌘W is the one exception (`boundBy: 'menu'`): it is
  the File menu's accelerator, which fires before the page sees the key.
- No other command becomes a menu accelerator: one on ⌘K would take the key from CodeMirror's
  link command, one on ⌘C from xterm.
- `matchHotkey` is exact on modifiers, so ⌘T and ⌘⇧T are two rows.
- A node test pins the table: ids unique, hotkeys unique, menu-bound rows have a glyph, every
  glyph parses.
- Ranking is a pure function outside cmdk (`shouldFilter={false}`), so the test and the screen agree.
- There is no "New folder" command: the tree names a folder inline, and an unnamed folder is nothing.

## Rejected

- Files-only quick open: the box is meant to reach everything.
- Recents in `.holi/settings/app.local.yaml`: its validator refuses undeclared keys and every
  write regenerates the file; a list that changes on every tab switch is UI state.
- Command declarations in `@holi/shared` with the menu built from them: each accelerator is a
  deliberate choice.
- The exit on Radix's own `Presence`: it waits for a CSS animation, and the morph is a `motion`
  spring, so `forceMount` hands unmounting to `AnimatePresence`. Radix drops the focus trap as
  `open` turns false, so a row that focuses a terminal keeps it through the exit.
- The palette as a sixth entry in the form-dialog registry: it is a different overlay class, and
  its keys must work while a form dialog is up.
- Rebindable keys and a keybindings file; VS Code's other prefixes (`@`, `:`, `#`, `?`);
  frontmatter titles in rows (the snapshot has none, and the tree shows filenames).

## Code

- `apps/desktop/src/renderer/src/state/commands.ts`: the table, `runCommandAtom`,
  `useCommandHotkeys`.
- `apps/desktop/src/renderer/src/features/palette/CommandPalette.tsx`: the overlay, ⌃⇥, the Ask row.
- `apps/desktop/src/renderer/src/primitives/Command.tsx`: shadcn Command on `cmdk`, in
  `primitives/MorphDialog.tsx`, the morphing top-anchored shell it shares with
  [quick add](tasks.md).
- `apps/desktop/src/renderer/src/primitives/springs.ts`: the springs it shares with the nav menu.
- `apps/desktop/src/renderer/src/lib/palette-rows.ts`: rows and ranking.
- `apps/desktop/src/renderer/src/state/palette.ts`, `state/recents.ts`, `lib/recents.ts`.
- `apps/desktop/src/renderer/src/state/pane-exit.ts`, `state/vault-switch.ts`.
- `apps/desktop/src/main/menu.ts`: the menu and `menu:command`.
