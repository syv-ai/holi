import { eq } from 'drizzle-orm'
import { parseWikiLinks } from '@holi/shared'
import type { Db } from '../db/client'
import { linkIndex } from '../db/schema'

/** Rebuild this doc's link_index rows from its current text (PRD §link_index). */
export async function refreshLinkIndex(
  db: Db,
  vaultId: string,
  srcDocId: string,
  text: string,
): Promise<void> {
  const counts = new Map<string, number>()
  for (const link of parseWikiLinks(text)) {
    if (link.kind !== 'note') continue
    counts.set(link.target, (counts.get(link.target) ?? 0) + 1)
  }
  await db.transaction(async (tx) => {
    await tx.delete(linkIndex).where(eq(linkIndex.srcDocId, srcDocId))
    if (counts.size > 0) {
      await tx.insert(linkIndex).values(
        [...counts].map(([targetPath, occurrences]) => ({ vaultId, srcDocId, targetPath, occurrences })),
      )
    }
  })
}
