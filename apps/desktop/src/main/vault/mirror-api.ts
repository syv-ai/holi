/** MirrorApi over the main-process tRPC client — ops run as the signed-in
 * user, so membership gating stays server-side (spec §McpServer principle). */
import type { ServerClient } from '../server-client'
import type { MirrorApi } from './vault-mirror'

export function makeMirrorApi(client: ServerClient, vaultId: string): MirrorApi {
  return {
    listDocs: async () => (await client.vaults.listDocs.query({ vaultId })).docs,
    createNote: (path) => client.notes.create.mutate({ vaultId, path, kind: 'note' }),
    deleteNote: async (docId) => {
      await client.notes.delete.mutate({ vaultId, docId })
    },
    takeSnapshot: async (docId, label) => {
      await client.snapshots.take.mutate({ docId, label })
    },
  }
}
