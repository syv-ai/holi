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
import { inboxAtom, openInboxEntryAtom, type InboxView } from '../renderer/state/inbox'
import { toast } from 'sonner'
import { agentSessionsAtom, type AgentSession } from '../renderer/state/sessions'
import { agentsViewAtom } from '../renderer/state/agents-view'
import { inboxEvents } from '../renderer/state/inbox'

// These workflows run with the public settings contract enabled. Dynamic
// settings loading and disabled views are covered in optional-navigation.
vi.mock('@/plugin-api', async (original) => {
  const real = await original<typeof import('@/plugin-api')>()
  const { atom } = await import('jotai')
  const { resolveAppSettings } = await import('@holi/shared')
  return {
    ...real,
    activeVaultSettingsAtom: atom({
      ...resolveAppSettings(null, null),
      plugins: { vault: {}, localOff: [] },
      pluginValues: {},
    }),
  }
})

const agentCap = vi.hoisted(() => ({
  inboxSeen: vi.fn(),
  inboxDismiss: vi.fn(),
  open: vi.fn(),
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
  agentCap.open.mockReset()
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

test('the inbox-open event opens its actual session handler target', async () => {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv/vault')
  store.set(agentSessionsAtom, [
    { id: 'j0123456789ab', provider: 'codex', name: 'Review', state: 'idle' } as AgentSession,
  ])
  agentCap.open.mockResolvedValueOnce({ ok: true, terminalId: 'codex-terminal' })
  inboxEvents['inbox-open']!(
    {
      remote: 'syv/vault',
      payload: {
        id: 'job-entry',
        at: new Date().toISOString(),
        title: 'Review is ready',
        line: 'Open the result.',
        session: 'j0123456789ab',
      },
    },
    store,
  )

  await vi.waitFor(() =>
    expect(store.get(agentsViewAtom)).toEqual({
      kind: 'session',
      id: 'j0123456789ab',
    }),
  )
  expect(agentCap.open).toHaveBeenCalledWith('syv/vault', {
    attach: 'j0123456789ab',
    cols: 80,
    rows: 24,
  })
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

test.each([{ ok: false, message: 'That Codex job has expired.' }, new Error('IPC disconnected')])(
  'shows an unavailable-session message when opening a session fails: %o',
  async (failure) => {
    const store = createStore()
    store.set(activeRemoteAtom, 'syv/vault')
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 'toast-id')
    error.mockClear()
    agentCap.open.mockReset()
    if (failure instanceof Error) agentCap.open.mockRejectedValue(failure)
    else agentCap.open.mockResolvedValue(failure)

    store.set(openInboxEntryAtom, {
      id: 'job',
      at: new Date().toISOString(),
      title: 'Codex run',
      line: 'Review the result.',
      session: 'j0123456789ab',
    })
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith('Could not open agent session', {
        description: failure.message,
      }),
    )
  },
)

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
