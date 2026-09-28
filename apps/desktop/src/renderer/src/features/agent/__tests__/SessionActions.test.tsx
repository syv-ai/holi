/**
 * An assistant tab's actions in its tab bar: another session, or the overview
 * (Claude Code's picker of past sessions) in a new tab.
 */
import { render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { SessionActions } from '../SessionActions'
import { activeRemoteAtom } from '@/state/vaults'

const REMOTE = 'owner/repo'
const kill = vi.fn()
const start = vi.fn()

beforeEach(() => {
  kill.mockReset()
  start.mockReset()
  start.mockResolvedValue({ ok: true, id: 'spawned' })
  window.holi = {
    agent: { kill: (id: string) => kill(id), start: (args: unknown) => start(args) },
  } as never
})

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, REMOTE)
  render(
    <Provider store={store}>
      <SessionActions />
    </Provider>,
  )
}

test('starts another session', async () => {
  setup()
  await userEvent.click(screen.getByLabelText('Start another session'))
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ vaultId: REMOTE })),
  )
})

test('opens the overview in a new session, killing nothing', async () => {
  setup()
  await userEvent.click(screen.getByLabelText('Open overview'))
  await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ resume: true })))
  expect(kill).not.toHaveBeenCalled()
})
