import { emptyVaultSnapshot } from '@holi/shared'
import { createStore } from 'jotai'
import { describe, expect, test } from 'vitest'
import type { PathClaim } from '@/state/plugin-types'
import { coreContributionAtom } from '@/state/plugins'
import { shellTabForPathAtom } from '@/state/surfaces'
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
