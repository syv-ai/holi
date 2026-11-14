/**
 * The vault notice under the file tree: a plugin the vault uses that this
 * machine cannot run can be dismissed, for that vault and plugin only, and it
 * stays dismissed across a restart and a newer pin, until the plugin is ready
 * there.
 */
import { act, render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { communityRenderer } from '../renderer/index'
import { rowsAtom, updatesAtom, type PluginRow } from '../renderer/state'

const Notice = communityRenderer.sidebarSection!
const update = vi.hoisted(() => vi.fn())
const install = vi.hoisted(() => vi.fn())
vi.mock('../renderer/install-flow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../renderer/install-flow')>()),
  installAndAsk: install,
  updatePlugin: update,
}))

const row = (
  id: string,
  name: string,
  version = '0.1.0',
  status: PluginRow['status'] = 'not-installed',
): PluginRow => ({
  id,
  name,
  description: '',
  opens: [],
  status,
  on: true,
  running: false,
  pin: { repo: `syv-ai/${id}`, path: '', version, commit: 'abc' },
  install: null,
  setup: null,
  serve: null,
  apps: [],
  bin: [],
  cli: null,
  commandsNote: null,
  check: null,
})

/** A fresh store, as a restart or a vault switch leaves it. */
function open(remote: string, rows: readonly PluginRow[]) {
  const store = createStore()
  store.set(activeRemoteAtom, remote)
  store.set(rowsAtom, { remote, rows })
  return render(
    <Provider store={store}>
      <Notice />
    </Provider>,
  )
}

afterEach(() => localStorage.clear())

test('the initiating update shows a spinner, blocks duplicates and restores after resolution', async () => {
  let resolve!: (value: null) => void
  update.mockReturnValueOnce(new Promise<null>((done) => (resolve = done)))
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  store.set(rowsAtom, { remote: 'ada/notes', rows: [row('dash', 'Dash', '1.0.0', 'ready')] })
  store.set(updatesAtom, { dash: '2.0.0' })
  render(
    <Provider store={store}>
      <Notice />
    </Provider>,
  )
  const button = screen.getByRole('button', { name: 'Update…' })
  await userEvent.click(button)
  expect(button).toBeDisabled()
  expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull()
  await userEvent.click(button)
  expect(update).toHaveBeenCalledTimes(1)
  resolve(null)
  await waitForEnabled(button)
})

async function waitForEnabled(button: HTMLElement) {
  await act(async () => {
    await Promise.resolve()
  })
  expect(button).toBeEnabled()
}

test('install spins only its own action until consent handoff resolves', async () => {
  let resolve!: (value: null) => void
  install.mockReturnValueOnce(new Promise<null>((done) => (resolve = done)))
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  store.set(rowsAtom, { remote: 'ada/notes', rows: [row('dash', 'Dash')] })
  render(
    <Provider store={store}>
      <Notice />
    </Provider>,
  )
  const button = screen.getByRole('button', { name: 'Install…' })
  await userEvent.click(button)
  expect(button).toBeDisabled()
  expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull()
  await userEvent.click(button)
  expect(install).toHaveBeenCalledTimes(1)
  await act(async () => resolve(null))
  expect(button).toBeEnabled()
})

test('a rejected update restores its action button and shows the existing error', async () => {
  let reject!: (reason: Error) => void
  update.mockReturnValueOnce(new Promise<null>((_resolve, fail) => (reject = fail)))
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  store.set(rowsAtom, { remote: 'ada/notes', rows: [row('dash', 'Dash', '1.0.0', 'ready')] })
  store.set(updatesAtom, { dash: '2.0.0' })
  render(
    <Provider store={store}>
      <Notice />
    </Provider>,
  )
  const button = screen.getByRole('button', { name: 'Update…' })
  await userEvent.click(button)
  await act(async () => reject(new Error('download failed')))
  expect(button).toBeEnabled()
  expect(screen.getByRole('alert')).toHaveTextContent('download failed')
})

test('a dismissed notice stays gone for that vault and plugin only', async () => {
  const first = open('ada/notes', [row('dash', 'Dash'), row('deck', 'Deck')])
  await userEvent.click(screen.getByRole('button', { name: 'Dismiss Dash' }))
  expect(screen.queryByText('Dash')).toBeNull()
  expect(screen.getByText('Deck')).toBeInTheDocument()
  first.unmount()

  // After a restart, with the vault now pinning a newer Dash.
  const again = open('ada/notes', [row('dash', 'Dash', '0.2.0'), row('deck', 'Deck')])
  expect(screen.queryByText('Dash')).toBeNull()
  expect(screen.getByText('Deck')).toBeInTheDocument()
  again.unmount()

  open('ada/other', [row('dash', 'Dash')])
  expect(screen.getByText('Dash')).toBeInTheDocument()
})

test('a plugin ready in the vault drops its dismissal, so a later pin shows again', async () => {
  const first = open('ada/notes', [row('dash', 'Dash')])
  await userEvent.click(screen.getByRole('button', { name: 'Dismiss Dash' }))
  first.unmount()

  // Installed after all, through Settings: the vault reads it ready.
  open('ada/notes', [row('dash', 'Dash', '0.1.0', 'ready')]).unmount()

  open('ada/notes', [row('dash', 'Dash', '0.2.0', 'pin-differs')])
  expect(screen.getByText('Dash')).toBeInTheDocument()
})
