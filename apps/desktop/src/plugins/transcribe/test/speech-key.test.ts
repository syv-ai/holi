/**
 * The syv.ai speech key on this machine: kept keychain-encrypted in
 * `userData` exactly as Google's own-client store is, never written in
 * plaintext, and resolved before the vault's `SYV_API_KEY`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityError } from '../../../main/capabilities/error'
import { MODELS_URL } from '../main/asr'
import { createSpeechKey, createSpeechKeyStore } from '../main/speech-key'

/** `safeStorage`'s shape, with encryption that is just a reversible marker. */
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buf: Buffer) => buf.toString().replace(/^enc:/, ''),
}

const KEY = 'hv_0123456789abcdefghijklmnopqrstuv'

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
    await store.write(KEY)

    expect(await readFile(file, 'utf8')).not.toContain(KEY)
    expect(await store.read()).toBe(KEY)

    await store.write(null)
    expect(await store.read()).toBeNull()
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('refuses to write when the platform cannot encrypt, leaving nothing behind', async () => {
    const store = createSpeechKeyStore(file, { ...storage, isEncryptionAvailable: () => false })

    await expect(store.write(KEY)).rejects.toBeInstanceOf(CapabilityError)
    await expect(readFile(file, 'utf8')).rejects.toThrow()
    // Removing the key needs no keychain.
    await expect(store.write(null)).resolves.toBeUndefined()
  })

  it('reads a file the keychain can no longer decrypt as no key', async () => {
    await createSpeechKeyStore(file, storage).write(KEY)
    const rekeyed = createSpeechKeyStore(file, {
      ...storage,
      decryptString: () => {
        throw new Error('keychain re-keyed')
      },
    })
    expect(await rekeyed.read()).toBeNull()
  })
})

describe('the key in use', () => {
  function speechKey(vaultEnv: Record<string, string> = {}) {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ data: [] }))
    const changed = vi.fn()
    const key = createSpeechKey({
      store: createSpeechKeyStore(file, storage),
      vaultEnv: async () => vaultEnv,
      fetch,
      changed,
    })
    return { key, fetch, changed }
  }

  it("is the app's key first, then the vault's SYV_API_KEY, then none", async () => {
    const { key } = speechKey({ SYV_API_KEY: 'hv_from_the_vault_env_local' })
    expect(await key.resolve()).toBe('hv_from_the_vault_env_local')
    expect(await key.status()).toEqual({ set: true, source: 'vault' })

    await key.set(KEY)
    expect(await key.resolve()).toBe(KEY)
    expect(await key.status()).toEqual({ set: true, source: 'app' })

    await key.clear()
    expect(await key.status()).toEqual({ set: true, source: 'vault' })

    const none = speechKey({ SYV_API_KEY: '' }).key
    expect(await none.resolve()).toBeNull()
    expect(await none.status()).toEqual({ set: false, source: null })
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
