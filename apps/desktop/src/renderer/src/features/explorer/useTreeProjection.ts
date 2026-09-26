import { useMemo } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { isHiddenPath, isLocalOnlyPath } from '@holi/shared'
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
      ...(showTasks ? snapshot.tasks.map((t) => t.path) : []),
    ],
    [snapshot, showTasks],
  )
  const visible = useMemo(() => {
    const paths = showHidden
      ? docPaths
      : docPaths.filter((p) => p === revealPath || (!isHiddenPath(p) && !isLocalOnlyPath(p)))
    const dirs = showHidden ? snapshot.dirs : snapshot.dirs.filter((d) => !isHiddenPath(d))
    return { paths, dirs }
  }, [docPaths, snapshot.dirs, showHidden, revealPath])

  const taskByPath = useMemo(() => new Map(snapshot.tasks.map((t) => [t.path, t])), [snapshot])
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
