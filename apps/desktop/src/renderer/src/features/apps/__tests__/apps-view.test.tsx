/**
 * The Apps page: a card per vault app on ReUI's c-card-7, with its icon,
 * whether it is shared or personal, its folder, its name, its manifest's
 * description and Open; a skeleton while the vault loads; and the empty
 * states for no apps and for the plugin being off.
 */
import { atom, createStore, Provider } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { VaultSnapshot } from '@holi/shared'
import { fireEvent, render, screen, within } from '@/test/render'
import type { ConversationStart } from '@/plugin-api/types'
import { agentsSelectionAtom } from '@/state/agents-slots'
import { openNextBeside } from '@/state/alt-open'
import { coreContributionAtom, installedPluginsAtom } from '@/state/plugins'
import { revealInFilesRequestAtom } from '@/state/reveal-in-files'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'
import { useSessionTabs } from '../../../hooks/use-session-tabs'
import { AppsView } from '../apps-view'

const toasts = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
  return { toast }
})
vi.mock('sonner', () => toasts)

beforeEach(() => {
  toasts.toast.mockReset()
  toasts.toast.error.mockReset()
  toasts.toast.success.mockReset()
})

const APPS = ['tools/Budget.app', 'Home.local.app']

function files(paths: string[], updatedAt = '2026-10-01T00:00:00Z') {
  return paths.flatMap((app) => [
    { path: `${app}/index.html`, updatedAt },
    { path: `${app}/app.yaml`, updatedAt },
  ])
}

function withApps({
  apps = APPS,
  describe,
  loaded = true,
  create,
  extra = {},
}: {
  apps?: string[]
  describe?: (remote: string, id: string) => Promise<string | null>
  loaded?: boolean
  create?: () => Promise<string | null>
  /** More of the `app` surface: previews, the archive. */
  extra?: Record<string, unknown>
} = {}) {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/site')
  if (loaded) {
    store.set(snapshotAtom, {
      docs: [],
      claimed: {},
      files: files(apps),
      dirs: [],
      icons: {},
    } as unknown as VaultSnapshot)
  }
  store.set(coreContributionAtom, {
    rail: [],
    claims:
      create === undefined
        ? []
        : [
            {
              match: () => true,
              folder: { surface: 'app', entry: 'index.html' },
              create: {
                id: 'app',
                label: 'New app',
                icon: () => null,
                placeholder: 'App name',
                run: create,
              },
            },
          ],
    surfaces: [
      {
        kind: 'app',
        label: (id?: string) => (id ?? 'App').replace(/^.*\//, '').replace(/(\.local)?\.app$/, ''),
        icon: () => <svg data-testid="app-icon" />,
        render: () => null,
        instances: atom(apps),
        describe,
        ...extra,
      },
    ],
  } as never)
  return store
}

function renderView(store: ReturnType<typeof createStore>, onOpen = vi.fn()) {
  render(
    <Provider store={store}>
      <AppsView onOpen={onOpen} />
    </Provider>,
  )
  return onOpen
}

test('each app is a card with its state, folder, name and description, and Open opens it', async () => {
  const describe = vi.fn(async (_remote: string, id: string) =>
    id === 'tools/Budget.app' ? 'What the month cost, by category' : null,
  )
  const onOpen = renderView(withApps({ describe }))

  const cards = screen.getAllByRole('listitem')
  expect(cards).toHaveLength(2)

  const budget = within(cards[0]!)
  expect(budget.getByText('Budget')).toBeInTheDocument()
  expect(budget.getByText('Shared')).toBeInTheDocument()
  expect(budget.getByText('tools')).toBeInTheDocument()
  expect(await budget.findByText('What the month cost, by category')).toBeInTheDocument()

  const home = within(cards[1]!)
  expect(home.getByText('Personal')).toBeInTheDocument()
  expect(home.getByText('Vault root')).toBeInTheDocument()
  expect(await home.findByText('No description yet.')).toBeInTheDocument()

  expect(describe).toHaveBeenCalledWith('syv-ai/site', 'tools/Budget.app')

  await userEvent.click(screen.getByRole('button', { name: 'Open Budget' }))
  expect(onOpen).toHaveBeenCalledWith('tools/Budget.app')
})

test('a description that cannot be read says so, and Retry reads it again', async () => {
  let fail = true
  const describe = vi.fn(async () => {
    if (fail) throw new Error('gone')
    return 'Back again'
  })
  renderView(withApps({ apps: ['Budget.app'], describe }))

  expect(await screen.findByText("Couldn't read its description.")).toBeInTheDocument()
  fail = false
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Back again')).toBeInTheDocument()
  expect(describe).toHaveBeenCalledTimes(2)
})

test("an app's description is read again when its files change", async () => {
  const describe = vi.fn(async () => 'First')
  const store = withApps({ apps: ['Budget.app'], describe })
  renderView(store)
  expect(await screen.findByText('First')).toBeInTheDocument()

  describe.mockResolvedValue('Second')
  store.set(snapshotAtom, {
    ...store.get(snapshotAtom),
    files: files(['Budget.app'], '2026-10-02T00:00:00Z'),
  })
  expect(await screen.findByText('Second')).toBeInTheDocument()
})

test('while the vault loads, the page shows card skeletons', () => {
  renderView(withApps({ loaded: false }))
  expect(screen.getByRole('list', { name: 'Loading apps' })).toBeInTheDocument()
  expect(screen.queryByText('No apps yet')).not.toBeInTheDocument()
})

test('with no apps, the empty state offers New app, which opens the new app', async () => {
  const create = vi.fn(async () => 'Untitled.app/index.html')
  const onOpen = renderView(withApps({ apps: [], create }))
  expect(screen.getByText('No apps yet')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'New app' }))
  expect(create).toHaveBeenCalledWith({
    remote: 'syv-ai/site',
    parent: '',
    name: 'Untitled',
  })
  expect(onOpen).toHaveBeenCalledWith('Untitled.app')
})

test('with the plugin off, the page says how to turn it on', () => {
  renderView(createStore())
  expect(screen.getByText('Vault apps are off')).toBeInTheDocument()
})

test("an app's preview fills its plate, and one without keeps the icon", async () => {
  const preview = vi.fn(async (_remote: string, id: string) =>
    id === 'tools/Budget.app' ? 'data:image/jpeg;base64,AAAA' : null,
  )
  renderView(withApps({ extra: { preview } }))
  const [budget, home] = screen.getAllByRole('listitem')
  const img = await within(budget!).findByRole('img', {
    name: 'Budget, as it last looked',
  })
  expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA')
  expect(img.className).toContain('object-cover')
  await vi.waitFor(() => expect(within(home!).getByTestId('app-icon')).toBeInTheDocument())
  expect(preview).toHaveBeenCalledWith('syv-ai/site', 'Home.local.app')
})

/** The menu a card opens: a right-click, or the menu key on its focused
 *  Open button, both a `contextmenu` event the card's trigger hears. */
function openMenu(name: string) {
  fireEvent.contextMenu(screen.getByRole('button', { name: `Open ${name}` }))
  return screen.getByRole('menu')
}

test("right-click offers the app's actions, and each does its thing", async () => {
  const refresh = vi.fn(async (_id: string) => {})
  const store = withApps({
    extra: {
      refreshPreview: atom(null, (_get, _set, id: string) => refresh(id)),
      archive: atom(null, async () => {}),
    },
  })
  const write = vi.fn(async () => {})
  Object.assign(navigator, { clipboard: { writeText: write } })
  const onOpen = renderView(store)

  const menu = openMenu('Budget')
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent),
  ).toEqual(['Open', 'Open beside', 'Reveal in Files', 'Copy path', 'Refresh preview', 'Archive'])

  await userEvent.click(within(menu).getByRole('menuitem', { name: 'Open' }))
  expect(onOpen).toHaveBeenCalledWith('tools/Budget.app')

  await userEvent.click(within(openMenu('Budget')).getByRole('menuitem', { name: 'Copy path' }))
  expect(write).toHaveBeenCalledWith('tools/Budget.app')

  await userEvent.click(
    within(openMenu('Budget')).getByRole('menuitem', {
      name: 'Reveal in Files',
    }),
  )
  expect(store.get(revealInFilesRequestAtom)?.path).toBe('tools/Budget.app')

  await userEvent.click(
    within(openMenu('Budget')).getByRole('menuitem', {
      name: 'Refresh preview',
    }),
  )
  expect(refresh).toHaveBeenCalledWith('tools/Budget.app')
})

test('Open beside opens the app in split view, as ⌥-click does', async () => {
  const store = withApps()
  store.set(shellWorkspaceAtom, {
    entries: ['holi:apps'],
    active: 'holi:apps',
    closed: [],
    seq: 0,
  })
  renderView(store)
  await userEvent.click(within(openMenu('Budget')).getByRole('menuitem', { name: 'Open beside' }))
  const ws = store.get(shellWorkspaceAtom)
  expect(ws.entries).toHaveLength(1)
  expect(ws.entries[0]).toMatchObject({
    views: ['holi:apps', 'tools/Budget.app'],
  })
})

test("Archive hides the card behind Archived, and the toast's Undo brings it back", async () => {
  const archived = atom<string[]>([])
  const instances = atom((get) => APPS.filter((p) => !get(archived).includes(p)))
  const calls: { id: string; archived: boolean }[] = []
  const archive = atom(null, async (_get, set, arg: { id: string; archived: boolean }) => {
    calls.push(arg)
    set(archived, (now) => (arg.archived ? [...now, arg.id] : now.filter((p) => p !== arg.id)))
  })
  renderView(withApps({ extra: { instances, archived, archive } }))

  await userEvent.click(within(openMenu('Budget')).getByRole('menuitem', { name: 'Archive' }))
  expect(calls).toEqual([{ id: 'tools/Budget.app', archived: true }])
  expect(screen.queryByRole('button', { name: 'Open Budget' })).not.toBeInTheDocument()

  // Listed under Archived, with Unarchive in its menu.
  const toggle = screen.getByRole('button', { name: 'Show the archived apps' })
  expect(toggle.textContent).toContain('1')
  await userEvent.click(toggle)
  expect(screen.getByText('Archived apps')).toBeInTheDocument()
  expect(
    within(openMenu('Budget')).getByRole('menuitem', { name: 'Unarchive' }),
  ).toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

  // The toast says so and undoes it; the undo offers no second toast.
  expect(toasts.toast).toHaveBeenCalledTimes(1)
  const [title, options] = toasts.toast.mock.calls[0] as [
    string,
    { action: { label: string; onClick: () => void } },
  ]
  expect(title).toBe('Budget archived')
  expect(options.action.label).toBe('Undo')
  options.action.onClick()
  await vi.waitFor(() =>
    expect(screen.getByRole('button', { name: 'Open Budget' })).toBeInTheDocument(),
  )
  expect(calls[1]).toEqual({ id: 'tools/Budget.app', archived: false })
  expect(toasts.toast).toHaveBeenCalledTimes(1)
  // Nothing archived: no Archived toggle.
  expect(screen.queryByRole('button', { name: /archived apps/ })).not.toBeInTheDocument()
})

/** The shell's selection-to-tab rule, as the app shell mounts it. */
function SessionTabs() {
  useSessionTabs(null)
  return null
}

test('Ask about this app opens a new chat beside the page, carrying the app', async () => {
  const store = withApps()
  store.set(shellWorkspaceAtom, {
    entries: ['holi:apps'],
    active: 'holi:apps',
    closed: [],
    seq: 0,
  })
  // A chat slot as the chat plugin's is: with no text it opens its
  // new-session page, beside when asked, holding the context.
  const started: ConversationStart[] = []
  store.set(installedPluginsAtom, [
    {
      info: { id: 'chat-stand-in', label: 'Chat', default: true },
      agentsSlot: {
        start: atom(null, async (_get, set, args: ConversationStart) => {
          started.push(args)
          if (args.beside) openNextBeside()
          set(agentsSelectionAtom, { owner: 'chat', id: 'new' })
          return { ok: true as const }
        }),
      },
    },
  ] as never)
  render(
    <Provider store={store}>
      <SessionTabs />
      <AppsView onOpen={() => {}} />
    </Provider>,
  )
  await userEvent.click(
    within(openMenu('Budget')).getByRole('menuitem', {
      name: 'Ask about this app',
    }),
  )
  expect(started).toEqual([
    {
      text: '',
      context: [{ kind: 'app', path: 'tools/Budget.app', name: 'Budget' }],
      beside: true,
    },
  ])
  await vi.waitFor(() =>
    expect(store.get(shellWorkspaceAtom).entries[0]).toMatchObject({
      views: ['holi:apps', 'holi:agents'],
    }),
  )
})

test('with no agent to ask, the menu leaves Ask about this app out', () => {
  renderView(withApps())
  expect(
    within(openMenu('Budget')).queryByRole('menuitem', {
      name: 'Ask about this app',
    }),
  ).toBeNull()
})
