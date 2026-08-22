/**
 * `.holi/icons.json` decorates a tree row (D82).
 *
 * The snapshot carries the resolved map, so the tree stays a pure projection —
 * there is no icon state here to get out of sync, and one source means no
 * precedence to test.
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
  docs: string[],
  extra: { icons?: Record<string, string>; dirs?: string[]; files?: string[] } = {},
) {
  store.set(activeRemoteAtom, REMOTE)
  store.set(vaultsAtom, [{ remote: REMOTE, path: '/vault' } as never])
  store.set(snapshotAtom, {
    ...EMPTY,
    docs: docs.map((path) => ({ path, kind: 'note' as const, updatedAt: '' })),
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

test('a note with an entry shows the emoji instead of its type glyph', () => {
  tree(['roadmap.md'], { icons: { 'roadmap.md': '🎯' } })

  const slot = iconSlotOf('roadmap.md')
  expect(slot.textContent).toContain('🎯')
  // The markdown glyph is an <svg>; the emoji stands in its place, it does not
  // sit next to it.
  expect(slot.innerHTML).not.toContain('<svg')
})

test('a note without one keeps the markdown glyph', () => {
  tree(['plain.md'])

  const slot = iconSlotOf('plain.md')
  expect(slot.textContent).not.toContain('🎯')
  expect(slot.innerHTML).toContain('<svg')
})

test('the emoji does not leak into the row label', () => {
  tree(['roadmap.md'], { icons: { 'roadmap.md': '🎯' } })
  // The name is still the filename: the icon lives in a map keyed BY that name,
  // so there is nothing to strip out of it.
  expect(screen.getByText('roadmap.md')).toBeTruthy()
})

// The half frontmatter could never have served.
test('an entry decorates a folder', () => {
  tree(['Clients/acme.md'], { dirs: ['Clients'], icons: { Clients: '👥' } })

  const slot = iconSlotOf('Clients')
  expect(slot.textContent).toContain('👥')
  expect(slot.innerHTML).not.toContain('<svg')
})

test('an entry decorates a file that has no frontmatter at all', () => {
  // A PDF is not markdown, so the scan files it under `files` and it was never
  // reachable by a frontmatter rule.
  tree([], { files: ['spec.pdf'], icons: { 'spec.pdf': '📘' } })

  expect(iconSlotOf('spec.pdf').textContent).toContain('📘')
})

// A stale entry — the file it names was moved outside Holi — must be inert,
// which is the whole cost the map was accepted with.
test('an entry does not conjure a row for a path that is not there', () => {
  tree(['roadmap.md'], { icons: { 'ghost.md': '👻' } })

  expect(rowFor('roadmap.md')).not.toBeNull()
  expect(document.querySelector('[data-path="ghost.md"]')).toBeNull()
})
