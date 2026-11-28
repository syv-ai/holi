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

export type ManagedWorkingCopyIdentity = {
  remote: string
  branch: string
  nativeId: string
  /** Private recovery locations retained after interrupted acquisitions. */
  retainedAcquisitions?: string[]
}

export type WorkingCopyRefusal = { code: string; message: string }

/** Semantic native transport seam: implementations own safe preparation and durable identity checks. */
export interface ManagedWorkingCopyNative extends NativeWorkingCopy {
  /** Runs recoverMoves directly while the caller holds the canonical-root lock. */
  recover(
    root: string,
    expected: { remote: string; branch: string; nativeId?: string },
  ): Promise<void>
  prepare(
    root: string,
    remote: string,
    branch: string,
    credential: string,
  ): Promise<ManagedWorkingCopyIdentity>
  reopen(root: string): Promise<ManagedWorkingCopyIdentity>
  fetch(
    root: string,
    identity: ManagedWorkingCopyIdentity,
    credential: string,
  ): Promise<void | WorkingCopyRefusal>
  publish(
    root: string,
    identity: ManagedWorkingCopyIdentity,
    credential: string,
  ): Promise<void | WorkingCopyRefusal>
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
    policy: (rawPath: string) => number,
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
  native: Pick<NativeWorkingCopy, 'identity'> & NativeTreePreparation,
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
    const policy = (raw: string): number => {
      try {
        const path = vaultRelPath(raw)
        if (path !== raw) return -1
        const folded = vaultRelPath(raw.normalize('NFC').toLocaleLowerCase('en-US'))
        if (
          isSecretPath(path) ||
          isLocalOnlyPath(path) ||
          isInIgnoredDir(path) ||
          isSecretPath(folded) ||
          isLocalOnlyPath(folded) ||
          isInIgnoredDir(folded) ||
          path.split('/').some((part) => /^\.holi-storage-/i.test(part))
        )
          return 0
        return 1
      } catch {
        return -1
      }
    }
    const result = await native.prepareWorkingCopyTree(root, vault.remote, vault.branch, policy)
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

function isValidBranch(branch: string): boolean {
  if (
    !branch ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    [...branch].some(
      (character) =>
        character.charCodeAt(0) <= 32 ||
        character.charCodeAt(0) === 127 ||
        character.charCodeAt(0) === 92 ||
        '~^:?*['.includes(character),
    )
  )
    return false
  return branch
    .split('/')
    .every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        !part.startsWith('.') &&
        !part.endsWith('.lock'),
    )
}

/** Acquires or reopens a managed clone and offers credential-scoped network operations. */
export function createManagedWorkingCopy(
  native: ManagedWorkingCopyNative,
  vault: { remote: string; root: string; branch: string },
  credential: string,
) {
  const { remote, root, branch } = vault
  if (!isRemote(remote) || !isValidBranch(branch) || !credential)
    throw new Error('Invalid working copy request')
  let canonical: Promise<string> | undefined
  let acquiredNativeId: string | undefined
  const rootPath = () =>
    (canonical ??= native.canonicalRoot(root).catch((error: unknown) => {
      canonical = undefined
      throw error
    }))
  const recover = async (canonicalRoot: string) =>
    native.recover(canonicalRoot, { remote, branch, nativeId: acquiredNativeId })
  const assertIdentity = (identity: ManagedWorkingCopyIdentity) => {
    if (
      !identity ||
      typeof identity.nativeId !== 'string' ||
      !identity.nativeId ||
      identity.remote !== remote ||
      identity.branch !== branch ||
      (acquiredNativeId !== undefined && acquiredNativeId !== identity.nativeId)
    )
      throw new Error('Working copy identity does not match vault')
    acquiredNativeId ??= identity.nativeId
  }
  const operate = async (action: 'fetch' | 'publish') => {
    const root = await rootPath()
    return withVaultLock(root, async () => {
      await recover(root)
      const identity = await native.reopen(root)
      assertIdentity(identity)
      const result = await native[action](root, identity, credential)
      if (result) throw Object.assign(new Error(result.message), { refusal: result })
    })
  }
  return {
    async acquire() {
      const root = await rootPath()
      return withVaultLock(root, async () => {
        await recover(root)
        const identity = await native.prepare(root, remote, branch, credential)
        assertIdentity(identity)
        return identity
      })
    },
    async reopen() {
      const root = await rootPath()
      return withVaultLock(root, async () => {
        await recover(root)
        const identity = await native.reopen(root)
        assertIdentity(identity)
        return identity
      })
    },
    fetch: () => operate('fetch'),
    publish: () => operate('publish'),
  }
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
