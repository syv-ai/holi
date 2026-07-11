import { eq } from 'drizzle-orm'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import type { Db } from '../db/client'
import { docs, yjsDocs } from '../db/schema'

export async function loadDocState(db: Db, docId: string): Promise<Uint8Array | null> {
  const [row] = await db.select({ state: yjsDocs.state }).from(yjsDocs).where(eq(yjsDocs.docId, docId))
  return row?.state ?? null
}

/** Upsert the merged state and bump docs.updated_at. */
export async function storeDocState(db: Db, docId: string, state: Uint8Array): Promise<void> {
  const now = new Date()
  await db
    .insert(yjsDocs)
    .values({ docId, state, updatedAt: now })
    .onConflictDoUpdate({ target: yjsDocs.docId, set: { state, updatedAt: now } })
  await db.update(docs).set({ updatedAt: now }).where(eq(docs.id, docId))
}

export function docFromState(state: Uint8Array | null): Y.Doc {
  const ydoc = new Y.Doc()
  if (state && state.length > 0) Y.applyUpdate(ydoc, state)
  return ydoc
}

export function docText(ydoc: Y.Doc): string {
  return ydoc.getText(YDOC_TEXT_KEY).toString()
}
