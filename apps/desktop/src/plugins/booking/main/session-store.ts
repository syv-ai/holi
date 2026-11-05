/**
 * The booking session, on disk, encrypted by the OS keychain. One per
 * machine: it is a person's sign-in, not a vault's.
 *
 * It keeps the two invariants of Google's and GitHub's token stores, which a
 * plugin may not import, so they are restated here and tested here:
 *
 *   - **It never writes plaintext.** If the platform cannot encrypt, `write`
 *     throws rather than falling back.
 *   - **A file it cannot read is a sign-out, not a crash.** Signing in again
 *     is a recovery a person can perform.
 *
 * Writes and clears run one at a time, in the order they were asked for: a
 * refresh's write that is still landing when the person signs out is cleared
 * after it lands, never left behind, and two writes never share the temp file.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SafeStorageLike } from '../../../main/plugin-api'
import type { AuthTokens } from './api'

export interface SessionStore {
  read(): Promise<AuthTokens | null>
  write(tokens: AuthTokens): Promise<void>
  clear(): Promise<void>
}

const VERSION = 1

export function createSessionStore(file: string, storage: SafeStorageLike): SessionStore {
  let last: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(change: () => Promise<T>): Promise<T> => {
    const next = last.then(change, change)
    last = next.catch(() => undefined)
    return next
  }

  return {
    async read() {
      const text = await readFile(file, 'utf8').catch(() => null)
      if (text === null) return null
      try {
        const envelope = JSON.parse(text) as { v?: unknown; data?: unknown }
        if (envelope.v !== VERSION || typeof envelope.data !== 'string') return null
        const tokens: unknown = JSON.parse(
          storage.decryptString(Buffer.from(envelope.data, 'base64')),
        )
        return isTokens(tokens) ? tokens : null
      } catch {
        return null
      }
    },

    write(tokens) {
      return inTurn(async () => {
        if (!storage.isEncryptionAvailable()) {
          throw new Error(
            'the OS keychain is unavailable, so Holi will not keep the booking sign-in on disk',
          )
        }
        const data = storage.encryptString(JSON.stringify(tokens)).toString('base64')
        await mkdir(dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        await writeFile(tmp, JSON.stringify({ v: VERSION, data }), { mode: 0o600 })
        await rename(tmp, file)
      })
    },

    clear() {
      return inTurn(() => rm(file, { force: true }))
    },
  }
}

function isTokens(value: unknown): value is AuthTokens {
  if (value === null || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return (
    typeof t.accessToken === 'string' &&
    typeof t.refreshToken === 'string' &&
    typeof t.expiresAt === 'number' &&
    typeof t.userId === 'string' &&
    typeof t.email === 'string'
  )
}
