import { isLocalOnlyPath, isSecretPath, vaultRelPath } from '@holi/shared'
import { exactPath, exactPathSync } from '@holi/shared/path-safety-node'
import { isNonContentPath } from './vault-files'
import { ownedCommitOids, repositoryPublicationSnapshot } from '../managed-commit-provenance'
import { canonicalGitHubRemote } from '../mdx-trust'
import type { GitRepo } from '../git'
import type { SubscriptionScope } from './subscriptions'

interface SubscriptionChange {
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
  if (args.baseline === null) return pending
  let remote: string
  try {
    remote = canonicalGitHubRemote(args.remote)
  } catch {
    return { ...pending, history: 'unavailable' as const }
  }
  const scopeMatches = (scope: SubscriptionScope | null) =>
    scope !== null && scope.path === args.path && scope.baseline === args.baseline
  const currentScope = await args.currentScope().catch(() => null)
  if (!args.current() || !scopeMatches(currentScope))
    return { ...pending, history: 'unavailable' as const }

  const initial = repositoryPublicationSnapshot(args.root)
  if (initial === null || initial.remote !== remote)
    return { ...pending, history: 'unavailable' as const }

  let tip: string | null = null
  try {
    const captured = await args.repo.historicalHead()
    if (captured.kind === 'unborn') return pending
    if (captured.kind !== 'commit') return { ...pending, history: 'unavailable' as const }
    tip = captured.sha
  } catch {
    return { ...pending, history: 'unavailable' as const }
  }
  let history: Awaited<ReturnType<GitRepo['revisionChanges']>>
  try {
    history = await args.repo.revisionChanges(args.baseline, tip, args.path)
  } catch {
    return { ...pending, tip, history: 'unavailable' as const }
  }
  const safeChanges: typeof history.changes = []
  for (const change of history.changes) {
    const { path } = change
    try {
      if (
        vaultRelPath(path) !== path ||
        isLocalOnlyPath(path) ||
        isSecretPath(path) ||
        isNonContentPath(path)
      )
        continue
      // exactPath rejects an existing symlink/case alias, while still allowing
      // deleted historical paths through the closest existing ancestor.
      if ((await exactPath(args.root, path)) !== null) safeChanges.push(change)
    } catch {
      // Invalid historical names are not emitted.
    }
  }

  // The last async observation is the saved scope. Everything after it is
  // synchronous, including provenance reads and the repository publication guard.
  const finalScope = await args.currentScope().catch(() => null)
  // Revalidate exact paths after the final await; this synchronous publication
  // segment has no opportunity for a symlink/case alias swap between check and return.
  const publishableChanges = safeChanges.filter(
    ({ path }) => exactPathSync(args.root, path) !== null,
  )
  const final = repositoryPublicationSnapshot(args.root)
  const ownership =
    args.accountId === null || final?.lifetime === null || final === null
      ? new Set<string>()
      : ownedCommitOids({
          file: args.provenanceFile,
          remote,
          identity: final,
          accountId: args.accountId,
          oids: publishableChanges.map(({ sha }) => sha),
        })
  if (
    !args.current() ||
    !scopeMatches(finalScope) ||
    final === null ||
    final.remote !== remote ||
    final.root !== initial.root ||
    final.gitDir !== initial.gitDir ||
    final.device !== initial.device ||
    final.inode !== initial.inode ||
    final.marker !== initial.marker
  )
    return { ...pending, tip, history: 'unavailable' as const }

  const changes = publishableChanges
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
