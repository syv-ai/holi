/**
 * The vault as a project (docs/features/planning.md): its two committed
 * files, `.holi/statuses.yaml` (the board's columns) and `.holi/project.md`
 * (name, status, lead, dates, milestones, About).
 *
 * Read through main like any vault file and re-read whenever the snapshot
 * says the file changed, so a teammate's edit, the agent's, or one made in
 * the editor reaches the view the way a task edit does. A file that does not
 * exist is the defaults, not an error.
 *
 * Vault-scoped and loaded once from Shell (`usePlanningFiles`): the sidebar's
 * Board count needs the statuses before the planning view is ever opened.
 */
import {
  DEFAULT_STATUSES,
  EMPTY_PROJECT,
  isClosedStatus,
  parseProjectFile,
  parseStatusesFile,
  PROJECT_FILE,
  serializeProjectFile,
  STATUSES_FILE,
  type Project,
  type StatusDef,
} from '@holi/shared'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { EMPTY_PLANNING_FILTER, type PlanningFilter, type PlanningSort } from '@/lib/planning'
import { trpc } from '@/lib/trpc'
import { activeRemoteAtom, loadSnapshotAtom, snapshotAtom } from './vaults'

/** A file read through main: not yet, read (with what in it was not
 *  understood), or failed. */
export type Loadable<T> =
  | { state: 'loading' }
  | { state: 'ready'; value: T; warnings: string[] }
  | { state: 'error'; message: string }

export const statusesFileAtom = atom<Loadable<StatusDef[]>>({ state: 'loading' })
export const projectFileAtom = atom<Loadable<Project>>({ state: 'loading' })

/** The vault's statuses, in board order: the defaults until the file is read,
 *  or when it could not be. */
export const statusesAtom = atom<readonly StatusDef[]>((get) => {
  const file = get(statusesFileAtom)
  return file.state === 'ready' ? file.value : DEFAULT_STATUSES
})

/** Whether a status is finished, by the vault's own statuses. */
export const isClosedAtom = atom((get) => {
  const statuses = get(statusesAtom)
  return (status: string) => isClosedStatus(statuses, status)
})

/** When each file last changed on disk, or null when it is not there: what
 *  a re-read keys on. `.holi/project.md` is markdown, so a doc; the statuses
 *  file is not. */
const fileStampsAtom = atom((get) => {
  const snapshot = get(snapshotAtom)
  return {
    project: snapshot.docs.find((d) => d.path === PROJECT_FILE)?.updatedAt ?? null,
    statuses: snapshot.files.find((f) => f.path === STATUSES_FILE)?.updatedAt ?? null,
  }
})

/** Bumped by Retry, so a failed read is asked again with nothing changed. */
const retryAtom = atom(0)
export const retryPlanningFilesAtom = atom(null, (_get, set) => set(retryAtom, (n) => n + 1))

async function readText(remote: string, path: string, exists: boolean): Promise<string | null> {
  if (!exists) return null
  return trpc.notes.read.query({ remote, path })
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Read both files whenever the vault, or either file, changes. Mounted once,
 *  in Shell. */
export function usePlanningFiles(): void {
  const remote = useAtomValue(activeRemoteAtom)
  const stamps = useAtomValue(fileStampsAtom)
  const retry = useAtomValue(retryAtom)
  const setStatuses = useSetAtom(statusesFileAtom)
  const setProject = useSetAtom(projectFileAtom)

  useEffect(() => {
    if (remote === null) return
    let live = true
    readText(remote, STATUSES_FILE, stamps.statuses !== null)
      .then((text) => {
        const { statuses, warnings } = parseStatusesFile(text)
        if (live) setStatuses({ state: 'ready', value: statuses, warnings })
      })
      .catch((err: unknown) => live && setStatuses({ state: 'error', message: message(err) }))
    return () => {
      live = false
    }
  }, [remote, stamps.statuses, retry, setStatuses])

  useEffect(() => {
    if (remote === null) return
    let live = true
    readText(remote, PROJECT_FILE, stamps.project !== null)
      .then((text) => {
        const { project, warnings } = parseProjectFile(text)
        if (live) setProject({ state: 'ready', value: project, warnings })
      })
      .catch((err: unknown) => live && setProject({ state: 'error', message: message(err) }))
    return () => {
      live = false
    }
  }, [remote, stamps.project, retry, setProject])
}

/** Write the project file whole, then re-read the vault: the file on disk is
 *  the truth, as for a task. Autosave commits it like any other edit. */
export const saveProjectAtom = atom(null, async (get, set, project: Project) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  await trpc.notes.write.mutate({
    remote,
    path: PROJECT_FILE,
    text: serializeProjectFile(project),
  })
  set(projectFileAtom, { state: 'ready', value: project, warnings: [] })
  await set(loadSnapshotAtom)
})

// ------------------------------------------------------------- view state
//
// Kept here rather than in the view, so leaving the Board tab and coming back
// finds the same tab, search, filter and order. Per session, not per vault:
// a filter by person still means that person in the next vault.

export type PlanningTab = 'overview' | 'board' | 'list' | 'table'

export const planningTabAtom = atom<PlanningTab>('board')
export const planningFilterAtom = atom<PlanningFilter>(EMPTY_PLANNING_FILTER)
export const planningSortAtom = atom<PlanningSort>('manual')
