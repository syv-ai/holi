/**
 * Where the shortcut table (`lib/shortcuts.ts`) meets the components that own
 * what a key does.
 *
 * A component registers a handler per id while it is mounted
 * (`useShortcutHandlers`); the set of live ids is an atom, so the Keyboard
 * shortcuts dialog lists what works now and nothing else. One `keydown`
 * listener and the menu's `menu:command` channel run them
 * (`useShortcutDispatcher`, installed once by the app shell).
 */
import { atom, useSetAtom, useStore } from 'jotai'
import { useEffect, useRef } from 'react'
import { keyTargetOf, resolveShortcut } from '../lib/shortcuts'

/** `index` is which of the row's keys matched; 0 from the menu. */
export type ShortcutHandler = (index: number) => void

type Slot = { current: ShortcutHandler }

/** Each live id's handlers, newest last: the newest one runs. */
const handlersAtom = atom<ReadonlyMap<string, readonly Slot[]>>(new Map())

/** The ids a key or the menu can run right now. */
export const liveShortcutIdsAtom = atom<ReadonlySet<string>>(
  (get) => new Set(get(handlersAtom).keys()),
)

/** Whether the Keyboard shortcuts dialog is open. */
export const shortcutsDialogOpenAtom = atom(false)

/**
 * Register `handlers` while the caller is mounted. An `undefined` entry is a
 * shortcut that does not apply now (Mail with no account), so it is neither
 * run nor listed. Handlers may close over fresh state on every render: the
 * registration follows the set of ids, and each slot reads the latest one.
 */
export function useShortcutHandlers(
  handlers: Readonly<Record<string, ShortcutHandler | undefined>>,
): void {
  const setHandlers = useSetAtom(handlersAtom)
  const latest = useRef(handlers)
  latest.current = handlers
  const ids = Object.keys(handlers)
    .filter((id) => handlers[id] !== undefined)
    .sort()
    .join('\n')

  useEffect(() => {
    if (ids === '') return
    const slots = ids
      .split('\n')
      .map((id): [string, Slot] => [id, { current: (index) => latest.current[id]?.(index) }])
    setHandlers((map) => {
      const next = new Map(map)
      for (const [id, slot] of slots) next.set(id, [...(next.get(id) ?? []), slot])
      return next
    })
    return () =>
      setHandlers((map) => {
        const next = new Map(map)
        for (const [id, slot] of slots) {
          const rest = (next.get(id) ?? []).filter((s) => s !== slot)
          if (rest.length > 0) next.set(id, rest)
          else next.delete(id)
        }
        return next
      })
  }, [ids, setHandlers])
}

/** Whether `main.tsx` stamped this as a Mac. Read at the time of use: it is
 *  stamped after the modules load. */
export function isMac(): boolean {
  return document.documentElement.dataset.platform === 'mac'
}

/** A modal over the shell: a Radix dialog or alert dialog that is open. */
function dialogOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ) !== null
  )
}

/**
 * The one `keydown` listener over the table, and the menu's ids. Installed
 * once; it reads the handlers through the store, so registering one never
 * re-subscribes it.
 */
export function useShortcutDispatcher(): void {
  const store = useStore()

  useEffect(() => {
    const run = (id: string, index: number): boolean => {
      const slots = store.get(handlersAtom).get(id)
      const slot = slots?.[slots.length - 1]
      if (slot === undefined) return false
      slot.current(index)
      return true
    }
    const onKey = (e: KeyboardEvent): void => {
      const match = resolveShortcut(e, {
        mac: isMac(),
        target: keyTargetOf(e.target),
        dialogOpen: dialogOpen(),
        live: store.get(liveShortcutIdsAtom),
      })
      if (match === null) return
      e.preventDefault()
      run(match.shortcut.id, match.index)
    }
    window.addEventListener('keydown', onKey)
    // Absent in a test or a page without the preload bridge.
    const offMenu = window.holi?.menu?.onCommand((id) => void run(id, 0))
    return () => {
      window.removeEventListener('keydown', onKey)
      offMenu?.()
    }
  }, [store])
}
