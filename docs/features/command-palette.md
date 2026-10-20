# Command palette

One box that reaches everything, shaped like VS Code's: ⌘P opens anything in the vault, `>` runs
any command, ⌃⇥ switches tabs, and a typed sentence can go to the assistant. Behind it, every
app-level action is one row of one command table that keys, palette and menu all share.

## How it works

- **Quick open (⌘P)** lists every openable thing: markdown docs and other vault files (hidden
  paths left out, git-ignored ones dimmed), vault apps, what a plugin lists (`RendererPlugin.palette`:
  the agent's live sessions), the tabs of a surface that lists its own (`Surface.tabs`: agent
  terminals), and every registered surface but Home
  (board, agenda, mail, settings, history, and any plugin's), each with its own label and icon. A path row shows its filename with the folder beside
  it, and the tree's type glyph or the vault's emoji for that path. A plugin's row shows
  its dot (a session's status orb). Enter opens pinned, ⌘↵ opens beside. ⌘P while open steps the selection.
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
- **Ask the agent.** With any text typed outside `>` mode, the last row ("Ask the agent: …") sends it to the
  session the showing agent tab was opened for (else the last one opened, else a new one), where it
  lands unsent in the input box ([agent sessions](agent-sessions.md)). Nothing matching says so,
  naming the query.
- **The overlay** is its own atom, mounted once in Shell: top-anchored, no dimmed backdrop, 60vh
  list with an always-painted scrollbar, ↑ on the first row wraps. Every chosen row closes the
  palette first, then opens or runs.
- **It is the house `Dialog`** with `placement="top"`, `size="bare"` and no close button: the
  menus' surface, growing in from the top and shrinking away with the overlay motion every popup
  uses (`motion-in-origin`, `motion-out-origin`). Quick add is the same dialog. The input is
  `text-xs`, like the app's other search fields. There are no scroll-edge shades; the
  always-painted scrollbar says there is more.
- **The command table** (`state/commands.ts`): each row is an id, a label, an optional hotkey
  glyph, an optional `when`, and a Jotai write; a running plugin adds its own
  (`RendererPlugin.commands`: the agent's two). One `keydown` listener installed by Shell matches
  the table with `lib/hotkey.ts`, and skips a key the focused widget already handled
  (`defaultPrevented`), so the editor's own binding wins where it has one. The application menu sends a command id over `menu:command`.
  Rows today: open today's daily (⌘⇧D), save and sync (⌘S), split pane (⌘\), toggle sidebar
  (⌘B, bold in a focused markdown editor), go to the agents (⌘J), new session, new task (⌘T), new task with details (⌘⇧T), close
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
- A morph of its own (a bar that widens, then drops with its rows cascading in): a second motion
  language beside the one every other popup speaks, on a surface opened many times a day.
- The palette as a sixth entry in the form-dialog registry: it is a different overlay class, and
  its keys must work while a form dialog is up.
- Rebindable keys and a keybindings file; VS Code's other prefixes (`@`, `:`, `#`, `?`);
  frontmatter titles in rows (the snapshot has none, and the tree shows filenames).

## Code

- `apps/desktop/src/renderer/src/state/commands.ts`: the table, `runCommandAtom`,
  `useCommandHotkeys`.
- `apps/desktop/src/renderer/src/features/palette/CommandPalette.tsx`: the overlay, ⌃⇥, the Ask row.
- `apps/desktop/src/renderer/src/primitives/Command.tsx`: shadcn Command on `cmdk`, in
  `primitives/Dialog.tsx`, the top-anchored dialog it shares with [quick add](tasks.md).
- `apps/desktop/src/renderer/src/lib/palette-rows.ts`: rows and ranking.
- `apps/desktop/src/renderer/src/state/palette.ts`, `state/recents.ts`, `lib/recents.ts`.
- `apps/desktop/src/renderer/src/state/pane-exit.ts`, `state/vault-switch.ts`.
- `apps/desktop/src/main/menu.ts`: the menu and `menu:command`.
