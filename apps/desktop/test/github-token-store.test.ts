import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TokenStore, type SafeStorageLike, type StoredAuth } from '../src/main/github/token-store'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'holi-tok-'))
  dirs.push(d)
  return join(d, 'github-auth.enc')
}

/**
 * A stand-in for Electron's `safeStorage`.
 *
 * Deliberately **not** the identity function: a store that "worked" by writing
 * the plaintext straight through would pass an identity-backed round-trip test,
 * and refusing to write plaintext is the one thing this module exists to do.
 */
const MARKER = 'enc:'

interface FakeStorage extends SafeStorageLike {
  available: boolean
  decryptThrows: boolean
  encryptionThrows: boolean
  backend: string
}

function fakeStorage(): FakeStorage {
  const s: FakeStorage = {
    available: true,
    decryptThrows: false,
    encryptionThrows: false,
    backend: 'gnome_libsecret',
    getSelectedStorageBackend: () => s.backend,
    isEncryptionAvailable: () => s.available,
    encryptString: (plain) => {
      if (s.encryptionThrows) throw new Error(`native secret ${TOKEN}`)
      return Buffer.from(MARKER + Buffer.from(plain, 'utf8').toString('base64'), 'utf8')
    },
    decryptString: (encrypted) => {
      if (s.decryptThrows) throw new Error('keychain item could not be decrypted')
      const text = encrypted.toString('utf8')
      if (!text.startsWith(MARKER)) throw new Error('not encrypted by this storage')
      return Buffer.from(text.slice(MARKER.length), 'base64').toString('utf8')
    },
  }
  return s
}

const TOKEN = 'gho_16C7e42F292c6912E7710c838347Ae178B4a'

const auth = (over: Partial<StoredAuth> = {}): StoredAuth => ({
  token: TOKEN,
  accountId: 583231,
  login: 'nthomsencph',
  name: 'Ada Holm',
  avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
  scopes: ['repo', 'read:user', 'read:org'],
  ...over,
})

describe('TokenStore', () => {
  it('round-trips an auth record', async () => {
    const store = new TokenStore(await scratch(), fakeStorage())
    await store.write(auth())
    expect(await store.read()).toEqual(auth())
  })

  it('writes no plaintext token to disk', async () => {
    // The assertion that actually pins encrypted storage. Read the raw bytes rather
    // than going back through the store, because the store is the thing on trial.
    const file = await scratch()
    await new TokenStore(file, fakeStorage()).write(auth())

    const bytes = await readFile(file)
    expect(bytes.includes(TOKEN)).toBe(false)
    expect(bytes.includes('nthomsencph')).toBe(false)
  })

  it('stages a unique restrictive ciphertext without replacing the prior file', async () => {
    const file = await scratch()
    const store = new TokenStore(file, fakeStorage())
    await store.write(auth({ token: 'prior-token' }))
    const prior = await readFile(file)
    const prepared = await store.prepare(auth({ token: 'replacement-token' }))
    expect(await readFile(file)).toEqual(prior)
    const entries = await readdir(join(file, '..'))
    const stagedName = entries.find((entry) => entry !== 'github-auth.enc')
    expect(stagedName).toMatch(/^github-auth\.enc\.[0-9a-f-]+\.tmp$/)
    if (process.platform !== 'win32')
      expect((await stat(join(file, '..', stagedName!))).mode & 0o777).toBe(0o600)
    await prepared.discard()
    expect(await readdir(join(file, '..'))).toEqual(['github-auth.enc'])
    expect(await readFile(file)).toEqual(prior)
  })

  it('preserves an existing destination and removes only its staged file after replace failure', async () => {
    const file = await scratch()
    await mkdir(file)
    await writeFile(join(file, 'keep'), 'unrelated')
    const store = new TokenStore(file, fakeStorage())
    const prepared = await store.prepare(auth())
    const entries = await readdir(join(file, '..'))
    const stagedName = entries.find((entry) => entry !== 'github-auth.enc')
    expect(stagedName).toMatch(/^github-auth\.enc\.[0-9a-f-]+\.tmp$/)
    expect(() => prepared.publish()).toThrow()
    await prepared.discard()
    expect(await readFile(join(file, 'keep'), 'utf8')).toBe('unrelated')
    expect(await readdir(join(file, '..'))).toEqual(['github-auth.enc'])
  })

  it('does not follow or remove a pre-existing predictable staging symlink', async () => {
    const file = await scratch()
    const sentinel = join(file, '..', 'sentinel')
    const predictableStage = `${file}.tmp`
    await writeFile(sentinel, 'untouched')
    await symlink(sentinel, predictableStage)
    await new TokenStore(file, fakeStorage()).write(auth())
    expect(await readFile(sentinel, 'utf8')).toBe('untouched')
    expect((await lstat(predictableStage)).isSymbolicLink()).toBe(true)
  })

  it('reports staging write failures without leaving a partial file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-tok-'))
    dirs.push(dir)
    const file = join(dir, 'x'.repeat(300))
    const error = await new TokenStore(file, fakeStorage())
      .prepare(auth())
      .catch((caught: unknown) => caught as Error)
    expect(error).toMatchObject({ phase: 'write', backend: 'gnome_libsecret' })
    expect(await readdir(dir)).toEqual([])
  })

  it('reads null when the file does not exist', async () => {
    // First launch. Signed out is a state, not an error.
    expect(await new TokenStore(await scratch(), fakeStorage()).read()).toBeNull()
  })

  it('reads null when the file is corrupt', async () => {
    const file = await scratch()
    await writeFile(file, 'not json at all', 'utf8')
    expect(await new TokenStore(file, fakeStorage()).read()).toBeNull()
  })

  it('reads null when the envelope version is unknown', async () => {
    // A file written by a future format. Signing the user out is recoverable;
    // guessing at the bytes is not.
    const file = await scratch()
    await writeFile(file, JSON.stringify({ v: 99, data: 'ZW5jOg==' }), 'utf8')
    expect(await new TokenStore(file, fakeStorage()).read()).toBeNull()
  })

  it('reads null when decryption fails', async () => {
    // A keychain re-keyed by an OS upgrade. This must be a sign-out, not a
    // crash on launch — there is no way back from a crash on launch.
    const file = await scratch()
    const storage = fakeStorage()
    await new TokenStore(file, storage).write(auth())

    storage.decryptThrows = true
    expect(await new TokenStore(file, storage).read()).toBeNull()
  })

  it('throws EncryptionUnavailableError rather than writing plaintext', async () => {
    // Linux with no keyring, or macOS before app.whenReady(). A token in a
    // plaintext file is precisely what encrypted storage exists to prevent.
    const file = await scratch()
    const storage = fakeStorage()
    storage.available = false

    await expect(new TokenStore(file, storage).write(auth())).rejects.toMatchObject({
      name: 'EncryptionUnavailableError',
      phase: 'availability',
      backend: 'gnome_libsecret',
      message: expect.stringMatching(
        /keyring is installed, running and unlocked.*session bus is available/i,
      ),
    })
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('refuses Electron basic_text even when it reports encryption available', async () => {
    const file = await scratch()
    const storage = fakeStorage()
    storage.backend = 'basic_text'

    await expect(new TokenStore(file, storage).write(auth())).rejects.toMatchObject({
      name: 'EncryptionUnavailableError',
      backend: 'basic_text',
    })
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('reports encrypted-operation failures without native text or credentials', async () => {
    const storage = fakeStorage()
    storage.encryptionThrows = true

    const error = await new TokenStore(await scratch(), storage)
      .write(auth())
      .catch((caught: unknown) => caught as Error)
    expect(error).toMatchObject({
      name: 'TokenStorageError',
      phase: 'encryption',
      backend: 'gnome_libsecret',
    })
    expect(error.message).toContain('login keyring')
    expect(error.message).not.toContain(TOKEN)
  })

  it('bounds unknown backend labels and storage error details', async () => {
    const storage = fakeStorage()
    storage.backend = `secret ${TOKEN}`
    storage.encryptionThrows = true

    const error = await new TokenStore(await scratch(), storage)
      .write(auth())
      .catch((caught: unknown) => caught as Error)
    expect(error).toMatchObject({ backend: 'unknown' })
    expect(error.message).not.toContain(TOKEN)
  })

  it('reports filesystem persistence failures separately without native details', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-tok-'))
    dirs.push(dir)
    const parent = join(dir, 'not-a-directory')
    await writeFile(parent, 'block directory creation')
    const storage = fakeStorage()

    const error = await new TokenStore(join(parent, 'github-auth.enc'), storage)
      .write(auth())
      .catch((caught: unknown) => caught as Error)
    expect(error).toMatchObject({ phase: 'directory', backend: 'gnome_libsecret' })
    expect(error.message).toContain('write its user-data folder')
    expect(error.message).not.toContain(TOKEN)
  })

  it('clears the entry', async () => {
    const file = await scratch()
    const store = new TokenStore(file, fakeStorage())
    await store.write(auth())

    await store.clear()
    expect(await store.read()).toBeNull()
  })

  it('clears when nothing is stored', async () => {
    // Sign-out can be pressed twice, and the second press is not a failure.
    const store = new TokenStore(await scratch(), fakeStorage())
    await expect(store.clear()).resolves.toBeUndefined()
  })
})
