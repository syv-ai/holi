import {
  isInIgnoredDir,
  isLocalOnlyPath,
  isRemote,
  isSecretPath,
  shownPathOrNull,
  vaultRelPath,
  type VaultRelPath,
} from '@holi/shared/mobile-path-safety'
import { withVaultLock } from './vault-lock'

export type WorkingCopyChange = {
  path: VaultRelPath
  staged: boolean
  worktree: boolean
  conflict: boolean
  /** Opaque native status bits, normalized into the three flags above. */
}

export type WorkingCopyStatus = {
  changes: WorkingCopyChange[]
}

/** Native adapter exposes semantic identity and status, never libgit2 constants. */
export interface NativeWorkingCopy {
  canonicalRoot(root: string): Promise<string>
  identity(root: string): Promise<{ remotes: string[]; branch: string | null; attached: boolean }>
  /** Metadata only: must not read or hash working-tree file contents. */
  candidates(root: string): Promise<Array<{ path: string }>>
  /** Inspect an authorized path (e.g. detect symlink escape) without running hooks or filters. */
  authorize(root: string, path: VaultRelPath): Promise<boolean>
  hasPendingRecovery(root: string): Promise<boolean>
  status(
    root: string,
    paths: VaultRelPath[],
  ): Promise<Array<{ path: string; staged: boolean; worktree: boolean; conflict: boolean }>>
}

function safePath(raw: string): VaultRelPath | null {
  const shown = shownPathOrNull(raw)
  if (!shown) return null
  const path = vaultRelPath(shown)
  if (isSecretPath(path) || isLocalOnlyPath(path) || isInIgnoredDir(path)) return null
  return path
}

/** Read-only status for an already-attached managed clone. Never performs storage recovery. */
export function createWorkingCopy(
  native: NativeWorkingCopy,
  vault: {
    remote: string
    root: string
    branch: string
  },
) {
  if (!isRemote(vault.remote)) throw new Error('Invalid vault identity')
  let canonical: Promise<string> | undefined
  const rootPath = () => (canonical ??= native.canonicalRoot(vault.root))

  return {
    async status(): Promise<WorkingCopyStatus> {
      const root = await rootPath()
      return withVaultLock(root, async () => {
        if (await native.hasPendingRecovery(root)) throw new Error('Vault recovery is pending')
        const identity = await native.identity(root)
        if (
          !identity.attached ||
          identity.branch !== vault.branch ||
          !identity.remotes.includes(vault.remote)
        )
          throw new Error('Working copy identity does not match vault')
        const candidates = await native.candidates(root)
        const authorized: VaultRelPath[] = []
        for (const candidate of candidates) {
          const path = safePath(candidate.path)
          if (path && (await native.authorize(root, path))) authorized.push(path)
        }
        const changes = await native.status(root, authorized)
        return {
          changes: changes
            .map((change) => ({ ...change, path: safePath(change.path) }))
            .filter((change): change is WorkingCopyChange => change.path !== null)
            .sort((left, right) => left.path.localeCompare(right.path)),
        }
      })
    },
  }
}
