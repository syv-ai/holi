/**
 * Who is signed in, as the renderer understands it.
 *
 * Three values, not two: `undefined` means "not asked yet" and `null` means
 * "asked, and nobody is". `App` branches on all three — it renders nothing at
 * all for `undefined` — so collapsing them leaves the window permanently blank
 * on a cold start rather than showing the sign-in.
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import { installFakeHoli, type FakeHoli } from './helpers/fake-holi'
import { loadSessionAtom, sessionAtom, signOutAtom } from '../src/renderer/src/state/session'

let holi: FakeHoli | null = null
afterEach(() => {
  holi?.restore()
  holi = null
})

describe('session', () => {
  it('takes the viewer the router reports', async () => {
    holi = installFakeHoli((op) =>
      op.path === 'auth.status' ? { viewer: { login: 'nthomsencph' } } : undefined,
    )
    const store = createStore()

    await store.set(loadSessionAtom)

    expect(store.get(sessionAtom)).toEqual({ login: 'nthomsencph' })
  })

  it('reports signed out as null, never as "not asked yet"', async () => {
    // `auth.status` answers `{viewer: null}` for a machine with no keychain
    // entry. Storing that as `undefined` would leave App rendering null
    // forever, waiting for a load that already happened.
    holi = installFakeHoli(() => ({ viewer: null }))
    const store = createStore()

    await store.set(loadSessionAtom)

    expect(store.get(sessionAtom)).toBeNull()
  })

  it('clears the session on sign-out', async () => {
    holi = installFakeHoli((op) =>
      op.path === 'auth.status' ? { viewer: { login: 'nthomsencph' } } : { ok: true },
    )
    const store = createStore()
    await store.set(loadSessionAtom)

    await store.set(signOutAtom)

    expect(store.get(sessionAtom)).toBeNull()
    // FR-15: signing out drops the keychain entry, not the clones. A renderer
    // that also cleared the vault list would imply the checkouts had gone.
    expect(holi.calls.map((c) => c.path)).toEqual(['auth.status', 'auth.signOut'])
  })
})
