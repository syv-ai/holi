/**
 * The connected-Google account, shared: the Connections section, which changes
 * it, and the nav menu, which decides whether Mail and Agenda show at all, must
 * not disagree.
 */
import { Provider, createStore } from 'jotai'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, render, waitFor } from '@/test/render'
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
              name === 'google.allAccounts'
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

let remoteCounter = 0
const renderProbe = (store = createStore(), remote = `syv-ai/vault-${remoteCounter++}`) => {
  store.set(activeRemoteAtom, remote)
  const view = render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
  return { ...view, store }
}

beforeEach(() => {
  accountsMock.mockReset().mockResolvedValue({ accounts: [], current: null })
  statusMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

test('starts unknown, then reports the connected account', async () => {
  statusMock.mockResolvedValue({ account: { email: 'ada@syv.ai' }, missingScopes: [] })

  const { getByTestId } = renderProbe()

  // Unknown is a third state on purpose: the shell hides the chips until the
  // answer is in, so a disconnected app never flashes them on launch.
  expect(getByTestId('account').textContent).toBe('unknown')
  await waitFor(() => expect(getByTestId('account').textContent).toBe('ada@syv.ai'))
})

test('a successful disconnected result is authoritative and does not retry', async () => {
  vi.useFakeTimers()
  statusMock.mockResolvedValue({ account: null, missingScopes: [] })

  const { getByTestId } = renderProbe()

  await act(async () => {
    await Promise.resolve()
  })
  expect(getByTestId('account').textContent).toBe('none')
  expect(statusMock).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

test('recovers from a transient status failure and reveals the sidebar connection', async () => {
  statusMock
    .mockRejectedValueOnce(new Error('Google is not ready yet'))
    .mockResolvedValue({ account: { email: 'ada@syv.ai' }, missingScopes: [] })

  vi.useFakeTimers()
  const { getByTestId, store } = renderProbe()

  expect(getByTestId('account').textContent).toBe('unknown')
  expect(store.get(googleConnectedAtom)).toBe(false)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
    await Promise.resolve()
  })
  expect(getByTestId('account').textContent).toBe('ada@syv.ai')
  expect(store.get(googleConnectedAtom)).toBe(true)
  expect(statusMock).toHaveBeenCalledTimes(2)
})

test('a persistent read failure stays unknown after bounded retries', async () => {
  vi.useFakeTimers()
  statusMock.mockRejectedValue(new Error('Google is unavailable'))

  const { getByTestId } = renderProbe()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_250)
    await Promise.resolve()
  })
  expect(getByTestId('account').textContent).toBe('unknown')
  expect(statusMock).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(0)
})

test('an exhausted read is an error and an explicit refresh starts a fresh sequence', async () => {
  vi.useFakeTimers()
  statusMock.mockRejectedValue(new Error('Google is unavailable'))
  const { getByTestId, store } = renderProbe()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_250)
    await Promise.resolve()
  })
  expect(getByTestId('account').textContent).toBe('unknown')
  statusMock.mockResolvedValue({ account: { email: 'recovered@syv.ai' }, missingScopes: [] })
  store.set(refreshGoogleAtom)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_250)
    await Promise.resolve()
  })
  expect(getByTestId('account').textContent).toBe('recovered@syv.ai')
  expect(statusMock).toHaveBeenCalledTimes(4)
})

test('remount after cancelling a retry starts a fresh request in the same store', async () => {
  vi.useFakeTimers()
  statusMock.mockRejectedValue(new Error('Google is unavailable'))
  const { unmount, store } = renderProbe(createStore(), 'syv-ai/remount-test')
  await act(async () => {
    await Promise.resolve()
  })
  expect(statusMock).toHaveBeenCalledTimes(1)
  unmount()
  statusMock.mockResolvedValue({ account: { email: 'remounted@syv.ai' }, missingScopes: [] })
  const view = renderProbe(store, 'syv-ai/remount-test')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_250)
  })
  expect(view.getByTestId('account').textContent).toBe('remounted@syv.ai')
  expect(statusMock).toHaveBeenCalledTimes(2)
})

test('late rejection after unmount cannot start retries', async () => {
  vi.useFakeTimers()
  let rejectOld!: (error: Error) => void
  statusMock.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectOld = reject
      }),
  )
  const { unmount } = renderProbe()
  expect(statusMock).toHaveBeenCalledTimes(1)
  unmount()
  expect(statusMock).toHaveBeenCalledTimes(1)
  await act(async () => {
    rejectOld(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(1_250)
  })
  expect(statusMock).toHaveBeenCalledTimes(1)
})

test('Google account reads safely under React StrictMode', async () => {
  statusMock.mockResolvedValue({ account: { email: 'strict@syv.ai' }, missingScopes: [] })
  const store = createStore()
  store.set(activeRemoteAtom, 'strict/remount')
  const view = render(
    <StrictMode>
      <Provider store={store}>
        <Probe />
      </Provider>
    </StrictMode>,
  )
  await waitFor(() => expect(view.getByTestId('account').textContent).toBe('strict@syv.ai'))
  expect(statusMock).toHaveBeenCalled()
})

test('independent stores do not share a same-vault result', async () => {
  statusMock
    .mockResolvedValueOnce({ account: { email: 'first@syv.ai' }, missingScopes: [] })
    .mockResolvedValueOnce({ account: { email: 'second@syv.ai' }, missingScopes: [] })
  const first = renderProbe(createStore(), 'same/remote')
  const second = renderProbe(createStore(), 'same/remote')
  await waitFor(() =>
    expect(first.container.querySelector('[data-testid="account"]')?.textContent).toBe(
      'first@syv.ai',
    ),
  )
  await waitFor(() =>
    expect(second.container.querySelector('[data-testid="account"]')?.textContent).toBe(
      'second@syv.ai',
    ),
  )
  expect(statusMock).toHaveBeenCalledTimes(2)
})

test('unmounting one store does not cancel another same-remote request', async () => {
  vi.useFakeTimers()
  let rejectFirst!: (error: Error) => void
  let resolveSecond!: (value: { account: { email: string }; missingScopes: string[] }) => void
  statusMock
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectFirst = reject
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve
        }),
    )
  const first = renderProbe(createStore(), 'same/remote')
  const second = renderProbe(createStore(), 'same/remote')
  expect(statusMock).toHaveBeenCalledTimes(2)
  first.unmount()
  await act(async () => {
    resolveSecond({ account: { email: 'second@syv.ai' }, missingScopes: [] })
    await Promise.resolve()
  })
  expect(second.container.querySelector('[data-testid="account"]')?.textContent).toBe(
    'second@syv.ai',
  )
  await act(async () => {
    rejectFirst(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(1_250)
  })
  expect(statusMock).toHaveBeenCalledTimes(2)
})

test('unmounting one of several same-store readers does not cancel the other', async () => {
  vi.useFakeTimers()
  statusMock
    .mockRejectedValueOnce(new Error('temporary'))
    .mockResolvedValue({ account: null, missingScopes: [] })
  const store = createStore()
  store.set(activeRemoteAtom, 'same/store')
  const first = render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
  const second = render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  first.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(second.getByTestId('account').textContent).toBe('none')
  expect(statusMock).toHaveBeenCalledTimes(2)
})

test('asks once, however many components read it', async () => {
  statusMock.mockResolvedValue({ account: null, missingScopes: [] })
  const store = createStore()

  const remote = 'syv-ai/shared-vault'
  const { getByTestId } = renderProbe(store, remote)
  await waitFor(() => expect(getByTestId('account').textContent).toBe('none'))
  renderProbe(store, remote)

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

test('retries an all-accounts failure without losing a connected account', async () => {
  statusMock.mockResolvedValue({ account: { email: 'ada@syv.ai' }, missingScopes: [] })
  accountsMock
    .mockRejectedValueOnce(new Error('Google is not ready yet'))
    .mockResolvedValue({ accounts: [], current: null })

  vi.useFakeTimers()
  const { getByTestId } = renderProbe()
  expect(getByTestId('account').textContent).toBe('unknown')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
    await Promise.resolve()
  })
  expect(getByTestId('account').textContent).toBe('ada@syv.ai')
  expect(accountsMock).toHaveBeenCalledTimes(2)
})

test('unmounting cancels a pending retry', async () => {
  vi.useFakeTimers()
  statusMock.mockRejectedValue(new Error('Google is not ready yet'))

  const { unmount } = renderProbe()
  await act(async () => {
    await Promise.resolve()
  })
  expect(vi.getTimerCount()).toBe(1)
  act(() => unmount())
  expect(vi.getTimerCount()).toBe(0)
})

test('a vault switch does not let a late prior answer overwrite the new vault', async () => {
  let resolveOld!: (value: { account: { email: string }; missingScopes: string[] }) => void
  statusMock
    .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
    .mockResolvedValue({ account: { email: 'new@syv.ai' }, missingScopes: [] })
  const store = createStore()
  const { getByTestId } = renderProbe(store)

  store.set(activeRemoteAtom, 'other/vault')
  await waitFor(() => expect(getByTestId('account').textContent).toBe('new@syv.ai'))
  await act(async () => {
    resolveOld({ account: { email: 'old@syv.ai' }, missingScopes: [] })
    await Promise.resolve()
  })
  expect(getByTestId('account').textContent).toBe('new@syv.ai')
})

test('the sidebar subscription preserves a connection without a React account reader', async () => {
  vi.useFakeTimers()
  statusMock.mockResolvedValue({ account: { email: 'ada@syv.ai' }, missingScopes: [] })
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/sidebar-only')
  const unsubscribe = store.sub(googleConnectedAtom, () => undefined)
  await vi.waitFor(() => expect(store.get(googleConnectedAtom)).toBe(true))

  statusMock.mockRejectedValue(new Error('Google is unavailable'))
  store.set(refreshGoogleAtom)
  await vi.advanceTimersByTimeAsync(1_250)
  expect(store.get(googleConnectedAtom)).toBe(true)

  statusMock.mockResolvedValue({ account: null, missingScopes: [] })
  store.set(refreshGoogleAtom)
  await vi.advanceTimersByTimeAsync(1_250)
  expect(store.get(googleConnectedAtom)).toBe(false)
  unsubscribe()
})

test('refresh failures preserve the last connected account', async () => {
  statusMock.mockResolvedValueOnce({ account: { email: 'ada@syv.ai' }, missingScopes: [] })
  const store = createStore()
  const { getByTestId } = renderProbe(store)
  await waitFor(() => expect(getByTestId('account').textContent).toBe('ada@syv.ai'))

  vi.useFakeTimers()
  statusMock.mockRejectedValue(new Error('Google is unavailable'))
  store.set(refreshGoogleAtom)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_250)
    await Promise.resolve()
  })
  expect(getByTestId('account').textContent).toBe('ada@syv.ai')
  expect(store.get(googleConnectedAtom)).toBe(true)
  expect(statusMock).toHaveBeenCalledTimes(4)
  expect(vi.getTimerCount()).toBe(0)
})

test('an explicit refresh prevents an older in-flight answer from winning', async () => {
  let resolveOld!: (value: { account: { email: string }; missingScopes: string[] }) => void
  statusMock
    .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
    .mockResolvedValue({ account: { email: 'refreshed@syv.ai' }, missingScopes: [] })
  const store = createStore()
  const { getByTestId } = renderProbe(store)

  store.set(refreshGoogleAtom)
  await waitFor(() => expect(getByTestId('account').textContent).toBe('refreshed@syv.ai'))
  await act(async () => {
    resolveOld({ account: { email: 'stale@syv.ai' }, missingScopes: [] })
    await Promise.resolve()
  })
  expect(getByTestId('account').textContent).toBe('refreshed@syv.ai')
})

test('switching vaults cancels a scheduled retry', async () => {
  vi.useFakeTimers()
  statusMock
    .mockRejectedValueOnce(new Error('Google is not ready yet'))
    .mockResolvedValue({ account: { email: 'new@syv.ai' }, missingScopes: [] })
  const store = createStore()
  const { getByTestId } = renderProbe(store)
  await act(async () => {
    await Promise.resolve()
  })
  expect(vi.getTimerCount()).toBe(1)

  store.set(activeRemoteAtom, 'other/vault')
  await act(async () => {
    await Promise.resolve()
  })
  expect(getByTestId('account').textContent).toBe('new@syv.ai')
  expect(vi.getTimerCount()).toBe(0)
  expect(statusMock).toHaveBeenCalledTimes(2)
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

  statusMock.mockResolvedValue({ account: null, missingScopes: [] })
  store.set(refreshGoogleAtom)
  await waitFor(() => expect(getByTestId('account').textContent).toBe('none'))
  expect(store.get(googleConnectedAtom)).toBe(false)
})
