# Command palette implementation plan

**Goal:** ⌘P quick-opens every openable thing in the vault, `>` switches to commands, and every
app-level action is one row of one table that keys, menu and palette all run by id (D102).
**Approach:** Build the table first and move Shell's five shortcut effects onto it, so the
palette arrives as a second reader of something already true. Recents, rows and ranking are
pure modules with node tests; the palette component is thin over them. Docs consolidate last.
**Stack:** React 19, Jotai, cmdk 1.1.1 via today's shadcn Command component, `command-score`
0.1.2, Radix from `radix-ui`, Vitest 4 (node project for pure modules, dom project for
components).
**Design of record:** [`../specs/2026-09-21-command-palette-design.md`](../specs/2026-09-21-command-palette-design.md).

## Read before starting

- `AGENTS.md` (repo root). Renderer layers: `primitives/` → `composites/` → `features/`;
  features cannot import each other; Radix and native inputs only in `primitives/`; no
  `title=`; no colour literals. `state/` and `lib/` sit below all three.
- Never run the node and dom Vitest projects at the same time. Node is ~4.5 min, dom ~20 s:
  `pnpm -C apps/desktop exec vitest run --project node` then `--project dom`.
- Prettier only on files you touched, and check the baseline first: `Shell.tsx`,
  `test/helpers/fake-holi.ts`, `docs/decisions.md`, `docs/prd/notes-editor.md` are not clean
  at HEAD, so `--write` on them rewrites unrelated lines.
- **A preload change blanks the running dev app.** The renderer hot-reloads against the old
  preload, so a new `window.holi` namespace is `undefined` until the page reloads; if the app
  is up on port 9333, `location.reload()` over CDP brings it back. Main changes (the menu)
  reach the app only after a restart, which is his to do.
- `test/helpers/fake-holi.ts` is not typed to `window.holi`; typecheck will not tell you a
  new namespace is missing from it. Run the full node suite after touching the preload.

## File map

| File                                                                                                                            | Responsibility                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/renderer/src/primitives/Command.tsx` (new)                                                                    | Today's shadcn Command over cmdk; `CommandDialog` composed on Radix Dialog from `radix-ui`, top-anchored, no backdrop dim                         |
| `apps/desktop/src/renderer/src/primitives/Kbd.tsx` (new)                                                                        | The hotkey glyph chip, lifted from the tooltip in `composites/PanelHeader.tsx:85-87` so the palette and the tooltip share one                     |
| `apps/desktop/src/renderer/src/state/commands.ts` (new)                                                                         | The table: `Command`, the static list, `commandsAtom` (static plus per-vault switch rows), `runCommandAtom`, `useCommandHotkeys`                  |
| `apps/desktop/src/renderer/src/state/pane-exit.ts` (new)                                                                        | `leavingPaneAtom`, `closeTabWithExitAtom`, `closePaneWithExitAtom`: the exit animation Shell owned                                                |
| `apps/desktop/src/renderer/src/state/vault-switch.ts` (new)                                                                     | `leavingVaultAtom`, `switchVaultAtom`, `applyVaultSwitchAtom`: the confirm-then-switch Shell owned                                                |
| `apps/desktop/src/renderer/src/state/recents.ts` (new)                                                                          | `recentsByVaultAtom` (`atomWithStorage('holi:recents')`), `touchRecentAtom`, `recentsAtom` for the active vault                                   |
| `apps/desktop/src/renderer/src/lib/recents.ts` (new)                                                                            | Pure: `RecentEntry`, `touch(list, entry, cap)`, `prune(list, isLive)`                                                                             |
| `apps/desktop/src/renderer/src/lib/palette-rows.ts` (new)                                                                       | Pure: `PaletteRow`, `buildRows(...)`, `rankRows(rows, query, recents, cap)`, `commandQuery(query)`, `rankCommands(...)`                           |
| `apps/desktop/src/renderer/src/state/palette.ts` (new)                                                                          | `paletteAtom { open, query, step }`, `openPaletteAtom(mode)`, `closePaletteAtom`                                                                  |
| `apps/desktop/src/renderer/src/features/palette/CommandPalette.tsx` (new)                                                       | The overlay: rows, `>` mode, Ask row, open-pinned and open-beside, close-before-run                                                               |
| `apps/desktop/src/renderer/src/components/Shell.tsx`                                                                            | Loses five keydown effects, `leaveThenApply`, `applySwitch`, `switchVault`; gains `useCommandHotkeys()`, the recents effect, `<CommandPalette />` |
| `apps/desktop/src/main/menu.ts`, `src/preload/index.ts`, `src/renderer/src/global.d.ts`, `test/helpers/fake-holi.ts`            | `menu:command` carrying a command id replaces `menu:close-tab`                                                                                    |
| `apps/desktop/src/renderer/src/features/onboarding/OnboardingRitual.tsx:571-573`                                                | ⌘K → ⌘P                                                                                                                                           |
| `docs/prd/command-palette.md` (new), `docs/architecture.md`, `docs/prd/vault-apps.md`, `docs/not-built.md`, `docs/decisions.md` | Consolidation of D102                                                                                                                             |

Tests: node project `apps/desktop/test/{commands,recents,palette-rows,pane-exit}.test.ts`; dom
project `primitives/__tests__/Command.test.tsx`, `features/palette/__tests__/CommandPalette.test.tsx`.

## Tasks

### Task 1: the Command primitive

**Files:** create `primitives/Command.tsx`, `primitives/Kbd.tsx` · modify `primitives/index.ts`,
`composites/PanelHeader.tsx:85-87`, `apps/desktop/package.json` · test
`primitives/__tests__/Command.test.tsx`

**Behaviour:** `CommandDialog` opens top-anchored with its input focused, filters nothing itself
(`shouldFilter={false}` is the caller's to set), closes on Escape and returns focus to the
opener. `Kbd` renders a glyph string in the chip style the panel-header tooltip uses today.

- [ ] From `apps/desktop`: `pnpm dlx shadcn@4.21.0 add command`. It lands in `primitives/`
      (the `ui` alias) and adds `cmdk`. Confirm `cmdk` resolves to 1.1.1 and that `pnpm install`
      did not need an `onlyBuiltDependencies` entry.
- [ ] Rewrite `CommandDialog`: the registry item imports the compound `Dialog`, `DialogContent`,
      `DialogHeader`, `DialogTitle`, `DialogDescription`, none of which exist here. Compose
      `Dialog` from `radix-ui` directly: Portal, an Overlay with no tint (`bg-transparent`),
      Content fixed at `top-[12vh] left-1/2 -translate-x-1/2 w-full max-w-xl p-0`, the
      popover's `motion-in-origin`/`motion-out-origin` classes, an sr-only Title and
      Description, no close button. Keep every other export as shadcn wrote it, with `text-sm`
      swapped for the house scale where the file's neighbours do that.
- [ ] `Kbd.tsx`: `<kbd className="rounded border bg-muted px-1 font-sans text-muted-foreground">`
      as a primitive; `PanelHeader.tsx:85-87` uses it. Export both from `primitives/index.ts`.
- [ ] dom test: render `CommandDialog open` with two `CommandItem`s; the input has focus; the
      list shows both; `userEvent.keyboard('{Escape}')` calls `onOpenChange(false)`.
- [ ] Verify: `pnpm -C apps/desktop exec vitest run --project dom primitives` passes;
      `pnpm lint` reports 0 errors (the file is in `primitives/`, so Radix and the native
      `kbd` are allowed there).

### Task 2: the exit animation and the vault switch become atoms

**Files:** create `state/pane-exit.ts`, `state/vault-switch.ts` · modify `components/Shell.tsx:169-212`
(`leavingPane`, `leaveTimer`, `leaveThenApply`, `closePaneWithExit`, `closeTabWithExit`),
`:318-320` (`leaving`), `:482-505` (`applySwitch`, `switchVault`), `:563`, `:569-579` · test
`test/pane-exit.test.ts`

**Behaviour:** Everything Shell did stays true: a close that empties a split pane marks it
leaving for `--motion-leave` then applies; a second close before the first lands drops the
first timer; reduced motion applies at once. A vault switch asks first when
`sessionsWorthAsking` is non-empty, otherwise resets the workspace and moves
`activeRemoteAtom`. Shell renders from the atoms and owns no copy.

- [ ] `state/pane-exit.ts`: `leavingPaneAtom: atom<number | null>`; a module-level timer handle;
      `closeTabWithExitAtom(paneIndex, tabIndex)` and `closePaneWithExitAtom(index)` with the
      same bodies as `Shell.tsx:179-212`, using `prefersReducedMotion` and `motionDurationMs`
      from wherever Shell imports them.
- [ ] `state/vault-switch.ts`: `leavingVaultAtom: atom<{ kind: 'switch'; remote } | { kind: 'add' } | null>`;
      `applyVaultSwitchAtom(remote)` resets `leavingVaultAtom`, `workspaceAtom` to
      `emptyWorkspace()`, and sets `activeRemoteAtom`; `switchVaultAtom(remote)` is
      `Shell.tsx:498-505` over `agentSessionsAtom`. The conflict banner Shell clears in
      `applySwitch` becomes a Shell effect that clears it when `activeRemote` changes.
- [ ] Shell: delete the moved code, read `leavingPaneAtom` where it read `leavingPane`, and
      call the atoms from the tab strip, the pane close button, `VaultPicker.onSelect` and
      `VaultSwitchConfirm`. Add-vault (`leaving.kind === 'add'`) keeps working.
- [ ] node test: with a fake timer, `closeTabWithExitAtom` on the last tab of a split sets
      `leavingPaneAtom`, applies after the duration, clears it; on a non-emptying close it
      applies at once; `switchVaultAtom` with a live session sets `leavingVaultAtom` and does
      not move the remote. Use `getDefaultStore()` or a fresh `createStore()`; stub
      `prefersReducedMotion` via `vi.mock` on its module.
- [ ] Verify: `pnpm -C apps/desktop exec vitest run --project node test/pane-exit.test.ts` and
      `--project dom` pass; ⌘W over CDP (or the strip's ✕) still plays the exit in the app.
- [ ] Commit: `refactor(shell): the pane exit and the vault switch are atoms`.

### Task 3: the table, and Shell dispatches from it

**Files:** create `state/commands.ts` · modify `components/Shell.tsx:358-441` (the five effects),
`:224-233` (the ⌘W subscriber), `main/menu.ts`, `preload/index.ts`, `global.d.ts`,
`test/helpers/fake-holi.ts` · test `test/commands.test.ts`

**Behaviour:** Every shortcut that worked yesterday works today, from one listener over one
table. The menu's Close Tab runs `tab.close` through the same table. Ids and hotkeys are unique.

- [ ] `Command` as in the spec's "The table" section, plus `category?: string` used only for
      the label prefix ("View: ", "Agent: ") the way VS Code prints one. The static list has
      the ids and hotkeys in the table below, each `run` calling what Shell calls today.
      `folder.new` is not a command: the tree names a new note or folder inline in a
      `PendingRow` (`FileTree.tsx:598-616`) that is component-local, and a folder without a
      name is nothing. A note can start untitled, as VS Code's New File does.

| id                            | label                                       | hotkey                | run                                                                                                                |
| ----------------------------- | ------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `daily.open`                  | Open today's daily                          | ⌘⇧D                   | `openTodaysDailyAtom`                                                                                              |
| `sync.save`                   | Save and sync                               | ⌘S                    | `saveAllBuffers` then `sync.commitNow` then `sync.pushNow`                                                         |
| `pane.split`                  | Split pane                                  | ⌘\                    | `splitPane`                                                                                                        |
| `agent.show`                  | Go to the agent                             | ⌘J                    | `showAgentAtom`                                                                                                    |
| `agent.new`                   | New session                                 |                       | `startSessionAtom`                                                                                                 |
| `task.new`                    | New task                                    | ⌘T                    | `openDialogAtom` create-task quick                                                                                 |
| `task.new.full`               | New task with details                       | ⌘⇧T                   | create-task full                                                                                                   |
| `tab.close`                   | Close tab                                   | ⌘W, `boundBy: 'menu'` | `closeTabWithExitAtom` on the focused pane's active tab                                                            |
| `board.open` … `history.open` | Open board, agenda, mail, settings, history |                       | `openSingleton`                                                                                                    |
| `note.new`                    | New note                                    |                       | `Untitled.md` at the vault root (`Untitled 2.md` and so on when taken) through `createNoteAtom`, then `openPinned` |
| `palette.open`                | Quick open                                  | ⌘P                    | `openPaletteAtom('open')` (Task 6)                                                                                 |
| `palette.commands`            | Command palette                             | ⌘⇧P                   | `openPaletteAtom('commands')` (Task 6)                                                                             |
| `vault.switch:<remote>`       | Switch to <name>                            |                       | `switchVaultAtom`, one per other vault, from `commandsAtom`                                                        |

- [ ] `runCommandAtom(id)`: looks the id up in `commandsAtom`, refuses when `when` is false,
      records `{ kind: 'command', key: id }` through `touchRecentAtom` (Task 4; stub as a no-op
      until then), then awaits `run`.
- [ ] `useCommandHotkeys()`: one `keydown` listener installed once, reading the table through
      a ref so it never re-subscribes; skips `boundBy` rows and `when === false` rows; on a
      match, `preventDefault` and `set(runCommandAtom, id)`. It ignores `e.isComposing`.
- [ ] Shell: delete the five effects and the ⌘W subscriber; call `useCommandHotkeys()`;
      subscribe `window.holi.menu.onCommand((id) => set(runCommandAtom, id))`.
- [ ] Main: `MENU_COMMAND_CHANNEL = 'menu:command'`; Close Tab's `click` sends `'tab.close'`;
      delete `CLOSE_TAB_CHANNEL`. Preload: `menu.onCommand` via `pushChannel<string>`;
      `global.d.ts` and `fake-holi.ts` follow. Bump the comments that name `menu:close-tab`
      (`Shell.tsx`, `menu.ts`, `preload/index.ts`, `prd/notes-editor.md` §Split panes).
- [ ] node test `test/commands.test.ts`: ids unique; hotkeys unique; every `boundBy` row has a
      hotkey; every hotkey parses through `parseHotkey` to a non-empty key; `commandsAtom`
      with two vaults yields one switch row for the other vault and none for the active one;
      `runCommandAtom` on an unknown id is a no-op.
- [ ] Verify: node test passes; the full node suite passes (preload changed); `pnpm typecheck`;
      `pnpm --filter @holi/desktop build`; over CDP each of ⌘⇧D, ⌘S, ⌘\, ⌘J, ⌘T, ⌘⇧T still
      does its thing (after a `location.reload()`; ⌘W needs his restart).
- [ ] Commit: `feat(shell): one table of commands, and the keys dispatch from it`.

### Task 4: recents

**Files:** create `lib/recents.ts`, `state/recents.ts` · modify `components/Shell.tsx` (one
effect), `state/commands.ts` (the stub from Task 3) · test `test/recents.test.ts`

**Behaviour:** The active vault has a most-recent-first list of `{ kind, key }` entries, capped
at 50, that survives a restart. Activating any tab records it; running any command records it.

- [ ] `lib/recents.ts`: `type RecentKind = 'path' | 'app' | 'session' | 'surface' | 'command'`;
      `RecentEntry = { kind: RecentKind; key: string }`; `touch(list, entry, cap = 50)` moves or
      inserts at the front; `prune(list, isLive: (e) => boolean)`.
- [ ] `state/recents.ts`: `recentsByVaultAtom = atomWithStorage<Record<string, RecentEntry[]>>('holi:recents', {})`;
      `recentsAtom` reads the active remote's list; `touchRecentAtom(entry)` writes through
      `touch`. No remote, no write.
- [ ] Shell: an effect on `activeTab(workspace)` that maps a tab to an entry (`note` → `path`,
      `app` → `app`, `session` → `session`, singleton → `surface`) and touches it. One place,
      so the tree, the strip and the palette all count.
- [ ] node test: `touch` moves an existing entry to the front without duplicating; caps; `prune`
      drops what `isLive` refuses and keeps order.
- [ ] Verify: node test passes; in the app, `localStorage['holi:recents']` fills as tabs change.
- [ ] Commit: `feat(state): recents per vault`.

### Task 5: rows and ranking

**Files:** create `lib/palette-rows.ts` · modify `apps/desktop/package.json` (`command-score`) ·
test `test/palette-rows.test.ts`

**Behaviour:** Given the snapshot, the app ids, the live sessions, the recents and a query, a
pure function returns the rows to show, in order, capped. `>` strips itself before scoring.

- [ ] `PaletteRow = { kind: RecentKind minus 'command'; key: string; name: string; detail?: string; icon: string | { kind: 'emoji'; value: string }; dim?: boolean }`.
- [ ] `buildRows({ snapshot, appIds, sessions, activeRemote })`: `snapshot.docs` and
      `snapshot.files` minus `isHiddenPath` (from `@holi/shared`), `detail` = folder, `dim` when
      in `snapshot.ignored`, emoji from `snapshot.icons[path]`; one row per app id; one per
      session that has not exited, named by the session; five surface rows with the
      `TAB_NAME` labels the strip uses.
- [ ] `rankRows(rows, query, recents, cap = 50)`: empty query → recents that still exist, in
      order, then the newest-modified docs up to the cap; typed → `commandScore(name, q)` with
      a fallback to `commandScore(key, q)` at a discount, zero dropped, stable sort by score
      with recents order as the tie-break, capped. `command-score` has no types: declare the
      module in `global.d.ts` or a `types/` shim.
- [ ] `commandQuery(query)`: `null` unless it starts with `>`, else the rest trimmed.
      `rankCommands(commands, query, recents)`: `when` false dropped; empty → recently used
      first then the rest by label; typed → scored on label.
- [ ] node test: hidden and `.holi/` paths absent; emoji rows; empty-query order is recents then
      modified time; `'>spl'` scores "Split pane" first; a dead session's recent is pruned; the
      cap holds; a query matching a folder name still finds the file through `key`.
- [ ] Verify: node test passes.
- [ ] Commit: `feat(palette): rows and ranking as pure functions`.

### Task 6: the palette

**Files:** create `state/palette.ts`, `features/palette/CommandPalette.tsx` · modify
`components/Shell.tsx` (mount beside `<DialogHost />` at `:871`), `state/commands.ts`
(`palette.open`, `palette.commands` run for real) · test
`features/palette/__tests__/CommandPalette.test.tsx`

**Behaviour:** ⌘P opens it with the recents; typing filters every openable thing; Enter opens
pinned, ⌘Enter opens beside; `>` lists commands with their glyphs; ⌘⇧P opens there; ⌘P while
open moves the selection down; Escape closes and focus returns. The palette closes before the
chosen action runs.

- [ ] `state/palette.ts`: `paletteAtom = atom<{ open: boolean; query: string; step: number }>`;
      `openPaletteAtom(mode)`: closed → `{ open: true, query: mode === 'commands' ? '>' : '' }`;
      already open and mode `'commands'` → query `'>'`; already open and mode `'open'` →
      `step + 1`. `closePaletteAtom`.
- [ ] `CommandPalette.tsx`: `CommandDialog` on `paletteAtom.open`, `Command shouldFilter={false}`,
      `CommandInput` bound to `query`; rows from `rankRows` or `rankCommands` by
      `commandQuery`; a `CommandGroup` "Recently opened" / "Recently used" for the rows that
      came from recents and one for the rest; each row's `onSelect` closes first, then acts:
      `path` → `openPinned`, or `openBeside(w, w.active, path)` when the `keydown` that chose
      it had `metaKey`; `app` → `openApp`; `session` → `activeSessionIdAtom` then
      `openSession`; `surface` → `openSingleton`; a command row → `runCommandAtom`. A
      `step` change dispatches `new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })`
      on the cmdk root, which is how cmdk moves selection. The command rows render the glyph
      through `Kbd`.
- [ ] Shell mounts `<CommandPalette />` beside `<DialogHost />`.
- [ ] dom test: seed `snapshotAtom` with three docs and `recentsByVaultAtom` with one; press
      ⌘P (`userEvent.keyboard('{Meta>}p{/Meta}')` after `useCommandHotkeys` is mounted in a
      small harness component); the recent doc is first; type part of another name; Enter puts
      that path pinned in `workspaceAtom`; the palette is closed. `'>'` shows "Split pane" with
      `⌘\`; Enter on it adds a pane. ⌘⇧P opens with `>` already in the input. Escape closes.
- [ ] Verify: dom suite passes; `pnpm lint` 0 errors (the feature imports `primitives`,
      `composites`, `state`, `lib` only); live over CDP: ⌘P then Enter returns to the previous
      file.
- [ ] Commit: `feat(palette): ⌘P quick open and > commands`.

### Task 7: the Ask row

**Files:** modify `features/palette/CommandPalette.tsx`, `lib/palette-rows.ts` · test the dom
test from Task 6

**Behaviour:** With a non-empty query that is not `>` mode, the last row reads "Ask the
assistant: <query>". Choosing it closes the palette and sends the text through
`sendToAgentAtom` to `defaultAgentTargetAtom`, so it lands unsent in the session's input and
that tab comes forward (D100), starting a session named from the text when the target is
`'new'`.

- [ ] Append the row after the capped results, never scored, `icon` the agent's; `onSelect`
      closes then `set(sendToAgentAtom, { text, target: get(defaultAgentTargetAtom) })`.
- [ ] dom test: type "why is the board empty", arrow up to the last row, Enter; the fake
      `window.holi.agent.paste` (or `startSessionAtom`'s call) received the text and the
      palette is closed.
- [ ] Verify: dom suite passes; live: a sentence, Enter on Ask, the session tab shows it in the
      input box.
- [ ] Commit: `feat(palette): ask the assistant from the palette`.

### Task 8: consolidate D102

**Files:** create `docs/prd/command-palette.md` · modify `docs/architecture.md` (§renderer, one
paragraph naming the table), `docs/prd/vault-apps.md:9,149` and `docs/not-built.md:61` (the
palette entry is built), `docs/prd/notes-editor.md` §Split panes (⌘W's paragraph names the
table), `docs/decisions.md` (D102 leaves the inbox for the table, status paragraph updated),
`features/onboarding/OnboardingRitual.tsx:571-573` (⌘K → ⌘P)

**Behaviour:** The living docs describe what is built; no doc calls the palette absent; the
onboarding ritual promises a key that exists.

- [ ] `prd/command-palette.md`: what it lists, the two modes, recents, the Ask row, the table
      and its invariants, out of scope (rebinding, other prefixes, titles), with the spec
      linked as design of record.
- [ ] The three amendments and the decisions row, matching the D101 row's shape.
- [ ] Verify: `pnpm exec prettier --check` on the new PRD; `pnpm lint`; the dom suite (the
      onboarding test renders that act).
- [ ] Commit: `docs: consolidate D102, the command palette`.

## End-to-end verification

After his dev restart (menu and preload are main-side):

1. ⌘P: the palette opens top-anchored, input focused, recents listed. Enter: the previous
   tab is active again.
2. ⌘P, type three letters of a filename in a subfolder, Enter: the note opens pinned in the
   focused pane. ⌘P, same, ⌘Enter: it opens in the pane to the right.
3. ⌘P, type "boa", Enter: the board. Type an app's id: its tab. Type a session's name: its tab.
4. ⌘⇧P: the input holds `>`; the list shows "Split pane ⌘\", "Close tab ⌘W", "Quick open
   ⌘P". Type `spl`, Enter: a second pane. ⌘P then `>clo`, Enter: the empty pane goes with its
   exit.
5. ⌘⇧D, ⌘S, ⌘J, ⌘T, ⌘⇧T, ⌘W, ⌘\ all still do what they did.
6. ⌘P, type "what is in this vault", arrow to the last row, Enter: the session tab comes
   forward with the sentence in its input, unsent.
7. `pnpm -C packages/shared test`, then the node project, then the dom project, `pnpm typecheck`,
   `pnpm lint` (0 errors, the 4 pre-existing warnings), `pnpm --filter @holi/desktop build`.
