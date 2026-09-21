# The command palette, and one table of commands

**Date** 2026-09-21 · **Decision** D102 · **Status** agreed, not built

> Start the command palette, ⌘P, emulating VS Code's as closely as possible.

The old Holi (Tauri, `/Users/nicolaibthomsen/repos/holi`, last commit 2026-06-21) had
one and got several things right: a leading `>` switches to commands, the filter
strips the `>` before scoring, every action closes the palette before it runs. It
also left a split it never closed. Its bindings registry carried no handlers, the
shortcut hook dispatched on a `switch` of its own, and the palette's `onSelect`
closures duplicated the same actions a third time. Two of thirteen commands got a
shortcut hint. Its persisted rebinding layer was read on every open and written by
nothing. This design keeps the first list and closes the split.

## What is there today

- **Five app-level shortcuts, five `useEffect`s** in `components/Shell.tsx`: ⌘⇧D
  (today's daily), ⌘S (save, commit, push), ⌘\ (split), ⌘J (go to the agent), ⌘T
  and ⌘⇧T (new task). Four are hand-rolled modifier checks; one uses
  `lib/hotkey.ts`, whose glyph string (`⌘J`) both displays and binds a key.
- **⌘W is a menu accelerator** (`main/menu.ts`, `c29e4e2`): main sends
  `menu:close-tab`, the shell closes the focused pane's active tab. A menu
  accelerator fires before the page sees the key, which is the reason it lives
  there and the reason nothing else should: an accelerator on ⌘K would take the
  key from CodeMirror's link command, on ⌘C from xterm.
- **No fuzzy matcher, no recents.** Every filter in the renderer is
  `includes(query)`; the closest analogue to a quick-open list is the `@`-mention
  source in `editor/mentions.ts`. The only "last opened" notion is per vault, in
  the registry.
- **The snapshot** (`VaultSnapshot`) carries `docs[]` and `files[]` with a path,
  a kind and a modified time, `dirs[]`, `icons` (path to emoji, D82) and
  `ignored[]`. No titles. The tree and the tab strip both show the filename.
- **Overlays.** `primitives/Dialog.tsx` is an opinionated `{open, onClose, size}`
  wrapper over Radix, and `state/dialogs.ts` plus `components/DialogHost.tsx` is
  the block-and-registry mount for the four form dialogs. There is no Command
  primitive and `cmdk` is not installed. `components.json` maps shadcn's `ui`
  alias to `primitives/`, so today's shadcn Command component lands there.
- **A stale promise.** The onboarding ritual's last act advertises "⌘K command
  palette". ⌘K is the editor's link key and no palette exists.
- **`prd/vault-apps.md` and `not-built.md`** list "a command-palette entry" as
  designed and absent.

## Decisions

Decided by Nicolai on 2026-09-21, in this order. None is open.

1. **VS Code exactly.** ⌘P opens Quick Open. Typing `>` switches the same box to
   commands; ⌘⇧P opens it already in `>` mode. Two shortcuts, one palette.
2. **cmdk, as today's shadcn Command component in `primitives/`**, pulled at the
   current shadcn version and checked against the installed `cmdk`. Not the old
   repo's copy.
3. **⌘P lists every openable thing**: markdown docs, other vault files, vault
   apps, live agent sessions, and the five fixed surfaces (board, agenda, mail,
   settings, history). "Full access." The surfaces also remain `>` commands, which
   is where their hotkeys show.
4. **A question can be asked from the same box.** Once something is typed, the
   last row is "Ask the assistant: …". It sends the text to the current session,
   the one ⌘J goes to, starting a session with that prompt when there is none.
5. **Recents come first and survive a restart.** Before anything is typed the
   rows are the most recently opened things, across every kind, remembered per
   vault on this machine. ⌘P then Enter switches to the previous thing.
6. **The recents live in `localStorage`**, per vault, beside the panel layouts
   and the show-hidden flag. Not in `app.local.yaml`: that file is a settings
   document the user or agent authors, its validator refuses undeclared keys, and
   every write regenerates the whole file.
7. **One table.** `state/commands.ts` holds every app-level action as
   `{ id, label, hotkey?, run }`. Shell's five keydown effects become one
   dispatcher over it; `>` lists it; ⌘W's row carries its glyph for display and
   stays bound by main's menu, which sends the command id.
8. **Shell's two component-local behaviours move into atoms** so a command can
   drive them: the pane exit animation and the vault-switch confirm. Close tab,
   split and switch vault then work identically from key, menu and palette.
9. **The palette is its own overlay.** Radix Dialog composed directly in
   `primitives/Command.tsx`, top-anchored, no dimmed backdrop, VS Code's shape.
   Its state is its own atom with one mount in Shell beside `DialogHost`, not a
   sixth entry in the form-dialog registry.

## The table

```ts
// state/commands.ts
interface Command {
  id: string // 'daily.open', 'tab.close', 'palette.commands', 'vault.switch:<remote>'
  label: string // what `>` shows: 'Open today's daily'
  hotkey?: string // glyph string, the one lib/hotkey.ts binds and displays: '⌘⇧D'
  boundBy?: 'menu' // display only; main's accelerator fires it (⌘W)
  when?: (get: Getter) => boolean
  run: (get: Getter, set: Setter) => void | Promise<void>
}
```

- **Static commands** are a literal array. **Dynamic commands** (switch to each
  other vault) come from a derived atom that concatenates the static list with
  rows built from `vaultsAtom`. Apps and sessions are not commands; they are ⌘P
  rows, per decision 3.
- **`runCommandAtom(id)`** is the only way a command runs, from the key
  dispatcher, the palette, and main's menu alike. It records the id in the
  recents (decision 5) and then calls `run`.
- **The dispatcher** is one `keydown` listener installed once by Shell. It walks
  the table with `matchHotkey`, skips rows with `boundBy: 'menu'` and rows whose
  `when` is false, and calls `runCommandAtom`. `matchHotkey` is exact on
  modifiers, so `⌘T` and `⌘⇧T` are two rows, as they are two commands.
- **Main's menu** sends `menu:command` with an id in place of the one-off
  `menu:close-tab`; the preload exposes `menu.onCommand`. The menu template stays
  hand-written in `main/menu.ts` and restates the accelerator, because an
  accelerator is a deliberate choice per item (see "What is there today").
- **Invariants a node test pins**: ids unique, hotkeys unique, every `boundBy:
'menu'` row has a hotkey, and every hotkey parses.

The initial inventory, all of which exists as an atom or a pure workspace
function today: open today's daily (⌘⇧D), save and sync (⌘S), split pane (⌘\),
go to the agent (⌘J), new task (⌘T), new task with details (⌘⇧T), close tab (⌘W,
menu), open board, open agenda, open mail, open settings, open history, new note,
new folder, new session, switch vault to each other vault, quick open (⌘P),
command palette (⌘⇧P).

## The palette

- **`state/palette.ts`**: `paletteAtom: { open: boolean; query: string }`;
  `openPaletteAtom(mode: 'open' | 'commands')` sets the query to `''` or `'>'`;
  `closePaletteAtom`. ⌘P while open moves the selection down, ⌘⇧P while open
  switches to `>` mode, as in VS Code.
- **Rows** (`lib/palette-rows.ts`, pure, node-tested): built from the snapshot
  (`docs` and `files` minus hidden paths, `ignored` dimmed), the apps list, the
  live sessions and the five surfaces. A row is
  `{ kind, key, name, detail?, icon }`: the filename with the folder as `detail`,
  the vault's emoji for the path when one exists, otherwise a kind icon. Enter
  opens pinned; ⌘Enter opens beside (`openBeside`).
- **Ranking is ours, not cmdk's.** `command-score` (the scorer cmdk bundles) is
  imported directly and cmdk runs with `shouldFilter={false}`, so the same pure
  function decides the order in a node test and on screen. Empty query: the
  recents, rot-checked against the snapshot and the live session list; a vault
  with none yet lists docs by modified time so the box is never blank. Typed
  query: every row scored on name then path, recents breaking ties, capped at a
  fixed count so a vault of thousands of files never mounts thousands of items.
- **`>` mode** strips the prefix before scoring, lists the table minus rows
  whose `when` is false, hotkey glyph right-aligned in the house `kbd` style
  (`composites/PanelHeader.tsx`), with "recently used" first the way VS Code
  does it.
- **The Ask row** is the last row whenever the query is non-empty and does not
  start with `>`. Choosing it closes the palette, then sends the text to the
  current session via the existing send atom and shows its tab, or starts a
  session with the text as its first prompt when there is none.
- **Recents** (`recentsByVaultAtom`, `atomWithStorage('holi:recents')`):
  `{ [remote]: RecentEntry[] }`, `RecentEntry = { kind, key }`, most recent
  first, capped. Touched on every open through the palette, on every tab
  activation, and on every command run.
- **Closing before running** is a property of the component, not of each row:
  the palette closes, then the row's action runs, so cmdk's close-on-select under
  a controlled `open` is never relied on.
- **Focus return** is Radix's `onCloseAutoFocus`, back to what had focus.

## Primitive

`primitives/Command.tsx` is today's shadcn `command` registry item (shadcn 4.21,
`cmdk` 1.1.1 as the registry's dependency), with one adaptation: `CommandDialog`
composes `Dialog` from `radix-ui` directly, because the compound `Dialog`,
`DialogContent`, `DialogHeader` it imports do not exist here by design. The
overlay is transparent, the content sits at the top of the window at a fixed
width, and the motion classes are the popover's. The renderer ESLint gate holds:
Radix and native inputs only in `primitives/`, no `title=` tooltips, no colour
literals.

## Out of scope

- Rebindable keys and a keybindings file. The old repo's dead layer is the
  argument; the table is shaped so one could be added without touching callers.
- VS Code's other prefixes (`@` symbols, `:` line, `#`, `?`).
- Frontmatter titles in rows. The snapshot has none; filenames match the tree
  and the tab strip.
- Menu items built from the table. The accelerator question makes each menu item
  a deliberate choice.
- Persisting tabs and panes, which is the separate question `panes.ts` names.

## Consolidation

D102's prose lands in a new living `prd/command-palette.md` covering the palette
and the command table, with `architecture.md` §renderer naming the table.
`prd/vault-apps.md` and `not-built.md` stop calling the palette entry absent. The
onboarding ritual's "⌘K command palette" copy becomes ⌘P.

## Verification

1. `pnpm -C apps/desktop exec vitest run --project node`: the table invariants,
   the row builder, the ranking and the recents rules.
2. `pnpm -C apps/desktop exec vitest run --project dom`: ⌘P opens the palette,
   typing filters, Enter opens a note, `>` lists commands with their glyphs,
   ⌘⇧P opens in `>` mode, Escape closes and returns focus, the Ask row sends.
3. Live, after a dev restart (the menu and preload are main-side): ⌘P, type a
   filename, Enter; ⌘P, Enter returns to the previous file; `>spl` runs split;
   ⌘W still closes the tab; type a sentence and choose Ask, the session tab shows
   it as a turn.
