/**
 * The apps menu the tab strip shows while the nav is hidden: every registered
 * app, opened as its row in the nav opens it, and nothing at all without apps.
 */
import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, atom, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { activeTab, workspaceAtom } from '@/state/panes'
import { AppsMenu } from '../AppsMenu'

const { ids } = vi.hoisted(() => ({ ids: { current: [] as string[] } }))
vi.mock('@/state/apps', () => ({ appIdsAtom: atom(() => ids.current) }))

function setup(appIds: string[]) {
  ids.current = appIds
  const store = createStore()
  const view = render(
    <Provider store={store}>
      <AppsMenu />
    </Provider>,
  )
  return { store, ...view }
}

test('picking an app opens its tab', async () => {
  const { store } = setup(['char-count', 'tasks-by-area'])
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: 'apps' }))
  await user.click(screen.getByRole('menuitem', { name: 'tasks-by-area' }))

  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'app', appId: 'tasks-by-area' })
})

test('a vault with no apps shows no apps button', () => {
  const { container } = setup([])
  expect(container).toBeEmptyDOMElement()
})
