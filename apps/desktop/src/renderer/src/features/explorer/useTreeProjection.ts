import { useMemo } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { isHiddenPath, isLocalOnlyPath } from '@holi/shared'
import { buildTreeData } from '@/lib/tree-data'
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
 * The rebuilt tree's copy of what `FileTree` computes inline.
 */
export function useTreeProjection() {
  const snapshot = useAtomValue(snapshotAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  const revealPath = useAtomValue(revealRequestAtom)?.path ?? null
  const [hiddenByVault, setHiddenByVault] = useAtom(showHiddenByVaultAtom)
  const [tasksByVault, setTasksByVault] = useAtom(showTasksByVaultAtom)
  const showHidden = activeRemote !== null && hiddenByVault[activeRemote] === true
  const showTasks = activeRemote !== null && tasksByVault[activeRemote] === true

  const data = useMemo(() => {
    const paths = [
      ...snapshot.docs.map((d) => d.path),
      ...snapshot.files.map((f) => f.path),
      ...(showTasks ? snapshot.tasks.map((t) => t.path) : []),
    ]
    const visible = showHidden
      ? paths
      : paths.filter((p) => p === revealPath || (!isHiddenPath(p) && !isLocalOnlyPath(p)))
    const dirs = showHidden ? snapshot.dirs : snapshot.dirs.filter((d) => !isHiddenPath(d))
    return buildTreeData(visible, dirs)
  }, [snapshot, showHidden, showTasks, revealPath])

  const taskByPath = useMemo(() => new Map(snapshot.tasks.map((t) => [t.path, t])), [snapshot])
  const iconByPath = useMemo(() => new Map(Object.entries(snapshot.icons)), [snapshot.icons])
  const ignored = useMemo(() => new Set(snapshot.ignored), [snapshot.ignored])

  return {
    data,
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
