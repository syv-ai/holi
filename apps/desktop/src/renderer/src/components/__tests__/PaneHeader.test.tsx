/**
 * The pane header's Agent button: on a note it is a split button whose menu
 * holds what running plugins offer for the document
 * (`RendererPlugin.documentActions`); with none, it is the plain button.
 */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { expect, test } from 'vitest'
import { DropdownMenuItem } from '@/primitives'
import { PaneHeader } from '@/components/PaneHeader'
import { installedPluginsAtom } from '@/state/plugins'
import type { RendererPlugin } from '@/plugin-api'

const plugin = (extra: Partial<RendererPlugin>): RendererPlugin =>
  ({
    info: { id: 'agent', label: 'Agent', default: true },
    agentsMode: { sidebar: () => null, main: () => null },
    ...extra,
  }) as unknown as RendererPlugin

function setup(plugins: RendererPlugin[]) {
  const store = createStore()
  store.set(installedPluginsAtom, plugins)
  render(
    <Provider store={store}>
      <PaneHeader tab={{ kind: 'note', path: 'kunder/nordlys.md' } as never} />
    </Provider>,
  )
}

test("draws a plugin's rows for the open document in the Agent button's menu", async () => {
  setup([
    plugin({
      documentActions: ({ path }) => <DropdownMenuItem>Send {path}</DropdownMenuItem>,
    }),
  ])
  expect(screen.getByRole('button', { name: /Agent/ })).toBeTruthy()
  await userEvent.click(screen.getByLabelText('More with this document'))
  expect(screen.getByRole('menuitem', { name: 'Send kunder/nordlys.md' })).toBeTruthy()
})

test('with no plugin offering anything, Agent is the plain button', () => {
  setup([plugin({})])
  expect(screen.getByRole('button', { name: /Agent/ })).toBeTruthy()
  expect(screen.queryByLabelText('More with this document')).toBeNull()
})
