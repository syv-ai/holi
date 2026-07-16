/**
 * The one live connection, owned by main — **one per signed-in user, not per vault** (D50).
 *
 * It exists as its own module because its lifetime is now different from everything
 * around it: it is started at sign-in and stopped at sign-out, and it must survive vault
 * switches untouched. It used to be built inside `VaultManager.activate`, which tore it
 * down and rebuilt it on every switch — and the renderer must still never open one
 * (that invariant did not loosen, only its scope did: one per *user* now, still owned here).
 *
 * This is deliberately a dumb transport. It unwraps the envelope and hands
 * `(channel, vaultId, event)` on; deciding which frames are about the vault on screen and
 * which are not is the dispatcher's job (D52), not this module's.
 */
import { API_URL, type ServerClient } from '../server-client'
import { SseClient } from '../vault/sse-client'

/** Every frame the server sends: the payloads have no vaultId, the transport labels them. */
type Envelope = { vaultId: string; event: unknown }

export interface UserStream {
  start(): void
  stop(): void
}

export function createUserStream(deps: {
  getToken: () => string | null
  client: ServerClient
  onEnvelope: (channel: string, vaultId: string, event: unknown) => void
  /** A gap means whatever holds local state must re-read it — the active vault's mirror
   * and projector. Nothing else has any: an inactive vault's state is fetched when you
   * open it. */
  onReconnect: () => void
}): UserStream {
  /**
   * Fires that landed while we were not listening, for **every** vault (D48 is closed:
   * they are no longer only the active vault's). Routed through `onEnvelope` exactly like
   * a live frame — a fire you missed is not a different kind of fire, and giving it a
   * second path is how the two would drift.
   */
  const catchUp = async (): Promise<void> => {
    try {
      for (const { vaultId, event } of await deps.client.reminders.catchUpAll.mutate()) {
        deps.onEnvelope('reminders', vaultId, event)
      }
    } catch (err) {
      console.error('[reminders] catch-up failed:', err)
    }
  }

  const sse = new SseClient({
    url: `${API_URL}/events`,
    getToken: deps.getToken,
    onEvent: (channel, data) => {
      const { vaultId, event } = data as Envelope
      deps.onEnvelope(channel, vaultId, event)
    },
    onReconnect: () => {
      deps.onReconnect()
      void catchUp()
    },
  })

  let started = false
  return {
    start: () => {
      if (started) return // sign-in can be reached more than one way; the stream is one
      started = true
      sse.start()
      // After the stream is up, never before: a fire landing in the gap would be missed
      // by a catch-up that already ran and by a stream not yet listening. At worst this
      // shows one twice — and the server advances the watermark on live sends, so in
      // practice it will not. Duplicates beat silence.
      void catchUp()
    },
    stop: () => {
      started = false
      sse.stop()
    },
  }
}
