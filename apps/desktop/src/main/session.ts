/**
 * ClientSession persistence (auth PRD §Data): the opaque Syv token, encrypted
 * at rest via Electron safeStorage (OS keychain-backed key). Lives ONLY in
 * main — the renderer gets user identity, never the token (tRPC), and a
 * transient collab token per WS connection (plan decision #1).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ClientSession {
  token: string
  userId: string
  email: string
  name: string | null
  /** Last successful server contact — offline-grace anchor (FR-19). */
  cachedAt: string
}

export interface SessionCrypto {
  encrypt(plaintext: string): Buffer
  decrypt(ciphertext: Buffer): string
}

export interface SessionStore {
  load(): ClientSession | null
  save(session: ClientSession): void
  clear(): void
}

export function createSessionStore(file: string, crypto: SessionCrypto): SessionStore {
  return {
    load() {
      try {
        return JSON.parse(crypto.decrypt(readFileSync(file))) as ClientSession
      } catch {
        return null
      }
    },
    save(session) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, crypto.encrypt(JSON.stringify(session)))
    },
    clear() {
      rmSync(file, { force: true })
    },
  }
}

/** Electron glue — untestable by design, keep it thin. Call after app ready. */
export function electronSessionStore(): SessionStore {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app, safeStorage } = require('electron') as typeof import('electron')
  return createSessionStore(join(app.getPath('userData'), 'session.bin'), {
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  })
}
