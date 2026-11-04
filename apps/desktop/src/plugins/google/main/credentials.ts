/**
 * The OAuth client Holi presents to Google, and **the one rule for resolving
 * it**: the person's own client, else the environment, else the shipped pair.
 *
 * Its own file because it has two callers that must never drift: `GoogleSession`
 * refreshes with it and `accounts.ts` runs a consent with it. A stray
 * `?? ''` in one of them makes consent die at Google with `Missing required
 * parameter: client_id`.
 *
 * **The shipped client takes syv.ai accounts only.** Its consent screen is
 * Internal, so Google refuses any other account with `Error 403:
 * org_internal` before it draws a consent screen. Anyone else brings their own
 * Desktop app client, set in Settings, Google and kept, keychain-encrypted, in
 * this machine's `userData` (docs/features/google.md).
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EncryptionUnavailableError, type SafeStorageLike } from './token-store'

/**
 * The OAuth client id for Holi's Google app.
 *
 * A desktop client's id is not a secret, and neither is the `client_secret`
 * Google issues alongside it: for an installed app both ship in the binary and
 * **PKCE** is what actually protects the grant.
 *
 * A person's own client, then `HOLI_GOOGLE_CLIENT_ID` /
 * `HOLI_GOOGLE_CLIENT_SECRET` in the environment, take its place
 * (`resolveClient`).
 * @public exported for its test
 */
export const GOOGLE_CLIENT_ID =
  '132910330015-4ror8qtmhh69d1ms1s3s99tot5gm551q.apps.googleusercontent.com'

/**
 * The desktop `client_secret` Google issued alongside the id above.
 *
 * **Committed on purpose, and it is not a credential.** Google's own docs say
 * the secret for an installed app "is obviously not treated as a secret": it
 * ships in every copy of the binary. Google requires it on the token exchange
 * for a Desktop-type client; what actually stops a stolen authorization code
 * being redeemed is **PKCE** (`pkce.ts`), which binds the exchange to a
 * verifier that never leaves this process.
 *
 * This pair identifies *Holi*, not a user, and grants nothing on its own: every
 * token still requires the user to complete consent in their own browser.
 * @public exported for its test
 */
export const GOOGLE_CLIENT_SECRET = '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'

/** A Google OAuth client: a Desktop app client's id and the secret Google
 *  issued with it. */
export interface GoogleClient {
  id: string
  secret?: string
}

/** Where the client in use came from, so settings can say whose it is. */
export type GoogleClientSource = 'own' | 'environment' | 'shipped'

/**
 * The client to present: the person's own, else `HOLI_GOOGLE_CLIENT_ID` (with
 * `HOLI_GOOGLE_CLIENT_SECRET`), else the shipped pair. Never empty.
 *
 * Each source is taken whole. A secret belongs to one client id, so an id from
 * one source with a secret from another is a pair Google refuses.
 */
export function resolveClient(
  own: GoogleClient | null,
  env: NodeJS.ProcessEnv = process.env,
): GoogleClient & { source: GoogleClientSource } {
  if (own !== null) return { ...own, source: 'own' }
  const envId = env.HOLI_GOOGLE_CLIENT_ID
  if (envId !== undefined && envId !== '') {
    const secret = env.HOLI_GOOGLE_CLIENT_SECRET
    return {
      id: envId,
      ...(secret !== undefined && secret !== '' ? { secret } : {}),
      source: 'environment',
    }
  }
  return { id: GOOGLE_CLIENT_ID, secret: GOOGLE_CLIENT_SECRET, source: 'shipped' }
}

/** Whether Google would see two clients as one: a grant made under one
 *  refreshes under the other. **The id alone decides it**: a grant belongs to
 *  the client id, and a client keeps it across a new or rotated secret. */
export function sameClient(a: GoogleClient, b: GoogleClient): boolean {
  return a.id === b.id
}

/** The suffix every Google OAuth client id carries. Checked so a secret pasted
 *  into the id field is refused here, not by Google after a consent. */
export const CLIENT_ID_SUFFIX = '.apps.googleusercontent.com'

/** The person's own client on this machine. */
export interface GoogleClientStore {
  read(): Promise<GoogleClient | null>
  /** `null` goes back to the environment's or the shipped client. */
  write(client: GoogleClient | null): Promise<void>
}

/**
 * The person's own client, encrypted by the OS keychain in `userData` beside
 * the tokens, exactly as they are (`token-store.ts`).
 *
 * **Machine-local and never in a vault**: the accounts it connects are this
 * machine's, and a vault is a shared repo. Encrypted although Google's guidance
 * is that an installed app's secret is not confidential: this one is the
 * person's own, not Holi's published pair, and the keychain costs nothing.
 *
 * Same two rules as the tokens. **It never writes plaintext**: without the
 * keychain, `write` throws rather than falling back (going back to the default
 * client still works, since that only deletes the file). **A file it cannot
 * read is no client**, which falls back to the next source.
 */
export function createClientStore(path: string, storage: SafeStorageLike): GoogleClientStore {
  return {
    async read() {
      const text = await readFile(path, 'utf8').catch(() => null)
      if (text === null) return null
      try {
        const envelope: unknown = JSON.parse(text)
        if (!isEnvelope(envelope) || envelope.v !== CLIENT_VERSION) return null
        return parseClient(JSON.parse(storage.decryptString(Buffer.from(envelope.data, 'base64'))))
      } catch {
        return null
      }
    },
    async write(client) {
      if (client === null) {
        await rm(path, { force: true })
        return
      }
      // Checked before anything touches the filesystem, as the tokens are.
      if (!storage.isEncryptionAvailable()) {
        throw new EncryptionUnavailableError('your own Google client')
      }
      const envelope = {
        v: CLIENT_VERSION,
        data: storage.encryptString(JSON.stringify(client)).toString('base64'),
      }
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify(envelope), { mode: 0o600 })
      await rename(tmp, path)
    },
  }
}

/** Bump when the stored client's shape changes; another value reads as none. */
const CLIENT_VERSION = 1

function isEnvelope(value: unknown): value is { v: number; data: string } {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return typeof e.v === 'number' && typeof e.data === 'string'
}

function parseClient(raw: unknown): GoogleClient | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { id, secret } = raw as Record<string, unknown>
  if (typeof id !== 'string' || id === '') return null
  return typeof secret === 'string' && secret !== '' ? { id, secret } : { id }
}
