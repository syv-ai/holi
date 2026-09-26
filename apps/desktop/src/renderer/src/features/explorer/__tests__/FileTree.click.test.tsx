/**
 * What a click on a row does, with and without modifiers.
 *
 * ⌘-click opens a file in a new pane, the way an editor's ⌘-click on a link
 * does, so the selection toggle is ⌘⇧-click. ⇧-click selects a range, and a
 * plain click selects the row and opens a preview.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { getDefaultStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { fireEvent, render } from '@/test/render'
import { FileTree } from '../FileTree'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '../../../state/vaults'

const REMOTE = 'syv-ai/holi'
const EMPTY = emptyVaultSnapshot()
const store = getDefaultStore()

vi.mock('../../../lib/trpc', () => ({
  trpc: { vaults: { snapshot: { query: () => Promise.resolve(EMPTY) } } },
}))

function tree(docs: string[]) {
  store.set(activeRemoteAtom, REMOTE)
  store.set(vaultsAtom, [{ remote: REMOTE, path: '/vault' } as never])
  store.set(snapshotAtom, {
    ...EMPTY,
    docs: docs.map((path) => ({ path, kind: 'note' as const, updatedAt: '' })),
  })
  const onOpenPreview = vi.fn()
  const onOpenInNewPane = vi.fn()
  render(
    <FileTree
      activePath={null}
      onOpenPreview={onOpenPreview}
      onOpenPinned={() => {}}
      onOpenInNewPane={onOpenInNewPane}
    />,
  )
  return { onOpenPreview, onOpenInNewPane }
}

const row = (path: string) => document.querySelector(`[data-path="${path}"]`)!
const selected = (path: string) => row(path).getAttribute('aria-selected') === 'true'

test('a plain click selects the file and opens a preview', () => {
  const { onOpenPreview, onOpenInNewPane } = tree(['a.md'])

  fireEvent.click(row('a.md'))

  expect(selected('a.md')).toBe(true)
  expect(onOpenPreview).toHaveBeenCalledWith('a.md')
  expect(onOpenInNewPane).not.toHaveBeenCalled()
})

test('⌘-click opens the file in a new pane, and not as a preview', () => {
  const { onOpenPreview, onOpenInNewPane } = tree(['a.md', 'b.md'])

  fireEvent.click(row('b.md'), { metaKey: true })

  expect(onOpenInNewPane).toHaveBeenCalledWith('b.md')
  expect(onOpenPreview).not.toHaveBeenCalled()
})

test('⌘⇧-click toggles one file in and out of the selection, opening nothing', () => {
  const { onOpenPreview, onOpenInNewPane } = tree(['a.md', 'b.md', 'c.md'])

  fireEvent.click(row('a.md'))
  onOpenPreview.mockClear()
  fireEvent.click(row('c.md'), { metaKey: true, shiftKey: true })

  // A toggle, not a range: b.md between them stays out.
  expect([selected('a.md'), selected('b.md'), selected('c.md')]).toEqual([true, false, true])

  fireEvent.click(row('c.md'), { metaKey: true, shiftKey: true })
  expect(selected('c.md')).toBe(false)
  expect(onOpenPreview).not.toHaveBeenCalled()
  expect(onOpenInNewPane).not.toHaveBeenCalled()
})

test('⇧-click selects the range from the last clicked row, opening nothing', () => {
  const { onOpenPreview } = tree(['a.md', 'b.md', 'c.md', 'd.md'])

  fireEvent.click(row('b.md'))
  onOpenPreview.mockClear()
  fireEvent.click(row('d.md'), { shiftKey: true })

  expect(['a.md', 'b.md', 'c.md', 'd.md'].map(selected)).toEqual([false, true, true, true])
  expect(onOpenPreview).not.toHaveBeenCalled()
})

test('a click on a folder opens it and shows its contents', () => {
  tree(['notes/a.md'])

  expect(document.querySelector('[data-path="notes/a.md"]')).toBeNull()
  fireEvent.click(row('notes'))

  expect(row('notes').getAttribute('aria-expanded')).toBe('true')
  expect(row('notes/a.md')).not.toBeNull()
})
