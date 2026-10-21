/**
 * The tree from the keyboard: one tab stop, moved by the arrows, with ⇧
 * extending the selection and the keys the row menu advertises.
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
  trpc: {
    notes: { backrefsMany: { query: () => Promise.resolve([]) } },
    vaults: { snapshot: { query: () => Promise.resolve(EMPTY) } },
  },
}))

function tree(docs: string[]) {
  store.set(activeRemoteAtom, REMOTE)
  store.set(vaultsAtom, [{ remote: REMOTE, path: '/vault' } as never])
  store.set(snapshotAtom, {
    ...EMPTY,
    docs: docs.map((path) => ({ path, kind: 'note' as const, updatedAt: '' })),
  })
  const onOpenPreview = vi.fn()
  render(
    <FileTree
      activePath={null}
      onOpenPreview={onOpenPreview}
      onOpenPinned={() => {}}
      onOpenInNewPane={() => {}}
    />,
  )
  return { onOpenPreview }
}

const row = (path: string) => document.querySelector<HTMLElement>(`[data-path="${path}"]`)!
const selected = (path: string) => row(path).getAttribute('aria-selected') === 'true'
const tabStop = () =>
  document.querySelector('[role="treeitem"][tabindex="0"]')?.getAttribute('data-path')

test('the arrows move the one tab stop and the selection with it', () => {
  tree(['a.md', 'b.md', 'c.md'])
  expect(tabStop()).toBe('a.md')

  fireEvent.keyDown(row('a.md'), { key: 'ArrowDown' })

  expect(tabStop()).toBe('b.md')
  expect([selected('a.md'), selected('b.md')]).toEqual([false, true])
})

test('⇧ with an arrow extends the selection from the anchor', () => {
  tree(['a.md', 'b.md', 'c.md'])
  fireEvent.click(row('a.md'))

  fireEvent.keyDown(row('a.md'), { key: 'ArrowDown', shiftKey: true })
  fireEvent.keyDown(row('b.md'), { key: 'ArrowDown', shiftKey: true })

  expect(['a.md', 'b.md', 'c.md'].map(selected)).toEqual([true, true, true])
})

test('→ opens a folder and ← closes it again', () => {
  tree(['notes/a.md'])

  fireEvent.keyDown(row('notes'), { key: 'ArrowRight' })
  expect(row('notes').getAttribute('aria-expanded')).toBe('true')

  fireEvent.keyDown(row('notes'), { key: 'ArrowLeft' })
  expect(row('notes').getAttribute('aria-expanded')).toBe('false')
})

test('Enter opens the focused file', () => {
  const { onOpenPreview } = tree(['a.md'])

  fireEvent.keyDown(row('a.md'), { key: 'Enter' })

  expect(onOpenPreview).toHaveBeenCalledWith('a.md')
})

test('typing a name jumps to the row it begins', () => {
  tree(['alpha.md', 'beta.md', 'gamma.md'])

  fireEvent.keyDown(row('alpha.md'), { key: 'g' })

  expect(tabStop()).toBe('gamma.md')
  expect(selected('gamma.md')).toBe(true)
})

test('F2 opens the rename field with the name as listed, without .md', () => {
  tree(['plan.md'])

  fireEvent.keyDown(row('plan.md'), { key: 'F2' })

  expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('plan')
})

test('⌫ on a multi-selection asks to delete all of it', async () => {
  tree(['a.md', 'b.md'])
  fireEvent.click(row('a.md'))
  fireEvent.click(row('b.md'), { shiftKey: true })

  fireEvent.keyDown(row('b.md'), { key: 'Backspace' })

  await vi.waitFor(() => expect(document.body.textContent).toMatch(/Delete 2 files\?/))
})
