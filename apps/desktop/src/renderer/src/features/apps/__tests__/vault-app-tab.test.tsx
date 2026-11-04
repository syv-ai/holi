/**
 * A vault app's tab draws the registry's `app` surface under a header: its
 * name, its folder, the surface's own controls and Edit source. A plugin's
 * open (the agent's `holi apps open`) lands in the shell's tabs.
 */
import { atom, createStore, Provider } from 'jotai'
import { expect, test } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/render'
import { coreContributionAtom } from '@/state/plugins'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { openSurfaceAtom } from '@/state/surfaces'
import { activeRemoteAtom } from '@/state/vaults'
import { VaultAppTab } from '../vault-app-tab'

function withApps(store = createStore()) {
  store.set(activeRemoteAtom, 'syv-ai/site')
  store.set(coreContributionAtom, {
    rail: [],
    claims: [],
    surfaces: [
      {
        kind: 'app',
        label: (id?: string) => (id ?? 'App').replace(/^.*\//, '').replace(/\.app$/, ''),
        icon: () => null,
        render: ({ id }: { id?: string }) => <p>Running {id}</p>,
        instances: atom([]),
        headerActions: ({ id }: { id?: string }) => <button type="button">Reload {id}</button>,
      },
    ],
  })
  return store
}

test('an app opens under its name, folder and controls', async () => {
  const store = withApps()
  render(
    <Provider store={store}>
      <VaultAppTab path="tools/Budget.app" onOpenSearch={() => undefined} />
    </Provider>,
  )
  expect(screen.getByRole('heading', { name: 'Budget' })).toBeInTheDocument()
  expect(screen.getByText('tools')).toBeInTheDocument()
  expect(screen.getByText('Running tools/Budget.app')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Reload tools/Budget.app' })).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Edit source' }))
  const ws = store.get(shellWorkspaceAtom)
  expect(JSON.stringify(ws)).toContain('tools/Budget.app/index.html')
})

test('with the plugin off, the tab says how to turn it on', () => {
  const store = createStore()
  render(
    <Provider store={store}>
      <VaultAppTab path="Budget.app" onOpenSearch={() => undefined} />
    </Provider>,
  )
  expect(screen.getByText('Vault apps are off')).toBeInTheDocument()
})

test("a plugin's open reaches the shell's tabs", () => {
  const store = withApps()
  store.set(openSurfaceAtom, 'app', 'Budget.app')
  expect(JSON.stringify(store.get(shellWorkspaceAtom))).toContain('Budget.app')
})
