import { useSetAtom, useStore } from 'jotai'
import { useEffect, useRef } from 'react'

import { isMac } from '@/lib/platform'
import { keyTargetOf, resolveShortcut } from '@/lib/shortcuts'
import { dialogOpen } from '@/lib/dialog-open'
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
      .map((id): [string, Slot] => [
        id,
        { current: (index, key) => latest.current[id]?.(index, key) },
      ])
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

/**
 * The `keydown` listeners over the table, one per phase, and the menu's ids.
 * Installed once; they read the handlers through the store, so registering
 * one never re-subscribes them.
 */
export function useShortcutDispatcher(): void {
  const store = useStore()

  useEffect(() => {
    const run = (id: string, index: number, key?: KeyboardEvent): void => {
      const slots = store.get(handlersAtom).get(id)
      slots?.[slots.length - 1]?.current(index, key)
    }
    // Two phases: a `capture` row runs before the focused widget sees the
    // key, and is kept from it; every other row lets the widget go first.
    const listener =
      (capture: boolean) =>
      (e: KeyboardEvent): void => {
        const match = resolveShortcut(e, {
          mac: isMac(),
          target: keyTargetOf(e.target),
          dialogOpen: dialogOpen(),
          live: store.get(liveShortcutIdsAtom),
          capture,
        })
        if (match === null) return
        e.preventDefault()
        if (capture) e.stopPropagation()
        run(match.shortcut.id, match.index, e)
      }
    const onKey = listener(false)
    const onCapturedKey = listener(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onCapturedKey, true)
    // Absent in a test or a page without the preload bridge.
    const offMenu = window.holi?.menu?.onCommand((id) => run(id, 0))
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', onCapturedKey, true)
      offMenu?.()
    }
  }, [store])
}
