import { useMemo } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { isHiddenPath, TASKS_CLAIM } from '@holi/shared'

import { joinPath } from '@/lib/tree-paths'
import {
  activeRemoteAtom,
  createNoteAtom,
  showHiddenByVaultAtom,
  showTasksByVaultAtom,
  snapshotAtom,
} from '@/state/vaults'

/** `base`, then `base 2`, `base 3`… : the first name the folder does not hold. */
export function freeName(
  taken: ReadonlySet<string>,
  parent: string,
  base: string,
  ext = '',
): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base} ${n}${ext}`
    if (!taken.has(joinPath(parent, name))) return name
  }
}

/**
 * The paths the tree shows, and every path it can act on: documents, other
 * files and claimed files (tasks only while "show task files" is on), minus
 * dot paths unless "show hidden files" is on.
 */
export function useFiles() {
  const snapshot = useAtomValue(snapshotAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const [hiddenByVault, setHiddenByVault] = useAtom(showHiddenByVaultAtom)
  const [tasksByVault, setTasksByVault] = useAtom(showTasksByVaultAtom)
  const showHidden = remote !== null && hiddenByVault[remote] === true
  const showTasks = remote !== null && tasksByVault[remote] === true

  const docPaths = useMemo(
    () => [
      ...snapshot.docs.map((doc) => doc.path),
      ...snapshot.files.map((file) => file.path),
      ...Object.entries(snapshot.claimed).flatMap(([id, set]) =>
        id === TASKS_CLAIM && !showTasks
          ? []
          : [...set.items.map((item) => item.path), ...set.broken.map((item) => item.path)],
      ),
    ],
    [snapshot, showTasks],
  )
  // Everything a rename or a new name must not collide with, or must carry
  // along: task files too, shown or not.
  const allPaths = useMemo(
    () => [
      ...snapshot.docs.map((doc) => doc.path),
      ...snapshot.files.map((file) => file.path),
      ...Object.values(snapshot.claimed).flatMap((set) => [
        ...set.items.map((item) => item.path),
        ...set.broken.map((item) => item.path),
      ]),
    ],
    [snapshot],
  )
  // Memoised: the tree rebuilds whenever these change identity, and a
  // rebuild re-renders this component.
  const paths = useMemo(
    () => (showHidden ? docPaths : docPaths.filter((path) => !isHiddenPath(path))),
    [docPaths, showHidden],
  )
  const dirs = useMemo(
    () => (showHidden ? snapshot.dirs : snapshot.dirs.filter((dir) => !isHiddenPath(dir))),
    [snapshot.dirs, showHidden],
  )

  return {
    remote,
    docPaths,
    allPaths,
    paths,
    dirs,
    taken: new Set([...allPaths, ...snapshot.dirs]),
    showHidden,
    showTasks,
    toggleHidden: () =>
      remote !== null && setHiddenByVault({ ...hiddenByVault, [remote]: !showHidden }),
    toggleTasks: () =>
      remote !== null && setTasksByVault({ ...tasksByVault, [remote]: !showTasks }),
  }
}

/** The one way a failed vault action is reported: what failed, and what to do. */
export async function attempt(what: string, action: () => Promise<void>) {
  try {
    await action()
  } catch {
    toast.error(`Couldn't ${what}. Check that the vault is reachable, then try again.`)
  }
}

/** A new, uniquely named note at the vault's root, for New document and +. */
export function useNewDocument(onCreated: (path: string) => void) {
  const { taken } = useFiles()
  const createNote = useSetAtom(createNoteAtom)
  return () =>
    attempt('create a document', async () => {
      const path = freeName(taken, '', 'Untitled', '.md')
      await createNote(path)
      onCreated(path)
    })
}
