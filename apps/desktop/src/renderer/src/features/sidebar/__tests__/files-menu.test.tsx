/**
 * The Files menu's New items make things where the menu was opened: a
 * folder row's menu makes them in that folder, the empty space's at the root.
 * Its Delete asks first, then deletes a file, or a folder with what is in it.
 */
import { Provider, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { emptyVaultSnapshot } from '@holi/shared'
import { fireEvent, render, screen, waitFor } from '@/test/render'
import { coreContributionAtom } from '@/state/plugins'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { activeRemoteAtom, snapshotAtom, vaultsAtom } from '@/state/vaults'
import { SidebarProvider } from '@/components/ui/sidebar'
import { FilesSection } from '../files-section'

const deleteMany = vi.hoisted(() => vi.fn(async (_input: unknown) => undefined))
vi.mock('@/lib/trpc', () => ({
  trpc: {
    sync: { commitNow: { mutate: async () => undefined } },
    notes: { deleteMany: { mutate: deleteMany } },
    vaults: {
      snapshot: {
        query: async () => (await import('@holi/shared')).emptyVaultSnapshot(),
      },
    },
  },
}))

function mount() {
  const store = createStore()
  store.set(activeRemoteAtom, 'mara/notes')
  store.set(vaultsAtom, [
    {
      remote: 'mara/notes',
      path: '/vaults/mara/notes',
      name: 'notes',
      lastOpenedAt: '2026-10-23T10:00:00.000Z',
    },
  ] as never)
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    dirs: ['kunder'],
    docs: [
      {
        path: 'kunder/brief.md',
        title: 'brief',
        updatedAt: '2026-10-23T10:00:00Z',
      },
    ] as never,
  })
  const run = vi.fn(
    async ({ parent, name }: { parent: string; name: string }) =>
      `${parent === '' ? '' : `${parent}/`}${name}.app/index.html`,
  )
  const makeLink = vi.fn(async ({ name }: { name: string }) =>
    name.startsWith('https://')
      ? 'link.example.md'
      : Promise.reject(new Error('That isn’t a web address')),
  )
  store.set(coreContributionAtom, {
    surfaces: [],
    rail: [],
    claims: [
      {
        match: (p: string) => p.endsWith('.app'),
        folder: { surface: 'app', entry: 'index.html' },
        create: {
          id: 'app',
          label: 'New app',
          icon: () => null,
          placeholder: 'App name',
          run,
        },
      },
      {
        match: (p: string) => p.startsWith('link.'),
        create: {
          id: 'link',
          label: 'New Link',
          icon: () => null,
          placeholder: 'Paste a web address',
          asksName: true as const,
          fromUrl: true as const,
          run: makeLink,
        },
      },
    ],
  })
  const onOpen = vi.fn()
  render(
    <Provider store={store}>
      <SidebarProvider>
        <FilesSection activeId={null} onOpen={onOpen} onMoved={() => undefined} />
      </SidebarProvider>
    </Provider>,
  )
  return { run, makeLink, onOpen, store }
}

test("New app on a folder's menu makes the app in that folder", async () => {
  const { run, onOpen } = mount()
  fireEvent.contextMenu(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New app' }))
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith({
      remote: 'mara/notes',
      parent: 'kunder',
      name: 'Untitled',
    }),
  )
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('kunder/Untitled.app'))
})

test("New app on a file's menu makes the app beside the file", async () => {
  const { run } = mount()
  fireEvent.click(await screen.findByText('kunder'))
  fireEvent.contextMenu(await screen.findByText('brief'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New app' }))
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ parent: 'kunder' })),
  )
})

test("a file's menu opens it in split view beside what is in front", async () => {
  const { store } = mount()
  fireEvent.click(await screen.findByText('kunder'))
  fireEvent.contextMenu(await screen.findByText('brief'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in split view' }))
  expect(JSON.stringify(store.get(shellWorkspaceAtom))).toContain('kunder/brief.md')
})

test("a folder's menu has no Open in split view", async () => {
  mount()
  fireEvent.contextMenu(await screen.findByText('kunder'))
  await screen.findByRole('menuitem', { name: 'New app' })
  expect(screen.queryByRole('menuitem', { name: 'Open in split view' })).toBeNull()
})

test("Delete on a file's menu asks, then deletes the file and closes its tab", async () => {
  deleteMany.mockClear()
  const { store } = mount()
  fireEvent.click(await screen.findByText('kunder'))
  fireEvent.contextMenu(await screen.findByText('brief'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in split view' }))
  fireEvent.contextMenu(await screen.findByText('brief'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
  await screen.findByRole('alertdialog', { name: 'Delete “brief.md”?' })
  expect(deleteMany).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() =>
    expect(deleteMany).toHaveBeenCalledWith({
      remote: 'mara/notes',
      paths: ['kunder/brief.md'],
      folders: [],
    }),
  )
  await waitFor(() =>
    expect(JSON.stringify(store.get(shellWorkspaceAtom))).not.toContain('kunder/brief.md'),
  )
})

test("Delete on a folder's menu deletes it with everything in it", async () => {
  deleteMany.mockClear()
  mount()
  fireEvent.contextMenu(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
  await screen.findByText(/everything in it/)
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() =>
    expect(deleteMany).toHaveBeenCalledWith({
      remote: 'mara/notes',
      paths: ['kunder/brief.md'],
      folders: ['kunder'],
    }),
  )
})

test('Cancel deletes nothing', async () => {
  deleteMany.mockClear()
  mount()
  fireEvent.contextMenu(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(deleteMany).not.toHaveBeenCalled()
})

test('New Link asks for the address first, and a refusal stays in the dialog', async () => {
  const { makeLink, onOpen } = mount()
  fireEvent.contextMenu(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New Link' }))
  const field = await screen.findByPlaceholderText('Paste a web address')
  expect(makeLink).not.toHaveBeenCalled()
  fireEvent.change(field, { target: { value: 'not a link' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('That isn’t a web address')).toBeTruthy()
  fireEvent.change(field, { target: { value: 'https://example.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('link.example.md'))
  expect(makeLink).toHaveBeenLastCalledWith({
    remote: 'mara/notes',
    parent: 'kunder',
    name: 'https://example.com',
  })
})

test('a web address dropped from a browser is saved as a link', async () => {
  const { makeLink } = mount()
  await screen.findByText('kunder')
  const area = document.querySelector('[data-dropping], [data-slot=tree]')
    ?.parentElement as HTMLElement
  const data = {
    files: [] as File[],
    types: ['text/uri-list', 'text/plain'],
    getData: (type: string) => (type === 'text/uri-list' ? 'https://example.com/page' : ''),
  }
  fireEvent.drop(area, { dataTransfer: data })
  await waitFor(() =>
    expect(makeLink).toHaveBeenCalledWith({
      remote: 'mara/notes',
      parent: '',
      name: 'https://example.com/page',
    }),
  )
})
