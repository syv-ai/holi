import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import type { Db } from '../db/client'
import type { GetLiveDoc } from '../trpc'
import { docFromState, loadDocState, storeDocState } from './doc-store'

/**
 * Apply `edit` to the doc's text inside one Y transaction and persist the new
 * state. If a live Hocuspocus room is open, ops go through the live doc so
 * connected editors receive them over the normal relay path; otherwise the
 * stored state is loaded, edited, and written back.
 * Returns the pre-edit state (for snapshots), the post-edit state, and the
 * post-edit text (for link_index refresh).
 */
export async function editDocText(
  db: Db,
  getLiveDoc: GetLiveDoc,
  docId: string,
  edit: (text: Y.Text) => void,
): Promise<{ before: Uint8Array; after: Uint8Array; text: string }> {
  const live = getLiveDoc(docId)
  const ydoc = live ?? docFromState(await loadDocState(db, docId))
  const before = Y.encodeStateAsUpdate(ydoc)
  ydoc.transact(() => edit(ydoc.getText(YDOC_TEXT_KEY)))
  const after = Y.encodeStateAsUpdate(ydoc)
  await storeDocState(db, docId, after)
  return { before, after, text: ydoc.getText(YDOC_TEXT_KEY).toString() }
}

/** Replace the entire text content (restore) as normal delete+insert ops. */
export function replaceAllText(text: Y.Text, next: string): void {
  text.delete(0, text.length)
  text.insert(0, next)
}
