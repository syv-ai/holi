/**
 * The GitHub token, on disk, encrypted by the OS keychain. The only file in the
 * app that knows a keychain exists.
 *
 * Two properties are load-bearing, and both are tested:
 *
 *   - **It never writes plaintext.** If the platform cannot encrypt, `write`
 *     throws rather than falling back: a fallback is how a token ends up in a
 *     readable file while every test still passes.
 *   - **A file it cannot read is a sign-out, not a crash.** Corrupt JSON, an
 *     envelope from a future version, a keychain re-keyed by an OS upgrade:
 *     all read as `null`, because "sign in again" is a recovery a user can
 *     perform and a bricked app is not.
 */
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

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
   * GitHub's numeric account id, and the identity key. Never `login`: a login
   * can be renamed by its owner and the freed name claimed by someone else, so
   * a record keyed on it can silently come to mean a different person.
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
  getSelectedStorageBackend?(): string
}

/** The platform has no keychain to encrypt with. The message is advice — the
 * user can often fix this (install a keyring, unlock the login keychain) — so
 * it deserves its own type rather than a generic failure.
 */
type TokenStoragePhase = 'availability' | 'encryption' | 'directory' | 'write' | 'replace'

const BACKENDS = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
  'basic_text',
  'unknown',
])

/** Safe, bounded diagnostics: never expose native error text or credential data. */
class TokenStorageError extends Error {
  readonly phase: TokenStoragePhase
  readonly backend: string

  constructor(phase: TokenStoragePhase, backend: string) {
    const safeBackend = BACKENDS.has(backend) ? backend : 'unknown'
    const linuxBackend = safeBackend === 'gnome_libsecret' || safeBackend.startsWith('kwallet')
    const advice =
      phase === 'availability'
        ? linuxBackend
          ? 'Ensure a Linux keyring is installed, running and unlocked, and that the session bus is available, then retry sign-in.'
          : 'Ensure the operating system credential store is available, then retry sign-in.'
        : phase === 'encryption'
          ? linuxBackend
            ? 'Ensure a Linux login keyring and session bus are running and available, and that the keyring is unlocked, then retry sign-in.'
            : 'Ensure the operating system credential store is available, then retry sign-in.'
          : 'Check that Holi can write its user-data folder, then retry sign-in.'
    super(
      `Holi could not securely save the GitHub sign-in (${phase}; backend: ${safeBackend}). ${advice} No plaintext fallback was used.`,
    )
    this.name = phase === 'availability' ? 'EncryptionUnavailableError' : 'TokenStorageError'
    this.phase = phase
    this.backend = safeBackend
  }
}

class EncryptionUnavailableError extends TokenStorageError {
  constructor(backend = 'unknown') {
    super('availability', backend)
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

/** A staged encrypted replacement: publish is synchronous, and discard cleans only its staging file. */
export interface PreparedTokenWrite {
  publish(): void
  discard(): Promise<void>
}

class PreparedTokenReplacement implements PreparedTokenWrite {
  #target: string
  #staged: string | null

  #backend: string

  constructor(target: string, staged: string, backend: string) {
    this.#target = target
    this.#staged = staged
    this.#backend = backend
  }

  publish(): void {
    const staged = this.#staged
    if (staged === null) throw new Error('Prepared token write already consumed')
    try {
      renameSync(staged, this.#target)
      this.#staged = null
    } catch {
      throw new TokenStorageError('replace', this.#backend)
    }
  }

  async discard(): Promise<void> {
    const staged = this.#staged
    this.#staged = null
    if (staged !== null) await rm(staged, { force: true }).catch(() => {})
  }
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

  async prepare(auth: StoredAuth): Promise<PreparedTokenWrite> {
    const backend = this.#backend()
    // Never allow Electron's basic_text backend, even if it reports availability.
    if (backend === 'basic_text') throw new EncryptionUnavailableError(backend)
    try {
      if (!this.#storage.isEncryptionAvailable()) throw new EncryptionUnavailableError(backend)
    } catch (error) {
      if (error instanceof EncryptionUnavailableError) throw error
      throw new TokenStorageError('availability', backend)
    }

    let encrypted: Buffer
    try {
      encrypted = this.#storage.encryptString(JSON.stringify(auth))
    } catch {
      throw new TokenStorageError('encryption', backend)
    }
    const envelope: Envelope = { v: VERSION, data: encrypted.toString('base64') }

    try {
      await mkdir(dirname(this.#file), { recursive: true })
    } catch {
      throw new TokenStorageError('directory', backend)
    }
    // Write-then-rename: a crash mid-write must not leave a truncated file that
    // reads as a sign-out on next launch. The prior file remains until rename.
    const tmp = `${this.#file}.${randomUUID()}.tmp`
    let owned = false
    try {
      const handle = await open(tmp, 'wx', 0o600)
      owned = true
      try {
        await handle.writeFile(JSON.stringify(envelope), 'utf8')
      } finally {
        await handle.close()
      }
    } catch {
      if (owned) await rm(tmp, { force: true }).catch(() => {})
      throw new TokenStorageError('write', backend)
    }
    return new PreparedTokenReplacement(this.#file, tmp, backend)
  }

  async write(auth: StoredAuth): Promise<void> {
    const prepared = await this.prepare(auth)
    try {
      prepared.publish()
    } catch (error) {
      await prepared.discard()
      throw error
    }
  }

  #backend(): string {
    try {
      const backend = this.#storage.getSelectedStorageBackend?.()
      return typeof backend === 'string' && BACKENDS.has(backend) ? backend : 'unknown'
    } catch {
      return 'unknown'
    }
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
