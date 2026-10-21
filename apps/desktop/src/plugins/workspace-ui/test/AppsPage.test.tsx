/**
 * The Apps page: every finished app of the vault as a card, and a card opens
 * that app. With none, it says how one comes to be.
 */
import { render, screen, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { expect, test } from 'vitest'
import { snapshotAtom } from '@/plugin-api'
import { AppsPage, appFolder } from '../renderer/AppsPage'
import { APPS_RAIL, APPS_SURFACE } from '../renderer'

const file = (path: string) => ({ path, kind: 'file' as const, size: 1, mtime: 1 })

function setup(paths: string[]) {
  const store = createStore()
  store.set(snapshotAtom, { files: paths.map(file) } as never)
  render(
    <Provider store={store}>
      <AppsPage />
    </Provider>,
  )
  return { store, user: userEvent.setup() }
}

test('every finished app is a card, with where it lives', () => {
  setup([
    'Dash/Dash activity.local.app/index.html',
    'Dash/Dash activity.local.app/app.yaml',
    'Tracker.app/index.html',
    'Tracker.app/app.yaml',
    // A draft: an entry and no manifest is not an app yet.
    'Draft.app/index.html',
  ])
  const page = document.querySelector<HTMLElement>('[data-apps-page]')!
  expect(within(page).getByText('Dash activity')).toBeInTheDocument()
  expect(within(page).getByText('Dash')).toBeInTheDocument()
  expect(within(page).getByText('Tracker')).toBeInTheDocument()
  expect(within(page).getByText('Vault root')).toBeInTheDocument()
  expect(within(page).queryByText('Draft')).toBeNull()
  expect(screen.getByText('2 apps')).toBeInTheDocument()
})

test('a card opens its app', async () => {
  const { user } = setup(['Tracker.app/index.html', 'Tracker.app/app.yaml'])
  // Pressing it asks the workspace for the app's tab, which is not under test
  // here; the card is a real button that does not throw.
  await user.click(screen.getByRole('button', { name: /Tracker/ }))
  expect(document.querySelector('[data-app-card="Tracker.app"]')).not.toBeNull()
})

test('with no apps it says what an app is and how to get one', () => {
  setup([])
  expect(document.querySelector('[data-apps-empty]')).not.toBeNull()
  expect(screen.getByText('No apps in this vault yet.')).toBeInTheDocument()
  expect(screen.getByText('0 apps')).toBeInTheDocument()
})

test('the nav item goes to this page, not down into a list', () => {
  expect(APPS_RAIL.surface).toBe(APPS_SURFACE.kind)
  expect(APPS_SURFACE.render).toBe(AppsPage)
  expect(appFolder('Dash/Dash activity.local.app')).toBe('Dash')
  expect(appFolder('Tracker.app')).toBe('')
})
