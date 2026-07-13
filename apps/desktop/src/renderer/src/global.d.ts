import type { TrpcEnvelope, TrpcOpWire } from './lib/ipc-link'
import type { AgentStatus } from './state/agent'

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
      agent: {
        start(args: { vaultId: string; resume?: boolean }): Promise<TrpcEnvelope>
        write(data: string): Promise<void>
        resize(cols: number, rows: number): Promise<void>
        kill(): Promise<TrpcEnvelope>
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
