/**
 * Batch copy: each source read and written to its destination verbatim. NO link
 * rewrite — a copy's `[[links]]` keep pointing where the original's did, matching
 * VS Code and the spec (§Cut/Copy/Paste). Callers refuse clobbers before calling
 * (the router checks each `to`), so this is pure read-and-write.
 */
import { readFile } from 'node:fs/promises'
import { vaultRelPath } from '@holi/shared'
import { absPathFor, writeAtomic } from './vault-files'

export async function copyNotes(
  root: string,
  copies: { from: string; to: string }[],
): Promise<void> {
  for (const c of copies) {
    const text = await readFile(absPathFor(root, vaultRelPath(c.from)), 'utf8')
    await writeAtomic(root, vaultRelPath(c.to), text)
  }
}
