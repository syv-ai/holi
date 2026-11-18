/**
 * Lightweight caret and scroll memory for a file's next mount. A view writes
 * here as its position moves and reads it back after disposal and remount.
 * Visited open editors retain their mounted instances across tab switches;
 * that retention is separate from this position memory.
 *
 * Per vault and path, for the app's lifetime, and nothing is written to
 * disk: a relaunch opens files at the top, as a fresh open does. The memory
 * lives in the store, so a fresh store remembers nothing.
 */
import { atom, useAtomValue } from 'jotai'
import { useMemo } from 'react'

interface ViewSpot {
  /** The selection, as the view counts positions. */
  anchor: number
  head: number
  scrollTop: number
}

const memoryAtom = atom(() => new Map<string, ViewSpot>())

const keyOf = (remote: string, path: string) => `${remote}\n${path}`

export interface ViewMemory {
  get(remote: string, path: string): ViewSpot | undefined
  /** Merge in what moved; an unwritten field keeps what was there. */
  note(remote: string, path: string, spot: Partial<ViewSpot>): void
}

/** The same object for the store's lifetime, so an effect may depend on it. */
export function useViewMemory(): ViewMemory {
  const memory = useAtomValue(memoryAtom)
  return useMemo(
    () => ({
      get: (remote, path) => memory.get(keyOf(remote, path)),
      note: (remote, path, spot) => {
        const key = keyOf(remote, path)
        const was = memory.get(key) ?? { anchor: 0, head: 0, scrollTop: 0 }
        memory.set(key, { ...was, ...spot })
      },
    }),
    [memory],
  )
}
