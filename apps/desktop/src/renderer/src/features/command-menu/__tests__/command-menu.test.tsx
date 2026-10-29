/**
 * ⌘K's menu: the vault's documents, the places to go and the shell's live
 * actions, each doing what it says; `>` for actions only, and the notes whose
 * text matches.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import userEvent from '@testing-library/user-event'
import { atom, createStore, Provider } from 'jotai'
import { expect, test, vi } from 'vitest'

import { render, screen, waitFor } from '@/test/render'
import { installedPluginsAtom } from '@/state/plugins'
import { useShortcutHandlers } from '@/hooks/use-shortcuts'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'
import { CommandMenu } from '../command-menu'

const search = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: { notes: { search: { query: search } } },
}))

function Live({ split }: { split: () => void }) {
  useShortcutHandlers({ 'pane.split': split })
  return null
}

function setup({
  start,
  plugin,
}: {
  start?: (text: string) => void
  plugin?: (id: string) => void
} = {}) {
  const store = createStore()
  if (plugin !== undefined) {
    store.set(installedPluginsAtom, [
      {
        info: { id: 'holis-stand-in', label: 'Holis', default: true },
        commandMenu: {
          entries: atom([
            { id: 'inbox', label: 'Inbox', group: 'go', icon: () => null },
            { id: 'new', label: 'New Holi', group: 'action', icon: () => null },
            { id: 'holi:ada', label: 'Ada', group: 'Holis', icon: () => null },
          ]),
          run: atom(null, (_get, _set, id: string) => plugin(id)),
        },
      },
    ])
  }
  if (start !== undefined) {
    const startAtom = atom(null, async (_get, _set, { text }: { text: string }) => {
      start(text)
      return { ok: true as const }
    })
    store.set(installedPluginsAtom, [
      {
        info: { id: 'stand-in', label: 'Stand-in', default: true },
        agentsSlot: { start: startAtom },
      },
    ])
  }
  store.set(activeRemoteAtom, 'o/notes')
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    docs: [
      {
        path: 'plans/roadmap.md',
        kind: 'note',
        updatedAt: '2026-09-02T00:00:00Z',
      },
      { path: 'ideas.md', kind: 'note', updatedAt: '2026-09-01T00:00:00Z' },
    ],
  })
  const onOpen = vi.fn()
  const split = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <Provider store={store}>
      <Live split={split} />
      <CommandMenu open onOpenChange={onOpenChange} onOpen={onOpen} onAddVault={() => undefined} />
    </Provider>,
  )
  return { onOpen, split, onOpenChange }
}

test('untyped, it offers the newest documents, places and live actions', () => {
  setup()
  expect(screen.getByRole('group', { name: 'Recent' })).toBeInTheDocument()
  const options = screen.getAllByRole('option').map((o) => o.textContent)
  expect(options[0]).toContain('roadmap')
  expect(options).toEqual(expect.arrayContaining([expect.stringContaining('Board')]))
  expect(options).toEqual(expect.arrayContaining([expect.stringContaining('Split view')]))
  // A shortcut nothing handles right now is not offered.
  expect(options.some((o) => o?.includes('Toggle terminal'))).toBe(false)
})

test('a document opens, and the menu closes first', async () => {
  search.mockResolvedValue([])
  const { onOpen, onOpenChange } = setup()
  await userEvent.type(screen.getByRole('combobox'), 'road')
  await userEvent.keyboard('{Enter}')
  expect(onOpenChange).toHaveBeenCalledWith(false)
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('plans/roadmap.md', false))
})

test('⌘↵ opens it beside', async () => {
  search.mockResolvedValue([])
  const { onOpen } = setup()
  await userEvent.type(screen.getByRole('combobox'), 'road')
  await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('plans/roadmap.md', true))
})

test("> lists actions only, and an action runs its shortcut's handler", async () => {
  const { split } = setup()
  await userEvent.type(screen.getByRole('combobox'), '>split')
  const options = screen.getAllByRole('option').map((o) => o.textContent)
  expect(options).toEqual([expect.stringContaining('Split view')])
  await userEvent.keyboard('{Enter}')
  await waitFor(() => expect(split).toHaveBeenCalled())
})

test('notes whose text matches follow the name matches', async () => {
  search.mockResolvedValue([{ path: 'ideas.md', match: 'body', snippet: '…a quarterly plan…' }])
  setup()
  await userEvent.type(screen.getByRole('combobox'), 'quarterly')
  expect(await screen.findByRole('group', { name: 'In text' })).toBeInTheDocument()
  expect(await screen.findByText('…a quarterly plan…')).toBeInTheDocument()
  expect(search).toHaveBeenLastCalledWith({ remote: 'o/notes', q: 'quarterly' })
})

test('a failed text search offers a retry', async () => {
  search.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
  setup()
  await userEvent.type(screen.getByRole('combobox'), 'zz')
  const retry = await screen.findByRole('option', {
    name: /Couldn’t search note text/,
  })
  await userEvent.click(retry)
  await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
})

test('nothing matching says so and clears', async () => {
  search.mockResolvedValue([])
  setup()
  await userEvent.type(screen.getByRole('combobox'), '>qqqq')
  expect(screen.getByText('Nothing matches “qqqq”.')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))
  expect(screen.getByRole('combobox')).toHaveValue('')
})

test('typed text can go to the agent as a new chat, the only row when nothing matches', async () => {
  search.mockResolvedValue([])
  const start = vi.fn()
  setup({ start })
  await userEvent.type(screen.getByRole('combobox'), 'draft a launch plan')
  await screen.findByRole('option', { name: /Ask the agent/ })
  await waitFor(() => expect(screen.queryByText('Searching note text…')).not.toBeInTheDocument())
  expect(screen.getAllByRole('option')).toHaveLength(1)
  await userEvent.keyboard('{Enter}')
  await waitFor(() => expect(start).toHaveBeenCalledWith('draft a launch plan'))
})

test('without an agent, there is no Ask row', async () => {
  search.mockResolvedValue([])
  setup()
  await userEvent.type(screen.getByRole('combobox'), 'road')
  expect(screen.queryByRole('option', { name: /Ask the agent/ })).toBeNull()
})

test("a plugin's rows sit with Go to and Actions; its long lists wait for typing", async () => {
  search.mockResolvedValue([])
  const plugin = vi.fn()
  setup({ plugin })
  const untyped = screen.getAllByRole('option').map((o) => o.textContent)
  expect(untyped).toEqual(expect.arrayContaining([expect.stringContaining('Inbox')]))
  expect(untyped).toEqual(expect.arrayContaining([expect.stringContaining('New Holi')]))
  expect(untyped.some((o) => o?.includes('Ada'))).toBe(false)

  await userEvent.type(screen.getByRole('combobox'), 'ada')
  expect(screen.getByRole('group', { name: 'Holis' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('option', { name: /Ada/ }))
  await waitFor(() => expect(plugin).toHaveBeenCalledWith('holi:ada'))
})

test("typing finds Settings' pages and the theme", async () => {
  search.mockResolvedValue([])
  setup()
  await userEvent.type(screen.getByRole('combobox'), '>theme')
  expect(screen.getByRole('group', { name: 'Theme' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: /Dark theme/ })).toBeInTheDocument()
  await userEvent.clear(screen.getByRole('combobox'))
  await userEvent.type(screen.getByRole('combobox'), '>appearance')
  expect(screen.getByRole('group', { name: 'Settings' })).toBeInTheDocument()
})
