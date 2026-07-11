import { TRPCError } from '@trpc/server'
import { PathSafetyError, vaultRelPath, type VaultRelPath } from '@holi/shared'
import type { Db } from './db/client'
import { folders } from './db/schema'

/** Parse a client path or throw BAD_REQUEST — the only path entry point. */
export function safePath(raw: string): VaultRelPath {
  try {
    return vaultRelPath(raw)
  } catch (err) {
    if (err instanceof PathSafetyError) throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
    throw err
  }
}

/** Ensure folder identity rows exist for every ancestor of `path` (documented
 * choice, Task 7). Accepts a transaction too — hence the Pick. */
export async function ensureAncestorFolders(
  db: Pick<Db, 'insert'>,
  vaultId: string,
  path: string,
): Promise<void> {
  const segments = path.split('/')
  for (let i = 1; i < segments.length; i++) {
    const folderPath = segments.slice(0, i).join('/')
    await db.insert(folders).values({ vaultId, path: folderPath }).onConflictDoNothing()
  }
}
