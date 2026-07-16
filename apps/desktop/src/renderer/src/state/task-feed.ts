/**
 * The task feed: tasks and presence PUSHED from main, which owns the one SSE connection
 * per signed-in user (D50). The renderer never opens a second stream.
 *
 * **This is a vault-level concern, not the board's (D58).** It lived inside `BoardView` until
 * the notes editor grew task chips (D27) and found `tasksAtom` empty — because the board
 * had never mounted, nothing had ever loaded a task, and a chip resolving against an
 * empty map confidently rendered every live task as "[deleted task]". The `@`-mention's
 * task list was silently empty for the same reason, from the moment it shipped.
 *
 * So it sits beside the docs feed in `Shell` now, with the same lifetime as the active
 * vault. Two consumers of `tasksAtom` in different subtrees is exactly the shape that
 * makes "whoever renders it loads it" wrong.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import {
  applyPresence,
  applyTasksEvent,
  loadTasksAtom,
  presenceAtom,
  pruneExpired,
  tasksAtom,
} from './tasks'
import { activeVaultIdAtom } from './vaults'

export function useTaskFeed(): void {
  const vaultId = useAtomValue(activeVaultIdAtom)
  const loadTasks = useSetAtom(loadTasksAtom)
  const setTasks = useSetAtom(tasksAtom)
  const setPresence = useSetAtom(presenceAtom)

  useEffect(() => {
    if (!vaultId) return
    void loadTasks()
    const offEvent = window.holi.tasks.onEvent((e) => setTasks((prev) => applyTasksEvent(prev, e)))
    const offPresence = window.holi.tasks.onPresence((e) =>
      setPresence((prev) => applyPresence(prev, e)),
    )
    // Entries expire on their own — a heartbeat that stops arriving IS the release, so
    // there is nothing to unsubscribe from and no "stopped editing" event to wait for.
    const tick = setInterval(
      () => setPresence((prev) => pruneExpired(prev, new Date().toISOString())),
      2000,
    )
    return () => {
      offEvent()
      offPresence()
      clearInterval(tick)
    }
  }, [vaultId, loadTasks, setTasks, setPresence])
}
