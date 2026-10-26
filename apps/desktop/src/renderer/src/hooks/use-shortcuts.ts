import { useSetAtom, useStore } from 'jotai'
import { useEffect, useRef } from 'react'

import { isMac } from '@/lib/platform'
import { keyTargetOf, resolveShortcut } from '@/lib/shortcuts'
import {
  handlersAtom,
  liveShortcutIdsAtom,
  type ShortcutHandler,
  type Slot,
} from '@/state/shortcuts'

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
    const run = (id: string, index: number): void => {
      const slots = store.get(handlersAtom).get(id)
      slots?.[slots.length - 1]?.current(index)
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
    const offMenu = window.holi?.menu?.onCommand((id) => run(id, 0))
    return () => {
      window.removeEventListener('keydown', onKey)
      offMenu?.()
    }
  }, [store])
}
