/**
 * The Google tokens, on disk, encrypted by the OS keychain.
 *
 * A deliberate sibling of `github/token-store.ts` rather than a generalization
 * of it: the two hold different shapes, version independently, and a shared
 * abstraction over two callers would be the wrong kind of DRY. The two
 * invariants *are* copied, because both are load-bearing and both are tested:
 *
 *   - **It never writes plaintext.** If the platform cannot encrypt, `write`
 *     throws rather than falling back. A refresh token in a readable file is a
 *     standing grant to someone's mail.
 *   - **A file it cannot read is a disconnect, not a crash.** Corrupt JSON, an
 *     envelope from a future version, a keychain re-keyed by an OS upgrade —
 *     all read as "no accounts". "Connect again" is a recovery a user can
 *     perform; a bricked app is not.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SafeStorageLike } from '../github/token-store'

export interface StoredGoogleAuth {
  /**
   * Google's stable account id, and the identity key. Never the email: a
   * Workspace address can be renamed and a freed one reassigned, so a record
   * keyed on it can silently come to mean a different person — the same
   * reasoning that keys GitHub on `accountId` rather than `login`.
   */
  sub: string
  email: string
  /** The durable half of the grant. Everything else is derivable from it. */
  refreshToken: string
  accessToken: string
  /** Epoch ms. */
  expiresAt: number
  /** What was actually granted, so a failure can name the missing scope. */
  scopes: string[]
}

/**
 * Keyed by `sub`, even though v1 connects exactly one account.
 *
 * A map is the same amount of code as a single record here, and it is the
 * difference between "multi-account is an additive change" and "multi-account
 * is a storage migration". D67 chose single-account deliberately; it did not
 * choose to make the second one expensive.
 */
export type GoogleAccounts = Record<string, StoredGoogleAuth>

/** Bump when the shape changes; an unrecognised value reads as disconnected. */
const VERSION = 1

interface Envelope {
  v: number
  /** base64 of the ciphertext, so the file stays valid JSON and stays greppable
   *  as *not* containing a token. */
  data: string
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      'the OS keychain is unavailable, so the Google tokens cannot be stored securely — ' +
        'Holi will not write them to disk unencrypted',
    )
    this.name = 'EncryptionUnavailableError'
  }
}

export class GoogleTokenStore {
  #file: string
  #storage: SafeStorageLike

  constructor(file: string, storage: SafeStorageLike) {
    this.#file = file
    this.#storage = storage
  }

  async read(): Promise<GoogleAccounts> {
    const text = await readFile(this.#file, 'utf8').catch(() => null)
    if (text === null) return {}

    try {
      const envelope: unknown = JSON.parse(text)
      if (!isEnvelope(envelope) || envelope.v !== VERSION) return {}
      const plain = this.#storage.decryptString(Buffer.from(envelope.data, 'base64'))
      const accounts: unknown = JSON.parse(plain)
      if (accounts === null || typeof accounts !== 'object') return {}

      // Filter rather than reject wholesale: one malformed entry should not
      // disconnect an account that is perfectly readable beside it.
      const valid: GoogleAccounts = {}
      for (const [sub, auth] of Object.entries(accounts as Record<string, unknown>)) {
        if (isStoredGoogleAuth(auth)) valid[sub] = auth
      }
      return valid
    } catch {
      return {}
    }
  }

  async write(accounts: GoogleAccounts): Promise<void> {
    // Checked before anything touches the filesystem, so a refusal leaves no
    // half-written file behind to be read as a corrupt one later.
    if (!this.#storage.isEncryptionAvailable()) throw new EncryptionUnavailableError()

    const envelope: Envelope = {
      v: VERSION,
      data: this.#storage.encryptString(JSON.stringify(accounts)).toString('base64'),
    }

    await mkdir(dirname(this.#file), { recursive: true })
    // Write-then-rename: a crash mid-write must not leave a truncated file that
    // reads as a disconnect on next launch.
    const tmp = `${this.#file}.tmp`
    await writeFile(tmp, JSON.stringify(envelope), { mode: 0o600 })
    await rename(tmp, this.#file)
  }

  async clear(): Promise<void> {
    // `force` because disconnect can be pressed twice, and the second is not a
    // failure.
    await rm(this.#file, { force: true })
  }
}

function isEnvelope(value: unknown): value is Envelope {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return typeof e.v === 'number' && typeof e.data === 'string'
}

function isStoredGoogleAuth(value: unknown): value is StoredGoogleAuth {
  if (value === null || typeof value !== 'object') return false
  const a = value as Record<string, unknown>
  return (
    typeof a.sub === 'string' &&
    typeof a.email === 'string' &&
    typeof a.refreshToken === 'string' &&
    typeof a.accessToken === 'string' &&
    typeof a.expiresAt === 'number' &&
    Array.isArray(a.scopes) &&
    a.scopes.every((s) => typeof s === 'string')
  )
}
