/**
 * The speech key (docs/features/meetings.md): the key of the speech service
 * in use (`speech-service.ts`), and **the one rule for resolving it**: the
 * key set in the Meetings tab, else, for syv.ai's service, the vault's
 * `SYV_API_KEY` (`.env.local`, then `.env`), else none. syv.ai's service
 * needs one; another may take requests without.
 *
 * The key is the person's, not the vault's: it is kept on this machine,
 * keychain-encrypted in `userData`, exactly as Google's own-client store
 * keeps its secret (`google/main/credentials.ts`), and never in a vault,
 * which is a shared repo. Same two rules: **it never writes plaintext**
 * (without the keychain, `write` refuses rather than falling back; removing
 * the key still works, since that only deletes the file) and **a file it
 * cannot read is no key**, which falls back to the vault's.
 *
 * **A key is bound to the service it was saved for**: it is stored with that
 * service's address and sent to that service alone. Choosing another service
 * leaves it unused (it applies again if that service is chosen again), unless
 * the person confirms sending it to the new one (`rebind`).
 *
 * The key stays in main. The renderer learns whether one is set and where
 * it came from, never the key.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CapabilityError, type SafeStorageLike } from '../../../main/plugin-api'
import type { SpeechService } from '../shared/meeting'
import { checkService, type Fetch } from './asr'
import { isSyv } from './speech-service'

/** A key as kept: the key, and the address of the service it is for
 *  (`SpeechService.url`, null for syv.ai's). */
interface SavedKey {
  key: string
  service: string | null
}

/** This machine's speech key on disk. */
export interface SpeechKeyStore {
  read(): Promise<SavedKey | null>
  /** `null` removes it. */
  write(saved: SavedKey | null): Promise<void>
}

/** Bump when the stored shape changes; another value reads as no key. 1 had
 *  no service: it was saved when syv.ai's was the only one. */
const VERSION = 2

export function createSpeechKeyStore(path: string, storage: SafeStorageLike): SpeechKeyStore {
  return {
    async read() {
      const text = await readFile(path, 'utf8').catch(() => null)
      if (text === null) return null
      try {
        const envelope: unknown = JSON.parse(text)
        if (!isEnvelope(envelope) || (envelope.v !== VERSION && envelope.v !== 1)) return null
        const key = storage.decryptString(Buffer.from(envelope.data, 'base64'))
        const service = envelope.v === 1 ? null : envelope.service
        if (service !== null && typeof service !== 'string') return null
        return key === '' ? null : { key, service }
      } catch {
        return null
      }
    },
    async write(saved) {
      if (saved === null) {
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
      const envelope = {
        v: VERSION,
        data: storage.encryptString(saved.key).toString('base64'),
        service: saved.service,
      }
      await mkdir(dirname(path), { recursive: true })
      // Write-then-rename: a crash mid-write leaves the old key, not half a file.
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify(envelope), { mode: 0o600 })
      await rename(tmp, path)
    },
  }
}

function isEnvelope(value: unknown): value is { v: number; data: string; service?: unknown } {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return typeof e.v === 'number' && typeof e.data === 'string'
}

/** Where the key in use came from: set in the app, or the vault's env. */
type SpeechKeySource = 'app' | 'vault'

export interface SpeechKeyStatus {
  set: boolean
  source: SpeechKeySource | null
  /** The service the key is for. */
  service: SpeechService
  /** Whether a meeting can be transcribed as things are: syv.ai's service
   *  with a key, or another service, which may need none. */
  ready: boolean
  /** A key saved on this machine is for another service, so it is not sent
   *  to this one. */
  elsewhere: boolean
}

export interface SpeechKey {
  /** The key to upload with, or null. Main's alone. */
  resolve(): Promise<string | null>
  status(): Promise<SpeechKeyStatus>
  /** Keep `key` for the service in use. */
  set(key: string): Promise<void>
  clear(): Promise<void>
  /** Send this machine's saved key to the service in use from now on, as
   *  the person confirmed. False when there is none. */
  rebind(): Promise<boolean>
  /** The service and key in use, asked whether they work: syv.ai's
   *  without spending credits. */
  test(): Promise<{ result: 'ok' | 'invalid' | 'unreachable' }>
}

export interface SpeechKeyDeps {
  store: SpeechKeyStore
  /** The vault's `.env` and `.env.local`, read fresh. */
  vaultEnv(): Promise<Record<string, string>>
  /** The speech service in use. */
  service(): Promise<SpeechService>
  fetch: Fetch
  /** The key was set or removed: wake what waits for one. */
  changed(): void
}

export function createSpeechKey(deps: SpeechKeyDeps): SpeechKey {
  async function current(
    service: SpeechService,
  ): Promise<{ key: string; source: SpeechKeySource } | null> {
    const own = await deps.store.read()
    if (own !== null && own.service === service.url) return { key: own.key, source: 'app' }
    // The vault's key is syv.ai's: it is never sent to another service.
    if (!isSyv(service)) return null
    const env = (await deps.vaultEnv().catch(() => ({}) as Record<string, string>))['SYV_API_KEY']
    const fromVault = env?.trim() ?? ''
    return fromVault === '' ? null : { key: fromVault, source: 'vault' }
  }

  return {
    resolve: async () => (await current(await deps.service()))?.key ?? null,
    async status() {
      const service = await deps.service()
      const [now, own] = await Promise.all([current(service), deps.store.read()])
      return {
        set: now !== null,
        source: now?.source ?? null,
        service,
        ready: now !== null || !isSyv(service),
        elsewhere: own !== null && own.service !== service.url,
      }
    },
    async set(key) {
      await deps.store.write({ key, service: (await deps.service()).url })
      deps.changed()
    },
    async rebind() {
      const own = await deps.store.read()
      if (own === null) return false
      await deps.store.write({ key: own.key, service: (await deps.service()).url })
      deps.changed()
      return true
    },
    async clear() {
      await deps.store.write(null)
      deps.changed()
    },
    async test() {
      const service = await deps.service()
      const now = await current(service)
      if (now === null && isSyv(service)) {
        throw new CapabilityError('CONFLICT', 'no speech key is set')
      }
      const result = await checkService(deps.fetch, service, now?.key ?? null)
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
    throw new CapabilityError('BAD_REQUEST', 'that does not look like a speech service key')
  }
  return key
}
