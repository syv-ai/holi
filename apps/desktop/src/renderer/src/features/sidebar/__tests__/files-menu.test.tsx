/**
 * The Files menu's New items make things where the menu was opened: a
 * folder row's menu makes them in that folder, the empty space's at the root.
 * Its Delete asks first, then deletes a file, or a folder with what is in it.
 * What a New item made opens its name field once the vault has it, and a
 * plugin's folder document (a deck) opens from its row and expands from its
 * chevron. A note's menu has Create vault app, as the document's own does.
 */
import { Provider, createStore } from 'jotai'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { emptyVaultSnapshot, isSecretPath, TASKS_CLAIM, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { act, fireEvent, render, screen, waitFor } from '@/test/render'
import { coreContributionAtom, installedPluginsAtom } from '@/state/plugins'
import { vaultSettingsAtom } from '@/state/settings'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { activeSplit, openTab } from '@/state/shell-workspace'
import {
  activeRemoteAtom,
  openedRemoteAtom,
  subscribeToVault,
  vaultNavigationKeyAtom,
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
import { installFakeHoli } from '@/test/fake-holi'
import { revealInFilesAtom } from '@/state/reveal-in-files'
import { activateHostHint, discoverHostHintTargets } from '@/lib/host-hints'
import { installHintLayout } from '@/test/host-hint-layout'

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
const subscriptionScopes = vi.hoisted(() => ({
  values: [] as {
    path: string
    explicit: boolean
    coveredBy: string | null
    baseline: string | null
  }[],
  fail: false,
}))
const subscriptionList = vi.hoisted(() =>
  vi.fn(async ({ paths }: { paths: string }) => {
    if (subscriptionScopes.fail) throw new Error('Subscription storage is unavailable.')
    const requested = JSON.parse(paths) as string[]
    if (requested.some(isSecretPath)) throw new Error('This path cannot be subscribed.')
    return requested.map((path) => {
      const own = subscriptionScopes.values.find((scope) => scope.path === path)
      const parent = subscriptionScopes.values
        .filter(
          (scope) => scope.path !== path && scope.path !== '' && path.startsWith(`${scope.path}/`),
        )
        .sort((a, b) => b.path.length - a.path.length)[0]
      const root = subscriptionScopes.values.find((scope) => scope.path === '')
      return {
        ...(own ?? { path, explicit: false, baseline: null }),
        coveredBy: parent?.path ?? (path !== '' && root ? '' : null),
      }
    })
  }),
)
const subscriptionSet = vi.hoisted(() =>
  vi.fn(async ({ path, enabled }: { path: string; enabled: boolean }) => {
    subscriptionScopes.values = subscriptionScopes.values.filter((scope) => scope.path !== path)
    if (enabled)
      subscriptionScopes.values.push({
        path,
        explicit: true,
        coveredBy: null,
        baseline: 'f'.repeat(40),
      })
  }),
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
    subscriptions: { list: { query: subscriptionList }, set: { mutate: subscriptionSet } },
    cap: { run: { mutate: capRun } },
    vaults: {
      snapshot: {
        query: snapshotQuery,
      },
    },
  },
}))

function KeyedFiles({ onOpen }: { onOpen: (path: string) => void }) {
  return <FilesSection activeId={null} onOpen={onOpen} onMoved={() => undefined} />
}

function mount({ tasks = true }: { tasks?: boolean } = {}) {
  subscriptionScopes.values = []
  subscriptionList.mockClear()
  subscriptionSet.mockClear()
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

test('vault and folder subscription controls persist explicit scopes and explain inherited coverage', async () => {
  mount()
  const vault = await screen.findByRole('button', { name: 'Subscribe this vault' })
  await userEvent.click(vault)
  await waitFor(() =>
    expect(subscriptionSet).toHaveBeenCalledWith({ remote: 'mara/notes', path: '', enabled: true }),
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Unsubscribe this vault/ })).toBeInTheDocument(),
  )
  expect(
    await screen.findByRole('button', {
      name: /Subscribe kunder explicitly.*covered by the vault/,
    }),
  ).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /Subscribe kunder explicitly/ }))
  await waitFor(() =>
    expect(subscriptionSet).toHaveBeenCalledWith({
      remote: 'mara/notes',
      path: 'kunder',
      enabled: true,
    }),
  )
  expect(
    await screen.findByRole('button', {
      name: 'Remove explicit subscription for kunder (still covered by the vault)',
    }),
  ).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Unsubscribe this vault' }))
  expect(await screen.findByRole('button', { name: 'Unsubscribe kunder' })).toBeInTheDocument()
})

test('folder subscription actions keep a trailing slot and reveal on pointer or keyboard focus', async () => {
  const { store } = mount()
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom)!,
      dirs: ['kunder', 'a folder with a much longer name'],
    }),
  )

  const short = await screen.findByRole('treeitem', { name: 'kunder' })
  const long = await screen.findByRole('treeitem', { name: 'a folder with a much longer name' })
  const shortLabel = short.querySelector('[data-slot=tree-item-label]')!
  const longLabel = long.querySelector('[data-slot=tree-item-label]')!
  const shortAction = short.querySelector<HTMLButtonElement>('[data-tree-row-action]')!
  const longAction = long.querySelector<HTMLButtonElement>('[data-tree-row-action]')!

  expect(shortLabel).toHaveClass('w-full')
  expect(longLabel).toHaveClass('w-full')
  // The action's own auto margin places it at the row's trailing edge;
  // opacity-based reveal keeps that slot and the name's layout stable.
  expect(shortAction).toHaveClass('ms-auto')
  expect(longAction).toHaveClass('ms-auto')
  expect(shortAction.parentElement).toHaveClass('flex', 'flex-1', 'min-w-0')
  expect(longAction.parentElement).toHaveClass('flex', 'flex-1', 'min-w-0')
  expect(shortLabel.className).toContain('[&_[data-tree-row-action]]:opacity-0')
  expect(shortLabel.className).toContain('[&:hover_[data-tree-row-action]]:opacity-100')
  expect(shortLabel.className).toContain('[&:focus-within_[data-tree-row-action]]:opacity-100')
  expect(shortLabel.className).toContain(
    'group-focus-within/tree-item:[&_[data-tree-row-action]]:opacity-100',
  )
  expect(short).toHaveClass('group/tree-item')
  expect(shortLabel.className).toContain(
    '[@media(hover:none)]:[&_[data-tree-row-action]]:opacity-100',
  )
  // The action occupies the trailing flex slot beside the truncating name in
  // both short and long rows; revealing it cannot reflow the name.
  expect(shortLabel.querySelector('.truncate')?.parentElement).toBe(shortAction.parentElement)
  expect(longLabel.querySelector('.truncate')?.parentElement).toBe(longAction.parentElement)
  expect(shortAction).toHaveAttribute('aria-label', 'Subscribe kunder')
  expect(longAction).toHaveAttribute('aria-label', 'Subscribe a folder with a much longer name')

  short.focus()
  expect(document.activeElement).toBe(short)
  const originalName = shortLabel.querySelector('.truncate')?.textContent
  await userEvent.tab()
  expect(document.activeElement).toBe(shortAction)
  expect(shortAction).toHaveAttribute('aria-label', 'Subscribe kunder')
  await userEvent.keyboard('{Enter}')
  expect(await screen.findByRole('button', { name: 'Unsubscribe kunder' })).toBeInTheDocument()
  expect(short.querySelector('.truncate')).toHaveTextContent(originalName!)
  expect(short.querySelector('[data-tree-row-action]')).toBe(shortAction)
})

// Rendered geometry, pointer reveal, and focus visibility are exercised by
// scripts/run-folder-subscriptions-native-smoke.mjs in native Electron.
test('individual file subscription controls persist and are keyboard operable', async () => {
  const { store } = mount()
  await screen.findByRole('button', { name: 'Subscribe this vault' })
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom)!,
      docs: [
        ...store.get(snapshotAtom)!.docs,
        {
          path: 'a-considerably-longer-filename-to-check-the-trailing-action-slot.md',
          title: 'long filename',
          updatedAt: '2026-10-23T10:00:00Z',
        },
      ] as never,
    }),
  )
  const longFileRow = await screen.findByRole('treeitem', {
    name: 'a-considerably-longer-filename-to-check-the-trailing-action-slot.md',
  })
  const longFileControl = await screen.findByRole('button', {
    name: 'Subscribe a-considerably-longer-filename-to-check-the-trailing-action-slot.md',
  })
  expect(longFileRow).toContainElement(longFileControl)
  expect(subscriptionList.mock.calls.map(([input]) => JSON.parse(input.paths))).toContainEqual(
    expect.arrayContaining(['kunder/brief.md']),
  )
  fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'kunder' }), { key: ' ' })
  const fileControl = await screen.findByRole('button', { name: 'Subscribe brief.md' })
  const fileRow = screen.getByRole('treeitem', { name: 'brief.md' })
  const fileNameBefore = [...fileRow.querySelectorAll('.truncate')].find(
    (element) => element.textContent === 'brief',
  )?.textContent
  fileRow.focus()
  await userEvent.tab()
  expect(document.activeElement).toBe(fileControl)
  await userEvent.keyboard('{Enter}')
  await waitFor(() =>
    expect(subscriptionSet).toHaveBeenCalledWith({
      remote: 'mara/notes',
      path: 'kunder/brief.md',
      enabled: true,
    }),
  )
  const fileControlAfterSubscribe = await screen.findByRole('button', {
    name: 'Unsubscribe brief.md',
  })
  expect(fileControlAfterSubscribe).toHaveAttribute('data-tree-row-action', '')
  expect(fileRow).toContainElement(fileControlAfterSubscribe)
  expect(
    [...fileRow.querySelectorAll('.truncate')].find((element) => element.textContent === 'brief'),
  ).toHaveTextContent(fileNameBefore!)
  expect(screen.getByRole('button', { name: 'Subscribe kunder' })).toBeInTheDocument()
})

test('hidden secret files are excluded from subscription requests and row controls', async () => {
  const { store } = mount()
  store.set(showHiddenByVaultAtom, { 'mara/notes': true })
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom)!,
      dirs: ['kunder', 'nested', '.secrets'],
      docs: [
        ...store.get(snapshotAtom)!.docs,
        { path: '.env', title: '.env', updatedAt: '2026-10-23T10:00:00Z' },
        {
          path: 'nested/.secrets.prod',
          title: '.secrets.prod',
          updatedAt: '2026-10-23T10:00:00Z',
        },
        {
          path: '.secrets/credentials.md',
          title: 'credentials',
          updatedAt: '2026-10-23T10:00:00Z',
        },
        {
          path: '.holi/settings/app.local.yaml',
          title: 'app.local',
          updatedAt: '2026-10-23T10:00:00Z',
        },
      ] as never,
    }),
  )

  await screen.findByRole('button', { name: 'Subscribe this vault' })
  await waitFor(() =>
    expect(subscriptionList.mock.calls.at(-1)?.[0].paths).toContain(
      '.holi/settings/app.local.yaml',
    ),
  )
  const requested = JSON.parse(subscriptionList.mock.calls.at(-1)![0].paths) as string[]
  expect(requested).toContain('kunder/brief.md')
  expect(requested).not.toContain('.env')
  expect(requested).not.toContain('nested/.secrets.prod')
  expect(requested).not.toContain('.secrets')
  expect(requested).not.toContain('.secrets/credentials.md')

  expect(await screen.findByRole('treeitem', { name: '.env' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Subscribe .env' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Subscribe this vault' })).toBeInTheDocument()

  fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'nested' }), { key: ' ' })
  expect(await screen.findByRole('treeitem', { name: '.secrets' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Subscribe .secrets' })).toBeNull()
  fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'kunder' }), { key: ' ' })
  expect(await screen.findByRole('button', { name: 'Subscribe brief.md' })).toBeInTheDocument()
  const secretFolder = screen
    .getAllByRole('treeitem', { name: '.secrets' })
    .find((item) => item.getAttribute('aria-expanded') === 'false')
  expect(secretFolder).toBeDefined()
  fireEvent.keyDown(secretFolder!, { key: ' ' })
  expect(await screen.findByRole('treeitem', { name: 'credentials.md' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Subscribe credentials.md' })).toBeNull()
})

test('file subscription controls explain inherited coverage and allow explicit overrides', async () => {
  const { store } = mount()
  fireEvent.keyDown(await screen.findByRole('treeitem', { name: 'kunder' }), { key: ' ' })
  await screen.findByRole('button', { name: 'Subscribe brief.md' })
  subscriptionScopes.values = [
    { path: 'kunder', explicit: true, coveredBy: null, baseline: 'f'.repeat(40) },
  ]
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom)!,
      dirs: ['kunder', 'new-folder'],
    }),
  )
  expect(
    await screen.findByRole('button', {
      name: 'Subscribe brief.md explicitly (already covered by kunder)',
    }),
  ).toBeInTheDocument()
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Subscribe brief.md explicitly (already covered by kunder)',
    }),
  )
  await waitFor(() =>
    expect(subscriptionSet).toHaveBeenCalledWith({
      remote: 'mara/notes',
      path: 'kunder/brief.md',
      enabled: true,
    }),
  )
  expect(
    await screen.findByRole('button', {
      name: 'Remove explicit subscription for brief.md (still covered by kunder)',
    }),
  ).toBeInTheDocument()
})

test('tree rows activate by Enter and Space without consuming nested controls', async () => {
  const { onOpen } = mount()
  const folder = await screen.findByRole('treeitem', { name: 'kunder' })
  fireEvent.keyDown(folder, { key: ' ' })
  expect(folder).toHaveAttribute('aria-expanded', 'true')
  const file = await screen.findByRole('treeitem', { name: 'brief.md' })
  fireEvent.keyDown(file, { key: 'Enter' })
  expect(onOpen).toHaveBeenCalledWith('kunder/brief.md')
  const subscribe = screen.getByRole('button', { name: 'Subscribe this vault' })
  fireEvent.keyDown(subscribe, { key: 'Enter' })
  expect(onOpen).not.toHaveBeenCalledWith('')
})

test('background refresh preserves the usable tree while genuine folder changes still appear', async () => {
  const { store } = mount()
  const folder = await screen.findByRole('treeitem', { name: 'kunder' })
  await userEvent.click(folder)
  const note = await screen.findByRole('treeitem', { name: 'brief.md' })
  await userEvent.click(note)
  await waitFor(() => expect(note).toHaveFocus())

  let admit!: () => void
  const admitted = new Promise<void>((resolve) => {
    admit = resolve
  })
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const list = subscriptionList.getMockImplementation()!
  subscriptionList.mockImplementationOnce(async (input) => {
    admit()
    await pending
    return list(input)
  })
  const snapshot = store.get(snapshotAtom)!
  act(() =>
    store.set(snapshotAtom, {
      ...snapshot,
      docs: [...snapshot.docs],
      dirs: [...snapshot.dirs],
    }),
  )
  await admitted
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(folder).toHaveAttribute('aria-expanded', 'true')
  expect(note).toHaveFocus()
  expect(note).toHaveAttribute('aria-selected', 'true')
  await act(async () => {
    release()
    await pending
  })

  act(() => store.set(snapshotAtom, { ...snapshot, dirs: [...snapshot.dirs, 'new-folder'] }))
  expect(await screen.findByRole('treeitem', { name: 'new-folder' })).toBeInTheDocument()
  expect(folder).toHaveAttribute('aria-expanded', 'true')
  act(() => store.set(snapshotAtom, { ...snapshot, dirs: [...snapshot.dirs] }))
  await waitFor(() =>
    expect(screen.queryByRole('treeitem', { name: 'new-folder' })).not.toBeInTheDocument(),
  )
})

test('an older list response cannot erase a completed subscription refresh', async () => {
  const { store } = mount()
  let resolveOld!: (scopes: typeof subscriptionScopes.values) => void
  const oldResponse = new Promise<typeof subscriptionScopes.values>((resolve) => {
    resolveOld = resolve
  })
  subscriptionList.mockImplementationOnce(async () => oldResponse)
  let finishMutation!: () => void
  const mutationGate = new Promise<void>((resolve) => {
    finishMutation = resolve
  })
  subscriptionSet.mockImplementationOnce(async ({ path, enabled }) => {
    await mutationGate
    subscriptionScopes.values = subscriptionScopes.values.filter((scope) => scope.path !== path)
    if (enabled)
      subscriptionScopes.values.push({
        path,
        explicit: true,
        coveredBy: null,
        baseline: 'f'.repeat(40),
      })
  })

  await userEvent.click(await screen.findByRole('button', { name: 'Subscribe this vault' }))
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom)!,
      dirs: ['kunder', 'new-folder'],
    }),
  )
  await waitFor(() => expect(subscriptionList).toHaveBeenCalledTimes(2))
  finishMutation()
  await waitFor(() => expect(subscriptionList).toHaveBeenCalledTimes(3))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Unsubscribe this vault' })).toBeInTheDocument(),
  )
  resolveOld([])
  await act(async () => oldResponse)
  expect(screen.getByRole('button', { name: 'Unsubscribe this vault' })).toBeInTheDocument()
})

test('a superseded post-save list response does not leave subscription controls disabled', async () => {
  const { store } = mount()
  await screen.findByRole('button', { name: 'Subscribe this vault' })
  let resolvePostSave!: (scopes: typeof subscriptionScopes.values) => void
  const postSaveResponse = new Promise<typeof subscriptionScopes.values>((resolve) => {
    resolvePostSave = resolve
  })
  subscriptionList.mockImplementationOnce(async () => postSaveResponse)

  await userEvent.click(screen.getByRole('button', { name: 'Subscribe this vault' }))
  await waitFor(() => expect(subscriptionList).toHaveBeenCalledTimes(2))
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom)!,
      dirs: ['kunder', 'new-folder'],
    }),
  )
  await waitFor(() => expect(subscriptionList).toHaveBeenCalledTimes(3))
  const unsubscribe = await screen.findByRole('button', { name: 'Unsubscribe this vault' })
  await waitFor(() => expect(unsubscribe).toBeEnabled())

  resolvePostSave([])
  await act(async () => postSaveResponse)
  expect(screen.getByRole('button', { name: 'Unsubscribe this vault' })).toBeEnabled()
})

test('an earlier activation is discarded across an A-B-A vault switch', async () => {
  const { store } = mount()
  let resolveFirst!: (scopes: typeof subscriptionScopes.values) => void
  const firstResponse = new Promise<typeof subscriptionScopes.values>((resolve) => {
    resolveFirst = resolve
  })
  subscriptionList.mockImplementationOnce(async () => firstResponse)
  act(() => store.set(activeRemoteAtom, 'other/repo'))
  await waitFor(() => expect(subscriptionList).toHaveBeenCalledTimes(2))
  subscriptionScopes.values = [
    { path: '', explicit: true, coveredBy: null, baseline: 'f'.repeat(40) },
  ]
  act(() => store.set(activeRemoteAtom, 'mara/notes'))
  await waitFor(() => expect(subscriptionList).toHaveBeenCalledTimes(3))
  expect(await screen.findByRole('button', { name: 'Unsubscribe this vault' })).toBeInTheDocument()
  resolveFirst([])
  await act(async () => firstResponse)
  expect(screen.getByRole('button', { name: 'Unsubscribe this vault' })).toBeInTheDocument()
})

test('subscription storage errors offer retry without hiding the tree', async () => {
  subscriptionScopes.fail = true
  mount()
  expect(await screen.findByText('Subscription storage is unavailable.')).toBeInTheDocument()
  expect(screen.getByText('kunder')).toBeInTheDocument()
  subscriptionScopes.fail = false
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('button', { name: 'Subscribe this vault' })).toBeInTheDocument()
})

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

test('a hinted deck label opens the folder document without expanding its chevron', async () => {
  const { onOpen } = mount()
  const deck = await screen.findByRole('treeitem', { name: 'talk.deck' })
  const label = deck.querySelector<HTMLElement>('[data-slot=tree-item-label]')!
  const chevron = label.querySelector('svg')!
  const { place } = installHintLayout()
  try {
    place(deck, 10, 300, 300, 28)
    place(label, 10, 300, 300, 28)
    place(chevron, 20, 306, 12, 16)
    const target = discoverHostHintTargets(document.body).find(({ element }) => element === deck)!
    expect(target.x).toBeGreaterThan(chevron.getBoundingClientRect().right)
    act(() => expect(activateHostHint(target)).toBe(true))
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('talk.deck')
    expect(deck).toHaveAttribute('aria-expanded', 'false')
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

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

test('folder menus copy shareable Holi links but exclude machine-local folders', async () => {
  const user = userEvent.setup()
  const copied = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  try {
    const { store } = mount()
    act(() =>
      store.set(snapshotAtom, {
        ...store.get(snapshotAtom),
        dirs: ['kunder', 'private.local.folder', '.holi', '.holi/state', 'holi-state'],
      }),
    )
    fireEvent.contextMenu(await screen.findByText('kunder'))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy Holi link' }))
    await waitFor(() =>
      expect(copied).toHaveBeenCalledWith(
        'https://syv-ai.github.io/holi/#vault=mara/notes&path=kunder',
      ),
    )
    fireEvent.contextMenu(await screen.findByText('private.local.folder'))
    await screen.findByRole('menuitem', { name: 'New document' })
    expect(screen.queryByRole('menuitem', { name: 'Copy Holi link' })).toBeNull()
    fireEvent.contextMenu(await screen.findByText('state'))
    await screen.findByRole('menuitem', { name: 'New document' })
    expect(screen.queryByRole('menuitem', { name: 'Copy Holi link' })).toBeNull()
    fireEvent.contextMenu(await screen.findByText('holi-state'))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy Holi link' }))
    await waitFor(() =>
      expect(copied).toHaveBeenLastCalledWith(
        'https://syv-ai.github.io/holi/#vault=mara/notes&path=holi-state',
      ),
    )
  } finally {
    copied.mockRestore()
  }
})

test('directory reveals expand and select nested folders again without opening documents', async () => {
  const { store, onOpen } = mount()
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom),
      dirs: ['kunder', 'kunder/nested'],
      docs: [
        { path: 'kunder/nested/child.md', title: 'child', updatedAt: '2026-10-23T10:00:00Z' },
      ] as never,
    }),
  )
  act(() =>
    store.set(revealInFilesAtom, { remote: 'mara/notes', path: 'kunder/nested', directory: true }),
  )
  const row = await screen.findByRole('treeitem', { name: 'nested' })
  await waitFor(() => expect(row).toHaveAttribute('aria-expanded', 'true'))
  await waitFor(() => expect(row).toHaveFocus())
  expect(row).toHaveAttribute('aria-selected', 'true')
  expect(await screen.findByText('child')).toBeInTheDocument()
  fireEvent.click(screen.getByText('nested'))
  await waitFor(() => expect(row).toHaveAttribute('aria-expanded', 'false'))
  act(() =>
    store.set(revealInFilesAtom, { remote: 'mara/notes', path: 'kunder/nested', directory: true }),
  )
  await waitFor(() => expect(row).toHaveAttribute('aria-expanded', 'true'))
  expect(onOpen).not.toHaveBeenCalled()
})

test('a hidden directory reveal leaves unrelated hidden content and preferences alone', async () => {
  const { store, onOpen } = mount()
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom),
      dirs: ['kunder', 'kunder/.private', '.other'],
      docs: [
        { path: 'kunder/.private/inside.md', title: 'inside', updatedAt: '2026-10-23T10:00:00Z' },
        { path: 'kunder/.private/.hidden.md', title: '.hidden', updatedAt: '2026-10-23T10:00:00Z' },
      ] as never,
    }),
  )
  expect(screen.queryByText('.private')).toBeNull()
  act(() =>
    store.set(revealInFilesAtom, {
      remote: 'mara/notes',
      path: 'kunder/.private',
      directory: true,
    }),
  )
  const row = await screen.findByRole('treeitem', { name: '.private' })
  await waitFor(() => expect(row).toHaveAttribute('aria-expanded', 'true'))
  await waitFor(() => expect(row).toHaveFocus())
  expect(row).toHaveAttribute('aria-selected', 'true')
  expect(await screen.findByText('inside')).toBeInTheDocument()
  expect(screen.queryByText('.other')).toBeNull()
  expect(screen.queryByText('.hidden')).toBeNull()
  expect(store.get(showHiddenByVaultAtom)['mara/notes']).not.toBe(true)
  expect(onOpen).not.toHaveBeenCalled()
})

test('an app directory link browses its files rather than launching its surface', async () => {
  const { store, onOpen } = mount()
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom),
      dirs: ['demo.app'],
      docs: [
        { path: 'demo.app/index.html', title: 'index', updatedAt: '2026-10-23T10:00:00Z' },
      ] as never,
    }),
  )
  act(() =>
    store.set(revealInFilesAtom, { remote: 'mara/notes', path: 'demo.app', directory: true }),
  )
  const row = await screen.findByRole('treeitem', { name: 'demo.app' })
  await waitFor(() => expect(row).toHaveAttribute('aria-expanded', 'true'))
  await waitFor(() => expect(row).toHaveFocus())
  expect(row).toHaveAttribute('aria-selected', 'true')
  expect(await screen.findByRole('treeitem', { name: 'index.html' })).toBeVisible()
  expect(onOpen).not.toHaveBeenCalled()
})

test('directory links can browse inside an app bundle ancestor', async () => {
  const { store, onOpen } = mount()
  act(() =>
    store.set(snapshotAtom, {
      ...store.get(snapshotAtom),
      dirs: ['demo.app', 'demo.app/assets'],
      docs: [
        { path: 'demo.app/index.html', title: 'index', updatedAt: '2026-10-23T10:00:00Z' },
        { path: 'demo.app/assets/readme.md', title: 'readme', updatedAt: '2026-10-23T10:00:00Z' },
      ] as never,
    }),
  )
  act(() =>
    store.set(revealInFilesAtom, {
      remote: 'mara/notes',
      path: 'demo.app/assets',
      directory: true,
    }),
  )
  const row = await screen.findByRole('treeitem', { name: 'assets' })
  await waitFor(() => expect(row).toHaveFocus())
  expect(row).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('treeitem', { name: 'demo.app' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  expect(await screen.findByText('readme')).toBeVisible()
  expect(onOpen).not.toHaveBeenCalled()
})

test('a pending directory reveal cannot return after leaving and revisiting its vault', async () => {
  const { store } = mount()
  act(() =>
    store.set(revealInFilesAtom, {
      remote: 'mara/notes',
      path: 'later',
      directory: true,
      navigation: store.get(vaultNavigationKeyAtom),
    }),
  )
  act(() => {
    store.set(activeRemoteAtom, 'other/vault')
    store.set(activeRemoteAtom, 'mara/notes')
    store.set(snapshotAtom, { ...store.get(snapshotAtom), dirs: ['kunder', 'later'] })
  })
  const row = await screen.findByRole('treeitem', { name: 'later' })
  expect(row).toHaveAttribute('aria-selected', 'false')
  expect(row).toHaveAttribute('aria-expanded', 'false')
  expect(row).not.toHaveFocus()
})

test('a newer file arrival retires a directory waiting for its snapshot', async () => {
  const fake = installFakeHoli()
  const { store } = mount()
  store.set(openedRemoteAtom, 'mara/notes')
  const off = subscribeToVault(store)
  try {
    act(() => fake.pushOpen({ remote: 'mara/notes', path: 'later', kind: 'directory' }))
    act(() => fake.pushOpen({ remote: 'mara/notes', path: 'kunder/brief.md' }))
    act(() => store.set(snapshotAtom, { ...store.get(snapshotAtom), dirs: ['kunder', 'later'] }))
    const row = await screen.findByRole('treeitem', { name: 'later' })
    expect(row).toHaveAttribute('aria-selected', 'false')
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(row).not.toHaveFocus()
  } finally {
    off()
    fake.restore()
  }
})
