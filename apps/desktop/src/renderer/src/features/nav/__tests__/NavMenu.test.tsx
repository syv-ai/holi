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
import { activeTab, workspaceAtom } from '@/state/panes'
import { coreContributionAtom, installedPluginsAtom } from '@/state/plugins'
import { vaultSettingsAtom } from '@/state/settings'
import { activeRemoteAtom } from '@/state/vaults'
import { NavMenu } from '../NavMenu'
import type { RendererPlugin } from '@/plugin-api/types'
import { Inbox } from 'lucide-react'

const { apps, tasks, overdue } = vi.hoisted(() => ({
  apps: { current: [] as string[] },
  tasks: { current: 0 },
  overdue: { current: 0 },
}))
vi.mock('@/state/apps', () => ({
  appPathsAtom: atom(() => apps.current),
  appInstancesAtom: atom(() => apps.current),
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
  store.set(installedPluginsAtom, [FAKE_PLUGIN])
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
  ).toEqual(['Home', 'Search', 'Board', 'Agents', 'Sync: up to date', 'Settings'])
})

test("Settings comes last, after a plugin's items, so it sits beside More", async () => {
  const { user } = setup({ appPaths: ['char-count.app'], shown: true })
  const list = await openList(user)
  expect(
    within(list)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Home', 'Search', 'Apps', 'Board', 'Inbox', 'Agents', 'Sync: up to date', 'Settings'])
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
