import type { VaultSnapshot } from '@holi/shared'
import type { SyncState } from '../../main/vault/active-vault'
import type { TrpcEnvelope, TrpcOpWire } from './lib/ipc-link'

declare global {
  interface Window {
    /**
     * The one seam. Everything that used to hang off here — `collab.*`,
     * `docs.onEvent`, `tasks.onEvent`/`onPresence`, `vaults.onEvent`,
     * `stream.onResync`, `reminders.onOpen`, `auth.*`, `agent.*` — is gone:
     * those rode an SSE connection to a server that no longer exists, and auth
     * moved into the tRPC router when GitHub became identity.
     */
    holi: {
      trpc(op: TrpcOpWire): Promise<TrpcEnvelope>
      vault: {
        /** Each returns its unsubscribe closure. */
        onSnapshot(cb: (snapshot: VaultSnapshot) => void): () => void
        onSyncState(cb: (state: SyncState) => void): () => void
      }
      openExternal(url: string): Promise<void>
    }
  }
}

export {}
