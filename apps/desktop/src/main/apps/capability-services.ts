/**
 * What a capability may ask of the running app, beyond the vault's files.
 *
 * Both doors build a capability's context through `createCapabilityServices`,
 * so the app's bridge and the agent's `holi` CLI see the same sync state, the
 * same sessions and the same members, and there is one place that decides
 * what "the active vault" means for them.
 *
 * No `electron` import: the registry's tests hand in a fake instead.
 */
import type { Collaborator, RecentEntry } from '@holi/shared'
import type { SessionSummary } from '../agent/claude-sessions'
import { openRepo, type GitRepo } from '../git'
import type { AgendaWindow, CalendarEvent, CalendarOverrides } from '../google/calendar'
import type { GoogleData } from '../google/data'
import type { ListThreadsOptions, MailPage } from '../google/gmail'
import type { SyncState } from '../vault/active-vault'
import type { AppGrants } from './app-grants'
import { CapabilityError } from './capability-error'

export interface CapabilityServices {
  /** Today, local, as `YYYY-MM-DD`: the frame a recurrence rolls against. */
  today(): string
  /** Null when this vault is not the one open: main tracks sync for that one only. */
  syncState(): SyncState | null
  /** Empty when this vault is not the one open. */
  sessions(): SessionSummary[]
  /** The renderer's last report for this vault, unfiltered; empty before one. */
  recents(): RecentEntry[]
  /** The repo's collaborators, cached for a few minutes. Rejects on a GitHub error. */
  members(): Promise<Collaborator[]>
  repo(): GitRepo
  /** Null: no Google account is connected to this vault. */
  agenda(window: AgendaWindow): Promise<CalendarEvent[] | null>
  threads(options: ListThreadsOptions): Promise<MailPage | null>
  grants: AppGrants
}

export interface CapabilityServicesDeps {
  today(): string
  /** The open vault's remote and sync state, or null with none open. */
  active(): { remote: string; syncState(): SyncState } | null
  sessions(): SessionSummary[]
  collaborators(remote: string): Promise<Collaborator[]>
  googleDataFor(remote: string): Promise<GoogleData | null>
  calendarOverrides(): Promise<CalendarOverrides>
  grants: AppGrants
  now?: () => number
}

/** How long a collaborator list is reused: long enough that an app polling it
 *  does not spend the GitHub rate limit, short enough that an invite shows. */
export const MEMBERS_TTL_MS = 10 * 60 * 1000

/**
 * What the renderer says the person is looking at, per vault: the focused
 * note and the open ones (for the agent's per-turn focus file), and the
 * recents (for `holi recents` and an app's `holi.recents()`). One report, sent
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
export function createCapabilityServices(
  deps: CapabilityServicesDeps,
  reports: UiReports,
): (remote: string, root: string) => CapabilityServices {
  const now = deps.now ?? Date.now
  const members = new Map<string, { at: number; list: Promise<Collaborator[]> }>()

  return (remote, root) => {
    const isActive = () => deps.active()?.remote === remote
    return {
      today: deps.today,
      syncState: () => (isActive() ? (deps.active()?.syncState() ?? null) : null),
      sessions: () => (isActive() ? deps.sessions() : []),
      recents: () => reports.get(remote).recents,
      members: () => {
        const cached = members.get(remote)
        if (cached !== undefined && now() - cached.at < MEMBERS_TTL_MS) return cached.list
        const list = deps.collaborators(remote)
        members.set(remote, { at: now(), list })
        // A failure is not cached: the next call asks GitHub again.
        list.catch(() => members.delete(remote))
        return list
      },
      repo: () => openRepo(root),
      agenda: async (window) => {
        const data = await deps.googleDataFor(remote)
        return data === null ? null : data.agenda(window, await deps.calendarOverrides())
      },
      threads: async (options) => {
        const data = await deps.googleDataFor(remote)
        return data === null ? null : data.threads(options)
      },
      grants: deps.grants,
    }
  }
}

/**
 * Services for a door with none wired (the router's tests): everything past
 * the vault's files is "not here", never a wrong answer.
 */
export function noServices(today: () => string): CapabilityServices {
  const none = (): never => {
    throw new CapabilityError('UNAVAILABLE', 'not available here')
  }
  return {
    today,
    syncState: () => null,
    sessions: () => [],
    recents: () => [],
    members: async () => none(),
    repo: none,
    agenda: async () => null,
    threads: async () => null,
    grants: { status: async () => ({ codeHash: '', affordances: [] }), grant: async () => none() },
  }
}
