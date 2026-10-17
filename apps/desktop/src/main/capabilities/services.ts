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
import { createHash } from 'node:crypto'
import type { Collaborator, RecentEntry } from '@holi/shared'
import { tryGit } from '../git'
import { openRepo, type GitRepo } from '../git'
import type { MembersCache } from '../github/members-cache'
import type { SyncState } from '../vault/active-vault'
import type { ScanClaim } from '../vault/vault-store'
import { CapabilityError } from './error'

export interface CoreServices {
  /** Null when this vault is not the one open: main tracks sync for that one only. */
  syncState(): SyncState | null
  /** The renderer's last report for this vault, unfiltered; empty before one. */
  recents(): RecentEntry[]
  /** The repo's collaborators, cached for a few minutes. Rejects on a GitHub error. */
  members(): Promise<Collaborator[]>
  repo(): GitRepo
  /** Whether a running plugin claims this path, including before the file exists. */
  claimed(path: string): Promise<boolean>
  /** Commit/push a CLI note mutation only when this clone is the open vault. */
  settle(
    path: string,
    revision: string | null,
  ): Promise<{
    commitSha: string | null
    pushed: boolean
    phase: 'complete' | 'commit' | 'push'
    reason: string | null
    revision?: string | null
  }>
}

export interface CoreServicesDeps {
  /** The open vault's remote and sync state, or null with none open. */
  active(): {
    remote: string
    root: string
    syncState(): SyncState
    commitNow(): Promise<string | null>
    pushNow(): Promise<void>
    heldBack(): { path: string }[]
  } | null
  members: MembersCache
  reports: UiReports
  claims(root: string): Promise<readonly ScanClaim[]>
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
    claimed: async (path) => (await deps.claims(root)).some((claim) => claim.match(path)),
    settle: async (path, expectedRevision) => {
      const active = deps.active()
      if (active?.remote !== remote || active.root !== root) {
        return { commitSha: null, pushed: false, phase: 'commit', reason: 'vault-not-open' }
      }
      const state = active.syncState()
      if (
        state.kind === 'conflict' ||
        state.kind === 'reconciling' ||
        state.kind === 'paused' ||
        state.kind === 'pulling'
      ) {
        return { commitSha: null, pushed: false, phase: 'commit', reason: 'sync-blocked' }
      }
      if (active.heldBack().some((file) => file.path === path)) {
        return { commitSha: null, pushed: false, phase: 'commit', reason: 'oversized' }
      }
      let commitSha: string | null = null
      try {
        const newCommitSha = await active.commitNow()
        const initialHead = await tryGit(root, ['rev-parse', 'HEAD'])
        commitSha = newCommitSha ?? (initialHead.ok ? initialHead.stdout.trim() : '')
        if (!commitSha) {
          return { commitSha: null, pushed: false, phase: 'commit', reason: 'no-commit' }
        }
        // A hook may rewrite the document while committing. The caller includes
        // the revision it observed after the write; do not claim a different result.
        const current =
          expectedRevision === null
            ? await tryGit(root, ['cat-file', '-e', `HEAD:${path}`])
            : await tryGit(root, ['show', `HEAD:${path}`])
        const committedRevision = current.ok
          ? createHash('sha256').update(current.stdout).digest('hex')
          : null
        // Compare the requested revision to the worktree bytes as well: Git may
        // clean-filter those bytes (for example CRLF to LF) in the commit.
        const cleanWorktree =
          expectedRevision === null
            ? null
            : await tryGit(root, ['hash-object', '--path', path, path])
        const committedObject =
          expectedRevision === null ? null : await tryGit(root, ['rev-parse', `HEAD:${path}`])
        const normalizationOnly =
          cleanWorktree?.ok &&
          committedObject?.ok &&
          cleanWorktree.stdout.trim() === committedObject.stdout.trim()
        if (
          expectedRevision === null
            ? current.ok
            : committedRevision !== expectedRevision && !normalizationOnly
        ) {
          return {
            commitSha,
            pushed: false,
            phase: 'commit',
            reason: 'post-hook-mismatch',
            revision: committedRevision,
          }
        }
        const stillActive = deps.active()
        if (stillActive?.remote !== remote || stillActive.root !== root) {
          return {
            commitSha,
            pushed: false,
            phase: 'push',
            reason: 'vault-not-open',
            revision: committedRevision,
          }
        }
        await active.pushNow()
        const head = await tryGit(root, ['rev-parse', 'HEAD'])
        // Holi pushes to origin's default branch, or the current branch when
        // the remote is empty. A first push has no @{upstream} to inspect.
        const status = await openRepo(root).status()
        const target = status.defaultBranch ?? status.branch
        const origin = await tryGit(root, [
          'rev-parse',
          '--verify',
          `refs/remotes/origin/${target}`,
        ])
        if (
          head.ok &&
          origin.ok &&
          origin.stdout.trim() === head.stdout.trim() &&
          (head.stdout.trim() === commitSha ||
            (await tryGit(root, ['merge-base', '--is-ancestor', commitSha, head.stdout.trim()])).ok)
        ) {
          return {
            commitSha,
            pushed: true,
            phase: 'complete',
            reason: null,
            revision: committedRevision,
          }
        }
        return {
          commitSha,
          pushed: false,
          phase: 'push',
          reason: 'not-verified-on-origin',
          revision: committedRevision,
        }
      } catch (error) {
        return {
          commitSha,
          pushed: false,
          phase: commitSha === null ? 'commit' : 'push',
          reason: error instanceof Error ? error.message : 'commit-failed',
        }
      }
    },
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
    claimed: async () => false,
    settle: async () => ({
      commitSha: null,
      pushed: false,
      phase: 'commit',
      reason: 'vault-not-open',
    }),
  }
}
