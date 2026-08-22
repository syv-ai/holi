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
const EMPTY = { docs: [], tasks: [], broken: [], files: [], dirs: [], icons: {} }
const store = getDefaultStore()

vi.mock('../../../lib/trpc', () => ({
  trpc: { vaults: { snapshot: { query: () => Promise.resolve(EMPTY) } } },
}))

function tree(
  docs: { path: string; icon?: string }[],
  extra: { icons?: Record<string, string>; dirs?: string[]; files?: string[] } = {},
) {
  store.set(activeRemoteAtom, REMOTE)
  store.set(vaultsAtom, [{ remote: REMOTE, path: '/vault' } as never])
  store.set(snapshotAtom, {
    ...EMPTY,
    docs: docs.map((d) => ({ ...d, kind: 'note' as const, updatedAt: '' })),
    dirs: extra.dirs ?? [],
    files: (extra.files ?? []).map((path) => ({ path, updatedAt: '' })),
    icons: extra.icons ?? {},
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

/** The row's icon slot. The first `w-4` span is the expand chevron — a folder
 *  keeps that whatever its icon — so asserting on the row as a whole would test
 *  the chevron instead of the thing under test. */
const iconSlotOf = (path: string) => rowFor(path).querySelectorAll('span.flex.w-4')[1]!

beforeEach(() => {
  store.set(snapshotAtom, EMPTY)
})

test('a note with an icon shows the emoji instead of its type glyph', () => {
  tree([{ path: 'roadmap.md', icon: '🎯' }])

  const slot = iconSlotOf('roadmap.md')
  expect(slot.textContent).toContain('🎯')
  // The markdown glyph is an <svg>; the emoji stands in its place, it does not
  // sit next to it.
  expect(slot.innerHTML).not.toContain('<svg')
})

test('a note without one keeps the markdown glyph', () => {
  tree([{ path: 'plain.md' }])

  const slot = iconSlotOf('plain.md')
  expect(slot.textContent).not.toContain('🎯')
  expect(slot.innerHTML).toContain('<svg')
})

test('the emoji does not leak into the row label', () => {
  tree([{ path: 'roadmap.md', icon: '🎯' }])

  // The name is still the filename — the icon lives in frontmatter, so nothing
  // has to be stripped out of it.
  expect(screen.getByText('roadmap.md')).toBeTruthy()
})

// `.holi/icons.json` is the home for everything frontmatter cannot reach.
test('an icons.json entry decorates a folder', () => {
  tree([{ path: 'Clients/acme.md' }], { dirs: ['Clients'], icons: { Clients: '👥' } })

  const slot = iconSlotOf('Clients')
  expect(slot.textContent).toContain('👥')
  // The emoji REPLACES the folder glyph rather than sitting beside it.
  expect(slot.innerHTML).not.toContain('<svg')
})

test('an icons.json entry decorates a file that cannot carry frontmatter', () => {
  // A PDF is not markdown, so the scan puts it in `files`, never `docs` — there
  // is no DocMeta to hold an icon and the map is its only route to one.
  tree([], { files: ['spec.pdf'], icons: { 'spec.pdf': '📘' } })

  expect(iconSlotOf('spec.pdf').textContent).toContain('📘')
})

test('a map entry does not conjure a row for a path that is not there', () => {
  tree([{ path: 'roadmap.md' }], { icons: { 'ghost.md': '👻' } })

  expect(rowFor('roadmap.md')).not.toBeNull()
  expect(document.querySelector('[data-path="ghost.md"]')).toBeNull()
})

test("a note's own frontmatter outranks the map", () => {
  tree([{ path: 'roadmap.md', icon: '🎯' }], { icons: { 'roadmap.md': '👥' } })

  const slot = iconSlotOf('roadmap.md')
  expect(slot.textContent).toContain('🎯')
  expect(slot.textContent).not.toContain('👥')
})
