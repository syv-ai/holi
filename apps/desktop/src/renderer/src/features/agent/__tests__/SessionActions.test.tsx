/**
 * An agent tab's actions in its tab bar: a new overview (Claude Code's agent
 * list) or another session in a tab of its own.
 */
import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { agentTerminalsAtom } from '@/state/agent'
import { SessionActions } from '../SessionActions'

const open = vi.fn()
const start = vi.fn()

beforeEach(() => {
  open.mockReset()
  start.mockReset()
  open.mockResolvedValue({ ok: true, terminalId: 't-list' })
  start.mockResolvedValue({ ok: true, sessionId: 'newnew00', terminalId: 't-new' })
  window.holi = {
    agent: { open: (args: unknown) => open(args), start: (args: unknown) => start(args) },
  } as never
})

function setup(store = createStore()) {
  render(
    <Provider store={store}>
      <SessionActions />
    </Provider>,
  )
}

test('starts another session', async () => {
  setup()
  await userEvent.click(screen.getByLabelText('Start another session'))
  await waitFor(() => expect(start).toHaveBeenCalled())
})

test('opens the overview: the agent list, not a new session', async () => {
  setup()
  await userEvent.click(screen.getByLabelText('Open overview'))
  await waitFor(() => expect(open).toHaveBeenCalledWith({ cols: 80, rows: 24 }))
  expect(start).not.toHaveBeenCalled()
})

test('opens a new overview even with a list already open, unlike ⌘J', async () => {
  const store = createStore()
  store.set(agentTerminalsAtom, [{ id: 't-old', launchedFor: null, title: '' }])
  setup(store)
  await userEvent.click(screen.getByLabelText('Open overview'))
  await waitFor(() => expect(open).toHaveBeenCalledWith({ cols: 80, rows: 24 }))
})
