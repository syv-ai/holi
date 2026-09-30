/**
 * An app bundle in the tree: one row that opens the app, whose files
 * show only once its contents are expanded.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { getDefaultStore } from 'jotai'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/render'
import { FileTree } from '../FileTree'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '../../../state/vaults'

const REMOTE = 'syv-ai/holi'
const EMPTY = emptyVaultSnapshot()
const store = getDefaultStore()

vi.mock('../../../lib/trpc', () => ({
  trpc: { vaults: { snapshot: { query: () => Promise.resolve(EMPTY) } } },
}))

const FINISHED = ['Finance/Budget.app/index.html', 'Finance/Budget.app/app.yaml']

function tree(files: string[]) {
  const open = { preview: vi.fn(), pinned: vi.fn(), pane: vi.fn() }
  store.set(activeRemoteAtom, REMOTE)
  store.set(vaultsAtom, [{ remote: REMOTE, path: '/vault' } as never])
  store.set(snapshotAtom, {
    ...EMPTY,
    docs: [{ path: 'Finance/2026.md', kind: 'note', updatedAt: '' }],
    files: files.map((path) => ({ path, updatedAt: '' })),
  })
  render(
    <FileTree
      activePath="Finance/2026.md"
      onOpenPreview={open.preview}
      onOpenPinned={open.pinned}
      onOpenInNewPane={open.pane}
    />,
  )
  return open
}

const rowFor = (path: string) => document.querySelector<HTMLElement>(`[data-path="${path}"]`)

beforeEach(() => {
  store.set(snapshotAtom, EMPTY)
})

test('is one row named without .app, and its files are not listed', () => {
  tree(FINISHED)
  expect(rowFor('Finance/Budget.app')?.textContent).toBe('Budget')
  expect(rowFor('Finance/Budget.app/index.html')).toBeNull()
})

test('a click opens the app rather than expanding it', async () => {
  const open = tree(FINISHED)
  await userEvent.click(rowFor('Finance/Budget.app')!)
  expect(open.preview).toHaveBeenCalledWith('Finance/Budget.app')
  expect(rowFor('Finance/Budget.app/index.html')).toBeNull()
})

test('⌘-click opens it in a new pane', () => {
  const open = tree(FINISHED)
  fireEvent.click(rowFor('Finance/Budget.app')!, { metaKey: true })
  expect(open.pane).toHaveBeenCalledWith('Finance/Budget.app')
})

test('→ shows its contents, and ← hides them again', async () => {
  tree(FINISHED)
  rowFor('Finance/Budget.app')!.focus()
  await userEvent.keyboard('{ArrowRight}')
  expect(rowFor('Finance/Budget.app/index.html')).not.toBeNull()
  await userEvent.keyboard('{ArrowLeft}')
  expect(rowFor('Finance/Budget.app')?.getAttribute('aria-expanded')).toBe('false')
})

test('Show App Files in its menu lists its files', async () => {
  tree(FINISHED)
  await userEvent.pointer({ target: rowFor('Finance/Budget.app')!, keys: '[MouseRight]' })
  await userEvent.click(await screen.findByText('Show App Files'))
  expect(rowFor('Finance/Budget.app/app.yaml')).not.toBeNull()
})

test('an unfinished app offers Finish this app instead of Open', async () => {
  tree(['Finance/Budget.app/index.html'])
  await userEvent.pointer({ target: rowFor('Finance/Budget.app')!, keys: '[MouseRight]' })
  expect(await screen.findByText('Finish this app')).toBeTruthy()
  expect(screen.queryByText('Open')).toBeNull()
})

test('a click on an unfinished app shows its files rather than opening it', async () => {
  const open = tree(['Finance/Budget.app/index.html'])
  await userEvent.click(rowFor('Finance/Budget.app')!)
  expect(open.preview).not.toHaveBeenCalled()
  expect(rowFor('Finance/Budget.app/index.html')).not.toBeNull()
})
