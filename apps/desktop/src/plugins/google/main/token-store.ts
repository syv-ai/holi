/**
 * The Google tokens, on disk, encrypted by the OS keychain.
 *
 * A deliberate sibling of `github/token-store.ts` rather than a generalization
 * of it: the two hold different shapes and version independently. This store
 * has two tested constraints:
 *
 *   - **It never writes plaintext.** If the platform cannot encrypt, `write`
 *     throws rather than falling back. A refresh token in a readable file is a
 *     standing grant to someone's mail.
 *   - **Only a missing file is a disconnect.** Corrupt data or unavailable
 *     decryption must not look like an empty account store: a later write could
 *     otherwise replace credentials that are still recoverable.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The OS keychain's encryption, as Electron's `safeStorage` offers it. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface StoredGoogleAuth {
  /**
   * Google's stable account id, and the identity key. Never the email: a
   * Workspace address can be renamed and a freed one reassigned, so a record
   * keyed on it can silently come to mean a different person.
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

/** Every connected account, keyed by `sub`. */
export type GoogleAccounts = Record<string, StoredGoogleAuth>

/** Bump when the shape changes; an unrecognised value is unavailable. */
const VERSION = 1

interface Envelope {
  v: number
  /** base64 of the ciphertext, so the file stays valid JSON and stays greppable
   *  as *not* containing a token. */
  data: string
}

export class EncryptionUnavailableError extends Error {
  /** `what` names what could not be stored, for the message. */
  constructor(what = 'the Google tokens') {
    super(
      `the OS keychain is unavailable, so ${what} cannot be stored securely: ` +
        'Holi does not write a secret to disk unencrypted',
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
    let text: string
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error('the Google token store could not be read, decrypted, or parsed')
    }

    try {
      const envelope: unknown = JSON.parse(text)
      if (!isEnvelope(envelope) || envelope.v !== VERSION)
        throw new Error('the Google token store has an unsupported or invalid envelope')
      const plain = this.#storage.decryptString(Buffer.from(envelope.data, 'base64'))
      const accounts: unknown = JSON.parse(plain)
      if (accounts === null || typeof accounts !== 'object' || Array.isArray(accounts))
        throw new Error('the Google token store payload is not an account record')

      // Filter rather than reject wholesale: one malformed entry should not
      // disconnect an account that is perfectly readable beside it.
      const valid: GoogleAccounts = {}
      for (const [sub, auth] of Object.entries(accounts as Record<string, unknown>)) {
        if (isStoredGoogleAuth(auth)) valid[sub] = auth
      }
      return valid
    } catch {
      throw new Error('the Google token store could not be read, decrypted, or parsed')
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
    // Write-then-rename keeps a crash from replacing the stored credentials
    // with a truncated envelope.
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
