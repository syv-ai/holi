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
import { createClientStore } from '../main/credentials'
import { EncryptionUnavailableError, GoogleTokenStore } from '../main/token-store'

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
  email: 'ada@syv.ai',
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

describe("the person's own client, kept the same way", () => {
  const CLIENT = { id: 'own.apps.googleusercontent.com', secret: 'own-secret' }

  it('round-trips without the secret greppable on disk, and null deletes it', async () => {
    const clients = createClientStore(file, storage)
    await clients.write(CLIENT)

    expect(await readFile(file, 'utf8')).not.toContain('own-secret')
    expect(await clients.read()).toEqual(CLIENT)

    await clients.write(null)
    expect(await clients.read()).toBeNull()
  })

  it('refuses to write when the platform cannot encrypt, leaving nothing behind', async () => {
    const clients = createClientStore(file, { ...storage, isEncryptionAvailable: () => false })

    await expect(clients.write(CLIENT)).rejects.toBeInstanceOf(EncryptionUnavailableError)
    await expect(readFile(file, 'utf8')).rejects.toThrow()
    // Going back to the default client needs no keychain.
    await expect(clients.write(null)).resolves.toBeUndefined()
  })

  it('reads a legacy envelope and migrates its client alongside vault-owned clients', async () => {
    await writeFile(
      file,
      JSON.stringify({
        v: 1,
        data: storage.encryptString(JSON.stringify(CLIENT)).toString('base64'),
      }),
    )
    const clients = createClientStore(file, storage)
    expect(await clients.read()).toEqual(CLIENT)
    expect(await clients.readVault('owner/repo')).toBeNull()
    await clients.writeVault('owner/repo', { id: 'vault.apps.googleusercontent.com' })

    const restarted = createClientStore(file, storage)
    expect(await restarted.read()).toEqual(CLIENT)
    expect(await restarted.readVault('owner/repo')).toEqual({
      id: 'vault.apps.googleusercontent.com',
    })
    expect(await restarted.readVault('other/repo')).toBeNull()
    expect(await restarted.hasVault('owner/repo')).toBe(true)
    expect(await restarted.hasVault('other/repo')).toBe(false)
  })

  it('serializes independent vault updates and deletion without changing legacy provenance', async () => {
    const clients = createClientStore(file, storage)
    await clients.write(CLIENT)
    await Promise.all([
      clients.writeVault('one/repo', { id: 'one.apps.googleusercontent.com' }),
      clients.writeVault('two/repo', { id: 'two.apps.googleusercontent.com' }),
    ])
    await clients.writeVault('one/repo', null)
    await clients.write(null)

    expect(await clients.read()).toBeNull()
    expect(await clients.readVault('one/repo')).toBeNull()
    expect(await clients.hasVault('one/repo')).toBe(true)
    expect(await clients.hasVault('two/repo')).toBe(true)
    expect(await clients.readVault('two/repo')).toEqual({ id: 'two.apps.googleusercontent.com' })
  })

  it('preserves prior encrypted state when encryption is unavailable', async () => {
    const clients = createClientStore(file, storage)
    await clients.write(CLIENT)
    const before = await readFile(file, 'utf8')
    const unavailable = createClientStore(file, { ...storage, isEncryptionAvailable: () => false })

    await expect(unavailable.writeVault('owner/repo', CLIENT)).rejects.toBeInstanceOf(
      EncryptionUnavailableError,
    )
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await clients.read()).toEqual(CLIENT)
  })

  it('reads a file the keychain can no longer decrypt as no client', async () => {
    await createClientStore(file, storage).write(CLIENT)
    const rekeyed = createClientStore(file, {
      ...storage,
      decryptString: () => {
        throw new Error('keychain re-keyed')
      },
    })
    expect(await rekeyed.read()).toBeNull()
    await expect(rekeyed.writeVault('owner/repo', CLIENT)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).not.toBe('')
  })
})
