/**
 * A note's own frontmatter emoji replaces its type glyph in the tree (FR-12b).
 *
 * The snapshot carries the icon (`noteIcon` derives it during the scan), so the
 * tree stays a pure projection — there is no icon state here to get out of sync.
 */
import { getDefaultStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { render, screen } from '@/test/render'
import { FileTree } from '../FileTree'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '../../../state/vaults'

const REMOTE = 'syv-ai/holi'
const EMPTY = { docs: [], tasks: [], broken: [], files: [], dirs: [] }
const store = getDefaultStore()

vi.mock('../../../lib/trpc', () => ({
  trpc: { vaults: { snapshot: { query: () => Promise.resolve(EMPTY) } } },
}))

function tree(docs: { path: string; icon?: string }[]) {
  store.set(activeRemoteAtom, REMOTE)
  store.set(vaultsAtom, [{ remote: REMOTE, path: '/vault' } as never])
  store.set(snapshotAtom, {
    ...EMPTY,
    docs: docs.map((d) => ({ ...d, kind: 'note' as const, updatedAt: '' })),
  })
  return render(
    <FileTree
      activePath={null}
      onOpenPreview={() => {}}
      onOpenPinned={() => {}}
      onOpenInNewPane={() => {}}
    />,
  )
}

const rowFor = (path: string) => document.querySelector(`[data-path="${path}"]`)!

beforeEach(() => {
  store.set(snapshotAtom, EMPTY)
})

test('a note with an icon shows the emoji instead of its type glyph', () => {
  tree([{ path: 'roadmap.md', icon: '🎯' }])

  const row = rowFor('roadmap.md')
  expect(row.textContent).toContain('🎯')
  // The markdown glyph is an <svg>; the emoji stands in its place, it does not
  // sit next to it.
  expect(row.querySelector('svg')).toBeNull()
})

test('a note without one keeps the markdown glyph', () => {
  tree([{ path: 'plain.md' }])

  const row = rowFor('plain.md')
  expect(row.textContent).not.toContain('🎯')
  expect(row.querySelector('svg')).not.toBeNull()
})

test('the emoji does not leak into the row label', () => {
  tree([{ path: 'roadmap.md', icon: '🎯' }])

  // The name is still the filename — the icon lives in frontmatter, so nothing
  // has to be stripped out of it.
  expect(screen.getByText('roadmap.md')).toBeTruthy()
})
