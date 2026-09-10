/**
 * The icon map, which until now had no view at all (D82).
 *
 * The one thing this surface is FOR, beyond listing: an icon is keyed by path
 * and rots on rename by design, so a stale entry exists nowhere a user can see
 * it. Naming it here is the whole reason the section is a list rather than a
 * link to the file.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { emptyVaultSnapshot } from '@holi/shared'
import { IconsSection } from '../IconsSection'
import { activeDialogAtom } from '@/state/dialogs'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

const setIcon = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: { notes: { setIcon: { mutate: (input: unknown) => setIcon(input) } } },
}))

const REMOTE = 'syv-ai/holi'

function setup(icons: Record<string, string>, present: { docs?: string[]; dirs?: string[] } = {}) {
  const store = createStore()
  store.set(activeRemoteAtom, REMOTE)
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    icons,
    docs: (present.docs ?? []).map((path) => ({ path, kind: 'note', updatedAt: '' })),
    dirs: present.dirs ?? [],
  } as never)
  render(
    <Provider store={store}>
      <IconsSection />
    </Provider>,
  )
  return store
}

beforeEach(() => {
  setIcon.mockReset()
  setIcon.mockResolvedValue({ ok: true })
})

test('says where icons come from when there are none', () => {
  setup({})
  expect(screen.getByText(/Right-click a note, a folder or a file/)).toBeInTheDocument()
})

test('lists every entry in the map, whatever it points at', () => {
  setup({ 'notes/b.md': '🌱', 'a.md': '📌', projects: '📁' }, { docs: ['a.md', 'notes/b.md'], dirs: ['projects'] })
  const rows = screen.getAllByRole('listitem')
  // Sorted by path, not by insertion order: the file is written by whoever
  // edited last, and a list that reorders itself is not a list.
  expect(rows.map((r) => r.getAttribute('data-icon-path'))).toEqual([
    'a.md',
    'notes/b.md',
    'projects',
  ])
})

test('names an entry whose path is no longer in the vault', () => {
  // The failure mode D82 accepts: rename the file and the icon stays behind,
  // pointing at nothing. Invisible in the tree, because the row it decorated is
  // gone; this list is the only place it can be found and removed.
  setup({ 'old-name.md': '🌱', 'kept.md': '📌' }, { docs: ['kept.md'] })
  const stale = screen.getByText('old-name.md').closest('li')!
  expect(within(stale).getByText(/no longer in this vault/)).toBeInTheDocument()

  const kept = screen.getByText('kept.md').closest('li')!
  expect(within(kept).queryByText(/no longer in this vault/)).not.toBeInTheDocument()
})

test('clearing an entry removes it, rather than writing a blank', () => {
  // `undefined` is what deletes the key — the same call the dialog makes when
  // you empty its field. An empty string would be an entry that renders nothing.
  setup({ 'a.md': '📌' }, { docs: ['a.md'] })
  return userEvent.click(screen.getByRole('button', { name: 'clear the icon for a.md' })).then(() =>
    waitFor(() =>
      expect(setIcon).toHaveBeenCalledWith({ remote: REMOTE, path: 'a.md', emoji: undefined }),
    ),
  )
})

test('editing summons the tree’s own dialog, filled in', async () => {
  // Not a second editor: same validator, same writer, same rules about what an
  // empty field means.
  const store = setup({ 'a.md': '📌' }, { docs: ['a.md'] })
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
  expect(store.get(activeDialogAtom)).toMatchObject({
    id: 'edit-icon',
    remote: REMOTE,
    path: 'a.md',
    current: '📌',
  })
})
