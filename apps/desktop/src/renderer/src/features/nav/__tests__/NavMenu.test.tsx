/**
 * The nav menu's items do what their names say, and the ones that depend on
 * something (apps, Google) appear only when it is there. Core's surfaces are
 * installed as `main.tsx` installs them. Driven through the
 * expanded list: jsdom lays nothing out, so the vertical dock has no room and
 * holds only More, whose list is then every item.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, atom, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { googleAccountAtom } from '@/state/google'
import { paletteAtom } from '@/state/palette'
import { CORE_SURFACES } from '@/components/core-surfaces'
import { activeTab, workspaceAtom } from '@/state/panes'
import { coreSurfacesAtom } from '@/state/plugins'
import { vaultSettingsAtom } from '@/state/settings'
import { activeRemoteAtom } from '@/state/vaults'
import { NavMenu } from '../NavMenu'

const { apps, tasks, overdue } = vi.hoisted(() => ({
  apps: { current: [] as string[] },
  tasks: { current: 0 },
  overdue: { current: 0 },
}))
vi.mock('@/state/apps', () => ({ appPathsAtom: atom(() => apps.current) }))
vi.mock('@/state/tasks', () => ({
  openTaskCountAtom: atom(() => tasks.current),
  overdueTaskCountAtom: atom(() => overdue.current),
}))

type Account = { email: string } | null | undefined

function setup({
  appPaths = [],
  openTasks = 0,
  overdueTasks = 0,
  account = null,
}: { appPaths?: string[]; openTasks?: number; overdueTasks?: number; account?: Account } = {}) {
  apps.current = appPaths
  tasks.current = openTasks
  overdue.current = overdueTasks
  const store = createStore()
  store.set(coreSurfacesAtom, CORE_SURFACES)
  store.set(googleAccountAtom, account as never)
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

test('the items are in their order, without apps or Google when there are none', async () => {
  const { user } = setup()
  const list = await openList(user)
  expect(
    within(list)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Home', 'Search', 'Board', 'Agents', 'Sync: up to date', 'Settings'])
})

test('Settings comes last, after Google, so it sits beside More', async () => {
  const { user } = setup({ appPaths: ['char-count.app'], account: { email: 'ada@syv.ai' } })
  const list = await openList(user)
  expect(
    within(list)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual([
    'Home',
    'Search',
    'Apps',
    'Board',
    'Mail',
    'Agenda',
    'Agents',
    'Sync: up to date',
    'Settings',
  ])
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
  await waitFor(() => expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'surface', surface: 'home' }))
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
    kind: 'app',
    path: 'Areas/tasks-by-area.app',
  })
})

test('Mail and Agenda appear once Google is connected, and open their panes', async () => {
  const { store, user } = setup({ account: { email: 'ada@syv.ai' } })
  await openList(user)
  await user.click(screen.getByRole('button', { name: 'Mail' }))
  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'surface', surface: 'mail' })
  await openList(user)
  await user.click(screen.getByRole('button', { name: 'Agenda' }))
  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'surface', surface: 'agenda' })
})

test('before Google has been asked about, Mail and Agenda stay hidden', async () => {
  const { user } = setup({ account: undefined })
  await openList(user)
  expect(screen.queryByRole('button', { name: 'Mail', hidden: true })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Agenda', hidden: true })).toBeNull()
})

test('the active surface reads as the current page', async () => {
  const { user } = setup()
  await openList(user)
  await user.click(screen.getByRole('button', { name: 'Settings' }))
  await openList(user)
  expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
})
