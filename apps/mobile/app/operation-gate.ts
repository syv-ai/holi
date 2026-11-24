import type { NativeFiles } from './native-files'
import { recoverMoves } from './storage-move'
import {
  vaultRelPath,
  isSecretPath,
  isInIgnoredDir,
  shownPathOrNull,
  type VaultRelPath,
} from '@holi/shared/mobile-path-safety'
import type { StorageCheckpointCallback } from './native-files'

export function validateStoragePath(raw: string): VaultRelPath {
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

const queues = new Map<string, Promise<void>>()

function enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(work, work)
  const tail = next.then(
    () => {},
    () => {},
  )
  queues.set(key, tail)
  return next.finally(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
}

/** Serializes all work on the same canonical checkout and recovers interrupted moves first. */
export async function withVaultOperation<T>(
  adapter: NativeFiles,
  root: string,
  work: (canonicalRoot: string) => Promise<T>,
  checkpoint?: StorageCheckpointCallback,
): Promise<T> {
  const canonicalRoot = await adapter.canonicalRoot(root)
  return enqueue(canonicalRoot, async () => {
    await recoverMoves(adapter, canonicalRoot, validateStoragePath, checkpoint)
    return work(canonicalRoot)
  })
}
