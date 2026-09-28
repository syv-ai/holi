/**
 * One table of commands (D102).
 *
 * Every app-level action is one row here: an id, the label the palette shows,
 * the hotkey glyph that both binds and displays it (`lib/hotkey.ts`), and a
 * Jotai write. The keydown dispatcher (`useCommandHotkeys`), the palette's `>`
 * list and main's application menu all run a command by id through
 * `runCommandAtom`, so a shortcut hint beside a command is never a second list
 * to keep in step with the first.
 *
 * **A hotkey here is a renderer keydown.** ⌘W is the exception, marked
 * `boundBy: 'menu'`: it is the File menu's accelerator, which fires before the
 * page ever sees the key, so the dispatcher skips the row and main sends the
 * id instead. Nothing else should take that route: a menu accelerator on ⌘K
 * would take the key from CodeMirror's link command, on ⌘C from xterm.
 *
 * `matchHotkey` is exact on modifiers, so `⌘T` and `⌘⇧T` are two rows.
 */
import { atom, useSetAtom, useStore, type Getter, type Setter } from 'jotai'
import { useEffect } from 'react'
import { saveAllBuffers } from '../lib/buffer-registry'
import { matchHotkey } from '../lib/hotkey'
import { trpc } from '../lib/trpc'
import { showAgentAtom, startSessionAtom } from './agent-send'
import { openTodaysDailyAtom } from './daily'
import { openDialogAtom } from './dialogs'
import { closeActiveTabWithExitAtom } from './pane-exit'
import { openPaletteAtom } from './palette'
import { navOpenAtom } from './preferences'
import { touchRecentAtom } from './recents'
import { openQuickAddAtom } from './tasks'
import { openPinned, openSingleton, splitPane, workspaceAtom, type SingletonTab } from './panes'
import { activeRemoteAtom, createNoteAtom, snapshotAtom, vaultsAtom } from './vaults'
import { switchVaultAtom } from './vault-switch'

export interface Command {
  /** Stable, dotted: `daily.open`, `tab.close`, `vault.switch:<remote>`. */
  id: string
  /** What the palette shows: an imperative, `Open today's daily`. */
  label: string
  /** The glyph string `lib/hotkey.ts` binds and displays: `⌘⇧D`. */
  hotkey?: string
  /** Display only: main's menu accelerator fires it and sends the id. */
  boundBy?: 'menu'
  /** Listed and runnable only while true. Absent means always. */
  when?: (get: Getter) => boolean
  /** Not listed in the palette and not recorded as recently used: the
   *  palette's own two rows, which a list inside the palette has no use for. */
  hidden?: true
  run: (get: Getter, set: Setter) => void | Promise<void>
}

const SURFACES: readonly { kind: SingletonTab; label: string }[] = [
  { kind: 'home', label: 'Go home' },
  { kind: 'board', label: 'Open board' },
  { kind: 'agenda', label: 'Open agenda' },
  { kind: 'mail', label: 'Open mail' },
  { kind: 'settings', label: 'Open settings' },
  { kind: 'history', label: 'Open history' },
]

/** `Untitled.md`, then `Untitled 2.md` and so on, at the vault root. */
export function untitledPath(taken: ReadonlySet<string>): string {
  if (!taken.has('Untitled.md')) return 'Untitled.md'
  for (let n = 2; ; n++) {
    const candidate = `Untitled ${n}.md`
    if (!taken.has(candidate)) return candidate
  }
}

export const STATIC_COMMANDS: readonly Command[] = [
  // ⌘⇧D jumps to today's daily (creating it if needed). Deliberately NOT
  // routed through the landing: it still works in a vault whose `dailyNotes`
  // is off, which only stops the daily being opened automatically.
  {
    id: 'daily.open',
    label: "Open today's daily",
    hotkey: '⌘⇧D',
    run: (_get, set) => void set(openTodaysDailyAtom),
  },
  // A real commit point (`docs/features/vaults-sync.md`): write the buffers,
  // commit instead of waiting out the idle timer, then push, since ⌘S is an
  // explicit "save this" (D61). The commit has to resolve before the push, or
  // the push races ahead of it. Every open buffer saves; a buffer whose syntax
  // is mid-edit holds off on its own, which is why this uses the *gated* writer.
  {
    id: 'sync.save',
    label: 'Save and sync',
    hotkey: '⌘S',
    run: () =>
      saveAllBuffers()
        .then(() => trpc.sync.commitNow.mutate())
        .then(() => trpc.sync.pushNow.mutate())
        .then(() => undefined),
  },
  // A new empty pane beside this one, focused. Empty rather than a copy of the
  // current tab: see `splitPane`.
  {
    id: 'pane.split',
    label: 'Split pane',
    hotkey: '⌘\\',
    run: (_get, set) => set(workspaceAtom, (w) => splitPane(w)),
  },
  // The nav is a drawer (DrawerShell) and hides like one. ⌥⌘S is the macOS
  // "show/hide sidebar" key (Finder, Mail, Notes); ⌘B stays bold, ⌘S save.
  {
    id: 'nav.toggle',
    label: 'Toggle sidebar',
    hotkey: '⌥⌘S',
    run: (_get, set) => set(navOpenAtom, (open) => !open),
  },
  // Bound here because a session tab is mounted only while it is open, so the
  // shortcut that OPENS one cannot live inside it.
  {
    id: 'agent.show',
    label: 'Go to the agent',
    hotkey: '⌘J',
    run: (_get, set) => set(showAgentAtom),
  },
  {
    id: 'agent.new',
    label: 'New session',
    run: (_get, set) => void set(startSessionAtom),
  },
  // Create a task in any folder, including one that is not yet a lane. ⌘T is
  // quick add, the card it will make, in the board's dock or centred; ⌘⇧T is
  // the full dialog, which opens the task to fill in the rest.
  {
    id: 'task.new',
    label: 'New task',
    hotkey: '⌘T',
    run: (_get, set) => set(openQuickAddAtom),
  },
  {
    id: 'task.new.full',
    label: 'New task with details',
    hotkey: '⌘⇧T',
    run: (_get, set) => set(openDialogAtom, { id: 'create-task', size: 'md' }),
  },
  // The focused pane's active tab. A menu accelerator, so the glyph is for
  // display and main sends the id (`main/menu.ts`).
  {
    id: 'tab.close',
    label: 'Close tab',
    hotkey: '⌘W',
    boundBy: 'menu',
    run: (_get, set) => set(closeActiveTabWithExitAtom),
  },
  ...SURFACES.map(({ kind, label }): Command => ({
    id: `${kind}.open`,
    label,
    run: (_get, set) => set(workspaceAtom, (w) => openSingleton(w, kind)),
  })),
  // The tree names a new note inline; a command has no row to type into, so
  // the note starts untitled, as VS Code's New File does, and opens pinned.
  {
    id: 'note.new',
    label: 'New note',
    when: (get) => get(activeRemoteAtom) !== null,
    run: async (get, set) => {
      const path = untitledPath(new Set(get(snapshotAtom).docs.map((d) => d.path)))
      await set(createNoteAtom, path)
      set(workspaceAtom, (w) => openPinned(w, path))
    },
  },
  {
    id: 'palette.open',
    hidden: true,
    label: 'Quick open',
    hotkey: '⌘P',
    run: (_get, set) => set(openPaletteAtom, 'open'),
  },
  {
    id: 'palette.commands',
    hidden: true,
    label: 'Command palette',
    hotkey: '⌘⇧P',
    run: (_get, set) => set(openPaletteAtom, 'commands'),
  },
]

/** The table: the static rows, then one "switch to" per other vault. */
export const commandsAtom = atom<Command[]>((get) => {
  const active = get(activeRemoteAtom)
  const switches = get(vaultsAtom)
    .filter((v) => v.remote !== active)
    .map((v): Command => ({
      id: `vault.switch:${v.remote}`,
      label: `Switch to ${v.name}`,
      run: (_get, set) => set(switchVaultAtom, v.remote),
    }))
  return [...STATIC_COMMANDS, ...switches]
})

/**
 * The only way a command runs, from the key dispatcher, the palette and the
 * menu alike. Unknown ids and rows whose `when` is false are refused quietly:
 * a menu built for a vault that has since closed may still send one.
 */
export const runCommandAtom = atom(null, async (get, set, id: string): Promise<void> => {
  const command = get(commandsAtom).find((c) => c.id === id)
  if (command === undefined) return
  if (command.when !== undefined && !command.when(get)) return
  if (command.hidden === undefined) set(touchRecentAtom, { kind: 'command', key: id })
  await command.run(get, set)
})

/**
 * One `keydown` listener over the table, installed once by Shell. It reads the
 * table through the store rather than closing over it, so a vault switch
 * changing the rows never re-subscribes it.
 */
export function useCommandHotkeys(): void {
  const store = useStore()
  const run = useSetAtom(runCommandAtom)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing) return
      const match = store
        .get(commandsAtom)
        .find((c) => c.boundBy === undefined && c.hotkey !== undefined && matchHotkey(e, c.hotkey))
      if (match === undefined) return
      if (match.when !== undefined && !match.when(store.get)) return
      e.preventDefault()
      void run(match.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run, store])
}
