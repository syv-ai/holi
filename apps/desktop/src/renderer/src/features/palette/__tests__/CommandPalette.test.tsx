/**
 * The palette (D102), driven the way a person drives it: keys in, tabs out.
 *
 * Ranking is `test/palette-rows.test.ts`; what a command does is
 * `test/commands.test.ts`. This covers the seams between them and cmdk: the
 * keys that open it, the query reaching the ranker, Enter reaching the
 * workspace, `>` reaching the table, Escape, and the Ask row reaching the
 * agent seam.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { getDefaultStore } from 'jotai'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@/test/render'
import { useCommandHotkeys } from '@/state/commands'
import { activeSessionIdAtom, agentSessionsAtom, type AgentSession } from '@/state/agent'
import { paletteAtom } from '@/state/palette'
import { emptyWorkspace, workspaceAtom } from '@/state/panes'
import { recentsByVaultAtom } from '@/state/recents'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'
import { CommandPalette } from '../CommandPalette'

const store = getDefaultStore()

/** Shell's part: the one keydown listener over the table. */
function Hotkeys(): null {
  useCommandHotkeys()
  return null
}

const paste = vi.fn(async () => ({ ok: true }))

beforeEach(() => {
  // cmdk scrolls the selected item into view; jsdom has no layout to scroll.
  Element.prototype.scrollIntoView = () => {}
  // @ts-expect-error — the preload bridge is not typed onto window in tests.
  window.holi = { agent: { paste } }
  paste.mockClear()
  store.set(activeRemoteAtom, 'o/vault')
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    docs: [
      { path: 'notes/alpha.md', kind: 'note', updatedAt: '2026-09-01T00:00:00Z' },
      { path: 'notes/beta.md', kind: 'note', updatedAt: '2026-09-03T00:00:00Z' },
      { path: 'gamma.md', kind: 'note', updatedAt: '2026-09-02T00:00:00Z' },
    ],
  })
  store.set(recentsByVaultAtom, { 'o/vault': [{ kind: 'path', key: 'gamma.md' }] })
  store.set(workspaceAtom, emptyWorkspace())
  store.set(paletteAtom, { open: false, mode: 'open', query: '', step: 0, stepDirection: 1 })
  store.set(agentSessionsAtom, [])
  store.set(activeSessionIdAtom, null)
})

afterEach(() => {
  // @ts-expect-error — as above.
  delete window.holi
})

function mount() {
  return render(
    <>
      <Hotkeys />
      <CommandPalette />
    </>,
  )
}

const itemNames = () =>
  [...document.querySelectorAll('[cmdk-item]')].map((el) => el.textContent?.trim() ?? '')

test('⌘P opens with the recents first; typing filters; Enter opens pinned and closes', async () => {
  mount()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

  await userEvent.keyboard('{Meta>}p{/Meta}')

  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(itemNames()[0]).toContain('gamma.md')
  expect(screen.getByText('Recently opened')).toBeInTheDocument()

  await userEvent.keyboard('bet')
  await waitFor(() => expect(itemNames()[0]).toContain('beta.md'))

  await userEvent.keyboard('{Enter}')

  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([{ kind: 'note', path: 'notes/beta.md' }])
})

test('⌘⇧P opens in command mode with the glyphs beside the commands', async () => {
  mount()

  await userEvent.keyboard('{Meta>}{Shift>}p{/Shift}{/Meta}')

  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.getByPlaceholderText('Run a command')).toHaveValue('>')
  const split = screen.getByText('Split pane').closest('[cmdk-item]')!
  expect(split.textContent).toContain('⌘\\')
})

test('typing > switches to commands, and Enter runs the row', async () => {
  mount()

  await userEvent.keyboard('{Meta>}p{/Meta}')
  await userEvent.keyboard('>spl')
  await waitFor(() => expect(itemNames()[0]).toContain('Split pane'))

  await userEvent.keyboard('{Enter}')

  await waitFor(() => expect(store.get(workspaceAtom).panes).toHaveLength(2))
  expect(store.get(paletteAtom).open).toBe(false)
})

test('the palette does not list its own two commands', async () => {
  mount()
  await userEvent.keyboard('{Meta>}{Shift>}p{/Shift}{/Meta}')

  expect(itemNames().some((n) => n.startsWith('Quick open'))).toBe(false)
  expect(itemNames().some((n) => n.startsWith('Command palette'))).toBe(false)
  expect(itemNames().some((n) => n.startsWith('Split pane'))).toBe(true)
})

test('⌃⇥ lists the open tabs most recent first without the current one; releasing ⌃ switches', async () => {
  // Three tabs open, gamma active; alpha was the one before it.
  store.set(workspaceAtom, {
    panes: [
      {
        tabs: [
          { kind: 'note', path: 'notes/alpha.md' },
          { kind: 'note', path: 'notes/beta.md' },
          { kind: 'note', path: 'gamma.md' },
        ],
        active: 2,
      },
    ],
    active: 0,
  })
  store.set(recentsByVaultAtom, {
    'o/vault': [
      { kind: 'path', key: 'gamma.md' },
      { kind: 'path', key: 'notes/alpha.md' },
      { kind: 'path', key: 'notes/beta.md' },
    ],
  })
  mount()
  // One user instance: held keys are forgotten between bare `userEvent.keyboard`
  // calls, so releasing ⌃ in a second call would never send its keyup.
  const user = userEvent.setup()

  await user.keyboard('{Control>}{Tab}')

  expect(screen.getByPlaceholderText('Switch to an open tab')).toBeInTheDocument()
  expect(itemNames().map((n) => n.replace(/notes$/, ''))).toEqual(['alpha.md', 'beta.md'])

  await user.keyboard('{/Control}')

  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(store.get(workspaceAtom).panes[0]!.active).toBe(0)
})

test('⌃⇥ with one tab open does nothing', async () => {
  store.set(workspaceAtom, {
    panes: [{ tabs: [{ kind: 'note', path: 'gamma.md' }], active: 0 }],
    active: 0,
  })
  mount()

  await userEvent.keyboard('{Control>}{Tab}{/Control}')

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('a second ⌃⇥ steps down before ⌃ is released', async () => {
  store.set(workspaceAtom, {
    panes: [
      {
        tabs: [
          { kind: 'note', path: 'notes/alpha.md' },
          { kind: 'note', path: 'notes/beta.md' },
          { kind: 'note', path: 'gamma.md' },
        ],
        active: 2,
      },
    ],
    active: 0,
  })
  store.set(recentsByVaultAtom, {
    'o/vault': [
      { kind: 'path', key: 'gamma.md' },
      { kind: 'path', key: 'notes/alpha.md' },
      { kind: 'path', key: 'notes/beta.md' },
    ],
  })
  mount()

  await userEvent.keyboard('{Control>}{Tab}{Tab}{/Control}')

  await waitFor(() => expect(store.get(workspaceAtom).panes[0]!.active).toBe(1))
})

test('Escape closes', async () => {
  mount()
  await userEvent.keyboard('{Meta>}p{/Meta}')
  expect(screen.getByRole('dialog')).toBeInTheDocument()

  await userEvent.keyboard('{Escape}')

  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})

test('the Ask row is last once something is typed, and sends to the current session', async () => {
  const live = { id: 's1', name: 'refactor', exited: false, state: 'idle' } as AgentSession
  store.set(agentSessionsAtom, [live])
  store.set(activeSessionIdAtom, 's1')
  mount()

  await userEvent.keyboard('{Meta>}p{/Meta}')
  await userEvent.keyboard('why is the board empty')
  await waitFor(() =>
    expect(itemNames().at(-1)).toContain('Ask the assistant: why is the board empty'),
  )

  await userEvent.click(screen.getByText(/Ask the assistant/))

  await waitFor(() => expect(paste).toHaveBeenCalledWith('s1', 'why is the board empty'))
  expect(store.get(paletteAtom).open).toBe(false)
})
