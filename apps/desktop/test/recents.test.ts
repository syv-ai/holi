/**
 * Recents: the pure rules, and the per-vault atoms over them.
 */
import { createStore } from 'jotai'
import { describe, expect, it } from 'vitest'
import { prune, touch, type RecentEntry } from '../src/renderer/src/lib/recents'
import {
  recentOfTab,
  recentsAtom,
  recentsByVaultAtom,
  touchRecentAtom,
} from '../src/renderer/src/state/recents'
import { activeRemoteAtom, snapshotAtom } from '../src/renderer/src/state/vaults'
import { emptyVaultSnapshot } from '@holi/shared'

const path = (key: string): RecentEntry => ({ kind: 'path', key })

describe('touch', () => {
  it('puts a new entry first', () => {
    expect(touch([path('a')], path('b'))).toEqual([path('b'), path('a')])
  })

  it('moves an existing entry to the front without duplicating it', () => {
    expect(touch([path('a'), path('b'), path('c')], path('c'))).toEqual([
      path('c'),
      path('a'),
      path('b'),
    ])
  })

  it('tells kinds apart: a surface and a path with one key are two entries', () => {
    const list = touch([path('x')], { kind: 'surface', key: 'x' })
    expect(list).toHaveLength(2)
  })

  it("tells a surface's instances apart by id", () => {
    const app = (id: string): RecentEntry => ({ kind: 'surface', key: 'app', id })
    expect(touch([app('a.app')], app('b.app'))).toHaveLength(2)
    expect(touch([app('a.app')], app('a.app'))).toHaveLength(1)
  })

  it('caps the list', () => {
    const list = touch([path('a'), path('b'), path('c')], path('d'), 3)
    expect(list.map((e) => e.key)).toEqual(['d', 'a', 'b'])
  })
})

describe('prune', () => {
  it('drops what is no longer live and keeps the order', () => {
    const list = [path('a'), path('gone'), path('b')]
    expect(prune(list, (e) => e.key !== 'gone')).toEqual([path('a'), path('b')])
  })
})

describe('the per-vault atoms', () => {
  it('record into the active vault only', () => {
    const store = createStore()
    store.set(recentsByVaultAtom, {})
    store.set(activeRemoteAtom, 'o/a')

    store.set(touchRecentAtom, path('a.md'))
    store.set(activeRemoteAtom, 'o/b')
    store.set(touchRecentAtom, path('b.md'))

    expect(store.get(recentsByVaultAtom)).toEqual({ 'o/a': [path('a.md')], 'o/b': [path('b.md')] })
    expect(store.get(recentsAtom)).toEqual([path('b.md')])
  })

  it('record nothing with no vault open', () => {
    const store = createStore()
    store.set(recentsByVaultAtom, {})
    store.set(activeRemoteAtom, null)

    store.set(touchRecentAtom, path('a.md'))

    expect(store.get(recentsByVaultAtom)).toEqual({})
    expect(store.get(recentsAtom)).toEqual([])
  })
})

describe('pruning on write', () => {
  it('drops a dead session and a vanished path once the vault is scanned', () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'o/a')
    store.set(recentsByVaultAtom, {
      'o/a': [{ kind: 'session', key: 'gone' }, path('renamed.md'), path('kept.md')],
    })
    store.set(snapshotAtom, {
      ...emptyVaultSnapshot(),
      docs: [{ path: 'kept.md', kind: 'note', updatedAt: '' }],
    })

    store.set(touchRecentAtom, path('kept.md'))

    expect(store.get(recentsAtom)).toEqual([path('kept.md')])
  })

  it('keeps paths while the vault has not been scanned yet', () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'o/a')
    store.set(recentsByVaultAtom, { 'o/a': [path('a.md')] })

    store.set(touchRecentAtom, path('b.md'))

    expect(store.get(recentsAtom)).toEqual([path('b.md'), path('a.md')])
  })
})

describe('recentOfTab', () => {
  it('maps every tab kind', () => {
    expect(recentOfTab({ kind: 'note', path: 'a.md' })).toEqual(path('a.md'))
    expect(recentOfTab({ kind: 'surface', surface: 'app', id: 'plan.app' })).toEqual({
      kind: 'surface',
      key: 'app',
      id: 'plan.app',
    })
    expect(recentOfTab({ kind: 'surface', surface: 'agent', id: 't1' })).toEqual({
      kind: 'terminal',
      key: 't1',
    })
    expect(recentOfTab({ kind: 'surface', surface: 'board' })).toEqual({
      kind: 'surface',
      key: 'board',
    })
  })
})
