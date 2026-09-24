/**
 * What a modified click on a file row does.
 *
 * ⌘-click opens the file in a new pane beside the one you are in, the way an
 * editor's ⌘-click on a link does. That took ⌘ away from the selection, so ⇧
 * is the toggle now: ⇧-click adds a file to the selection or takes it out.
 * A plain click still opens a preview and nothing else.
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

test('⌘-click opens the file in a new pane, and not as a preview', () => {
  const { onOpenPreview, onOpenInNewPane } = tree(['a.md', 'b.md'])

  fireEvent.click(row('b.md'), { metaKey: true })

  expect(onOpenInNewPane).toHaveBeenCalledWith('b.md')
  expect(onOpenPreview).not.toHaveBeenCalled()
})

test('⇧-click toggles a file in and out of the selection, opening nothing', () => {
  const { onOpenPreview, onOpenInNewPane } = tree(['a.md', 'b.md', 'c.md'])

  fireEvent.click(row('a.md'))
  onOpenPreview.mockClear()
  fireEvent.click(row('c.md'), { shiftKey: true })

  // A toggle, not a range: b.md between them stays out.
  expect(selected('a.md')).toBe(true)
  expect(selected('b.md')).toBe(false)
  expect(selected('c.md')).toBe(true)

  fireEvent.click(row('c.md'), { shiftKey: true })
  expect(selected('c.md')).toBe(false)
  expect(onOpenPreview).not.toHaveBeenCalled()
  expect(onOpenInNewPane).not.toHaveBeenCalled()
})

test('a plain click still opens a preview', () => {
  const { onOpenPreview, onOpenInNewPane } = tree(['a.md'])

  fireEvent.click(row('a.md'))

  expect(onOpenPreview).toHaveBeenCalledWith('a.md')
  expect(onOpenInNewPane).not.toHaveBeenCalled()
})
