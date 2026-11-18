import {
  IGNORED_DIRS,
  isInIgnoredDir,
  isLocalOnlyPath,
  isRemote,
  isSecretPath,
  shownPathOrNull,
  vaultRelPath,
  type VaultRelPath,
} from '@holi/shared/mobile-path-safety'
import type { NativeFiles, StorageCheckpointCallback } from './native-files'
import { moveNote, recoverMoves } from './storage-move'

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

export type Revision = string
export type StoredDocument = { path: VaultRelPath; bytes: Uint8Array; revision: Revision }

const locks = new Map<string, Promise<void>>()
function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(work, work)
  const tail = next.then(
    () => {},
    () => {},
  )
  locks.set(key, tail)
  return next.finally(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
}

function validatePath(raw: string): VaultRelPath {
  const path = vaultRelPath(raw)
  if (
    isSecretPath(path) ||
    isInIgnoredDir(path) ||
    path.split('/').some((part) => part.startsWith('.holi-storage-')) ||
    !shownPathOrNull(path)
  ) {
    throw new Error('Path is not available to vault storage')
  }
  return path
}
function revision(bytes: Uint8Array): Revision {
  // The token encodes the full content, so even a hash collision cannot admit stale bytes.
  let encoded = `${bytes.length}:`
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, '0')
  return encoded
}

/** Byte-preserving vault note storage. Revisions are checked under a per-root lock. */
export function createVaultStorage(
  adapter: NativeFiles,
  vault: { remote: string; root: string },
  options: { checkpoint?: StorageCheckpointCallback } = {},
) {
  if (!isRemote(vault.remote)) throw new Error('Invalid vault identity')
  let canonical: Promise<string> | undefined
  const rootPath = () => (canonical ??= adapter.canonicalRoot(vault.root))
  const serialize = <T>(work: (root: string) => Promise<T>) =>
    rootPath().then((resolved) =>
      locked(resolved, async () => {
        await recoverMoves(adapter, resolved, validatePath, options.checkpoint)
        return work(resolved)
      }),
    )

  return {
    async list(): Promise<VaultRelPath[]> {
      return serialize(async (resolved) => {
        const entries = await adapter.list(resolved)
        return entries
          .filter(({ path, kind }) => {
            if (kind !== 'file') return false
            const safe = shownPathOrNull(path)
            return Boolean(
              safe &&
              !isSecretPath(path) &&
              !isLocalOnlyPath(path) &&
              !isInIgnoredDir(path) &&
              !IGNORED_DIRS.has(path) &&
              !path.split('/').some((part) => part.startsWith('.holi-storage-')),
            )
          })
          .map(({ path }) => vaultRelPath(path))
          .sort()
      })
    },
    async read(rawPath: string): Promise<StoredDocument> {
      const path = validatePath(rawPath)
      return serialize(async (resolved) => {
        const bytes = await adapter.read(resolved, path)
        return { path, bytes, revision: revision(bytes) }
      })
    },
    async create(rawPath: string, bytes: Uint8Array): Promise<StoredDocument> {
      const path = validatePath(rawPath)
      return serialize(async (resolved) => {
        await adapter.create(resolved, path, bytes)
        const saved = await adapter.read(resolved, path)
        return { path, bytes: saved, revision: revision(saved) }
      })
    },
    async move(
      rawFrom: string,
      rawTo: string,
      expectedRevision: Revision,
    ): Promise<StoredDocument> {
      const from = validatePath(rawFrom)
      const to = validatePath(rawTo)
      if (isLocalOnlyPath(from) || isLocalOnlyPath(to))
        throw new Error('Move note path is not public')
      return serialize(async (resolved) => {
        const moved = await moveNote(
          adapter,
          resolved,
          from,
          to,
          expectedRevision,
          validatePath,
          revision,
          options.checkpoint,
        )
        return { ...moved, path: to }
      })
    },
    async save(
      rawPath: string,
      bytes: Uint8Array,
      expectedRevision: Revision,
    ): Promise<StoredDocument> {
      const path = validatePath(rawPath)
      return serialize(async (resolved) => {
        const current = await adapter.read(resolved, path)
        if (revision(current) !== expectedRevision) throw new Error('Stale document revision')
        await adapter.publish(resolved, path, bytes, current)
        const saved = await adapter.read(resolved, path)
        if (!equalBytes(saved, bytes)) throw new Error('Published bytes did not verify')
        return { path, bytes: saved, revision: revision(saved) }
      })
    },
  }
}
