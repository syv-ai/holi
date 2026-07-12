/**
 * Per-doc collab session: Y.Doc + HocuspocusProvider (room name = docId,
 * server-data PRD §Yjs persistence). Credentials come from main per
 * connection and live only in this closure (plan decision #1).
 */
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import type { SyncStatus } from '@holi/shared'

export interface DocSession {
  ydoc: Y.Doc
  text: Y.Text
  provider: HocuspocusProvider
  destroy(): void
}

export async function openDoc(docId: string, onStatus: (s: SyncStatus) => void): Promise<DocSession> {
  const auth = await window.holi.collabAuth()
  if (!auth) throw new Error('not signed in')
  const ydoc = new Y.Doc()
  onStatus('syncing')
  const provider = new HocuspocusProvider({
    url: auth.url,
    name: docId,
    token: auth.token,
    document: ydoc,
    onSynced: () => onStatus('synced'),
    onDisconnect: () => onStatus('offline'),
    onStatus: ({ status }) => {
      if (status === 'connecting') onStatus('syncing')
    },
  })
  return {
    ydoc,
    text: ydoc.getText(YDOC_TEXT_KEY),
    provider,
    destroy() {
      provider.destroy()
      ydoc.destroy()
    },
  }
}

/** Deterministic presence color per user (D20). */
export function presenceColor(userId: string): string {
  const palette = ['#f97316', '#22d3ee', '#a3e635', '#e879f9', '#facc15', '#38bdf8', '#fb7185', '#4ade80']
  let hash = 0
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return palette[Math.abs(hash) % palette.length]!
}
