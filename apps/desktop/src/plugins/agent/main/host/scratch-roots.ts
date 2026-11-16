import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { VaultRef } from '../provider'

/** Private scratch roots owned by one canonical vault context. */
export async function agentScratchRoots(
  userData: string,
  vault: VaultRef,
): Promise<{ jobs: string; fenced: string }> {
  const root = await realpath(resolve(vault.root))
  const identity = JSON.stringify([vault.remote.toLowerCase(), root])
  const key = createHash('sha256').update(identity).digest('hex')
  const ownerRoot = join(resolve(userData), 'agent-scratch', key)
  await mkdir(ownerRoot, { recursive: true, mode: 0o700 })
  return {
    jobs: join(ownerRoot, 'jobs'),
    fenced: join(ownerRoot, 'fenced'),
  }
}
