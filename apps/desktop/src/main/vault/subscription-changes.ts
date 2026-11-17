import { isInIgnoredDir, isLocalOnlyPath, isSecretPath, vaultRelPath } from '@holi/shared'
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runGit, type GitRepo } from '../git'
import { ownedCommitOids, repositoryIdentity } from '../managed-commit-provenance'
import { canonicalGitHubRemote } from '../mdx-trust'
import type { SubscriptionScope } from './subscriptions'

export type SubscriptionChange = {
  sha: string
  path: string
  ownership: 'unknown'
  reviewed: false
}

export async function subscriptionChanges(args: {
  repo: GitRepo
  root: string
  remote: string
  baseline: SubscriptionScope['baseline']
  path: string
  provenanceFile: string
  accountId: number | null
  current: () => boolean
  currentScope: () => Promise<SubscriptionScope | null>
}) {
  const pending = {
    baseline: args.baseline,
    tip: null as string | null,
    complete: false,
    history: 'pending-baseline' as const,
    changes: [] as SubscriptionChange[],
  }
  const stillCurrent = async () => {
    if (!args.current()) return false
    const scope = await args.currentScope().catch(() => null)
    return (
      scope !== null &&
      scope.path === args.path &&
      scope.baseline === args.baseline &&
      args.current()
    )
  }
  if (args.baseline === null) return pending
  if (!(await stillCurrent())) return { ...pending, history: 'unavailable' as const }
  let tip: string | null
  try {
    tip = await args.repo.head()
  } catch {
    return { ...pending, history: 'unavailable' as const }
  }
  if (tip === null) return { ...pending, history: 'pending-baseline' as const }
  const identity = await repositoryIdentity(args.root, { createLifetime: false }).catch(() => null)
  let origin = ''
  try {
    origin = canonicalGitHubRemote(
      await runGit(args.root, ['--no-replace-objects', 'remote', 'get-url', 'origin'], {
        executionBudget: { maxBuffer: 65536, timeout: 1000 },
      }),
    )
  } catch {
    return { ...pending, tip, history: 'unavailable' as const }
  }
  if (!identity || origin !== args.remote)
    return { ...pending, tip, history: 'unavailable' as const }
  const history = await args.repo.revisionChanges(args.baseline, tip, args.path)
  const safeChanges: typeof history.changes = []
  for (const change of history.changes) {
    const { path } = change
    try {
      if (
        vaultRelPath(path) !== path ||
        isLocalOnlyPath(path) ||
        isSecretPath(path) ||
        isInIgnoredDir(path)
      )
        continue
      // Current symlinks can expose an outside target even though history
      // returns only the link's name. Walk each existing component without
      // following links; deleted paths remain eligible for historical review.
      const parts = path.split('/')
      let cursor = args.root
      let unsafe = false
      for (const part of parts) {
        cursor = resolve(cursor, part)
        try {
          if ((await lstat(cursor)).isSymbolicLink()) {
            unsafe = true
            break
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
          unsafe = true
          break
        }
      }
      if (!unsafe) safeChanges.push(change)
    } catch {
      // Invalid historical names are not emitted.
    }
  }
  const ownership =
    args.accountId === null || identity.lifetime === null
      ? new Set<string>()
      : ownedCommitOids({
          file: args.provenanceFile,
          remote: args.remote,
          identity,
          accountId: args.accountId,
          oids: safeChanges.map(({ sha }) => sha),
        })
  // Revalidate the exact repository and origin after every traversal await,
  // including path lstat checks, before any suppression can be returned.
  const afterIdentity = await repositoryIdentity(args.root, { createLifetime: false }).catch(
    () => null,
  )
  let afterOrigin = ''
  try {
    afterOrigin = canonicalGitHubRemote(
      await runGit(args.root, ['--no-replace-objects', 'remote', 'get-url', 'origin'], {
        executionBudget: { maxBuffer: 65536, timeout: 1000 },
      }),
    )
  } catch {
    return { ...pending, tip, history: 'unavailable' as const }
  }
  if (
    afterOrigin !== origin ||
    JSON.stringify(afterIdentity) !== JSON.stringify(identity) ||
    !(await stillCurrent()) ||
    !args.current()
  )
    return { ...pending, tip, history: 'unavailable' as const }
  const changes = safeChanges
    .filter((change) => !ownership.has(change.sha))
    .map((change) => ({ ...change, ownership: 'unknown' as const, reviewed: false as const }))
  return {
    baseline: args.baseline,
    tip,
    complete: history.complete,
    history: history.reason,
    changes,
  }
}
