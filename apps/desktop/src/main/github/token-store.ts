/**
 * The GitHub token, on disk, encrypted by the OS keychain.
 *
 * The only file in the app that knows a keychain exists. Everything above it
 * deals in a `StoredAuth` and never learns where it slept.
 *
 * Two properties are load-bearing, and both are tested:
 *
 *   - **It never writes plaintext.** If the platform cannot encrypt, `write`
 *     throws rather than falling back — a token in a readable file is exactly
 *     what auth PRD FR-5 exists to prevent, and a fallback is how one gets
 *     there while every test still passes.
 *   - **A file it cannot read is a sign-out, not a crash.** Corrupt JSON, an
 *     envelope from a future version, a keychain re-keyed by an OS upgrade —
 *     all read as `null`. This is `registry.ts`'s policy for the same reason:
 *     a bad file must not brick the app into a state with no way back, and
 *     "sign in again" is a recovery a user can perform.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Everything sign-in produced, kept together and encrypted as one blob.
 *
 * The login and avatar are not secret; they are in here anyway because a second
 * plaintext file would exist only to leak them, and if the keychain cannot be
 * read the token is gone too — leaving nothing worth displaying.
 */
export interface StoredAuth {
  token: string
  /**
   * GitHub's numeric account id, and the identity key (FR-6). Never `login`: a
   * login can be renamed by its owner and the freed name claimed by someone
   * else, so a record keyed on it can silently come to mean a different person.
   */
  accountId: number
  login: string
  name?: string
  avatarUrl?: string
  /** What was actually granted, so a failure can name the missing scope
   * instead of guessing at it. */
  scopes: string[]
}

/**
 * Electron `safeStorage`'s shape, exactly.
 *
 * Taken as an interface so this module — and every test of it — runs under
 * plain Node. Matching the shape rather than wrapping it means production
 * passes `safeStorage` straight through, and there is no adapter to drift.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** The platform has no keychain to encrypt with. The message is advice — the
 * user can often fix this (install a keyring, unlock the login keychain) — so
 * it deserves its own type rather than a generic failure. */
export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      'the OS keychain is unavailable, so the GitHub token cannot be stored securely — ' +
        'Holi will not write it to disk unencrypted',
    )
    this.name = 'EncryptionUnavailableError'
  }
}

/** The one format version we know how to read. Bump when the shape changes;
 * an unrecognised value reads as signed-out rather than as a guess. */
const VERSION = 1

interface Envelope {
  v: number
  /** base64 of the ciphertext, so the file stays valid JSON and stays greppable
   * as *not* containing a token. */
  data: string
}

export class TokenStore {
  #file: string
  #storage: SafeStorageLike

  constructor(file: string, storage: SafeStorageLike) {
    this.#file = file
    this.#storage = storage
  }

  async read(): Promise<StoredAuth | null> {
    const text = await readFile(this.#file, 'utf8').catch(() => null)
    if (text === null) return null

    try {
      const envelope: unknown = JSON.parse(text)
      if (!isEnvelope(envelope) || envelope.v !== VERSION) return null
      const plain = this.#storage.decryptString(Buffer.from(envelope.data, 'base64'))
      const auth: unknown = JSON.parse(plain)
      return isStoredAuth(auth) ? auth : null
    } catch {
      return null
    }
  }

  async write(auth: StoredAuth): Promise<void> {
    // Checked before anything touches the filesystem, so a refusal leaves no
    // half-written file behind to be read as a corrupt one later.
    if (!this.#storage.isEncryptionAvailable()) throw new EncryptionUnavailableError()

    const envelope: Envelope = {
      v: VERSION,
      data: this.#storage.encryptString(JSON.stringify(auth)).toString('base64'),
    }

    await mkdir(dirname(this.#file), { recursive: true })
    // Write-then-rename: a crash mid-write must not leave a truncated file that
    // reads as a sign-out on next launch.
    const tmp = `${this.#file}.tmp`
    await writeFile(tmp, JSON.stringify(envelope), { mode: 0o600 })
    await rename(tmp, this.#file)
  }

  async clear(): Promise<void> {
    // `force` because sign-out can be pressed twice, and the second press is
    // not a failure.
    await rm(this.#file, { force: true })
  }
}

function isEnvelope(value: unknown): value is Envelope {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return typeof e.v === 'number' && typeof e.data === 'string'
}

function isStoredAuth(value: unknown): value is StoredAuth {
  if (value === null || typeof value !== 'object') return false
  const a = value as Record<string, unknown>
  return (
    typeof a.token === 'string' &&
    typeof a.accountId === 'number' &&
    typeof a.login === 'string' &&
    Array.isArray(a.scopes) &&
    a.scopes.every((s) => typeof s === 'string')
  )
}
