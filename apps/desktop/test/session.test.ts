import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createSessionStore, type SessionCrypto } from '../src/main/session'

/** Reversible fake standing in for Electron safeStorage. */
const fakeCrypto: SessionCrypto = {
  encrypt: (s) => Buffer.from(s, 'utf8').reverse(),
  decrypt: (b) => Buffer.from(b).reverse().toString('utf8'),
}

const dir = mkdtempSync(join(tmpdir(), 'holi-session-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('session store', () => {
  it('save → load round-trips the session', () => {
    const store = createSessionStore(join(dir, 'a.bin'), fakeCrypto)
    const session = {
      token: 'tok-123',
      userId: 'u1',
      email: 'n@syv.ai',
      name: 'N',
      cachedAt: '2026-07-12T00:00:00.000Z',
    }
    store.save(session)
    expect(store.load()).toEqual(session)
  })

  it('load returns null when nothing saved', () => {
    const store = createSessionStore(join(dir, 'missing.bin'), fakeCrypto)
    expect(store.load()).toBeNull()
  })

  it('clear removes the session', () => {
    const store = createSessionStore(join(dir, 'c.bin'), fakeCrypto)
    store.save({ token: 't', userId: 'u', email: 'e', name: null, cachedAt: 'x' })
    store.clear()
    expect(store.load()).toBeNull()
  })

  it('the token is not stored in plaintext on disk', () => {
    const file = join(dir, 'd.bin')
    const store = createSessionStore(file, fakeCrypto)
    store.save({ token: 'super-secret', userId: 'u', email: 'e', name: null, cachedAt: 'x' })
    const raw = readFileSync(file, 'utf8')
    expect(raw.includes('super-secret')).toBe(false)
  })
})
