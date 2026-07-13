import type { TrpcEnvelope, TrpcOpWire } from './lib/ipc-link'

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
      openExternal(url: string): Promise<void>
    }
  }
}

export {}
