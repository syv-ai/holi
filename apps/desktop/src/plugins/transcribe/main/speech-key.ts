/**
 * The syv.ai speech key (docs/features/meetings.md), and **the one rule for
 * resolving it**: the key set in the Meetings tab, else the vault's
 * `SYV_API_KEY` (`.env.local`, then `.env`), else none.
 *
 * The key is the person's, not the vault's: it is kept on this machine,
 * keychain-encrypted in `userData`, exactly as Google's own-client store
 * keeps its secret (`google/main/credentials.ts`), and never in a vault,
 * which is a shared repo. Same two rules: **it never writes plaintext**
 * (without the keychain, `write` refuses rather than falling back; removing
 * the key still works, since that only deletes the file) and **a file it
 * cannot read is no key**, which falls back to the vault's.
 *
 * The key stays in main. The renderer learns whether one is set and where
 * it came from, never the key.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CapabilityError, type SafeStorageLike } from '../../../main/plugin-api'
import { checkKey, type Fetch } from './asr'

/** This machine's speech key on disk. */
export interface SpeechKeyStore {
  read(): Promise<string | null>
  /** `null` removes it. */
  write(key: string | null): Promise<void>
}

/** Bump when the stored shape changes; another value reads as no key. */
const VERSION = 1

export function createSpeechKeyStore(path: string, storage: SafeStorageLike): SpeechKeyStore {
  return {
    async read() {
      const text = await readFile(path, 'utf8').catch(() => null)
      if (text === null) return null
      try {
        const envelope: unknown = JSON.parse(text)
        if (!isEnvelope(envelope) || envelope.v !== VERSION) return null
        const key = storage.decryptString(Buffer.from(envelope.data, 'base64'))
        return key === '' ? null : key
      } catch {
        return null
      }
    },
    async write(key) {
      if (key === null) {
        await rm(path, { force: true })
        return
      }
      // Checked before anything touches the filesystem, so a refusal leaves
      // no half-written file behind.
      if (!storage.isEncryptionAvailable()) {
        throw new CapabilityError(
          'UNAVAILABLE',
          'the OS keychain is unavailable, so the speech key cannot be stored securely: ' +
            'Holi does not write a secret to disk unencrypted',
        )
      }
      const envelope = { v: VERSION, data: storage.encryptString(key).toString('base64') }
      await mkdir(dirname(path), { recursive: true })
      // Write-then-rename: a crash mid-write leaves the old key, not half a file.
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify(envelope), { mode: 0o600 })
      await rename(tmp, path)
    },
  }
}

function isEnvelope(value: unknown): value is { v: number; data: string } {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return typeof e.v === 'number' && typeof e.data === 'string'
}

/** Where the key in use came from: set in the app, or the vault's env. */
type SpeechKeySource = 'app' | 'vault'

export interface SpeechKeyStatus {
  set: boolean
  source: SpeechKeySource | null
}

export interface SpeechKey {
  /** The key to upload with, or null. Main's alone. */
  resolve(): Promise<string | null>
  status(): Promise<SpeechKeyStatus>
  set(key: string): Promise<void>
  clear(): Promise<void>
  /** The key in use, asked of the service without spending credits. */
  test(): Promise<{ result: 'ok' | 'invalid' | 'unreachable' }>
}

export interface SpeechKeyDeps {
  store: SpeechKeyStore
  /** The vault's `.env` and `.env.local`, read fresh. */
  vaultEnv(): Promise<Record<string, string>>
  fetch: Fetch
  /** The key was set or removed: wake what waits for one. */
  changed(): void
}

export function createSpeechKey(deps: SpeechKeyDeps): SpeechKey {
  async function current(): Promise<{ key: string; source: SpeechKeySource } | null> {
    const own = await deps.store.read()
    if (own !== null) return { key: own, source: 'app' }
    const env = (await deps.vaultEnv().catch(() => ({}) as Record<string, string>))['SYV_API_KEY']
    const fromVault = env?.trim() ?? ''
    return fromVault === '' ? null : { key: fromVault, source: 'vault' }
  }

  return {
    resolve: async () => (await current())?.key ?? null,
    async status() {
      const now = await current()
      return { set: now !== null, source: now?.source ?? null }
    },
    async set(key) {
      await deps.store.write(key)
      deps.changed()
    },
    async clear() {
      await deps.store.write(null)
      deps.changed()
    },
    async test() {
      const now = await current()
      if (now === null) throw new CapabilityError('CONFLICT', 'no speech key is set')
      const result = await checkKey(deps.fetch, now.key)
      // It works now: whatever waited on a refused key may go.
      if (result === 'ok') deps.changed()
      return { result }
    },
  }
}

/** Longest a pasted key may be; a syv.ai key (`hv_…`) is 35 characters. */
const MAX_KEY = 512
const MIN_KEY = 12

/**
 * A key as pasted: trimmed, one line, printable, no spaces, and a plausible
 * length. A syv.ai key looks like `hv_…`, but any shape that passes is
 * accepted: the service is the judge, and `meeting.key.test` asks it.
 */
export function speechKeyParam(raw: Record<string, unknown>): string {
  const value = raw['key']
  if (typeof value !== 'string') throw new CapabilityError('BAD_REQUEST', 'key must be text')
  const key = value.trim()
  if (key === '') throw new CapabilityError('BAD_REQUEST', 'the key is empty')
  if (/[\r\n]/.test(key)) throw new CapabilityError('BAD_REQUEST', 'the key must be one line')
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new CapabilityError('BAD_REQUEST', 'the key has spaces or characters a key never has')
  }
  if (key.length < MIN_KEY || key.length > MAX_KEY) {
    throw new CapabilityError('BAD_REQUEST', 'that does not look like a syv.ai speech key')
  }
  return key
}
