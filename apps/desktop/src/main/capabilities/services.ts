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
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Collaborator, LineRange, RecentEntry } from '@holi/shared'
import { openRepo, tryGit, type GitRepo } from '../git'
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
    /** Settle current changes, calling verify after commits and before any push. */
    deliverNow(verify: () => Promise<boolean>): Promise<boolean>
    heldBack(): { path: string }[]
  } | null
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
  /** The lines selected in the focused note, or null for a caret or no note.
   *  Never the text: the agent reads it from the file. */
  selection: LineRange | null
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
    get: (remote) =>
      byRemote.get(remote) ?? { focusedPath: null, selection: null, openPaths: [], recents: [] },
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
      let committedRevision: string | null = null
      let postHookMismatch = false
      let waitFailure: 'vault-not-open' | 'sync-blocked' | 'oversized' | null = null
      try {
        const delivered = await active.deliverNow(async () => {
          const stillActive = deps.active()
          if (stillActive?.remote !== remote || stillActive.root !== root) {
            waitFailure = 'vault-not-open'
            return false
          }
          const afterWaitState = stillActive.syncState()
          if (
            afterWaitState.kind === 'conflict' ||
            afterWaitState.kind === 'reconciling' ||
            afterWaitState.kind === 'paused' ||
            afterWaitState.kind === 'pulling'
          ) {
            waitFailure = 'sync-blocked'
            return false
          }
          if (stillActive.heldBack().some((file) => file.path === path)) {
            waitFailure = 'oversized'
            return false
          }
          const head = await tryGit(root, ['rev-parse', 'HEAD'])
          commitSha = head.ok ? head.stdout.trim() : ''
          if (!commitSha) return false
          // A hook may rewrite the document while committing. Verify the
          // committed content before allowing deliverNow to push it.
          const current =
            expectedRevision === null
              ? await tryGit(root, ['cat-file', '-e', `HEAD:${path}`])
              : await tryGit(root, ['show', `HEAD:${path}`])
          committedRevision = current.ok
            ? createHash('sha256').update(current.stdout).digest('hex')
            : null
          const worktree =
            expectedRevision === null ? null : await readFile(join(root, path)).catch(() => null)
          const worktreeRevision =
            worktree === null ? null : createHash('sha256').update(worktree).digest('hex')
          const normalizedExpected =
            worktreeRevision === expectedRevision && expectedRevision !== null && worktree !== null
              ? Buffer.from(worktree.toString('binary').replace(/\r\n/g, '\n'), 'binary')
              : null
          const normalizationOnly =
            current.ok &&
            normalizedExpected !== null &&
            Buffer.from(current.stdout).equals(normalizedExpected)
          postHookMismatch =
            expectedRevision === null
              ? current.ok
              : (committedRevision !== expectedRevision || worktreeRevision !== expectedRevision) &&
                !normalizationOnly
          return !postHookMismatch
        })
        if (postHookMismatch) {
          return {
            commitSha: commitSha || null,
            pushed: false,
            phase: 'commit',
            reason: 'post-hook-mismatch',
            revision: committedRevision,
          }
        }
        if (!delivered || !commitSha) {
          const afterWait = deps.active()
          const reason =
            waitFailure ??
            (afterWait?.remote !== remote || afterWait.root !== root
              ? 'vault-not-open'
              : (() => {
                  const afterWaitState = afterWait.syncState()
                  if (
                    afterWaitState.kind === 'conflict' ||
                    afterWaitState.kind === 'reconciling' ||
                    afterWaitState.kind === 'paused' ||
                    afterWaitState.kind === 'pulling'
                  ) {
                    return 'sync-blocked'
                  }
                  return afterWait.heldBack().some((file) => file.path === path)
                    ? 'oversized'
                    : null
                })())
          return {
            commitSha: null,
            pushed: false,
            phase: 'commit',
            reason: reason ?? 'no-commit',
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
        const final =
          expectedRevision === null
            ? await tryGit(root, ['cat-file', '-e', `HEAD:${path}`])
            : await tryGit(root, ['show', `HEAD:${path}`])
        const finalRevision = final.ok
          ? createHash('sha256').update(final.stdout).digest('hex')
          : null
        const finalWorktree = await readFile(join(root, path)).catch(() => null)
        const finalWorktreeRevision =
          finalWorktree === null ? null : createHash('sha256').update(finalWorktree).digest('hex')
        if (
          head.ok &&
          origin.ok &&
          origin.stdout.trim() === head.stdout.trim() &&
          (head.stdout.trim() === commitSha ||
            (await tryGit(root, ['merge-base', '--is-ancestor', commitSha, head.stdout.trim()]))
              .ok) &&
          finalRevision === committedRevision &&
          finalWorktreeRevision === expectedRevision
        ) {
          return {
            commitSha: head.stdout.trim(),
            pushed: true,
            phase: 'complete',
            reason: null,
            revision: expectedRevision,
          }
        }
        return {
          commitSha,
          pushed: false,
          phase: 'push',
          reason: 'not-verified-on-origin',
          revision: expectedRevision,
        }
      } catch (error) {
        return {
          commitSha,
          pushed: false,
          phase: commitSha === null ? 'commit' : 'push',
          reason: error instanceof Error ? error.message : 'commit-failed',
          revision: expectedRevision,
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
    settle: async () => ({
      commitSha: null,
      pushed: false,
      phase: 'commit',
      reason: 'vault-not-open',
    }),
  }
}
