import { isInIgnoredDir, isLocalOnlyPath, vaultRelPath } from '@holi/shared'
import { runGit, type GitRepo } from '../git'
import { ownedCommitOids, repositoryIdentity } from '../managed-commit-provenance'
import { canonicalGitHubRemote } from '../mdx-trust'
import type { SubscriptionScope } from './subscriptions'

export type SubscriptionChange = {
  sha: string
  path: string
  ownership: 'own' | 'unknown'
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
    !(await stillCurrent()) ||
    afterOrigin !== origin ||
    JSON.stringify(afterIdentity) !== JSON.stringify(identity)
  )
    return { ...pending, tip, history: 'unavailable' as const }
  const safeChanges = history.changes.filter(({ path }) => {
    try {
      return vaultRelPath(path) === path && !isLocalOnlyPath(path) && !isInIgnoredDir(path)
    } catch {
      return false
    }
  })
  const ownership =
    args.accountId === null
      ? new Set<string>()
      : ownedCommitOids({
          file: args.provenanceFile,
          remote: args.remote,
          identity,
          accountId: args.accountId,
          oids: safeChanges.map(({ sha }) => sha),
        })
  const changes = safeChanges.map((change) => ({
    ...change,
    ownership: ownership.has(change.sha) ? ('own' as const) : ('unknown' as const),
    reviewed: false as const,
  }))
  return {
    baseline: args.baseline,
    tip,
    complete: history.complete,
    history: history.reason,
    changes,
  }
}
