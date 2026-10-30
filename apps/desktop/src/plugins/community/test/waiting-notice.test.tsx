/**
 * The vault notice under the file tree: a plugin the vault uses that this
 * machine cannot run can be dismissed, for that vault and plugin only, and it
 * stays dismissed across a restart and a newer pin.
 */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { afterEach, expect, test } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { communityRenderer } from '../renderer/index'
import { rowsAtom, type PluginRow } from '../renderer/state'

const Notice = communityRenderer.sidebarSection!

const row = (id: string, name: string, version = '0.1.0'): PluginRow => ({
  id,
  name,
  description: '',
  opens: [],
  status: 'not-installed',
  on: true,
  running: false,
  pin: { repo: `syv-ai/${id}`, path: '', version, commit: 'abc' },
  install: null,
  setup: null,
  serve: null,
  apps: [],
  bin: [],
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
