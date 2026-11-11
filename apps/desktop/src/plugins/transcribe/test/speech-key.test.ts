/**
 * The syv.ai speech key on this machine: kept keychain-encrypted in
 * `userData` exactly as Google's own-client store is, never written in
 * plaintext, and resolved before the vault's `SYV_API_KEY`.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityError } from '../../../main/capabilities/error'
import { SYV_MODELS_URL as MODELS_URL } from '../main/speech-service'
import { createSpeechKey, createSpeechKeyStore } from '../main/speech-key'

/** `safeStorage`'s shape, with encryption that is just a reversible marker. */
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buf: Buffer) => buf.toString().replace(/^enc:/, ''),
}

const KEY = 'hv_0123456789abcdefghijklmnopqrstuv'
const SYV = { url: null, model: null }
const LOCAL = { url: 'http://localhost:8000/v1', model: 'whisper-large-v3' }

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-speech-key-'))
  file = join(dir, 'speech-key.enc')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('the store', () => {
  it('round-trips without the key greppable on disk, and null deletes it', async () => {
    const store = createSpeechKeyStore(file, storage)
    await store.write({ key: KEY, service: LOCAL.url })

    expect(await readFile(file, 'utf8')).not.toContain(KEY)
    expect(await store.read()).toEqual({ key: KEY, service: LOCAL.url })

    await store.write(null)
    expect(await store.read()).toBeNull()
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('refuses to write when the platform cannot encrypt, leaving nothing behind', async () => {
    const store = createSpeechKeyStore(file, { ...storage, isEncryptionAvailable: () => false })

    await expect(store.write({ key: KEY, service: null })).rejects.toBeInstanceOf(CapabilityError)
    await expect(readFile(file, 'utf8')).rejects.toThrow()
    // Removing the key needs no keychain.
    await expect(store.write(null)).resolves.toBeUndefined()
  })

  it('reads a file the keychain can no longer decrypt as no key', async () => {
    await createSpeechKeyStore(file, storage).write({ key: KEY, service: null })
    const rekeyed = createSpeechKeyStore(file, {
      ...storage,
      decryptString: () => {
        throw new Error('keychain re-keyed')
      },
    })
    expect(await rekeyed.read()).toBeNull()
  })

  it('reads a key saved before services had addresses as syv.ai’s', async () => {
    const data = storage.encryptString(KEY).toString('base64')
    await writeFile(file, JSON.stringify({ v: 1, data }))
    expect(await createSpeechKeyStore(file, storage).read()).toEqual({ key: KEY, service: null })
  })
})

describe('the key in use', () => {
  function speechKey(vaultEnv: Record<string, string> = {}) {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ data: [] }))
    const changed = vi.fn()
    let service: { url: string | null; model: string | null } = SYV
    const key = createSpeechKey({
      store: createSpeechKeyStore(file, storage),
      vaultEnv: async () => vaultEnv,
      service: async () => service,
      fetch,
      changed,
    })
    const choose = (next: typeof service) => void (service = next)
    return { key, fetch, changed, choose }
  }

  it('goes only to the service it was saved for, unless the person moves it', async () => {
    const { key, choose } = speechKey({ SYV_API_KEY: 'hv_from_the_vault_env_local' })
    await key.set(KEY)
    choose(LOCAL)
    // Another address: neither this Mac's key nor the vault's goes there.
    expect(await key.resolve()).toBeNull()
    expect(await key.status()).toEqual({
      set: false,
      source: null,
      service: LOCAL,
      ready: true,
      elsewhere: true,
    })
    // Back to syv.ai's, the key applies again.
    choose(SYV)
    expect(await key.resolve()).toBe(KEY)

    choose(LOCAL)
    expect(await key.rebind()).toBe(true)
    expect(await key.resolve()).toBe(KEY)
    expect((await key.status()).elsewhere).toBe(false)
    // And is no longer syv.ai's, whose vault key applies there now.
    choose(SYV)
    expect(await key.resolve()).toBe('hv_from_the_vault_env_local')
  })

  it("is the app's key first, then the vault's SYV_API_KEY, then none", async () => {
    const { key } = speechKey({ SYV_API_KEY: 'hv_from_the_vault_env_local' })
    expect(await key.resolve()).toBe('hv_from_the_vault_env_local')
    expect(await key.status()).toEqual({
      set: true,
      source: 'vault',
      service: { url: null, model: null },
      ready: true,
      elsewhere: false,
    })

    await key.set(KEY)
    expect(await key.resolve()).toBe(KEY)
    expect(await key.status()).toEqual({
      set: true,
      source: 'app',
      service: { url: null, model: null },
      ready: true,
      elsewhere: false,
    })

    await key.clear()
    expect(await key.status()).toEqual({
      set: true,
      source: 'vault',
      service: { url: null, model: null },
      ready: true,
      elsewhere: false,
    })

    const none = speechKey({ SYV_API_KEY: '' }).key
    expect(await none.resolve()).toBeNull()
    expect(await none.status()).toEqual({
      set: false,
      source: null,
      service: { url: null, model: null },
      ready: false,
      elsewhere: false,
    })
  })

  it('says when it changed, so the uploads waiting for it go', async () => {
    const { key, changed } = speechKey()
    await key.set(KEY)
    expect(changed).toHaveBeenCalledTimes(1)
    await key.clear()
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('is tested against the free model list, by its answer', async () => {
    const { key, fetch } = speechKey()
    await key.set(KEY)
    expect(await key.test()).toEqual({ result: 'ok' })
    expect(fetch).toHaveBeenCalledWith(
      MODELS_URL,
      expect.objectContaining({ method: 'GET', headers: { Authorization: `Bearer ${KEY}` } }),
    )
    fetch.mockResolvedValueOnce(new Response('no', { status: 401 }))
    expect(await key.test()).toEqual({ result: 'invalid' })
    fetch.mockResolvedValueOnce(new Response('no', { status: 403 }))
    expect(await key.test()).toEqual({ result: 'invalid' })
    fetch.mockResolvedValueOnce(new Response('down', { status: 502 }))
    expect(await key.test()).toEqual({ result: 'unreachable' })
    fetch.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await key.test()).toEqual({ result: 'unreachable' })
  })

  it('has nothing to test without a key', async () => {
    const { key, fetch } = speechKey()
    await expect(key.test()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
