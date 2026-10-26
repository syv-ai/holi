/**
 * The empty view: where you are, the mark, and the three things to start,
 * over the Holis' arcade.
 */
import { Provider, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import type { RendererPlugin } from '@/plugin-api'
import { fireEvent, render, screen } from '@/test/render'
import { nowAtom } from '@/state/clock'
import { installedPluginsAtom } from '@/state/plugins'
import { vaultSettingsAtom } from '@/state/settings'
import { activeRemoteAtom, vaultsAtom } from '@/state/vaults'
import { BOARD_TAB } from '../../sidebar/documents-nav'
import { NewTabView } from '../new-tab-view'

function mount(prepare?: (store: ReturnType<typeof createStore>) => void) {
  const store = createStore()
  store.set(nowAtom, '2026-10-23T12:00')
  store.set(activeRemoteAtom, 'mara/notes')
  store.set(vaultsAtom, [
    {
      remote: 'mara/notes',
      path: '/vaults/mara/notes',
      name: 'notes',
      lastOpenedAt: '2026-10-23T10:00:00.000Z',
    },
  ] as never)
  prepare?.(store)
  const onOpen = vi.fn()
  const onNewDocument = vi.fn()
  render(
    <Provider store={store}>
      <NewTabView onOpen={onOpen} onNewDocument={onNewDocument} />
    </Provider>,
  )
  return { onOpen, onNewDocument }
}

test('names the vault and the day, and its tasks open the board', () => {
  const { onOpen } = mount()
  expect(screen.getByText('notes')).toBeTruthy()
  expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/23/)
  fireEvent.click(screen.getByRole('button', { name: 'tasks' }))
  expect(onOpen).toHaveBeenCalledWith(BOARD_TAB)
})

test('starts a document; an agent session only where the agent runs', () => {
  const { onNewDocument } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'New document' }))
  expect(onNewDocument).toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Today’s note' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'New agent session' })).toBeNull()
  document.body.innerHTML = ''

  const newSession = vi.fn()
  mount((store) =>
    store.set(installedPluginsAtom, [
      {
        info: { id: 'agent', label: 'Agent', builtIn: true },
        agentsMode: { newSession: { write: newSession } },
      } as unknown as RendererPlugin,
    ]),
  )
  expect(screen.getByRole('button', { name: 'New agent session' })).toBeTruthy()
})

/** The scrolling content, which steps out while a game is on. */
function content() {
  return document.querySelector('[data-slot=empty-view-content]')!
}

test("the take-control pill shows over the board's free ground, or on focus", () => {
  mount()
  const pill = screen.getByRole('button', { name: /take control/i })
  expect(pill.dataset.show).toBe('false')
  fireEvent.pointerMove(pill.parentElement!)
  expect(pill.dataset.show).toBe('true')
  // Over a card is not the board.
  fireEvent.pointerMove(screen.getByText('New document'))
  expect(pill.dataset.show).toBe('false')
})

test('taking control covers the pane; Escape gives it back to the pill', () => {
  mount()
  const pill = screen.getByRole('button', { name: /take control/i })
  fireEvent.click(pill)

  const board = screen.getByRole('application', { name: /paper run/i })
  expect(document.activeElement).toBe(board)
  expect(content().hasAttribute('inert')).toBe(true)
  expect(screen.getByRole('button', { name: /release/i })).toBeTruthy()

  // Focus going elsewhere does not end it.
  fireEvent.blur(board)
  expect(screen.queryByRole('application')).toBeTruthy()

  fireEvent.keyDown(board, { key: 'Escape' })
  expect(screen.queryByRole('application')).toBeNull()
  expect(content().hasAttribute('inert')).toBe(false)
  expect(document.activeElement).toBe(pill)
})

test('Release ends the game too', () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: /take control/i }))
  fireEvent.click(screen.getByRole('button', { name: /release/i }))
  expect(screen.queryByRole('application')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: /take control/i }))
})

test('with the arcade off on this machine, there is no board and no pill', () => {
  mount((store) =>
    store.set(vaultSettingsAtom, {
      remote: 'mara/notes',
      settings: { ...VAULT_SETTING_DEFAULTS, gridArcade: false, warnings: [] },
    }),
  )
  expect(screen.queryByRole('button', { name: /take control/i })).toBeNull()
  expect(document.querySelector('[data-slot=arcade]')).toBeNull()
})
