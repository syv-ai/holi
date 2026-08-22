/**
 * Copy to Folder… / Move to Folder… (FR-13), the supported way out of the vault
 * now that the drag to Finder is known not to work.
 *
 * The assertion that matters is the last one: a move deletes only what actually
 * landed. Anything else loses the file — copied nowhere, and deleted from the
 * one place that had it.
 */
import { getDefaultStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
// `fireEvent.contextMenu` is how this codebase opens a Radix ContextMenu in
// jsdom (see primitives/__tests__/ContextMenu.test.tsx). A right-click driven
// through `userEvent.pointer` does NOT open it.
import { fireEvent, render, screen, waitFor } from '@/test/render'
import { FileTree } from '../FileTree'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '../../../state/vaults'

/** Typed explicitly: inferred from the happy-path value alone, `failed` would be
 *  `never[]` and the failure case below could not be expressed. */
type ExportResult = {
  landed: { from: string; to: string }[]
  failed: { name: string; reason: string }[]
}
const exportMock = vi.fn(
  (_input: unknown): Promise<ExportResult> =>
    Promise.resolve({ landed: [{ from: 'b.md', to: '/out/b.md' }], failed: [] }),
)
const deleteMock = vi.fn((_input: unknown) => Promise.resolve(undefined))
const backrefsMock = vi.fn((_input: unknown) => Promise.resolve([]))

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    notes: {
      exportFiles: { mutate: (i: unknown) => exportMock(i) },
      deleteMany: { mutate: (i: unknown) => deleteMock(i) },
      backrefsMany: { query: (i: unknown) => backrefsMock(i) },
    },
    sync: { commitNow: { mutate: () => Promise.resolve(undefined) } },
    vaults: { snapshot: { query: () => Promise.resolve(EMPTY) } },
  },
}))

const REMOTE = 'syv-ai/holi'
const EMPTY = { docs: [], tasks: [], broken: [], files: [], dirs: [], icons: {} }
const store = getDefaultStore()

function tree() {
  store.set(activeRemoteAtom, REMOTE)
  store.set(vaultsAtom, [{ remote: REMOTE, path: '/vault' } as never])
  store.set(snapshotAtom, {
    ...EMPTY,
    docs: [{ path: 'b.md', kind: 'note', updatedAt: '' }],
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
  exportMock.mockClear()
  deleteMock.mockClear()
  window.holi = { chooseFolder: () => Promise.resolve('/out') } as never
})

test('Copy to Folder… writes the file out and leaves the vault alone', async () => {
  tree()
  fireEvent.contextMenu(rowFor('b.md'))

  await userEvent.click(await screen.findByText('Copy to Folder…'))

  await waitFor(() =>
    expect(exportMock).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ['b.md'], dest: '/out' }),
    ),
  )
  expect(deleteMock).not.toHaveBeenCalled()
})

test('a cancelled folder chooser does nothing at all', async () => {
  window.holi = { chooseFolder: () => Promise.resolve(null) } as never
  tree()
  fireEvent.contextMenu(rowFor('b.md'))

  await userEvent.click(await screen.findByText('Copy to Folder…'))

  await new Promise((r) => setTimeout(r, 0))
  expect(exportMock).not.toHaveBeenCalled()
})

test('a move deletes ONLY what actually landed', async () => {
  // The whole reason the export reports `landed` separately. A file that could
  // not be written must still be in the vault afterwards — deleting it would
  // destroy the only copy there is.
  exportMock.mockResolvedValueOnce({
    landed: [],
    failed: [{ name: 'b.md', reason: 'could not be copied (EACCES)' }],
  })
  tree()
  fireEvent.contextMenu(rowFor('b.md'))
  await userEvent.click(await screen.findByText('Move to Folder…'))
  await userEvent.click(await screen.findByRole('button', { name: 'Move' }))

  await waitFor(() => expect(exportMock).toHaveBeenCalled())
  expect(deleteMock).not.toHaveBeenCalled()
  expect(await screen.findByText(/could not be copied/)).toBeInTheDocument()
})
