/**
 * The sidebar's Sessions section (D100).
 *
 * What it owes the user is the thing the footer door cannot give: which of
 * several sessions is the one waiting, and a way to get to that one. So the
 * cases here are when it appears at all, what a card says, and where a click
 * lands.
 */
import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { SessionsSection } from '../SessionsSection'
import {
  activeSessionIdAtom,
  agentSessionsAtom,
  agentSessionsSectionOpenAtom,
  type AgentSession,
} from '@/state/agent'
import { activeTab, workspaceAtom } from '@/state/panes'
import { activeRemoteAtom } from '@/state/vaults'

const REMOTE = 'owner/repo'

const kill = vi.fn()
const start = vi.fn()

const session = (over: Partial<AgentSession> & { id: string }): AgentSession => ({
  name: 'New session',
  state: 'idle',
  configStale: false,
  exited: false,
  ...over,
})

beforeEach(() => {
  kill.mockReset()
  kill.mockResolvedValue({ ok: true })
  start.mockReset()
  start.mockResolvedValue({ ok: true, id: 'spawned' })
  window.holi = {
    agent: { kill: (id: string) => kill(id), start: (args: unknown) => start(args) },
  } as never
})

function setup(sessions: AgentSession[], open = true) {
  const store = createStore()
  store.set(agentSessionsAtom, sessions)
  store.set(agentSessionsSectionOpenAtom, open)
  return {
    store,
    ...render(
      <Provider store={store}>
        <SessionsSection />
      </Provider>,
    ),
  }
}

test('is hidden entirely when the vault has no sessions', () => {
  const { container } = setup([])
  expect(container).toBeEmptyDOMElement()
})

test('is shown for a single session', () => {
  // Where it parts company with a tab strip: one tab is redundant with the
  // drawer's own header, one card is the only thing on screen that says a
  // session exists while the drawer is shut.
  setup([session({ id: 'a', name: 'Fix the merge' })])
  expect(screen.getByText('Fix the merge')).toBeInTheDocument()
})

test('shows an unnamed session as New session', () => {
  // The placeholder Claude Code builds from the cwd is identical for every
  // session in one vault, so main sends this instead of a label that is not one.
  setup([session({ id: 'a' })])
  expect(screen.getByText('New session')).toBeInTheDocument()
})

test('says what a waiting session is waiting for', async () => {
  // A dot cannot say WHAT it wants, and that is the whole reason to walk over.
  setup([session({ id: 'a', name: 'One', state: 'needs-you', waitingFor: 'permission prompt' })])
  expect(screen.getByText('needs you')).toBeInTheDocument()
  await userEvent.hover(screen.getByText('One'))
  expect(await screen.findAllByText(/permission prompt/)).not.toHaveLength(0)
})

test('says each session’s own state, not the vault’s', () => {
  setup([
    session({ id: 'a', name: 'One', state: 'working' }),
    session({ id: 'b', name: 'Two', state: 'needs-you' }),
    session({ id: 'c', name: 'Three', exited: true }),
  ])
  expect(screen.getByText('working…')).toBeInTheDocument()
  expect(screen.getByText('needs you')).toBeInTheDocument()
  expect(screen.getByText('ended')).toBeInTheDocument()
})

test('clicking a card opens that session as a tab', async () => {
  const { store } = setup([session({ id: 'a', name: 'One' }), session({ id: 'b', name: 'Two' })])
  await userEvent.click(screen.getByText('Two'))

  expect(store.get(activeSessionIdAtom)).toBe('b')
  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'session', id: 'b' })
})

test('clicking a card whose tab is already open brings it forward', async () => {
  // Deduped by id: two terminals over one PTY would both be attached to it.
  const { store } = setup([session({ id: 'a', name: 'One' }), session({ id: 'b', name: 'Two' })])
  await userEvent.click(screen.getByText('Two'))
  await userEvent.click(screen.getByText('One'))
  await userEvent.click(screen.getByText('Two'))

  const panes = store.get(workspaceAtom).panes
  expect(panes[0]!.tabs).toEqual([
    { kind: 'session', id: 'b' },
    { kind: 'session', id: 'a' },
  ])
  expect(activeTab(store.get(workspaceAtom))).toEqual({ kind: 'session', id: 'b' })
})

test('collapses to its heading, which is the control that expands it again', async () => {
  setup([session({ id: 'a', name: 'One' })], false)
  expect(screen.queryByText('One')).not.toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: /sessions/ }))
  expect(await screen.findByText('One')).toBeInTheDocument()
})

test('ends an idle session from the menu, without asking', async () => {
  setup([session({ id: 'a', name: 'One' })])
  await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByText('One') })

  await userEvent.click(await screen.findByText('End session'))
  await waitFor(() => expect(kill).toHaveBeenCalledWith('a'))
})

test('asks before ending one that is mid-turn', async () => {
  setup([session({ id: 'a', name: 'One', state: 'working' })])
  await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByText('One') })
  await userEvent.click(await screen.findByText('End session'))

  expect(kill).not.toHaveBeenCalled()
  expect(await screen.findByText('End One?')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'End session' }))
  await waitFor(() => expect(kill).toHaveBeenCalledWith('a'))
})

test('offers no rename, because the name is Claude Code’s', async () => {
  // Set with `--name` at spawn or `/rename` inside the session. A second copy kept
  // in Holi goes stale the moment anybody types `/rename`.
  setup([session({ id: 'a', name: 'One' })])
  await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByText('One') })

  await screen.findByText('End session')
  expect(screen.queryByText(/Rename/)).not.toBeInTheDocument()
})

test('starts another session from the section header', async () => {
  // The drawer's `+` had nowhere to go when the drawer did. This is the only
  // place left that means "another one of these".
  const { store } = setup([session({ id: 'a', name: 'One' })])
  store.set(activeRemoteAtom, REMOTE)
  await userEvent.click(screen.getByLabelText('start another session'))

  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ vaultId: REMOTE })),
  )
})

test('resumes a past session in a new tab, killing nothing', async () => {
  const { store } = setup([session({ id: 'a', name: 'One' })])
  store.set(activeRemoteAtom, REMOTE)
  await userEvent.click(screen.getByLabelText('resume a past session'))

  await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ resume: true })))
  expect(kill).not.toHaveBeenCalled()
})
