/**
 * The renderer's read side of FR-12: what links here, fetched on demand for the
 * delete-preview dialog. Kept in a `.ts` atom rather than the component so the
 * "no vault, no query" guard is testable without a DOM.
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import { installFakeHoli, type FakeHoli } from './helpers/fake-holi'
import { activeRemoteAtom, backrefsFor } from '../src/renderer/src/state/vaults'

let holi: FakeHoli | null = null
afterEach(() => {
  holi?.restore()
  holi = null
})

describe('backrefsFor', () => {
  it('queries backrefs for the open vault', async () => {
    holi = installFakeHoli((op) =>
      op.path === 'notes.backrefs' ? [{ path: 'a.md', count: 2 }] : undefined,
    )
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')

    expect(await store.set(backrefsFor, 'b.md')).toEqual([{ path: 'a.md', count: 2 }])
  })

  it('returns an empty list with no vault open, without calling', async () => {
    holi = installFakeHoli()
    const store = createStore()

    expect(await store.set(backrefsFor, 'b.md')).toEqual([])
    expect(holi.calls).toEqual([])
  })
})
