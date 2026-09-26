/**
 * Files dropped on the tree. There is one mechanism: a row's drag is a native
 * OS drag, so every drop arrives as files, and the path decides. A source
 * inside this vault is a move; anything else is an import. The folder under
 * the pointer is the destination.
 *
 * `preventDefault` is asserted directly where it matters: an unclaimed file
 * drop is a navigation, and Electron answers a navigation with a new window.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { getDefaultStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { render } from '@/test/render'
import { FileTree } from '../FileTree'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '../../../state/vaults'

const importMock = vi.fn((_input: unknown) => Promise.resolve({ skipped: [] }))
const moveMock = vi.fn((_input: unknown) => Promise.resolve(undefined))
const snapshotMock = vi.fn(() => Promise.resolve(EMPTY))

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    notes: {
      importFiles: { mutate: (input: unknown) => importMock(input) },
      move: { mutate: (input: unknown) => moveMock(input) },
    },
    sync: { commitNow: { mutate: () => Promise.resolve(undefined) } },
    vaults: { snapshot: { query: () => snapshotMock() } },
  },
}))

const REMOTE = 'syv-ai/holi'
const VAULT_PATH = '/Users/ada/vaults/holi'
const EMPTY = emptyVaultSnapshot()
const store = getDefaultStore()

/** jsdom implements no `DataTransfer`; this is the subset the tree reads. The
 *  `Files` entry in `types` is what marks a drag as coming from the OS. */
class FakeDataTransfer {
  dropEffect = 'none'
  effectAllowed = 'all'
  constructor(
    readonly files: { name: string }[] = [{ name: 'paper.pdf' }],
    readonly types: string[] = ['Files'],
  ) {}
  getData(): string {
    return ''
  }
}

/** Built by hand rather than via `fireEvent.drop`, so the test does not depend
 *  on how Testing Library papers over jsdom's missing `DragEvent`. */
function dragEvent(type: string, dataTransfer: FakeDataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

function tree() {
  store.set(activeRemoteAtom, REMOTE)
  store.set(vaultsAtom, [{ remote: REMOTE, path: VAULT_PATH } as never])
  store.set(snapshotAtom, {
    ...EMPTY,
    dirs: ['notes'],
    docs: [
      { path: 'notes/a.md', kind: 'note', updatedAt: '' },
      { path: 'b.md', kind: 'note', updatedAt: '' },
    ],
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
  importMock.mockClear()
  moveMock.mockClear()
  window.holi = {
    pathForFile: (f: { name: string }) => `/Users/ada/Downloads/${f.name}`,
  } as never
})

test('a file dropped on a folder row is claimed by the tree, not by the browser', () => {
  // An unprevented file drop is a navigation, and Electron answers a
  // navigation with a window.
  tree()
  const event = dragEvent('drop', new FakeDataTransfer())

  rowFor('notes').dispatchEvent(event)

  expect(event.defaultPrevented).toBe(true)
})

test('a file dropped on a folder row imports into that folder', () => {
  tree()

  rowFor('notes').dispatchEvent(dragEvent('drop', new FakeDataTransfer()))

  expect(importMock).toHaveBeenCalledWith(
    expect.objectContaining({ sources: ['/Users/ada/Downloads/paper.pdf'], folder: 'notes' }),
  )
})

test('a file dropped on a file row imports into the folder that file is in', () => {
  // `b.md` sits at the vault root, so its folder is '' — the same rule as
  // dropping on empty space, reached through a row rather than around it.
  tree()

  rowFor('b.md').dispatchEvent(dragEvent('drop', new FakeDataTransfer()))

  expect(importMock).toHaveBeenCalledWith(expect.objectContaining({ folder: '' }))
})

test('a file dragged out of this vault and dropped on a folder row is a move, not an import', async () => {
  // The in-tree move arrives as a file drop: a row's drag is a native
  // `startDrag`, so what comes back carries an absolute path inside this vault.
  tree()
  const dt = new FakeDataTransfer([{ name: 'b.md' }])
  window.holi = { pathForFile: () => `${VAULT_PATH}/b.md` } as never

  rowFor('notes').dispatchEvent(dragEvent('drop', dt))

  // A move flushes buffers and commits before it renames, so the call the test
  // is waiting for is two awaits deep — unlike the import, which is immediate.
  await vi.waitFor(() =>
    expect(moveMock).toHaveBeenCalledWith(
      expect.objectContaining({ moves: [{ from: 'b.md', to: 'notes/b.md' }] }),
    ),
  )
  expect(importMock).not.toHaveBeenCalled()
})

test('a dragover carrying files over a row is accepted, so the drop can fire at all', () => {
  tree()
  const event = dragEvent('dragover', new FakeDataTransfer())

  rowFor('notes').dispatchEvent(event)

  expect(event.defaultPrevented).toBe(true)
})

test('a dragover carrying something other than files is refused', () => {
  // A dragged text selection is nothing the tree can take, so no folder
  // lights up for it.
  tree()
  const event = dragEvent('dragover', new FakeDataTransfer([], ['text/plain']))

  rowFor('notes').dispatchEvent(event)

  expect(event.defaultPrevented).toBe(false)
})

test('a file dropped on the folder it is already in is refused, moving nothing', async () => {
  tree()
  window.holi = { pathForFile: () => `${VAULT_PATH}/notes/a.md` } as never

  rowFor('notes').dispatchEvent(dragEvent('drop', new FakeDataTransfer([{ name: 'a.md' }])))

  await new Promise((r) => setTimeout(r, 0))
  expect(moveMock).not.toHaveBeenCalled()
  expect(importMock).not.toHaveBeenCalled()
})

test('a file dropped on empty space imports into the vault root', () => {
  const { container } = tree()
  const tree_ = container.querySelector('[role="tree"]')!.parentElement!

  tree_.dispatchEvent(dragEvent('drop', new FakeDataTransfer()))

  expect(importMock).toHaveBeenCalledWith(expect.objectContaining({ folder: '' }))
})
