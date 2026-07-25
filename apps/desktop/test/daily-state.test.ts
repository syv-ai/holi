/**
 * Daily notes, renderer side — path-based and personal-gated.
 *
 * The correctness that matters: no daily is created in a shared vault, an
 * unknown/offline collaborator check defaults to personal (offline-complete),
 * and the sweep commits only when it actually changed something.
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import type { VaultSnapshot } from '@holi/shared'
import { installFakeHoli, type FakeHoli } from './helpers/fake-holi'
import { workspaceAtom } from '../src/renderer/src/state/panes'
import { activeRemoteAtom } from '../src/renderer/src/state/vaults'
import { openTodaysDailyAtom, sweepDailyAtom } from '../src/renderer/src/state/daily'

let holi: FakeHoli | null = null
afterEach(() => {
  holi?.restore()
  holi = null
})

const collab = (n: number) => ({
  visibility: 'private',
  collaborators: Array.from({ length: n }, (_, i) => ({ login: `u${i}` })),
})
const snap = (path: string): VaultSnapshot => ({
  docs: [{ path, kind: 'note', updatedAt: '2026-07-21T00:00:00Z' }],
  tasks: [],
  broken: [],
  files: [],
})

describe('openTodaysDailyAtom', () => {
  it('creates and opens a pinned tab in a personal vault', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'github.collaborators') return collab(1)
      if (op.path === 'notes.getOrCreateDaily') return { path: '21-07-2026.md', created: true }
      if (op.path === 'vaults.snapshot') return snap('21-07-2026.md')
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'me/notes')

    expect(await store.set(openTodaysDailyAtom)).toBe('21-07-2026.md')
    expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([
      { kind: 'note', path: '21-07-2026.md' },
    ])
    expect(holi.calls.map((c) => c.path)).toContain('notes.getOrCreateDaily')
  })

  it('creates nothing in a shared vault (>1 collaborator)', async () => {
    holi = installFakeHoli((op) => (op.path === 'github.collaborators' ? collab(2) : undefined))
    const store = createStore()
    store.set(activeRemoteAtom, 'org/shared')

    expect(await store.set(openTodaysDailyAtom)).toBeNull()
    expect(holi.calls.map((c) => c.path)).not.toContain('notes.getOrCreateDaily')
  })

  it('treats an unreachable collaborator check as personal (offline-complete)', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'github.collaborators') throw new Error('offline')
      if (op.path === 'notes.getOrCreateDaily') return { path: '21-07-2026.md', created: false }
      if (op.path === 'vaults.snapshot') return snap('21-07-2026.md')
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'me/notes')

    expect(await store.set(openTodaysDailyAtom)).toBe('21-07-2026.md')
  })
})

describe('sweepDailyAtom', () => {
  it('commits once when the sweep changed something', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'github.collaborators') return collab(1)
      if (op.path === 'notes.sweepDaily') return { archived: 1, deleted: 0 }
      if (op.path === 'vaults.snapshot') return snap('x.md')
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'me/notes')

    await store.set(sweepDailyAtom)
    expect(holi.calls.map((c) => c.path)).toContain('sync.commitNow')
  })

  it('does not commit when the sweep was a no-op', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'github.collaborators') return collab(1)
      if (op.path === 'notes.sweepDaily') return { archived: 0, deleted: 0 }
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'me/notes')

    await store.set(sweepDailyAtom)
    expect(holi.calls.map((c) => c.path)).not.toContain('sync.commitNow')
  })
})
