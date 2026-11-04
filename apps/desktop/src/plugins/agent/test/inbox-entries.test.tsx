/**
 * The Inbox's entries from the agent (docs/features/agent-inbox.md): newest
 * first, X dismisses one, being shown reads them all
 * while the unread keep their mark, and the count leaves out a waiting
 * session's own "needs you", which the session already counts.
 */
import { render, screen, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { InboxEntries } from '../renderer/agents/inbox-entries'
import { inboxCountAtom } from '../renderer/state/agents-status'
import { inboxAtom, type InboxView } from '../renderer/state/inbox'
import { agentSessionsAtom, type AgentSession } from '../renderer/state/sessions'

const agentCap = vi.hoisted(() => ({
  inboxSeen: vi.fn(),
  inboxDismiss: vi.fn(),
}))
vi.mock('../renderer/agent-cap', () => ({ agentCap }))

const VIEW: InboxView = {
  unread: 2,
  entries: [
    {
      id: 'e3',
      at: new Date().toISOString(),
      title: 'Offer drafted',
      line: 'Check the prices.',
      path: 'tilbud/a.md',
    },
    {
      id: 'e2',
      at: new Date().toISOString(),
      title: 'Triage needs you',
      line: 'permission prompt',
      session: 'abcd1234',
    },
    { id: 'e1', at: '2026-10-20T08:00:00Z', title: 'Mail checked', line: '' },
  ],
}

beforeEach(() => {
  agentCap.inboxSeen.mockReset()
  agentCap.inboxDismiss.mockReset()
  agentCap.inboxSeen.mockImplementation(async () => ({ ...VIEW, unread: 0 }))
})

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(inboxAtom, VIEW)
  render(
    <Provider store={store}>
      <InboxEntries />
    </Provider>,
  )
  return store
}

test('lists the entries, reads them, and keeps the unread marked', async () => {
  const store = setup()
  const list = screen.getByRole('region', { name: 'From your agents' })
  const rows = within(list).getAllByRole('listitem')
  expect(rows.map((r) => r.getAttribute('data-inbox-entry'))).toEqual(['e3', 'e2', 'e1'])
  expect(within(rows[0]!).getByText('tilbud/a.md')).toBeInTheDocument()
  await vi.waitFor(() => expect(agentCap.inboxSeen).toHaveBeenCalledWith('syv/vault'))
  expect(store.get(inboxAtom).unread).toBe(0)
  expect(within(rows[0]!).getByText('Offer drafted')).toHaveClass('font-semibold')
  expect(within(rows[2]!).getByText('Mail checked')).not.toHaveClass('font-semibold')
})

test('X dismisses an entry', async () => {
  const user = userEvent.setup()
  agentCap.inboxDismiss.mockImplementation(async () => ({
    unread: 0,
    entries: VIEW.entries.slice(1),
  }))
  setup()
  const row = screen.getByText('Offer drafted').closest('li')!
  await user.click(within(row).getByRole('button', { name: 'Dismiss' }))
  await vi.waitFor(() =>
    expect(agentCap.inboxDismiss).toHaveBeenCalledWith('syv/vault', { id: 'e3' }),
  )
  expect(screen.queryByText('Offer drafted')).toBeNull()
})

test("the count leaves out a waiting session's own entry", () => {
  const store = createStore()
  store.set(inboxAtom, VIEW)
  expect(store.get(inboxCountAtom)).toBe(2)
  store.set(agentSessionsAtom, [
    { id: 'abcd1234', provider: 'claude', name: 'Triage', state: 'needs-you' } as AgentSession,
  ])
  // The session, and the one unread entry that is not its own.
  expect(store.get(inboxCountAtom)).toBe(2)
})
