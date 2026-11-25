import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isLocalOnlyPath, isSecretPath, isInIgnoredDir, isRemote, vaultRelPath } from '@holi/shared'
import { isNonContentPath } from './vault-files'
import { exactPath } from '@holi/shared/path-safety-node'
import { repositoryPublicationSnapshot } from '../managed-commit-provenance'
import { canonicalGitHubRemote } from '../mdx-trust'
import type { GitRepo } from '../git'
import type { SubscriptionScope } from './subscriptions'

type Receipt = {
  remote: string
  root: string
  path: string
  revision: string
  scope: string
  valid: () => boolean
}

/** Captures committed text and issues short-lived, single-use proof for explicit subscriptions. */
export function createSubscriptionReceipts() {
  const receipts = new Map<string, Receipt>()
  return {
    async capture(args: {
      repo: GitRepo
      root: string
      remote: string
      path: string
      scope: SubscriptionScope | null
      valid: () => boolean
    }): Promise<{ text: string; receipt: string | null }> {
      const { path, scope } = args
      let remote: string
      try {
        remote = canonicalGitHubRemote(args.remote)
      } catch {
        throw new Error('This vault cannot issue subscription proof.')
      }
      const capturedIdentity = repositoryPublicationSnapshot(args.root)
      const valid = () => {
        try {
          const current = repositoryPublicationSnapshot(args.root)
          return (
            args.valid() &&
            capturedIdentity !== null &&
            capturedIdentity.remote === remote &&
            current !== null &&
            current.remote === remote &&
            JSON.stringify(current) === JSON.stringify(capturedIdentity)
          )
        } catch {
          return false
        }
      }
      if (
        !isRemote(args.remote) ||
        vaultRelPath(path) !== path ||
        isInIgnoredDir(path) ||
        isLocalOnlyPath(path) ||
        isSecretPath(path) ||
        isNonContentPath(path)
      )
        throw new Error('This path cannot be displayed as subscribed content.')
      const resolved = await exactPath(args.root, path)
      if (resolved === null) throw new Error('The subscribed file does not exist.')
      const text = await readFile(resolved, 'utf8')
      if (!valid()) return { text, receipt: null }
      if (!scope || scope.baseline === null) return { text, receipt: null }
      let head
      try {
        head = await args.repo.historicalHead()
      } catch {
        return { text, receipt: null }
      }
      if (!valid() || head.kind !== 'commit') return { text, receipt: null }
      try {
        if (!(await args.repo.isAncestor(scope.baseline, head.sha))) return { text, receipt: null }
        const committed = await args.repo.readReceiptText(head.sha, path)
        if (committed !== text || !valid()) return { text, receipt: null }
        const token = randomBytes(24).toString('base64url')
        if (receipts.size >= 512) receipts.delete(receipts.keys().next().value!)
        receipts.set(token, {
          remote,
          root: args.root,
          path,
          revision: head.sha,
          scope: JSON.stringify(scope),
          valid,
        })
        return { text, receipt: token }
      } catch {
        return { text, receipt: null }
      }
    },
    consume(
      token: string,
      expected: Omit<Receipt, 'revision' | 'valid'>,
    ): { revision: string; valid: () => boolean } | null {
      const saved = receipts.get(token)
      receipts.delete(token)
      let remote: string
      try {
        remote = canonicalGitHubRemote(expected.remote)
      } catch {
        return null
      }
      return saved &&
        saved.remote === remote &&
        saved.root === expected.root &&
        saved.path === expected.path &&
        saved.scope === expected.scope &&
        saved.valid()
        ? { revision: saved.revision, valid: saved.valid }
        : null
    },
  }
}
