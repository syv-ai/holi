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
import { withVaultOperation } from './operation-gate'
import type { NativeFiles } from './native-files'

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
export type PreparedWorkingCopyTree = {
  treeOID: string
  parentOID: string
  branch: string
  unchanged: boolean
}

export interface NativeTreePreparation {
  prepareWorkingCopyTree(
    root: string,
    remote: string,
    branch: string,
    paths: VaultRelPath[],
  ): Promise<PreparedWorkingCopyTree>
}

export interface NativeWorkingCopy {
  recoveryPending(root: string): Promise<boolean>
  canonicalRoot(root: string): Promise<string>
  identity(root: string): Promise<{ remotes: string[]; branch: string | null; attached: boolean }>
  /** Metadata only: must not read or hash working-tree file contents. */
  candidates(root: string): Promise<Array<{ path: string }>>
  /** Inspect an authorized path (e.g. detect symlink escape) without running hooks or filters. */
  authorize(root: string, path: VaultRelPath): Promise<boolean>
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

/** Prepare a complete native tree after storage recovery, refusing ambiguous or unsafe candidates. */
export async function prepareWorkingCopyTree(
  files: NativeFiles,
  native: NativeWorkingCopy & NativeTreePreparation,
  vault: { remote: string; root: string; branch: string },
): Promise<PreparedWorkingCopyTree> {
  if (!isRemote(vault.remote) || !vault.branch) throw new Error('Invalid vault identity')
  return withVaultOperation(files, vault.root, async (root) => {
    const identity = await native.identity(root)
    if (
      !identity.attached ||
      identity.branch !== vault.branch ||
      !identity.remotes.includes(vault.remote)
    )
      throw new Error('Working copy identity does not match vault')
    const candidates = await native.candidates(root)
    const unique = new Map<string, VaultRelPath>()
    const aliases = new Set<string>()
    for (const candidate of candidates) {
      const path = safePath(candidate.path)
      if (!path || !safePath(candidate.path.normalize('NFC').toLocaleLowerCase('en-US'))) continue
      const key = path.normalize('NFC').toLocaleLowerCase('en-US')
      if (aliases.has(key)) throw new Error('Ambiguous working copy paths')
      aliases.add(key)
      unique.set(path, path)
    }
    const paths = [...unique.values()].sort()
    for (const path of paths) {
      if (!(await native.authorize(root, path))) throw new Error('Unsafe working copy path')
    }
    const result = await native.prepareWorkingCopyTree(root, vault.remote, vault.branch, paths)
    if (
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(result.treeOID) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(result.parentOID) ||
      result.branch !== vault.branch ||
      typeof result.unchanged !== 'boolean'
    )
      throw new Error('Native Git returned an invalid working-copy tree')
    return result
  })
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
        if (await native.recoveryPending(root)) throw new Error('Vault recovery is pending')
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
            .filter((change) => authorized.includes(change.path as VaultRelPath))
            .filter((change): change is WorkingCopyChange => change.path !== null)
            .sort((left, right) => left.path.localeCompare(right.path)),
        }
      })
    },
  }
}
