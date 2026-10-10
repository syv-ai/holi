import { useMemo } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { isHiddenPath, snapshotTasks, TASKS_CLAIM } from '@holi/shared'
import { revealRequestAtom } from '@/state/reveal'
import {
  activeRemoteAtom,
  showHiddenByVaultAtom,
  showTasksByVaultAtom,
  snapshotAtom,
} from '@/state/vaults'

/**
 * The snapshot as the explorer shows it: hidden and task files filtered by the
 * per-vault toggles, plus the per-path facts a row paints (icon, task, ignored).
 * Claimed files show as the files they are, a broken one too, so it can be
 * opened and fixed; the tasks toggle hides task files.
 * The tree data itself is built by the caller, which adds the folders still
 * being named (they live in the explorer actions, which need `docPaths`).
 */
export function useTreeProjection() {
  const snapshot = useAtomValue(snapshotAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  const revealPath = useAtomValue(revealRequestAtom)?.path ?? null
  const [hiddenByVault, setHiddenByVault] = useAtom(showHiddenByVaultAtom)
  const [tasksByVault, setTasksByVault] = useAtom(showTasksByVaultAtom)
  const showHidden = activeRemote !== null && hiddenByVault[activeRemote] === true
  const showTasks = activeRemote !== null && tasksByVault[activeRemote] === true

  /** Every path the explorer can act on, for the explorer actions. */
  const docPaths = useMemo(
    () => [
      ...snapshot.docs.map((d) => d.path),
      ...snapshot.files.map((f) => f.path),
      ...Object.entries(snapshot.claimed).flatMap(([id, set]) =>
        id === TASKS_CLAIM && !showTasks
          ? []
          : [...set.items.map((i) => i.path), ...set.broken.map((b) => b.path)],
      ),
    ],
    [snapshot, showTasks],
  )
  // Machine-local files show like any other: `.local.` means "does not sync",
  // not "hide from me", and git's dim already marks them.
  const visible = useMemo(() => {
    const paths = showHidden
      ? docPaths
      : docPaths.filter((p) => p === revealPath || !isHiddenPath(p))
    const dirs = showHidden ? snapshot.dirs : snapshot.dirs.filter((d) => !isHiddenPath(d))
    return { paths, dirs }
  }, [docPaths, snapshot.dirs, showHidden, revealPath])

  const taskByPath = useMemo(
    () => new Map(snapshotTasks(snapshot).items.map((t) => [t.path, t])),
    [snapshot],
  )
  const iconByPath = useMemo(() => new Map(Object.entries(snapshot.icons)), [snapshot.icons])
  const ignored = useMemo(() => new Set(snapshot.ignored), [snapshot.ignored])

  return {
    docPaths,
    visible,
    taskByPath,
    iconByPath,
    ignored,
    showHidden,
    showTasks,
    toggleHidden: () =>
      activeRemote !== null && setHiddenByVault({ ...hiddenByVault, [activeRemote]: !showHidden }),
    toggleTasks: () =>
      activeRemote !== null && setTasksByVault({ ...tasksByVault, [activeRemote]: !showTasks }),
  }
}
