/**
 * Where each open file was left: its caret and how far it was scrolled, so a
 * tab switched away from and back to opens where it was rather than at the
 * top. Only the active entry's views are mounted (`panes-view.tsx`), so a
 * view writes here as the caret and scroll move and reads it back when it
 * mounts again.
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
