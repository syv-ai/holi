/**
 * The connected-Google account, shared: the Connections section, which changes
 * it, and the nav menu, which decides whether Mail and Agenda show at all, must
 * not disagree.
 */
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { render, waitFor } from '@/test/render'
import { googleConnectedAtom, refreshGoogleAtom, useGoogleAccount } from '../renderer/account'
import { activeRemoteAtom } from '@/plugin-api'

const statusMock = vi.fn()
const accountsMock = vi.fn()
vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      run: {
        mutate: async ({ name }: { name: string }) =>
          name === 'google.status'
            ? statusMock()
            : // The same read also asks which accounts exist and which one
              // this vault uses. Mocked here so these stay about the shared atom.
              name === 'google.accounts'
              ? accountsMock()
              : Promise.reject(new Error(`unexpected ${name}`)),
      },
    },
  },
}))

function Probe() {
  const { account, missingScopes } = useGoogleAccount()
  return (
    <>
      <span data-testid="account">
        {account === undefined ? 'unknown' : (account?.email ?? 'none')}
      </span>
      <span data-testid="missing">{missingScopes.length}</span>
    </>
  )
}

const renderProbe = (store = createStore()) => {
  store.set(activeRemoteAtom, 'syv-ai/vault')
  const view = render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
  return { ...view, store }
}

beforeEach(() => {
  accountsMock.mockResolvedValue({ accounts: [], current: null })
  statusMock.mockReset()
})

test('starts unknown, then reports the connected account', async () => {
  statusMock.mockResolvedValue({ account: { email: 'ada@syv.ai' }, missingScopes: [] })

  const { getByTestId } = renderProbe()

  // Unknown is a third state on purpose: the shell hides the chips until the
  // answer is in, so a disconnected app never flashes them on launch.
  expect(getByTestId('account').textContent).toBe('unknown')
  await waitFor(() => expect(getByTestId('account').textContent).toBe('ada@syv.ai'))
})

test('reports no account when nothing is connected', async () => {
  statusMock.mockResolvedValue({ account: null, missingScopes: [] })

  const { getByTestId } = renderProbe()

  await waitFor(() => expect(getByTestId('account').textContent).toBe('none'))
})

test('treats an unreachable connector as not connected, not as unknown forever', async () => {
  // The `google.*` procedures refuse outright when the connector is not
  // configured. That is a normal state, not an error the user can act on, and
  // leaving it `undefined` would re-query on every render.
  statusMock.mockRejectedValue(new Error('the Google connector is not configured'))

  const { getByTestId } = renderProbe()

  await waitFor(() => expect(getByTestId('account').textContent).toBe('none'))
})

test('asks once, however many components read it', async () => {
  statusMock.mockResolvedValue({ account: null, missingScopes: [] })
  const store = createStore()

  const { getByTestId } = renderProbe(store)
  await waitFor(() => expect(getByTestId('account').textContent).toBe('none'))
  renderProbe(store)

  await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(1))
})

test('carries the scopes a stored grant is missing — connected is not the same as sufficient', async () => {
  // The state a widened GOOGLE_SCOPES produces: the grant still works, mail
  // still lists, and only the new calls fail.
  statusMock.mockResolvedValue({
    account: { email: 'ada@syv.ai' },
    missingScopes: ['https://www.googleapis.com/auth/gmail.modify'],
  })

  const { getByTestId } = renderProbe()

  await waitFor(() => expect(getByTestId('missing').textContent).toBe('1'))
  // Connected AND insufficient, at the same time.
  expect(getByTestId('account').textContent).toBe('ada@syv.ai')
})

test('an unreachable connector reports no missing scopes rather than a stale list', async () => {
  statusMock.mockRejectedValue(new Error('the Google connector is not configured'))

  const { getByTestId } = renderProbe()

  await waitFor(() => expect(getByTestId('account').textContent).toBe('none'))
  expect(getByTestId('missing').textContent).toBe('0')
})

test('a refresh is visible to every reader: connecting lights the nav up', async () => {
  statusMock.mockResolvedValue({ account: null, missingScopes: [] })
  const store = createStore()

  const { getByTestId } = renderProbe(store)
  await waitFor(() => expect(getByTestId('account').textContent).toBe('none'))
  expect(store.get(googleConnectedAtom)).toBe(false)

  // What the Connections section does after a successful connect.
  statusMock.mockResolvedValue({ account: { email: 'ada@syv.ai' }, missingScopes: [] })
  store.set(refreshGoogleAtom)

  await waitFor(() => expect(getByTestId('account').textContent).toBe('ada@syv.ai'))
  expect(store.get(googleConnectedAtom)).toBe(true)
})
