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
  utilitiesPlacementAtom,
} from '@/state/plugins'
import { vaultSettingsAtom } from '@/state/settings'
import { activeRemoteAtom } from '@/state/vaults'
import { NavMenu } from '../NavMenu'
import { Utilities } from '../Utilities'
import type { RendererPlugin } from '@/plugin-api/types'
import { Inbox } from 'lucide-react'

const { apps } = vi.hoisted(() => ({ apps: { current: [] as string[] } }))

/** A plugin's rail item, shown while its own condition holds, as Google's
 *  Mail shows once an account is connected, and carrying a count, as the
 *  board carries its open tasks. */
const shownAtom = atom(false)
const badgeAtom = atom<{ count: number; tone?: 'alert' } | null>(null)
const FAKE_PLUGIN: RendererPlugin = {
  info: { id: 'fake', label: 'Fake', default: true },
  surfaces: [{ kind: 'inbox', label: 'Inbox', icon: Inbox, render: () => null }],
  rail: [{ surface: 'inbox', order: 40, visible: shownAtom, badge: badgeAtom }],
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
  badge = null,
  shown = false,
}: {
  appPaths?: string[]
  badge?: { count: number; tone?: 'alert' } | null
  shown?: boolean
} = {}) {
  apps.current = appPaths
  const store = createStore()
  store.set(coreContributionAtom, CORE_CONTRIBUTION)
  store.set(installedPluginsAtom, [FAKE_PLUGIN, FAKE_APPS])
  store.set(shownAtom, shown)
  store.set(badgeAtom, badge)
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
  ).toEqual(['Home', 'Search', 'Graph', 'Sync: up to date', 'Settings'])
})

test("Settings comes last, after a plugin's items, so it sits beside More", async () => {
  const { user } = setup({ appPaths: ['char-count.app'], shown: true })
  const list = await openList(user)
  expect(
    within(list)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Home', 'Search', 'Apps', 'Graph', 'Inbox', 'Sync: up to date', 'Settings'])
})

test("an item's count turns to an alert when its badge says so", async () => {
  const { user } = setup({ shown: true, badge: { count: 5, tone: 'alert' } })
  await openList(user)
  const count = within(screen.getByRole('button', { name: /Inbox/ })).getByText('5')
  expect(count).toHaveAttribute('data-tone', 'alert')
})

test('a plain badge is a plain count', async () => {
  const { user } = setup({ shown: true, badge: { count: 5 } })
  await openList(user)
  const count = within(screen.getByRole('button', { name: /Inbox/ })).getByText('5')
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

test("a plugin's item opens its surface", async () => {
  const { store, user } = setup({ shown: true })
  await openList(user)
  await user.click(screen.getByRole('button', { name: /Inbox/ }))
  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'surface', surface: 'inbox' })
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
 *  `app` tab per open app, which are the Apps item's too (`RailItem.tabs`). */
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

const tabsGroup = () => screen.queryByRole('group', { name: 'Open tabs' })

test('with the tabs in the menu, the section of them is there only while one is listed', () => {
  // The graph is its item's one page, so there is nothing to list.
  setupTabs([{ tabs: [{ kind: 'surface', surface: 'graph' }], active: 0 }])
  expect(tabsGroup()).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open files' })).toBeNull()
})

test('the open tabs are a section of the bar: go to one, or close it', async () => {
  const { store, user } = setupTabs([
    {
      tabs: [
        { kind: 'surface', surface: 'graph' },
        { kind: 'note', path: 'notes/alpha.md' },
        { kind: 'note', path: 'notes/beta.md' },
      ],
      active: 0,
    },
  ])
  const group = tabsGroup()!
  // Every file, and not the graph, whose item is the way to it.
  expect(
    within(group)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label')),
  ).toEqual(['alpha', 'beta'])

  await user.click(within(group).getByRole('button', { name: 'beta' }))
  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'note', path: 'notes/beta.md' })
  expect(within(group).getByRole('button', { name: 'beta' })).toHaveAttribute(
    'aria-current',
    'page',
  )

  await user.hover(within(group).getByRole('button', { name: 'alpha' }))
  await user.click(await screen.findByRole('button', { name: 'Close alpha' }))
  await waitFor(() =>
    expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([
      { kind: 'surface', surface: 'graph' },
      { kind: 'note', path: 'notes/beta.md' },
    ]),
  )
})

test('the section is in the menu’s own bar, after a line that sets it apart', () => {
  setupTabs([{ tabs: [{ kind: 'note', path: 'notes/alpha.md' }], active: 0 }])
  const group = tabsGroup()!
  const bar = screen.getByRole('button', { name: 'Home' }).closest('.grid')!
  expect(bar.contains(group)).toBe(true)
  const section = group.closest('[data-menu-trailing]')!
  expect(section).toHaveAttribute('data-menu-trailing', 'inline')
  expect(section.firstElementChild).toHaveAttribute('data-menu-trailing-line')
})

test('resting on a tab opens its name and close button above the bar, which keeps its size', async () => {
  const { user } = setupTabs([{ tabs: [{ kind: 'note', path: 'notes/alpha.md' }], active: 0 }])
  const tab = screen.getByRole('button', { name: 'alpha' })
  const bar = tab.closest('.grid') as HTMLElement
  const width = bar.style.width
  expect(screen.queryByRole('button', { name: 'Close alpha' })).toBeNull()
  await user.hover(tab)
  const close = await screen.findByRole('button', { name: 'Close alpha' })
  // Not in the bar at all, so it neither covers the icon nor moves the dock.
  expect(bar.contains(close)).toBe(false)
  expect(close.closest('[data-open-tab-label]')).toHaveTextContent('notes/alpha.md')
  expect(bar.style.width).toBe(width)
})

test('a preview tab is marked, and pressing it twice keeps it open', async () => {
  const { store, user } = setupTabs([
    { tabs: [{ kind: 'note', path: 'notes/alpha.md', preview: true }], active: 0 },
  ])
  const tab = screen.getByRole('button', { name: 'alpha, preview' })
  expect(tab).toHaveAttribute('data-preview')
  await user.dblClick(tab)
  expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([
    { kind: 'note', path: 'notes/alpha.md' },
  ])
  expect(screen.getByRole('button', { name: 'alpha' })).not.toHaveAttribute('data-preview')
})

test('a preview tab’s label keeps it open too', async () => {
  const { store, user } = setupTabs([
    {
      tabs: [
        { kind: 'note', path: 'notes/alpha.md' },
        { kind: 'note', path: 'notes/beta.md', preview: true },
      ],
      active: 0,
    },
  ])
  // A pinned tab's label has no Keep open.
  await user.hover(screen.getByRole('button', { name: 'alpha' }))
  await screen.findByRole('button', { name: 'Close alpha' })
  expect(screen.queryByRole('button', { name: 'Keep alpha open' })).toBeNull()
  await user.unhover(screen.getByRole('button', { name: 'alpha' }))

  await user.hover(screen.getByRole('button', { name: 'beta, preview' }))
  await user.click(await screen.findByRole('button', { name: 'Keep beta open' }))
  expect(store.get(workspaceAtom).panes[0]!.tabs[1]).toEqual({
    kind: 'note',
    path: 'notes/beta.md',
  })
})

test('open apps are in the section, and Apps reads as current while one shows', () => {
  setupTabs(
    [
      {
        tabs: [
          { kind: 'surface', surface: 'apps' },
          { kind: 'surface', surface: 'app', id: 'tools/char-count.app' },
        ],
        active: 1,
      },
    ],
    [TABS_IN_MENU, APPS_WITH_TABS],
  )
  // The app, and not the page of apps, which is the Apps item's.
  expect(
    within(tabsGroup()!)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label')),
  ).toEqual(['char-count'])
})

test('a page no menu item goes to is listed, so it can be closed', async () => {
  const { store, user } = setupTabs(
    [{ tabs: [{ kind: 'surface', surface: 'settings' }], active: 0 }],
    [{ ...TABS_IN_MENU, layout: { tabs: 'hub', utilities: 'header' } }],
  )
  await user.hover(within(tabsGroup()!).getByRole('button', { name: 'Settings' }))
  await user.click(await screen.findByRole('button', { name: 'Close Settings' }))
  await waitFor(() => expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([]))
})

/** A plugin that moves Settings and sync to the sidebar's header, as the
 *  workspace plugin does. */
const UTILITIES_IN_HEADER: RendererPlugin = {
  info: { id: 'utilities-in-header', label: 'Utilities in header', default: true },
  layout: { utilities: 'header' },
}

test('Settings and sync are the menu’s until a running plugin moves them to the header', () => {
  const store = createStore()
  expect(store.get(utilitiesPlacementAtom)).toBe('hub')
  store.set(installedPluginsAtom, [UTILITIES_IN_HEADER])
  expect(store.get(utilitiesPlacementAtom)).toBe('header')
})

function setupUtilities() {
  const store = createStore()
  store.set(coreContributionAtom, CORE_CONTRIBUTION)
  store.set(installedPluginsAtom, [UTILITIES_IN_HEADER])
  render(
    <Provider store={store}>
      <NavMenu orientation="vertical" />
    </Provider>,
  )
  return { store, user: userEvent.setup() }
}

test('with them in the header, the menu leaves Settings and sync out', async () => {
  const { user } = setupUtilities()
  const list = await openList(user)
  expect(
    within(list)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Home', 'Search', 'Graph'])
})

test('in the header they are two icons: sync opens its panel, Settings opens settings', async () => {
  const store = createStore()
  store.set(coreContributionAtom, CORE_CONTRIBUTION)
  store.set(installedPluginsAtom, [UTILITIES_IN_HEADER])
  render(
    <Provider store={store}>
      <Utilities />
    </Provider>,
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Sync: up to date' }))
  expect(await screen.findByRole('button', { name: 'Open history' })).toBeInTheDocument()
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: 'Settings' }))
  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'surface', surface: 'settings' })
})

test('the icons are not there while Settings and sync are the menu’s', () => {
  const store = createStore()
  store.set(coreContributionAtom, CORE_CONTRIBUTION)
  render(
    <Provider store={store}>
      <Utilities />
    </Provider>,
  )
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
})
