/**
 * The Files menu's New items make things where the menu was opened: a
 * folder row's menu makes them in that folder, the empty space's at the root.
 * Its Delete asks first, then deletes a file, or a folder with what is in it.
 * What a New item made opens its name field once the vault has it, and a
 * plugin's folder document (a deck) opens from its row and expands from its
 * chevron. A note's menu has Create vault app, as the document's own does.
 */
import { Provider, createStore, useAtomValue } from 'jotai'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { emptyVaultSnapshot, TASKS_CLAIM, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { act, fireEvent, render, screen, waitFor } from '@/test/render'
import { coreContributionAtom, installedPluginsAtom } from '@/state/plugins'
import { vaultSettingsAtom } from '@/state/settings'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { activeSplit, openTab } from '@/state/shell-workspace'
import {
  activeRemoteAtom,
  showHiddenByVaultAtom,
  showTasksByVaultAtom,
  snapshotAtom,
  vaultsAtom,
} from '@/state/vaults'
import { SidebarProvider } from '@/components/ui/sidebar'
// This integration test installs Tasks' real renderer contribution through the
// normal plugin-resolution path; production core remains plugin-free.
// eslint-disable-next-line no-restricted-imports
import { tasksRenderer } from '../../../../../plugins/tasks/renderer'
import { FilesSection } from '../files-section'

const deleteMany = vi.hoisted(() => vi.fn(async (_input: unknown) => undefined))
const createNote = vi.hoisted(() => vi.fn(async (_input: unknown) => undefined))
const createTask = vi.hoisted(() =>
  vi.fn(async ({ folder }: { folder: string; title: string; status: string }) =>
    folder === '' ? 'task.created.md' : `${folder}/task.created.md`,
  ),
)
const writeNote = vi.hoisted(() => vi.fn(async (_input: unknown) => undefined))
const snapshotQuery = vi.hoisted(() =>
  vi.fn(async () => (await import('@holi/shared')).emptyVaultSnapshot()),
)
const capRun = vi.hoisted(() =>
  vi.fn(async ({ name, paramsJson }: { name: string; paramsJson: string }) => {
    if (name === 'agent.providers') return []
    if (name === 'tasks.create') return { path: await createTask(JSON.parse(paramsJson) as never) }
    return { ok: true, sessionId: 'abc12345' }
  }),
)
vi.mock('@/lib/trpc', () => ({
  trpc: {
    sync: { commitNow: { mutate: async () => undefined } },
    notes: {
      deleteMany: { mutate: deleteMany },
      create: { mutate: createNote },
      write: { mutate: writeNote },
    },
    cap: { run: { mutate: capRun } },
    vaults: {
      snapshot: {
        query: snapshotQuery,
      },
    },
  },
}))

function KeyedFiles({ onOpen }: { onOpen: (path: string) => void }) {
  const remote = useAtomValue(activeRemoteAtom)
  return <FilesSection key={remote} activeId={null} onOpen={onOpen} onMoved={() => undefined} />
}

function mount({ tasks = true }: { tasks?: boolean } = {}) {
  const store = createStore()
  store.set(activeRemoteAtom, 'mara/notes')
  store.set(showHiddenByVaultAtom, {})
  store.set(showTasksByVaultAtom, {})
  snapshotQuery.mockImplementation(async () => store.get(snapshotAtom))
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
      {
        path: 'talk.deck/slides.md',
        title: 'slides',
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
        match: (p: string) => p.endsWith('.deck'),
        folder: { surface: 'deck-view', entry: 'slides.md' },
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
  store.set(installedPluginsAtom, [tasksRenderer])
  if (!tasks) {
    store.set(vaultSettingsAtom, {
      remote: 'mara/notes',
      settings: {
        ...VAULT_SETTING_DEFAULTS,
        plugins: {
          ...VAULT_SETTING_DEFAULTS.plugins,
          vault: { ...VAULT_SETTING_DEFAULTS.plugins.vault, tasks: false },
        },
        warnings: [],
      },
    })
  }
  const onOpen = vi.fn()
  render(
    <Provider store={store}>
      <SidebarProvider>
        <KeyedFiles onOpen={onOpen} />
      </SidebarProvider>
    </Provider>,
  )
  return { run, makeLink, onOpen, store }
}

test.each(['header New', 'More file actions', 'context menu'])(
  'the task dialog takes focus after the menu releases it (%s)',
  async (entryPoint) => {
    mount()
    if (entryPoint === 'header New') {
      await userEvent.click(screen.getByRole('button', { name: 'New' }))
    } else if (entryPoint === 'More file actions') {
      await userEvent.click(screen.getByRole('button', { name: 'More file actions' }))
    } else {
      fireEvent.contextMenu(await screen.findByText('kunder'))
    }
    const item = await screen.findByRole('menuitem', { name: 'New task' })
    vi.useFakeTimers()
    try {
      fireEvent.click(item)

      // Radix restores focus from a macrotask after the menu unmounts. The
      // asking dialog must not mount until that lifecycle has released focus.
      expect(screen.queryByPlaceholderText('Task title')).toBeNull()
      await act(async () => vi.runOnlyPendingTimers())
      const field = screen.getByPlaceholderText('Task title') as HTMLInputElement
      expect(document.activeElement).toBe(field)
      fireEvent.change(field, { target: { value: 'R' } })
      field.setSelectionRange(1, 1)
      expect(field).toHaveValue('R')
      expect(document.activeElement).toBe(field)
      expect(field.selectionStart).toBe(1)
      expect(field.selectionEnd).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  },
)

test.each([{ metaKey: true }, { ctrlKey: true }])(
  'a primary-modifier click opens an openable tree row beside the active tab (%o)',
  async (modifier) => {
    const { store } = mount()
    act(() => store.set(shellWorkspaceAtom, (ws) => openTab(openTab(ws, 'A.md'), 'B.md')))
    const deck = await screen.findByRole('treeitem', { name: 'talk.deck' })
    fireEvent.click(deck.querySelector('[data-slot=tree-item-label]')!, modifier)
    await waitFor(() => expect(activeSplit(store.get(shellWorkspaceAtom))).not.toBeNull())
    expect(activeSplit(store.get(shellWorkspaceAtom))?.views).toHaveLength(2)
    expect(activeSplit(store.get(shellWorkspaceAtom))?.views[0]).toBe('B.md')
    expect(store.get(shellWorkspaceAtom).entries).toHaveLength(2)
  },
)

test('primary-modifier open focuses the clicked row for ArrowDown', async () => {
  const { store } = mount()
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom)!,
      docs: [
        ...store.get(snapshotAtom)!.docs,
        { path: 'z.md', title: 'z', updatedAt: '2026-10-23T10:00:00Z' },
      ] as never,
    }),
  )
  const folder = await screen.findByRole('treeitem', { name: 'kunder' })
  fireEvent.click(folder)
  const deck = await screen.findByRole('treeitem', { name: 'talk.deck' })
  fireEvent.click(deck.querySelector('[data-slot=tree-item-label]')!, { metaKey: true })

  await waitFor(() => expect(deck).toHaveAttribute('data-focus', 'true'))
  expect(deck).toHaveAttribute('aria-selected', 'true')
  fireEvent.keyDown(deck, { key: 'ArrowDown' })
  const next = await screen.findByRole('treeitem', { name: 'z.md' })
  await waitFor(() => expect(next).toHaveAttribute('data-focus', 'true'))
  fireEvent.click(next.querySelector('[data-slot=tree-item-label]')!, { shiftKey: true })
  expect(deck).toHaveAttribute('aria-selected', 'true')
  expect(next).toHaveAttribute('aria-selected', 'true')
  expect(folder).toHaveAttribute('aria-selected', 'false')
})

test('primary-modifier open lets F2 rename the clicked row', async () => {
  mount()
  const folder = await screen.findByRole('treeitem', { name: 'kunder' })
  fireEvent.click(folder)
  const deck = await screen.findByRole('treeitem', { name: 'talk.deck' })
  fireEvent.click(deck.querySelector('[data-slot=tree-item-label]')!, { ctrlKey: true })
  await waitFor(() => expect(deck).toHaveAttribute('data-focus', 'true'))
  fireEvent.keyDown(deck, { key: 'F2' })
  expect(await screen.findByLabelText('Rename talk.deck')).toBeTruthy()
})

test('primary-modifier on a normal folder preserves expand and selection behavior', async () => {
  const { store } = mount()
  act(() => store.set(shellWorkspaceAtom, (ws) => openTab(openTab(ws, 'A.md'), 'B.md')))
  const folder = await screen.findByRole('treeitem', { name: 'kunder' })
  fireEvent.click(folder, { metaKey: true })
  expect(store.get(shellWorkspaceAtom).entries).toEqual(['A.md', 'B.md'])
  expect(folder).toHaveAttribute('aria-selected', 'true')
})

test('the Tasks plugin claim asks for a title and creates in the selected folder', async () => {
  createTask.mockClear()
  capRun.mockClear()
  const { makeLink, onOpen } = mount()
  fireEvent.click(await screen.findByText('kunder'))
  expect(screen.getByRole('treeitem', { name: 'kunder' })).toHaveAttribute('aria-selected', 'true')
  await userEvent.click(screen.getByRole('button', { name: 'New' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New task' }))
  expect(await screen.findByRole('dialog', { name: 'New task' })).toBeTruthy()
  expect(screen.getByText('In kunder.')).toBeTruthy()
  const field = screen.getByPlaceholderText('Task title')
  expect(createTask).not.toHaveBeenCalled()
  fireEvent.change(field, { target: { value: 'Review the brief' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(capRun).toHaveBeenCalledWith({
      remote: 'mara/notes',
      name: 'tasks.create',
      paramsJson: JSON.stringify({ title: 'Review the brief', status: 'todo', folder: 'kunder' }),
    }),
  )
  expect(createTask).toHaveBeenCalledWith({
    title: 'Review the brief',
    status: 'todo',
    folder: 'kunder',
  })
  expect(onOpen).toHaveBeenCalledWith('kunder/task.created.md')
  expect(screen.queryByLabelText('Rename task.created.md')).toBeNull()
  expect(makeLink).not.toHaveBeenCalled()
})

test('without the tasks plugin, the New menu has no task action', async () => {
  mount({ tasks: false })
  fireEvent.contextMenu(await screen.findByText('kunder'))
  expect(screen.queryByRole('menuitem', { name: 'New task' })).toBeNull()
})

test('the Files header New creates a document in the selected folder and focuses its name field', async () => {
  const { store } = mount()
  createNote.mockClear()
  fireEvent.click(await screen.findByText('kunder'))
  expect(screen.getByRole('treeitem', { name: 'kunder' })).toHaveAttribute('aria-selected', 'true')
  await userEvent.click(screen.getByRole('button', { name: 'New' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New document' }))
  await waitFor(() =>
    expect(createNote).toHaveBeenLastCalledWith({
      remote: 'mara/notes',
      path: 'kunder/Untitled.md',
      text: '',
    }),
  )
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom)!,
      docs: [
        ...store.get(snapshotAtom)!.docs,
        { path: 'kunder/Untitled.md', title: 'Untitled', updatedAt: '2026-10-23T10:00:00Z' },
      ] as never,
    }),
  )
  const input = await screen.findByLabelText('Rename Untitled.md')
  await waitFor(() => expect(document.activeElement).toBe(input))
})

test('the Files header New creates an app beside the selected file and focuses its name field', async () => {
  const { run, store } = mount()
  fireEvent.click(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByText('brief'))
  expect(screen.getByRole('treeitem', { name: 'brief.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await userEvent.click(screen.getByRole('button', { name: 'New' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New app' }))
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith({
      remote: 'mara/notes',
      parent: 'kunder',
      name: 'Untitled',
    }),
  )
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom)!,
      docs: [
        ...store.get(snapshotAtom)!.docs,
        {
          path: 'kunder/Untitled.app/index.html',
          title: 'index',
          updatedAt: '2026-10-23T10:00:00Z',
        },
      ] as never,
    }),
  )
  const input = await screen.findByLabelText('Rename Untitled.app')
  await waitFor(() => expect(document.activeElement).toBe(input))
})

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
  // Opened from a scan that has it, not the one from before it was made.
  const scanned = snapshotQuery.mock.invocationCallOrder.filter(
    (at) => at > run.mock.invocationCallOrder[0]!,
  )
  expect(scanned[0]).toBeLessThan(onOpen.mock.invocationCallOrder[0]!)
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

test('a made app keeps landing through snapshots that precede its row', async () => {
  const { run, store } = mount()
  let finish!: (path: string) => void
  run.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve
      }),
  )
  fireEvent.contextMenu(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New app' }))
  const original = store.get(snapshotAtom)!
  store.set(snapshotAtom, {
    ...original,
    docs: [
      ...original.docs,
      { path: 'kunder/other.md', title: 'other', updatedAt: '2026-10-23T10:00:00Z' },
    ] as never,
  })
  await act(async () => finish('kunder/Untitled.app/index.html'))
  store.set(snapshotAtom, {
    ...original,
    docs: [
      ...original.docs,
      { path: 'kunder/unrelated.md', title: 'unrelated', updatedAt: '2026-10-23T10:00:00Z' },
    ] as never,
  })
  // Show the parent so the intervening scan's unrelated row proves the
  // snapshot has rendered before the target arrives.
  fireEvent.click(await screen.findByText('kunder'))
  await screen.findByText('unrelated')
  expect(screen.queryByText('Untitled.app')).toBeNull()
  store.set(snapshotAtom, {
    ...original,
    docs: [
      ...original.docs,
      { path: 'kunder/Untitled.app/index.html', title: 'index', updatedAt: '2026-10-23T10:00:00Z' },
    ] as never,
  })
  expect(await screen.findByLabelText('Rename Untitled.app')).toBeTruthy()
  expect(screen.getByRole('treeitem', { name: 'Untitled.app' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
})

test('New document creates inside the selected folder', async () => {
  const { store } = mount()
  createNote.mockClear()
  const folder = await screen.findByText('kunder')
  fireEvent.click(folder)
  fireEvent.click(folder)
  fireEvent.contextMenu(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New document' }))
  await waitFor(() =>
    expect(createNote).toHaveBeenLastCalledWith({
      remote: 'mara/notes',
      path: 'kunder/Untitled.md',
      text: '',
    }),
  )
  store.set(snapshotAtom, {
    ...store.get(snapshotAtom)!,
    docs: [
      ...store.get(snapshotAtom)!.docs,
      { path: 'kunder/Untitled.md', title: 'Untitled', updatedAt: '2026-10-23T10:00:00Z' },
    ] as never,
  })
})

test('a made app opens its name field once the vault has it', async () => {
  const { store } = mount()
  fireEvent.contextMenu(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New app' }))
  const snapshot = store.get(snapshotAtom)!
  store.set(snapshotAtom, {
    ...snapshot,
    docs: [
      ...snapshot.docs,
      { path: 'kunder/Untitled.app/index.html', title: 'index', updatedAt: '2026-10-23T10:00:00Z' },
    ] as never,
  })
  expect(await screen.findByLabelText('Rename Untitled.app')).toBeTruthy()
})

test("a deck's row opens it, and its chevron shows the files inside", async () => {
  const { onOpen } = mount()
  const row = (await screen.findByText('talk')).closest('[data-slot=tree-item-label]')!
  // The chevron is the label's first glyph; jsdom lays everything at 0.
  fireEvent.click(row, { clientX: 40 })
  expect(onOpen).toHaveBeenCalledWith('talk.deck')
  expect(screen.queryByText('slides')).toBeNull()
  onOpen.mockClear()
  fireEvent.click(row, { clientX: 0 })
  expect(await screen.findByText('slides')).toBeTruthy()
  expect(onOpen).not.toHaveBeenCalled()
})

test("a note's menu creates a vault app from it once the agent can, and opens the note", async () => {
  const { store, onOpen } = mount()
  fireEvent.click(await screen.findByText('kunder'))
  fireEvent.contextMenu(await screen.findByText('brief'))
  // This machine's agent is not read yet: offered, not enabled.
  expect(await screen.findByRole('menuitem', { name: 'Create vault app' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

  store.set(installedPluginsAtom, [
    { info: { id: 'stand-in', label: 'Stand-in', default: true }, agent: { name: 'Helper' } },
  ] as never)
  store.set(vaultSettingsAtom, {
    remote: 'mara/notes',
    settings: { ...VAULT_SETTING_DEFAULTS, agentProvider: 'codex', warnings: [] },
  })
  fireEvent.contextMenu(await screen.findByText('brief'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Create vault app' }))
  expect(onOpen).toHaveBeenCalledWith('kunder/brief.md')
  await waitFor(() =>
    expect(capRun).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent.scoped' })),
  )
  const params = JSON.parse(
    capRun.mock.calls.find(([c]) => c.name === 'agent.scoped')![0].paramsJson,
  )
  expect(params).toMatchObject({
    provider: 'codex',
    scope: { read: ['kunder/brief.md'], write: ['kunder/brief.app/**'] },
  })
})

test("a folder's menu has no Create vault app", async () => {
  mount()
  fireEvent.contextMenu(await screen.findByText('kunder'))
  await screen.findByRole('menuitem', { name: 'New app' })
  expect(screen.queryByRole('menuitem', { name: 'Create vault app' })).toBeNull()
})

test('a delayed app creation cannot land in a different keyed vault', async () => {
  const { run, onOpen, store } = mount()
  let finish!: (path: string) => void
  run.mockImplementationOnce(() => new Promise<string>((resolve) => (finish = resolve)))
  fireEvent.contextMenu(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New app' }))
  act(() => store.set(activeRemoteAtom, 'other/vault'))
  await act(async () => finish('kunder/Untitled.app/index.html'))
  expect(onOpen).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('Rename Untitled.app')).toBeNull()
  expect(screen.getByRole('treeitem', { name: 'kunder' })).toHaveAttribute('aria-selected', 'false')
})

test('a delayed task creation cannot land in a different keyed vault', async () => {
  const { store, onOpen } = mount()
  let finish!: (value: string) => void
  createTask.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  fireEvent.contextMenu(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New task' }))
  fireEvent.change(await screen.findByPlaceholderText('Task title'), {
    target: { value: 'Delayed task' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  act(() => store.set(activeRemoteAtom, 'other/vault'))
  await act(async () => finish('task.created.md'))
  expect(onOpen).not.toHaveBeenCalled()
})

test('a delayed New document cannot land in a different keyed vault', async () => {
  const { store, onOpen } = mount()
  let finish!: () => void
  createNote.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        finish = () => resolve(undefined)
      }),
  )
  fireEvent.contextMenu(screen.getByRole('tree'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New document' }))
  act(() => store.set(activeRemoteAtom, 'other/vault'))
  await act(async () => finish())
  expect(onOpen).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('Rename Untitled.md')).toBeNull()
})

test.each([true, false])(
  'New document from a selected folder (expanded=%s) lands and selects its row',
  async (expanded) => {
    const { store } = mount()
    const folder = await screen.findByText('kunder')
    fireEvent.click(folder)
    if (!expanded) fireEvent.click(folder)
    expect(screen.getByRole('treeitem', { name: 'kunder' })).toHaveAttribute(
      'aria-expanded',
      String(expanded),
    )
    fireEvent.contextMenu(await screen.findByText('kunder'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New document' }))
    await waitFor(() =>
      expect(createNote).toHaveBeenLastCalledWith({
        remote: 'mara/notes',
        path: 'kunder/Untitled.md',
        text: '',
      }),
    )
    act(() =>
      store.set(snapshotAtom, {
        ...store.get(snapshotAtom)!,
        docs: [
          ...store.get(snapshotAtom)!.docs,
          { path: 'kunder/Untitled.md', title: 'Untitled', updatedAt: '2026-10-23T10:00:00Z' },
        ] as never,
      }),
    )
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: 'Untitled.md' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    )
    expect(screen.getByRole('treeitem', { name: 'kunder' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  },
)

test('New document beside a selected file skips an existing Untitled name and lands', async () => {
  const { store } = mount()
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom)!,
      docs: [
        ...store.get(snapshotAtom)!.docs,
        { path: 'kunder/Untitled.md', title: 'Untitled', updatedAt: '2026-10-23T10:00:00Z' },
      ] as never,
    }),
  )
  fireEvent.click(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByText('brief'))
  fireEvent.contextMenu(await screen.findByText('brief'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New document' }))
  await waitFor(() =>
    expect(createNote).toHaveBeenLastCalledWith({
      remote: 'mara/notes',
      path: 'kunder/Untitled 2.md',
      text: '',
    }),
  )
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom)!,
      docs: [
        ...store.get(snapshotAtom)!.docs,
        { path: 'kunder/Untitled 2.md', title: 'Untitled 2', updatedAt: '2026-10-23T10:00:00Z' },
      ] as never,
    }),
  )
  expect(await screen.findByRole('treeitem', { name: 'Untitled 2.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
})

test('a task created while hidden does not steal selection when task files are shown', async () => {
  const { store, onOpen } = mount()
  createTask.mockResolvedValueOnce('task.created.md')
  fireEvent.contextMenu(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New task' }))
  fireEvent.change(await screen.findByPlaceholderText('Task title'), {
    target: { value: 'Created' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('task.created.md'))
  await act(async () =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom),
      claimed: {
        [TASKS_CLAIM]: { items: [{ path: 'task.created.md', title: 'Created' }], broken: [] },
      } as never,
    }),
  )
  fireEvent.click(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByText('brief'))
  fireEvent.contextMenu(screen.getByText('brief'))
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Show task files' }))
  await screen.findByRole('treeitem', { name: 'task.created.md' })
  expect(screen.getByRole('treeitem', { name: 'brief.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  expect(screen.getByRole('treeitem', { name: 'task.created.md' })).toHaveAttribute(
    'aria-selected',
    'false',
  )
})

test('a newly hidden folder does not rename or steal selection when revealed later', async () => {
  const { store } = mount()
  let finish!: () => void
  writeNote.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        finish = () => resolve(undefined)
      }),
  )
  await act(async () => {
    store.set(showHiddenByVaultAtom, { 'mara/notes': true })
    store.set(snapshotAtom, { ...store.get(snapshotAtom), dirs: ['kunder', '.secret'] })
  })
  fireEvent.contextMenu(await screen.findByText('.secret'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New folder' }))
  act(() => store.set(showHiddenByVaultAtom, {}))
  await act(async () => finish())
  await act(async () =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom),
      dirs: ['kunder', '.secret', '.secret/New folder'],
    }),
  )
  fireEvent.click(await screen.findByText('kunder'))
  fireEvent.click(await screen.findByText('brief'))
  fireEvent.contextMenu(screen.getByText('brief'))
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Show hidden files' }))
  fireEvent.click(await screen.findByText('.secret'))
  await screen.findByText('New folder')
  expect(screen.queryByLabelText('Rename New folder')).toBeNull()
  expect(screen.getByRole('treeitem', { name: 'New folder' })).toHaveAttribute(
    'aria-selected',
    'false',
  )
})
