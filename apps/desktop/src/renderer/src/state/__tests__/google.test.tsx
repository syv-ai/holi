/**
 * The connected-Google account, shared.
 *
 * It exists because two places need the same answer and must not disagree:
 * vault settings, which changes it, and the shell, which decides whether the
 * agenda/mail chips exist at all. A component-local `useState` in the settings
 * panel left the shell showing chips for an account nobody was signed into.
 */
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { render, waitFor } from '@/test/render'
import { googleAccountAtom, useGoogleAccount } from '../google'

const statusMock = vi.fn()
vi.mock('../../lib/trpc', () => ({
  trpc: { google: { status: { query: () => statusMock() } } },
}))

function Probe() {
  const [account] = useGoogleAccount()
  return <span data-testid="account">{account === undefined ? 'unknown' : (account?.email ?? 'none')}</span>
}

const renderProbe = (store = createStore()) => {
  const view = render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
  return { ...view, store }
}

beforeEach(() => {
  statusMock.mockReset()
})

test('starts unknown, then reports the connected account', async () => {
  statusMock.mockResolvedValue({ account: { email: 'nicolai@syv.ai' } })

  const { getByTestId } = renderProbe()

  // Unknown is a third state on purpose: the shell hides the chips until the
  // answer is in, so a disconnected app never flashes them on launch.
  expect(getByTestId('account').textContent).toBe('unknown')
  await waitFor(() => expect(getByTestId('account').textContent).toBe('nicolai@syv.ai'))
})

test('reports no account when nothing is connected', async () => {
  statusMock.mockResolvedValue({ account: null })

  const { getByTestId } = renderProbe()

  await waitFor(() => expect(getByTestId('account').textContent).toBe('none'))
})

test('treats an unreachable connector as not connected, not as unknown forever', async () => {
  // The `google.*` procedures refuse outright when the connector is not
  // configured. That is a normal state, not an error the user can act on — and
  // leaving it `undefined` would re-query on every render.
  statusMock.mockRejectedValue(new Error('the Google connector is not configured'))

  const { getByTestId } = renderProbe()

  await waitFor(() => expect(getByTestId('account').textContent).toBe('none'))
})

test('asks once, however many components read it', async () => {
  statusMock.mockResolvedValue({ account: null })
  const store = createStore()

  const { getByTestId } = renderProbe(store)
  await waitFor(() => expect(getByTestId('account').textContent).toBe('none'))
  renderProbe(store)

  await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(1))
})

test('a write is visible to every reader — connecting lights the chips up', async () => {
  statusMock.mockResolvedValue({ account: null })
  const store = createStore()

  const { getByTestId } = renderProbe(store)
  await waitFor(() => expect(getByTestId('account').textContent).toBe('none'))

  // What vault settings does on a successful connect.
  store.set(googleAccountAtom, { email: 'nicolai@syv.ai' })

  await waitFor(() => expect(getByTestId('account').textContent).toBe('nicolai@syv.ai'))
})
