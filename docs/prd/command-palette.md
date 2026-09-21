# PRD — Command palette

One box that reaches everything: ⌘P opens anything in the vault, `>` runs any command, and a
typed sentence goes to the assistant. Built 2026-09-21 (D102); design of record
[`../specs/2026-09-21-command-palette-design.md`](../specs/2026-09-21-command-palette-design.md).

> **Status: built.** `features/palette/CommandPalette.tsx` over `primitives/Command.tsx` (today's
> shadcn Command on cmdk); what is listed and in what order is `lib/palette-rows.ts`; every
> command is a row of `state/commands.ts`. Verified live 2026-09-21 over CDP and by hand.

## What it is

**VS Code exactly.** ⌘P opens Quick Open. Typing `>` switches the same box to commands; ⌘⇧P
opens it already in `>` mode. Two shortcuts, one palette. It is its own overlay, top-anchored
with no dimmed backdrop, not one of the form dialogs in `state/dialogs.ts`.

**⌘P lists every openable thing**, not files alone: markdown docs and other vault files (hidden
paths excluded, git-ignored ones dimmed), vault apps, live agent sessions, and the five fixed
surfaces (board, agenda, mail, settings, history). A path row shows its filename with the folder
beside it, and the vault's emoji for the path when one exists (D82). Enter opens pinned, ⌘↵ opens
beside. ⌘P pressed while the palette is open steps the selection down, as VS Code's does.

**Recents come first and survive a restart.** Before anything is typed the rows are the most
recently opened things, in order, across every kind, then the vault's paths by modified time so
the box is never blank. ⌘P then Enter returns to the previous thing. With a query, every row is
scored on its name and then, at a discount, on its path, so a folder name still finds the file
inside it; recents break ties; the list is capped so a vault of thousands of files never mounts
thousands of rows. The recents are kept per vault in `localStorage` beside the panel layouts,
recorded in two places only: Shell watches the active tab, whichever surface opened it, and
`runCommandAtom` records each command it runs (except the palette's own two).

**`>` lists the command table**, each row with its hotkey glyph beside it in the house `Kbd`
chip, recently used first, then the rest by label. A command whose `when` is false is not
listed, and neither are the palette's own two rows: a list inside the palette has no use for
"open the palette".

**⌃⇥ is the tab switcher.** It opens the same box over the open tabs across every pane, most
recently used first with the current one left out, so one ⌃⇥ and release is "back to the
previous tab"; each further ⇥ moves down (⇧⇥ up) while ⌃ is held, and releasing ⌃ takes the
selected one. It is a chord finished by a keyup, so it lives beside the palette rather than in
the command table, and it means the literal Control key on every platform.

**The rows look like the tree's.** A path gets the tree's type glyph in its type colour, or the
vault's emoji for it; a session gets the sidebar's status orb, from the same rule; the folder
sits right-aligned in the muted tint. The list is tall (60vh) with its scrollbar always painted,
so its length can be read off the thumb; ↑ on the first row wraps to the last.

**Ask the assistant.** Once anything is typed outside `>` mode the last row reads "Ask the
assistant: …". Choosing it closes the palette and sends the text to the session ⌘J goes to,
where it lands unsent in the input box (D100), starting a session named from the text when there
is none.

**The palette closes before it acts.** Every chosen row closes the overlay first and then opens
or runs; cmdk's close-on-select under a controlled `open` is never relied on, and a chosen
action that opens a tab never fights the palette for focus.

## One table of commands

Every app-level action is one row of `state/commands.ts`: an id, the label the palette shows,
an optional hotkey glyph, and a Jotai write. Three readers, one table:

- **The keys.** `useCommandHotkeys` is one `keydown` listener over the table, installed once by
  Shell, matching with `lib/hotkey.ts`. Shell's five separate shortcut effects became this.
- **The palette's `>` list.** The same rows, with the same glyphs.
- **The application menu.** A menu item sends its command id over `menu:command`; the renderer
  runs it through `runCommandAtom` like any other.

**A hotkey in the table is a renderer keydown.** ⌘W is the one exception, marked
`boundBy: 'menu'`: it is the File menu's accelerator, which fires before the page ever sees the
key, so the dispatcher skips the row and main sends the id. Nothing else takes that route,
because a menu accelerator on ⌘K would take the key from CodeMirror's link command and one on
⌘C from xterm.

`matchHotkey` is exact on modifiers, so `⌘T` and `⌘⇧T` are two rows, as they are two commands.
A node test pins the invariants: ids unique, hotkeys unique, every menu-bound row has a glyph,
every glyph parses.

The rows today: open today's daily (⌘⇧D), save and sync (⌘S), split pane (⌘\), go to the agent
(⌘J), new session, new task (⌘T), new task with details (⌘⇧T), close tab (⌘W, menu), open
board, agenda, mail, settings and history, new note (untitled, at the vault root), quick open
(⌘P), command palette (⌘⇧P), and switch to each other vault. "New folder" is deliberately not
one: the tree names a folder inline, and a folder without a name is nothing.

Two Shell behaviours moved into atoms so the table could reach them: the pane exit animation
(`state/pane-exit.ts`) and the vault-switch confirm (`state/vault-switch.ts`). Close tab,
split and switch vault therefore behave identically from a key, the menu and the palette.

## Out of scope

- Rebindable keys and a keybindings file. The old Holi's rebinding layer was read on every open
  and written by nothing; the table is shaped so one could be added without touching callers.
- VS Code's other prefixes (`@` symbols, `:` line, `#`, `?`).
- Frontmatter titles in rows. The snapshot carries none; filenames match the tree and the strip.
- Menu items built from the table. Each menu accelerator is a deliberate choice.
- Persisting tabs and panes, which is the separate question `state/panes.ts` names.
