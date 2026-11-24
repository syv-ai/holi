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
import { withVaultLock } from './vault-lock'

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

/** Serializes all work on the same canonical checkout and recovers interrupted moves first. */
export async function withVaultOperation<T>(
  adapter: NativeFiles,
  root: string,
  work: (canonicalRoot: string) => Promise<T>,
  checkpoint?: StorageCheckpointCallback,
): Promise<T> {
  const canonicalRoot = await adapter.canonicalRoot(root)
  return withVaultLock(canonicalRoot, async () => {
    await recoverMoves(adapter, canonicalRoot, validateStoragePath, checkpoint)
    return work(canonicalRoot)
  })
}
