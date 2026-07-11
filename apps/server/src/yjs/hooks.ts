/**
 * Hocuspocus persistence + authz hooks (PRD §Yjs persistence). Room name =
 * docId. onAuthenticate uses the SAME membership resolution as tRPC — the
 * single chokepoint. Members and owners get read-write; non-members are
 * rejected; role rides in the connection context (D7/D20).
 */
import * as Y from 'yjs'
import type { Role } from '@holi/shared'
import { eq } from 'drizzle-orm'
import { resolveVaultRole } from '../auth/membership'
import { resolveSession } from '../auth/sessions'
import type { Bus } from '../bus'
import type { Db } from '../db/client'
import { docs } from '../db/schema'
import { docFromState, docText, loadDocState, storeDocState } from './doc-store'
import { refreshLinkIndex } from './link-index'
import { maybeIntervalSnapshot } from './snapshots'

export interface ConnectionContext {
  userId: string
  role: Role
  vaultId: string
}

export function makeHooks(deps: { db: Db; bus: Bus }) {
  const { db } = deps

  async function docRow(documentName: string) {
    if (!/^[0-9a-f-]{36}$/.test(documentName)) return null
    const [row] = await db.select().from(docs).where(eq(docs.id, documentName))
    return row ?? null
  }

  return {
    async onAuthenticate({ token, documentName }: { token: string; documentName: string }): Promise<ConnectionContext> {
      const user = await resolveSession(db, token)
      if (!user) throw new Error('invalid session')
      const row = await docRow(documentName)
      if (!row) throw new Error('unknown document')
      const role = await resolveVaultRole(db, row.vaultId, user.id)
      if (!role) throw new Error('not a vault member')
      return { userId: user.id, role, vaultId: row.vaultId }
    },

    async onLoadDocument({ documentName, document }: { documentName: string; document: Y.Doc }): Promise<Y.Doc> {
      const state = await loadDocState(db, documentName)
      if (state) Y.applyUpdate(document, state)
      return document
    },

    async onStoreDocument({
      documentName,
      document,
      context,
    }: {
      documentName: string
      document: Y.Doc
      context: ConnectionContext
    }): Promise<void> {
      const row = await docRow(documentName)
      if (!row) return // doc deleted while the room was open
      const state = Y.encodeStateAsUpdate(document)
      await storeDocState(db, documentName, state)
      await refreshLinkIndex(db, row.vaultId, documentName, docText(document))
      await maybeIntervalSnapshot(db, documentName, state, context?.userId)
    },
  }
}

export { docFromState } // re-export for tests/rename
