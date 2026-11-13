import { act, render, screen, fireEvent, waitFor } from '@/test/render'
import { Provider, createStore } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, shownDialogAtom } from '@/plugin-api'
import { PluginsSettings } from '../renderer/plugins-settings'
import { communityRenderer } from '../renderer/index'
import { rowsAtom, updatesAtom, type PluginRow } from '../renderer/state'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  install: vi.fn(),
  ask: vi.fn(),
  list: vi.fn(),
  updates: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('../renderer/install-flow', () => ({
  updatePlugin: mocks.update,
  installAndAsk: mocks.install,
  askToRun: mocks.ask,
}))
vi.mock('../renderer/community-cap', () => ({
  communityCap: { list: mocks.list, updates: mocks.updates, remove: mocks.remove },
  setPluginSwitch: vi.fn(),
}))

const Notice = communityRenderer.sidebarSection!
const row = (id = 'dash', status: PluginRow['status'] = 'ready'): PluginRow => ({
  id,
  name: id,
  description: '',
  opens: [],
  status,
  on: true,
  running: false,
  pin: { repo: `synthetic/${id}`, path: '', version: '1.0.0', commit: 'abc' },
  install: null,
  setup: null,
  serve: null,
  apps: [],
  bin: [],
  commandsNote: null,
  check: null,
})

let resolveAction!: (value: null) => void
let resolveInstall!: (value: null) => void
let rejectAction!: (reason: Error) => void

function openSettings(rows = [row()]) {
  const store = createStore()
  store.set(activeRemoteAtom, 'synthetic/vault')
  store.set(rowsAtom, { remote: 'synthetic/vault', rows })
  store.set(updatesAtom, { dash: '2.0.0' })
  const view = render(
    <Provider store={store}>
      <PluginsSettings remote="synthetic/vault" />
    </Provider>,
  )
  return { store, ...view }
}

function openNotice() {
  const store = createStore()
  store.set(activeRemoteAtom, 'synthetic/vault')
  store.set(rowsAtom, { remote: 'synthetic/vault', rows: [row()] })
  store.set(updatesAtom, { dash: '2.0.0' })
  render(
    <Provider store={store}>
      <Notice />
    </Provider>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.list.mockResolvedValue([row()])
  mocks.updates.mockResolvedValue({ dash: '2.0.0' })
  mocks.update.mockReturnValue(
    new Promise<null>((resolve, reject) => {
      resolveAction = resolve
      rejectAction = reject
    }),
  )
  mocks.install.mockReturnValue(
    new Promise<null>((resolve) => {
      resolveInstall = resolve
    }),
  )
  // Tailwind is not loaded by jsdom; model visibility/opacity so a hidden
  // utility cannot pass an accessible-name assertion based only on text.
  const css = document.createElement('style')
  css.id = 'busy-label-css'
  css.textContent = '.invisible { visibility: hidden; } .opacity-0 { opacity: 0; }'
  document.head.append(css)
})

afterEach(() => {
  document.querySelector('#busy-label-css')?.remove()
  localStorage.clear()
})

test('hiding Settings dismisses plugin search results and does not reopen them on return', async () => {
  const { store, rerender } = openSettings()
  const input = screen.getByPlaceholderText('Search GitHub, or type owner/repo')
  fireEvent.change(input, { target: { value: 'synthetic/plugin' } })
  await screen.findByText('Searching…')

  rerender(
    <Provider store={store}>
      <PluginsSettings remote="synthetic/vault" visible={false} />
    </Provider>,
  )
  expect(screen.queryByText('Searching…')).toBeNull()
  rerender(
    <Provider store={store}>
      <PluginsSettings remote="synthetic/vault" visible />
    </Provider>,
  )
  expect(screen.queryByText('Searching…')).toBeNull()
})

test('hiding Settings closes its already-open consent dialog', async () => {
  const { store, rerender } = openSettings([row('dash', 'needs-consent')])
  mocks.ask.mockImplementation((flow) => flow.openDialog(() => <div>consent body</div>))
  fireEvent.click(await screen.findByRole('button', { name: 'Review and allow…' }))
  expect(store.get(shownDialogAtom)).not.toBeNull()

  rerender(
    <Provider store={store}>
      <PluginsSettings remote="synthetic/vault" visible={false} />
    </Provider>,
  )
  expect(store.get(shownDialogAtom)).toBeNull()
})

test('an install finishing after Settings hides cannot hand off to consent', async () => {
  const { store, rerender } = openSettings([row('dash', 'not-installed')])
  let finishInstall!: () => void
  mocks.install.mockImplementation(async (flow) => {
    await new Promise<void>((resolve) => {
      finishInstall = resolve
    })
    flow.openDialog(() => <div>late consent</div>)
    return null
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Install 1.0.0' }))
  rerender(
    <Provider store={store}>
      <PluginsSettings remote="synthetic/vault" visible={false} />
    </Provider>,
  )
  await act(async () => finishInstall())
  expect(store.get(shownDialogAtom)).toBeNull()
})

test('an install finishing after Settings hides and returns cannot hand off to consent', async () => {
  const { store, rerender } = openSettings([row('dash', 'not-installed')])
  let finishInstall!: () => void
  mocks.install.mockImplementation(async (flow) => {
    await new Promise<void>((resolve) => {
      finishInstall = resolve
    })
    flow.openDialog(() => <div>late consent</div>)
    return null
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Install 1.0.0' }))
  rerender(
    <Provider store={store}>
      <PluginsSettings remote="synthetic/vault" visible={false} />
    </Provider>,
  )
  rerender(
    <Provider store={store}>
      <PluginsSettings remote="synthetic/vault" visible />
    </Provider>,
  )
  await act(async () => finishInstall())
  expect(store.get(shownDialogAtom)).toBeNull()
})

test('an install finishing after Settings unmounts cannot hand off to consent', async () => {
  const { store, unmount } = openSettings([row('dash', 'not-installed')])
  let finishInstall!: () => void
  mocks.install.mockImplementation(async (flow) => {
    await new Promise<void>((resolve) => {
      finishInstall = resolve
    })
    flow.openDialog(() => <div>late consent</div>)
    return null
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Install 1.0.0' }))
  unmount()
  await act(async () => finishInstall())
  expect(store.get(shownDialogAtom)).toBeNull()
})

test('unmounting Settings closes its open consent dialog', async () => {
  const { store, unmount } = openSettings([row('dash', 'needs-consent')])
  mocks.ask.mockImplementation((flow) => flow.openDialog(() => <div>consent body</div>))
  fireEvent.click(await screen.findByRole('button', { name: 'Review and allow…' }))
  expect(store.get(shownDialogAtom)).not.toBeNull()
  unmount()
  expect(store.get(shownDialogAtom)).toBeNull()
})

test('Settings keeps its update accessible name while the label is visually hidden', async () => {
  openSettings()
  await act(async () => {})
  const button = screen.getByRole('button', { name: 'Update to 2.0.0…' })
  fireEvent.click(button)
  const label = button.querySelector('span.relative > span')!
  expect(getComputedStyle(label).visibility).toBe('visible')
  expect(getComputedStyle(label).opacity).toBe('0')
  expect(button).toHaveAccessibleName('Update to 2.0.0…')
  expect(button).toBeDisabled()
  expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull()
  await act(async () => resolveAction(null))
})

test('Settings disables competing controls and prevents same-task duplicate updates', async () => {
  const installed = row('installed')
  installed.install = {
    kind: 'release',
    version: '1.0.0',
    repo: 'synthetic/installed',
  } as PluginRow['install']
  mocks.list.mockResolvedValue([row(), installed])
  openSettings([row(), installed])
  await act(async () => {})
  const update = screen.getByRole('button', { name: 'Update to 2.0.0…' })
  const another = screen.getByRole('button', { name: 'Remove' })
  // Add-plugin controls are also disabled while the action runs; Remove is a
  // second row action path and exercises its existing async button.
  act(() => {
    update.click()
    update.click()
    another.click()
  })
  expect(mocks.update).toHaveBeenCalledTimes(1)
  expect(mocks.remove).not.toHaveBeenCalled()
  expect(another).toBeDisabled()
  expect(another.querySelector('[data-slot="spinner"]')).toBeNull()
  expect(update.querySelector('[data-slot="spinner"]')).not.toBeNull()
  expect(screen.getByRole('combobox')).toBeDisabled()
  expect(screen.getByRole('switch', { name: 'Use dash in this vault' })).toBeDisabled()
  await act(async () => resolveAction(null))
  await waitFor(() => expect(update).toBeEnabled())
})

test('Settings install action keeps its label and spinner until consent handoff', async () => {
  const installing = row('new-plugin', 'not-installed')
  installing.install = {
    kind: 'release',
    version: '1.0.0',
    repo: 'synthetic/new-plugin',
  } as PluginRow['install']
  mocks.list.mockResolvedValue([installing])
  openSettings([installing])
  await act(async () => {})
  const button = screen.getByRole('button', { name: 'Install 1.0.0' })
  fireEvent.click(button)
  expect(button).toBeDisabled()
  expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull()
  expect(button).toHaveAccessibleName('Install 1.0.0')
  const label = button.querySelector('span.relative > span')!
  expect(getComputedStyle(label).visibility).toBe('visible')
  expect(getComputedStyle(label).opacity).toBe('0')
  await act(async () => resolveInstall(null))
  await waitFor(() => expect(button).toBeEnabled())
})

test('Settings restores update after a returned error or rejection and allows retry', async () => {
  openSettings()
  await act(async () => {})
  const button = screen.getByRole('button', { name: 'Update to 2.0.0…' })
  fireEvent.click(button)
  await act(async () => rejectAction(new Error('synthetic download error')))
  expect(button).toBeEnabled()
  expect(screen.getByRole('alert')).toHaveTextContent('synthetic download error')

  mocks.update.mockResolvedValueOnce('synthetic returned error')
  fireEvent.click(button)
  await act(async () => {})
  expect(button).toBeEnabled()
  expect(screen.getByRole('alert')).toHaveTextContent('synthetic returned error')

  mocks.update.mockResolvedValueOnce(null)
  fireEvent.click(button)
  await act(async () => {})
  expect(button).toBeEnabled()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('sidebar blocks two native clicks dispatched in one task', async () => {
  openNotice()
  const button = screen.getByRole('button', { name: 'Update…' })
  act(() => {
    button.click()
    button.click()
  })
  expect(mocks.update).toHaveBeenCalledTimes(1)
  expect(button).toHaveAccessibleName('Update…')
  const label = button.querySelector('span.relative > span')!
  expect(getComputedStyle(label).visibility).toBe('visible')
  expect(getComputedStyle(label).opacity).toBe('0')
  expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull()
  await act(async () => resolveAction(null))
})
