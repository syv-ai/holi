import type { TrpcEnvelope, TrpcOpWire } from './lib/ipc-link'
import type { AgentStatus } from './state/agent'
import type { PresenceEvent, TasksEvent } from './state/tasks'

export interface PublicUser {
  userId: string
  email: string
  name: string | null
}

type AuthEnvelope = { ok: true; data: PublicUser } | { ok: false; message: string; code?: string }

declare global {
  interface Window {
    holi: {
      trpc(op: TrpcOpWire): Promise<TrpcEnvelope>
      auth: {
        get(): Promise<PublicUser | null>
        signIn(): Promise<AuthEnvelope>
        devSignIn(token: string): Promise<AuthEnvelope>
        signOut(): Promise<{ ok: boolean }>
      }
      collabAuth(): Promise<{ url: string; token: string } | null>
      vault: {
        activate(vaultId: string): Promise<TrpcEnvelope>
      }
      vaults: {
        /** Returns its unsubscribe closure. You joined or left a vault — refetch the
         * list. A per-vault stream had no channel for this, which is why the switcher
         * needed a restart (D51). */
        onEvent(cb: (e: { vaultId: string; type: 'joined' | 'left' }) => void): () => void
      }
      docs: {
        /** Returns its unsubscribe closure. Rides main's single SSE stream, already
         * filtered to the active vault — so no vaultId to check. */
        onEvent(cb: (e: DocsEvent) => void): () => void
      }
      stream: {
        /** Returns its unsubscribe closure. The stream reconnected after a gap; there is
         * no resume cursor, so refetch anything without a reconcile of its own. */
        onResync(cb: () => void): () => void
      }
      reminders: {
        /** A reminder notification was clicked — open that task, in that vault. The
         * vault may not be the active one (D52), and a coalesced summary speaks for
         * several tasks so it carries no taskId. */
        onOpen(cb: (e: { vaultId: string; taskId: string | null }) => void): () => void
      }
      tasks: {
        /** Each returns its unsubscribe closure. Both ride main's single SSE stream. */
        onEvent(cb: (e: TasksEvent) => void): () => void
        onPresence(cb: (e: PresenceEvent) => void): () => void
      }
      agent: {
        start(args: { vaultId: string; resume?: boolean }): Promise<TrpcEnvelope>
        write(data: string): Promise<void>
        resize(cols: number, rows: number): Promise<void>
        kill(): Promise<TrpcEnvelope>
        /** Serialized terminal state from main; write it into a fresh xterm. */
        attach(): Promise<string>
        status(): Promise<AgentStatus>
        setFocus(focus: { focusedPath: string | null; openPaths: string[] }): Promise<void>
        /** Each returns its unsubscribe closure. */
        onData(cb: (data: string) => void): () => void
        onExit(cb: (e: { code: number }) => void): () => void
        onStatus(cb: (status: AgentStatus) => void): () => void
      }
      openExternal(url: string): Promise<void>
    }
  }
}

export {}
