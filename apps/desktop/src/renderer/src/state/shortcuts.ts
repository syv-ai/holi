/**
 * Where the shortcut table (`lib/shortcuts.ts`) meets the components that own
 * what a key does.
 *
 * A component registers a handler per id while it is mounted
 * (`useShortcutHandlers`, `hooks/use-shortcuts.ts`); the set of live ids is an atom, so the Keyboard
 * shortcuts dialog lists what works now and nothing else. One `keydown`
 * listener and the menu's `menu:command` channel run them
 * (`useShortcutDispatcher`, installed once by the app shell).
 */
import { atom } from 'jotai'

/** `index` is which of the row's keys matched; 0 from the menu. */
export type ShortcutHandler = (index: number) => void

export type Slot = { current: ShortcutHandler }

/** Each live id's handlers, newest last: the newest one runs. */
export const handlersAtom = atom<ReadonlyMap<string, readonly Slot[]>>(new Map())

/** The ids a key or the menu can run right now. */
export const liveShortcutIdsAtom = atom<ReadonlySet<string>>(
  (get) => new Set(get(handlersAtom).keys()),
)

/**
 * Run a live shortcut by id, as its key would: the command menu's actions
 * are the table's rows. `false` when nothing handles it now.
 */
export const runShortcutAtom = atom(null, (get, _set, id: string): boolean => {
  const slots = get(handlersAtom).get(id)
  const slot = slots?.[slots.length - 1]
  if (slot === undefined) return false
  slot.current(0)
  return true
})

/** Whether the Keyboard shortcuts dialog is open. */
export const shortcutsDialogOpenAtom = atom(false)
