/**
 * What a core capability may ask of the running app, beyond the vault's files.
 *
 * Every door builds a capability's context through one `createCoreServices`,
 * so the app's bridge and the agent's `holi` CLI see the same sync state, the
 * same recents and the same members, and there is one place that decides what
 * "the active vault" means for them. A feature's own needs are not here: each
 * feature's table closes over its dependencies when it is registered.
 *
 * No `electron` import: the registry's tests hand in a fake instead.
 */
import type { Collaborator, RecentEntry } from '@holi/shared'
import { openRepo, type GitRepo } from '../git'
import type { MembersCache } from '../github/members-cache'
import type { SyncState } from '../vault/active-vault'
import { CapabilityError } from './error'

export interface CoreServices {
  /** Null when this vault is not the one open: main tracks sync for that one only. */
  syncState(): SyncState | null
  /** The renderer's last report for this vault, unfiltered; empty before one. */
  recents(): RecentEntry[]
  /** The repo's collaborators, cached for a few minutes. Rejects on a GitHub error. */
  members(): Promise<Collaborator[]>
  repo(): GitRepo
}

export interface CoreServicesDeps {
  /** The open vault's remote and sync state, or null with none open. */
  active(): { remote: string; syncState(): SyncState } | null
  members: MembersCache
  reports: UiReports
}

/**
 * What the renderer says the person is looking at, per vault: the focused
 * note and the open ones (for the agent's per-turn focus file), and the
 * recents (for `holi vault recents` and an app's `holi.recents()`). One report, sent
 * whenever any of it changes (`state/ui-report.ts`); main keeps the last.
 */
export interface UiReport {
  focusedPath: string | null
  openPaths: string[]
  recents: RecentEntry[]
}

export interface UiReports {
  set(remote: string, report: UiReport): void
  get(remote: string): UiReport
}

export function createUiReports(): UiReports {
  const byRemote = new Map<string, UiReport>()
  return {
    set: (remote, report) => void byRemote.set(remote, report),
    get: (remote) => byRemote.get(remote) ?? { focusedPath: null, openPaths: [], recents: [] },
  }
}

/** One services object per call, for `remote` cloned at `root`. */
export function createCoreServices(
  deps: CoreServicesDeps,
): (remote: string, root: string) => CoreServices {
  return (remote, root) => ({
    syncState: () => {
      const active = deps.active()
      return active?.remote === remote ? active.syncState() : null
    },
    recents: () => deps.reports.get(remote).recents,
    members: () => deps.members.get(remote),
    repo: () => openRepo(root),
  })
}

/**
 * Services for a door with none wired (the router's tests): everything past
 * the vault's files is "not here", never a wrong answer.
 */
export function noCoreServices(): CoreServices {
  const none = (): never => {
    throw new CapabilityError('UNAVAILABLE', 'not available here')
  }
  return {
    syncState: () => null,
    recents: () => [],
    members: async () => none(),
    repo: none,
  }
}
