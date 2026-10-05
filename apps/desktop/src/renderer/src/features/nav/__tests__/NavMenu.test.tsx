/**
 * The nav menu's items do what their names say, and the ones that depend on
 * something (apps, a plugin's own condition) appear only when it is there. Core's surfaces are
 * installed as `main.tsx` installs them. Driven through the
 * expanded list: jsdom lays nothing out, so the vertical dock has no room and
 * holds only More, whose list is then every item.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, atom, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { paletteAtom } from '@/state/palette'
import { CORE_CONTRIBUTION } from '@/components/core-surfaces'
import { activeTab, workspaceAtom, type Tab } from '@/state/panes'
import {
  coreContributionAtom,
  hubPlacementAtom,
  installedPluginsAtom,
  tabsPlacementAtom,
} from '@/state/plugins'
import { vaultSettingsAtom } from '@/state/settings'
import { activeRemoteAtom } from '@/state/vaults'
import { tabThumbsAtom } from '@/state/tab-thumbs'
import { NavMenu } from '../NavMenu'
import type { RendererPlugin } from '@/plugin-api/types'
import { Inbox } from 'lucide-react'

const { apps, tasks, overdue } = vi.hoisted(() => ({
  apps: { current: [] as string[] },
  tasks: { current: 0 },
  overdue: { current: 0 },
}))
vi.mock('@/state/tasks', () => ({
  openTaskCountAtom: atom(() => tasks.current),
  overdueTaskCountAtom: atom(() => overdue.current),
}))

/** A plugin's rail item, shown while its own condition holds, as Google's
 *  Mail shows once an account is connected. */
const shownAtom = atom(false)
const FAKE_PLUGIN: RendererPlugin = {
  info: { id: 'fake', label: 'Fake', default: true },
  surfaces: [{ kind: 'inbox', label: 'Inbox', icon: Inbox, render: () => null }],
  rail: [{ surface: 'inbox', order: 40, visible: shownAtom }],
}

/** A surface with a tab per thing, as vault apps' is: its rail item drills
 *  down to its instances, and is there only while it has some. */
const FAKE_APPS: RendererPlugin = {
  info: { id: 'fake-apps', label: 'Fake apps', default: true },
  surfaces: [
    {
      kind: 'app',
      label: (id) => (id === undefined ? 'App' : (id.split('/').pop() ?? id).replace(/\.app$/, '')),
      icon: Inbox,
      render: () => null,
      instances: atom(() => apps.current),
    },
  ],
  rail: [{ surface: 'app', order: 20, label: 'Apps' }],
}

function setup({
  appPaths = [],
  openTasks = 0,
  overdueTasks = 0,
  shown = false,
}: { appPaths?: string[]; openTasks?: number; overdueTasks?: number; shown?: boolean } = {}) {
  apps.current = appPaths
  tasks.current = openTasks
  overdue.current = overdueTasks
  const store = createStore()
  store.set(coreContributionAtom, CORE_CONTRIBUTION)
  store.set(installedPluginsAtom, [FAKE_PLUGIN, FAKE_APPS])
  store.set(shownAtom, shown)
  render(
    <Provider store={store}>
      <NavMenu orientation="vertical" />
    </Provider>,
  )
  return { store, user: userEvent.setup() }
}

/** The expanded list, opened from More. */
async function openList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'More' }))
  return screen.getByRole('button', { name: 'Home' }).parentElement!
}

test("the items are in their order, without apps or a plugin's hidden item", async () => {
  const { user } = setup()
  const list = await openList(user)
  expect(
    within(list)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Home', 'Search', 'Board', 'Sync: up to date', 'Settings'])
})

test("Settings comes last, after a plugin's items, so it sits beside More", async () => {
  const { user } = setup({ appPaths: ['char-count.app'], shown: true })
  const list = await openList(user)
  expect(
    within(list)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Home', 'Search', 'Apps', 'Board', 'Inbox', 'Sync: up to date', 'Settings'])
})

test('the board count turns to an alert while a task is overdue', async () => {
  const { user } = setup({ openTasks: 5, overdueTasks: 1 })
  await openList(user)
  const count = within(screen.getByRole('button', { name: /Board/ })).getByText('5')
  expect(count).toHaveAttribute('data-tone', 'alert')
})

test('with nothing overdue the board count is plain', async () => {
  const { user } = setup({ openTasks: 5 })
  await openList(user)
  const count = within(screen.getByRole('button', { name: /Board/ })).getByText('5')
  expect(count).not.toHaveAttribute('data-tone')
})

test('Home opens the home surface', async () => {
  const { store, user } = setup({ appPaths: [VAULT_SETTING_DEFAULTS.home] })
  // A vault open, its settings already read: Home is the app it holds.
  store.set(activeRemoteAtom, 'me/notes')
  store.set(vaultSettingsAtom, {
    remote: 'me/notes',
    settings: { ...VAULT_SETTING_DEFAULTS, warnings: [] },
  })
  await openList(user)
  await user.click(screen.getByRole('button', { name: 'Home' }))
  await waitFor(() =>
    expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'surface', surface: 'home' }),
  )
})

test('Search opens the palette', async () => {
  const { store, user } = setup()
  await openList(user)
  await user.click(screen.getByRole('button', { name: 'Search' }))
  expect(store.get(paletteAtom).open).toBe(true)
})

test('Board opens the board and carries the open-task count', async () => {
  const { store, user } = setup({ openTasks: 12 })
  await openList(user)
  const board = screen.getByRole('button', { name: /Board/ })
  expect(board).toHaveTextContent('12')
  await user.click(board)
  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'surface', surface: 'board' })
})

test('Settings opens settings', async () => {
  const { store, user } = setup()
  await openList(user)
  await user.click(screen.getByRole('button', { name: 'Settings' }))
  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'surface', surface: 'settings' })
})

test('Apps drills into the apps by name, and picking one opens it', async () => {
  const { store, user } = setup({ appPaths: ['char-count.app', 'Areas/tasks-by-area.app'] })
  await openList(user)
  await user.click(screen.getByRole('button', { name: 'Apps' }))
  const group = screen.getByRole('generic', { name: 'Apps' })
  expect(
    within(group)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Back', 'char-count', 'tasks-by-area'])
  await user.click(within(group).getByRole('button', { name: 'tasks-by-area' }))
  expect(activeTab(store.get(workspaceAtom))).toEqual({
    kind: 'surface',
    surface: 'app',
    id: 'Areas/tasks-by-area.app',
  })
})

test("a plugin's item appears when its condition holds, and opens its pane", async () => {
  const { store, user } = setup({ shown: true })
  await openList(user)
  await user.click(screen.getByRole('button', { name: 'Inbox' }))
  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'surface', surface: 'inbox' })
})

test("a plugin's item stays hidden while its condition does not hold", async () => {
  const { user } = setup({ shown: false })
  await openList(user)
  expect(screen.queryByRole('button', { name: 'Inbox', hidden: true })).toBeNull()
})

test('the active surface reads as the current page', async () => {
  const { user } = setup()
  await openList(user)
  await user.click(screen.getByRole('button', { name: 'Settings' }))
  await openList(user)
  expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
})

test('the menu sits in the sidebar until a running plugin docks it', () => {
  const docking: RendererPlugin = {
    info: { id: 'docking', label: 'Docking', default: false },
    layout: { hub: 'dock' },
  }
  const store = createStore()
  store.set(installedPluginsAtom, [FAKE_PLUGIN, docking])
  // Installed, and off by its own default.
  expect(store.get(hubPlacementAtom)).toBe('sidebar')

  store.set(activeRemoteAtom, 'me/vault')
  store.set(vaultSettingsAtom, {
    remote: 'me/vault',
    settings: {
      ...VAULT_SETTING_DEFAULTS,
      plugins: { vault: { docking: true }, localOff: [] },
      warnings: [],
    },
  })
  expect(store.get(hubPlacementAtom)).toBe('dock')
})

test('as a dock it lays every item out in one centred, floating row', () => {
  const store = createStore()
  store.set(coreContributionAtom, CORE_CONTRIBUTION)
  render(
    <Provider store={store}>
      <NavMenu dock />
    </Provider>,
  )
  // Horizontal, so nothing overflows into More.
  expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
  const shell = screen.getByRole('navigation', { name: 'Go to' }).firstElementChild!
  expect(shell).toHaveClass('left-1/2', 'bg-popover')
})

/** A plugin that puts the open tabs in the menu, as the workspace plugin does. */
const TABS_IN_MENU: RendererPlugin = {
  info: { id: 'tabs-in-menu', label: 'Tabs in menu', default: true },
  layout: { tabs: 'hub' },
}

/** Vault apps as the plugin has them: a page of apps (the rail item) and one
 *  `app` tab per open app, which the Apps item holds (`RailItem.tabs`). */
const APPS_WITH_TABS: RendererPlugin = {
  info: { id: 'apps-with-tabs', label: 'Apps', default: true },
  surfaces: [
    { kind: 'apps', label: 'Apps', icon: Inbox, render: () => null },
    {
      kind: 'app',
      label: (id) => (id === undefined ? 'App' : (id.split('/').pop() ?? id).replace(/\.app$/, '')),
      icon: Inbox,
      render: () => null,
    },
  ],
  rail: [{ surface: 'apps', order: 20, tabs: 'app' }],
}

function setupTabs(panes: { tabs: Tab[]; active: number }[], plugins = [TABS_IN_MENU]) {
  const store = createStore()
  store.set(coreContributionAtom, CORE_CONTRIBUTION)
  store.set(installedPluginsAtom, plugins)
  store.set(workspaceAtom, { panes, active: 0 })
  render(
    <Provider store={store}>
      <NavMenu dock />
    </Provider>,
  )
  return { store, user: userEvent.setup() }
}

test('the tabs stay in each pane until a running plugin puts them in the menu', () => {
  const store = createStore()
  expect(store.get(tabsPlacementAtom)).toBe('strip')
  store.set(installedPluginsAtom, [TABS_IN_MENU])
  expect(store.get(tabsPlacementAtom)).toBe('hub')
})

test('with the tabs in the menu, Open files is there only while a file is open', () => {
  setupTabs([{ tabs: [{ kind: 'surface', surface: 'board' }], active: 0 }])
  expect(screen.queryByRole('button', { name: 'Open files' })).toBeNull()
})

test('an item holds its open tabs in a card: go to one, or close it', async () => {
  const { store, user } = setupTabs([
    {
      tabs: [
        { kind: 'surface', surface: 'board' },
        { kind: 'note', path: 'notes/alpha.md' },
        { kind: 'note', path: 'notes/beta.md' },
      ],
      active: 0,
    },
  ])
  const files = screen.getByRole('button', { name: 'Open files' })
  expect(within(files).getByText('2')).toBeInTheDocument()

  await user.hover(files)
  const card = await screen.findByRole('group', { name: 'Open files: open tabs' })
  // The board is its own item's, not a file.
  expect(within(card).queryByText('Board')).toBeNull()

  await user.click(within(card).getByRole('button', { name: 'notes/beta.md' }))
  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'note', path: 'notes/beta.md' })

  await user.click(within(card).getByRole('button', { name: 'Close alpha' }))
  expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([
    { kind: 'surface', surface: 'board' },
    { kind: 'note', path: 'notes/beta.md' },
  ])
})

test('a card shows a picture of each tab and no title, and a bubble to open a new one', async () => {
  const { store, user } = setupTabs([
    {
      tabs: [
        { kind: 'surface', surface: 'board' },
        { kind: 'note', path: 'notes/alpha.md' },
        { kind: 'note', path: 'notes/beta.md' },
      ],
      active: 1,
    },
  ])
  store.set(tabThumbsAtom, new Map([['note:notes/alpha.md', 'data:image/jpeg;base64,AAAA']]))
  store.set(activeRemoteAtom, 'me/notes')
  store.set(vaultSettingsAtom, {
    remote: 'me/notes',
    settings: { ...VAULT_SETTING_DEFAULTS, warnings: [] },
  })
  await user.hover(screen.getByRole('button', { name: 'Open files' }))
  const card = await screen.findByRole('group', { name: 'Open files: open tabs' })
  // A title would be text in the card; the bubbles are pictures.
  expect(card).toHaveTextContent('')
  const shown = within(card).getByRole('button', { name: 'notes/alpha.md' })
  expect(shown.querySelector('img')).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA')
  // Not seen yet: its mark, not a picture.
  expect(
    within(card).getByRole('button', { name: 'notes/beta.md' }).querySelector('img'),
  ).toBeNull()

  // "+" is the group's main page: Home, for the files.
  await user.click(within(card).getByRole('button', { name: 'Open a file' }))
  await waitFor(() =>
    expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'surface', surface: 'home' }),
  )
})

test('open apps are held by the Apps item, with their pictures, and not by Open files', async () => {
  const { store, user } = setupTabs(
    [
      {
        tabs: [
          { kind: 'note', path: 'notes/alpha.md' },
          { kind: 'surface', surface: 'app', id: 'char-count.app' },
          { kind: 'surface', surface: 'apps' },
        ],
        active: 1,
      },
    ],
    [TABS_IN_MENU, APPS_WITH_TABS],
  )
  store.set(tabThumbsAtom, new Map([['surface:app:char-count.app', 'data:image/jpeg;base64,BBBB']]))
  store.set(activeRemoteAtom, 'me/notes')
  store.set(vaultSettingsAtom, {
    remote: 'me/notes',
    settings: { ...VAULT_SETTING_DEFAULTS, warnings: [] },
  })
  // The note is the only file: the app is not counted with it.
  expect(
    within(screen.getByRole('button', { name: 'Open files' })).getByText('1'),
  ).toBeInTheDocument()

  await user.hover(screen.getByRole('button', { name: 'Apps' }))
  const card = await screen.findByRole('group', { name: 'Apps: open tabs' })
  const shown = within(card).getByRole('button', { name: /^char-count,/ })
  expect(shown.querySelector('img')).toHaveAttribute('src', 'data:image/jpeg;base64,BBBB')
  // The page of apps is the item itself, not one of its tabs.
  expect(within(card).queryByRole('button', { name: 'Apps' })).toBeNull()
  // "+" is the Apps page.
  await user.click(within(card).getByRole('button', { name: 'New Apps tab' }))
  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'surface', surface: 'apps' })
})

test('pressing Open files goes back to the file its pane was showing', async () => {
  const { store, user } = setupTabs([
    { tabs: [{ kind: 'surface', surface: 'board' }], active: 0 },
    {
      tabs: [
        { kind: 'note', path: 'a.md' },
        { kind: 'note', path: 'b.md' },
      ],
      active: 0,
    },
  ])
  await user.click(screen.getByRole('button', { name: 'Open files' }))
  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'note', path: 'a.md' })
})

test('a surface that is one page holds no card, only the way to it', async () => {
  const { user } = setupTabs([
    {
      tabs: [
        { kind: 'surface', surface: 'board' },
        { kind: 'note', path: 'notes/alpha.md' },
      ],
      active: 0,
    },
  ])
  await user.hover(screen.getByRole('button', { name: /Board/ }))
  // Its tooltip, as ever, and no card of tabs.
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Board')
  expect(screen.queryByRole('group', { name: 'Board: open tabs' })).toBeNull()
})
