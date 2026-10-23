/**
 * The shell's keyboard shortcuts, as one table (`docs/features/keyboard-shortcuts.md`).
 *
 * Each row is what a key does: an id, its keys, the label and group the
 * Keyboard shortcuts dialog shows, and when it may fire. What it *runs* is
 * not here: the component that owns the state registers a handler for the id
 * while it is mounted (`useShortcutHandlers`), and one `keydown` listener
 * matches this table against the handlers that are live. The dialog lists the
 * same live rows, so it shows exactly the keys that work right now.
 *
 * Keys are glyph strings (`lib/hotkey.ts`): on a Mac `⌘` is Command and `⌃`
 * Control; elsewhere both are Ctrl.
 */
import { matchShortcutKey } from './hotkey'

export type ShortcutGroup = 'Navigation' | 'Tabs' | 'Files' | 'Apps' | 'Help'

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  'Navigation',
  'Tabs',
  'Files',
  'Apps',
  'Help',
]

export interface Shortcut {
  /** Stable and dotted: `search.open`, `tab.next`. */
  id: string
  /** What the dialog shows, imperative: `Open search`. */
  label: string
  group: ShortcutGroup
  /** Every key that runs it; the handler is told which one matched. */
  keys: readonly string[]
  /** The one spec the dialog shows for a range of keys (`⌘1–9`). */
  display?: string
  /** Fires while focus is in a text field, the editor or the terminal (still
   *  never a key the focused widget handled). Off for a plain key like `?`,
   *  and for keys a field uses itself. */
  whileTyping?: true
  /** Fires while a dialog is open: the toggles for the dialogs themselves. */
  inDialogs?: true
  /** Fires on auto-repeat, for keys that step (next tab). */
  repeats?: true
  /** The application menu's accelerator, which fires before the page sees the
   *  key: the keys are for display and main sends the id (`main/menu.ts`). */
  boundBy?: 'menu'
}

export const SHORTCUTS: readonly Shortcut[] = [
  // Help
  {
    id: 'shortcuts.show',
    label: 'Show keyboard shortcuts',
    group: 'Help',
    // `?` only outside text, where it is a character; ⌘/ everywhere.
    keys: ['?'],
    inDialogs: true,
  },
  {
    id: 'shortcuts.toggle',
    label: 'Show keyboard shortcuts',
    group: 'Help',
    keys: ['⌘/'],
    whileTyping: true,
    inDialogs: true,
  },

  // Navigation
  {
    id: 'search.open',
    label: 'Search',
    group: 'Navigation',
    keys: ['⌘K'],
    whileTyping: true,
    inDialogs: true,
  },
  // In a focused markdown editor ⌘B is bold: the editor handles it first.
  {
    id: 'sidebar.toggle',
    label: 'Toggle sidebar',
    group: 'Navigation',
    keys: ['⌘B'],
    whileTyping: true,
  },
  {
    id: 'sidebar.documents',
    label: 'Show documents',
    group: 'Navigation',
    keys: ['⇧⌘E'],
    whileTyping: true,
  },
  {
    id: 'sidebar.agents',
    label: 'Show agents',
    group: 'Navigation',
    keys: ['⇧⌘A'],
    whileTyping: true,
  },
  {
    id: 'board.open',
    label: 'Open board',
    group: 'Navigation',
    keys: ['⇧⌘B'],
    whileTyping: true,
  },

  // Tabs
  {
    id: 'tab.next',
    label: 'Next tab',
    group: 'Tabs',
    keys: ['⌃Tab'],
    whileTyping: true,
    repeats: true,
  },
  {
    id: 'tab.previous',
    label: 'Previous tab',
    group: 'Tabs',
    keys: ['⌃⇧Tab'],
    whileTyping: true,
    repeats: true,
  },
  {
    id: 'tab.goto',
    label: 'Go to tab 1 to 8, or the last',
    group: 'Tabs',
    keys: ['⌘1', '⌘2', '⌘3', '⌘4', '⌘5', '⌘6', '⌘7', '⌘8', '⌘9'],
    display: '⌘1–9',
    whileTyping: true,
  },
  {
    id: 'tab.close',
    label: 'Close tab',
    group: 'Tabs',
    keys: ['⌘W'],
    boundBy: 'menu',
  },
  {
    id: 'tab.closeAll',
    label: 'Close all tabs',
    group: 'Tabs',
    keys: ['⌥⌘W'],
    whileTyping: true,
  },
  {
    id: 'pane.split',
    label: 'Split right',
    group: 'Tabs',
    keys: ['⌘\\'],
    whileTyping: true,
  },
  {
    id: 'tab.reopen',
    label: 'Reopen closed tab',
    group: 'Tabs',
    keys: ['⇧⌘T'],
    whileTyping: true,
  },

  // Files
  {
    id: 'document.new',
    label: 'New document',
    group: 'Files',
    keys: ['⌘N'],
    whileTyping: true,
  },
  // The tree renames its focused row itself; this is the same key with focus
  // anywhere else outside text, on the row selected in the tree.
  {
    id: 'files.rename',
    label: 'Rename selected file',
    group: 'Files',
    keys: ['F2'],
  },
  {
    id: 'files.collapseAll',
    label: 'Collapse all folders',
    group: 'Files',
    keys: ['⌥⌘←'],
  },

  // Apps: one row per sidebar app that has a key, live while it is listed.
  {
    id: 'app.mail',
    label: 'Open Mail',
    group: 'Apps',
    keys: ['⇧⌘M'],
    whileTyping: true,
  },
  {
    id: 'app.calendar',
    label: 'Open Calendar',
    group: 'Apps',
    keys: ['⇧⌘C'],
    whileTyping: true,
  },
]

/** Where a key landed, as far as the table cares. */
export type KeyTarget = 'page' | 'text' | 'terminal'

export function keyTargetOf(target: EventTarget | null): KeyTarget {
  if (!(target instanceof Element)) return 'page'
  if (target.closest('.xterm') !== null) return 'terminal'
  if (target.closest('.cm-editor') !== null) return 'text'
  if (target.closest('[contenteditable]:not([contenteditable="false"])') !== null) return 'text'
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return 'text'
  if (target instanceof HTMLInputElement) {
    return NON_TEXT_INPUTS.has(target.type) ? 'page' : 'text'
  }
  return 'page'
}

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

export interface KeyContext {
  mac: boolean
  target: KeyTarget
  /** A modal dialog is open over the shell. */
  dialogOpen: boolean
  /** The ids that have a handler right now. */
  live: ReadonlySet<string>
}

export interface ShortcutMatch {
  shortcut: Shortcut
  /** Which of its `keys` matched. */
  index: number
}

/**
 * The live row a key runs, or null. Pure, so a test can say exactly when a
 * key does and does not fire.
 *
 * Never: while composing text, on a key the focused widget already handled
 * (`defaultPrevented`: the editor's ⌘B is bold), or for a menu-bound row.
 * In text, only rows marked `whileTyping`. In the terminal, also never a
 * key with Control held: those are the terminal's (on a Mac ⌘ is free, as
 * xterm leaves Command keys alone).
 */
export function resolveShortcut(
  e: KeyboardEvent,
  ctx: KeyContext,
  table: readonly Shortcut[] = SHORTCUTS,
): ShortcutMatch | null {
  if (e.isComposing || e.defaultPrevented) return null
  for (const shortcut of table) {
    if (shortcut.boundBy !== undefined || !ctx.live.has(shortcut.id)) continue
    const index = shortcut.keys.findIndex((spec) => matchShortcutKey(e, spec, ctx.mac))
    if (index < 0) continue
    if (e.repeat && shortcut.repeats === undefined) return null
    if (ctx.dialogOpen && shortcut.inDialogs === undefined) return null
    if (ctx.target !== 'page' && shortcut.whileTyping === undefined) return null
    if (ctx.target === 'terminal' && e.ctrlKey) return null
    return { shortcut, index }
  }
  return null
}

/** One line of the Keyboard shortcuts dialog: a label and every key for it. */
export interface ShortcutLine {
  group: ShortcutGroup
  label: string
  specs: string[]
}

/** The lines the dialog shows: live rows, merged by label, in table order. */
export function liveShortcuts(
  live: ReadonlySet<string>,
  table: readonly Shortcut[] = SHORTCUTS,
): ShortcutLine[] {
  const lines = new Map<string, ShortcutLine>()
  for (const shortcut of table) {
    if (!live.has(shortcut.id)) continue
    const key = `${shortcut.group}:${shortcut.label}`
    const line = lines.get(key) ?? { group: shortcut.group, label: shortcut.label, specs: [] }
    line.specs.push(...(shortcut.display === undefined ? shortcut.keys : [shortcut.display]))
    lines.set(key, line)
  }
  return [...lines.values()]
}
