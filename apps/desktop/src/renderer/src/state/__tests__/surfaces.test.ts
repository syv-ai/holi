import { emptyVaultSnapshot } from '@holi/shared'
import { createStore } from 'jotai'
import { describe, expect, test } from 'vitest'
import type { PathClaim } from '@/state/plugin-types'
import { coreContributionAtom } from '@/state/plugins'
import {
  activeSurfaceIdAtom,
  closeSurfaceTabsAtom,
  closeSurfaceTabAtom,
  shellTabForPathAtom,
  surfaceTabIdsAtom,
} from '@/state/surfaces'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { openInSplit, openTab, emptyWorkspace } from '@/state/shell-workspace'
import { sessionKey, tabKey } from '@/state/tab-descriptor'
import { snapshotAtom } from '@/state/vaults'

const glyph = () => null

/** A community plugin's folder documents (Prezzi's decks) and a vault app. */
const CLAIMS: PathClaim[] = [
  {
    match: (path) => path.endsWith('.deck'),
    folder: { surface: 'plugin-document', entry: 'slides.md' },
    decorate: { icon: glyph, name: (path) => path, suffix: () => '.deck' },
  },
  {
    match: (path) => path.endsWith('.app'),
    folder: { surface: 'app', entry: 'index.html' },
  },
]

function storeWith(files: string[]) {
  const store = createStore()
  store.set(coreContributionAtom, { surfaces: [], rail: [], claims: CLAIMS })
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    files: files.map((path) => ({ path })) as never,
  })
  return store
}

describe('surface tabs in the shell workspace', () => {
  test('tracks all split members, focuses the active member, and closes programmatically', () => {
    const store = storeWith([])
    const first = tabKey({ kind: 'surface', surface: 'plugin-document', id: 'one.deck' })
    const second = tabKey({ kind: 'surface', surface: 'plugin-document', id: 'two.deck' })
    store.set(shellWorkspaceAtom, openInSplit(openTab(emptyWorkspace(), first), second))

    expect(store.get(surfaceTabIdsAtom('plugin-document'))).toEqual(['one.deck', 'two.deck'])
    expect(store.get(activeSurfaceIdAtom('plugin-document'))).toBe('two.deck')
    store.set(closeSurfaceTabsAtom, 'plugin-document', ['one.deck'])
    expect(store.get(surfaceTabIdsAtom('plugin-document'))).toEqual(['one.deck'])
  })
})

test('vault-app descriptors keep the app surface lifecycle and close behavior', () => {
  const store = storeWith([])
  const first = 'one.app'
  const second = 'two.app'
  store.set(shellWorkspaceAtom, openInSplit(openTab(emptyWorkspace(), first), second))
  expect(store.get(surfaceTabIdsAtom('app'))).toEqual([first, second])
  expect(store.get(activeSurfaceIdAtom('app'))).toBe(second)
  store.set(closeSurfaceTabAtom, 'app', second)
  expect(store.get(surfaceTabIdsAtom('app'))).toEqual([first])
  store.set(closeSurfaceTabsAtom, 'app', [])
  expect(store.get(surfaceTabIdsAtom('app'))).toEqual([])
})

describe('activeSurfaceIdAtom', () => {
  test('reads the focused session selection for its owning surface', () => {
    const store = storeWith([])
    const key = sessionKey({ owner: 'agent', id: 'session:codex-session' })
    store.set(shellWorkspaceAtom, (ws) => openTab(ws, key))

    expect(store.get(activeSurfaceIdAtom('agent'))).toBe('session:codex-session')
    expect(store.get(activeSurfaceIdAtom('browser'))).toBeNull()
  })
})

describe('shellTabForPathAtom', () => {
  test("a plugin's folder document opens as the plugin's surface", () => {
    const tabFor = storeWith(['talk.deck/slides.md']).get(shellTabForPathAtom)
    expect(tabFor('talk.deck')).toEqual({
      kind: 'surface',
      surface: 'plugin-document',
      id: 'talk.deck',
    })
  })

  test('a folder without its entry file is no document yet', () => {
    const tabFor = storeWith(['talk.deck/notes.md']).get(shellTabForPathAtom)
    expect(tabFor('talk.deck')).toEqual({ kind: 'doc', path: 'talk.deck' })
  })

  test('a vault app keeps its own tab, and a note stays a note', () => {
    const tabFor = storeWith(['retro.app/index.html', 'a.md']).get(shellTabForPathAtom)
    expect(tabFor('retro.app')).toEqual({ kind: 'vault-app', path: 'retro.app' })
    expect(tabFor('a.md')).toEqual({ kind: 'doc', path: 'a.md' })
  })
})
