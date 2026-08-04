/**
 * The Google keychain store — the two invariants it shares with the GitHub one.
 *
 * Both are the kind of property that stays true right up until a well-meaning
 * fallback is added, which is why they are pinned rather than assumed.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EncryptionUnavailableError, GoogleTokenStore } from '../src/main/google/token-store'

const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buf: Buffer) => buf.toString().replace(/^enc:/, ''),
}

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-google-store-'))
  file = join(dir, 'google-auth.enc')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const AUTH = {
  sub: 'sub-1',
  email: 'nicolai@syv.ai',
  refreshToken: 'rt-1',
  accessToken: 'at-1',
  expiresAt: 5_000,
  scopes: ['openid', 'email'],
}

describe('round-trip', () => {
  it('writes and reads an account back, keyed by sub', async () => {
    const store = new GoogleTokenStore(file, storage)
    await store.write({ 'sub-1': AUTH })

    expect(await store.read()).toEqual({ 'sub-1': AUTH })
  })

  it('reads as disconnected when the file does not exist', async () => {
    expect(await new GoogleTokenStore(file, storage).read()).toEqual({})
  })

  it('clears without complaint, twice', async () => {
    const store = new GoogleTokenStore(file, storage)
    await store.write({ 'sub-1': AUTH })
    await store.clear()
    await store.clear()

    expect(await store.read()).toEqual({})
  })
})

describe('it never writes plaintext', () => {
  it('refuses to write when the platform cannot encrypt', async () => {
    const store = new GoogleTokenStore(file, {
      ...storage,
      isEncryptionAvailable: () => false,
    })

    await expect(store.write({ 'sub-1': AUTH })).rejects.toBeInstanceOf(EncryptionUnavailableError)
    // And leaves nothing behind to be read as corrupt later.
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('leaves no refresh token greppable in the file it does write', async () => {
    const store = new GoogleTokenStore(file, storage)
    await store.write({ 'sub-1': AUTH })

    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain('rt-1')
  })
})

describe('an unreadable file is a disconnect, not a crash', () => {
  it('reads corrupt JSON as disconnected', async () => {
    await writeFile(file, 'not json at all')
    expect(await new GoogleTokenStore(file, storage).read()).toEqual({})
  })

  it('reads an envelope from a future version as disconnected', async () => {
    await writeFile(file, JSON.stringify({ v: 99, data: 'whatever' }))
    expect(await new GoogleTokenStore(file, storage).read()).toEqual({})
  })

  it('reads as disconnected when the keychain can no longer decrypt', async () => {
    const store = new GoogleTokenStore(file, storage)
    await store.write({ 'sub-1': AUTH })

    const rekeyed = new GoogleTokenStore(file, {
      ...storage,
      decryptString: () => {
        throw new Error('keychain re-keyed by an OS upgrade')
      },
    })
    expect(await rekeyed.read()).toEqual({})
  })

  it('drops only the malformed entry, keeping a readable one beside it', async () => {
    const store = new GoogleTokenStore(file, storage)
    // Write a valid one, then hand-craft a file with a broken sibling.
    await store.write({
      'sub-1': AUTH,
      'sub-2': { sub: 'sub-2', email: 'x@y.z' } as never,
    })

    expect(await store.read()).toEqual({ 'sub-1': AUTH })
  })
})
