import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  EncryptionUnavailableError,
  TokenStore,
  type SafeStorageLike,
  type StoredAuth,
} from '../src/main/github/token-store'

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
}

function fakeStorage(): FakeStorage {
  const s: FakeStorage = {
    available: true,
    decryptThrows: false,
    isEncryptionAvailable: () => s.available,
    encryptString: (plain) =>
      Buffer.from(MARKER + Buffer.from(plain, 'utf8').toString('base64'), 'utf8'),
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
  name: 'Nicolai Thomsen',
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
    // The assertion that actually pins auth PRD FR-5. Read the raw bytes rather
    // than going back through the store, because the store is the thing on trial.
    const file = await scratch()
    await new TokenStore(file, fakeStorage()).write(auth())

    const bytes = await readFile(file)
    expect(bytes.includes(TOKEN)).toBe(false)
    expect(bytes.includes('nthomsencph')).toBe(false)
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
    // plaintext file is precisely what FR-5 exists to prevent.
    const file = await scratch()
    const storage = fakeStorage()
    storage.available = false

    await expect(new TokenStore(file, storage).write(auth())).rejects.toThrow(
      EncryptionUnavailableError,
    )
    await expect(readFile(file, 'utf8')).rejects.toThrow()
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
