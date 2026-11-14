/** Renderer lifetimes for community plugin rows and their leased frames. */
import { act, cleanup, render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { communityCap } from '../renderer/community-cap'
import { PluginFrame } from '../renderer/plugin-frame'
import {
  followRows,
  refreshRows,
  refreshUpdates,
  rowsAtom,
  rowsErrorAtom,
  serversAtom,
  updatesAtom,
  type PluginRow,
} from '../renderer/state'

vi.mock('../renderer/community-cap', () => ({
  communityCap: {
    list: vi.fn(),
    updates: vi.fn(),
    acquire: vi.fn(),
    release: vi.fn(),
  },
}))

const row: PluginRow = {
  id: 'dash',
  name: 'Dash',
  description: '',
  opens: ['*.dash.md'],
  status: 'ready',
  on: true,
  running: true,
  pin: { repo: 'ada/dash', path: '', version: '1.0.0', commit: 'abc' },
  install: null,
  setup: null,
  serve: null,
  apps: [],
  bin: [],
  cli: null,
  commandsNote: null,
  check: null,
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const capability = vi.mocked(communityCap)
const releaseResult = {
  id: 'dash',
  port: 4312,
  lease: '123e4567-e89b-12d3-a456-426614174000',
} as const

afterEach(async () => {
  cleanup()
  // Lease releases run after the resolved acquire, including cleanup's unmounts.
  await Promise.resolve()
  await Promise.resolve()
  vi.resetAllMocks()
})

test('late row and update responses cannot repopulate a closed followRows lifetime', async () => {
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  const rows = deferred<PluginRow[]>()
  const updates = deferred<Readonly<Record<string, string>>>()
  capability.list.mockReturnValue(rows.promise)
  capability.updates.mockReturnValue(updates.promise)
  const stop = followRows('ada/notes', store)
  stop()
  rows.resolve([row])
  updates.resolve({ dash: '2.0.0' })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(store.get(rowsAtom)).toBeNull()
  expect(store.get(updatesAtom)).toEqual({})
})

test('late results from an earlier A lifetime cannot commit after A to B to A', async () => {
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  const staleRows = deferred<PluginRow[]>()
  const staleUpdates = deferred<Readonly<Record<string, string>>>()
  capability.list
    .mockReturnValueOnce(staleRows.promise)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
  capability.updates
    .mockReturnValueOnce(staleUpdates.promise)
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
  const stopA = followRows('ada/notes', store)
  stopA()
  store.set(activeRemoteAtom, 'ada/other')
  const stopB = followRows('ada/other', store)
  stopB()
  store.set(activeRemoteAtom, 'ada/notes')
  const stopAgain = followRows('ada/notes', store)
  await waitFor(() => expect(store.get(rowsAtom)).toEqual({ remote: 'ada/notes', rows: [] }))
  staleRows.resolve([row])
  staleUpdates.resolve({ dash: '2.0.0' })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(store.get(rowsAtom)).toEqual({ remote: 'ada/notes', rows: [] })
  expect(store.get(updatesAtom)).toEqual({})
  stopAgain()
})

test('a refresh cannot commit once a different vault is active', async () => {
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  const pendingRows = deferred<PluginRow[]>()
  const pendingUpdates = deferred<Readonly<Record<string, string>>>()
  capability.list.mockReturnValue(pendingRows.promise)
  capability.updates.mockReturnValue(pendingUpdates.promise)
  const rowRequest = refreshRows('ada/notes', store)
  const updateRequest = refreshUpdates('ada/notes', store)
  store.set(activeRemoteAtom, 'ada/other')
  pendingRows.resolve([row])
  pendingUpdates.resolve({ dash: '2.0.0' })
  await Promise.all([rowRequest, updateRequest])
  expect(store.get(rowsAtom)).toBeNull()
  expect(store.get(updatesAtom)).toEqual({})
})

test('a superseded refresh cannot overwrite a newer result', async () => {
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  const oldRows = deferred<PluginRow[]>()
  const oldUpdates = deferred<Readonly<Record<string, string>>>()
  capability.list.mockReturnValueOnce(oldRows.promise).mockResolvedValueOnce([])
  capability.updates.mockReturnValueOnce(oldUpdates.promise).mockResolvedValueOnce({})
  const firstRows = refreshRows('ada/notes', store)
  const secondRows = refreshRows('ada/notes', store)
  const firstUpdates = refreshUpdates('ada/notes', store)
  const secondUpdates = refreshUpdates('ada/notes', store)
  await Promise.all([secondRows, secondUpdates])
  oldRows.resolve([row])
  oldUpdates.resolve({ dash: '2.0.0' })
  await Promise.all([firstRows, firstUpdates])
  expect(store.get(rowsAtom)).toEqual({ remote: 'ada/notes', rows: [] })
  expect(store.get(updatesAtom)).toEqual({})
})

test('a frame acquires only for its current remote and serving row', async () => {
  capability.acquire.mockResolvedValue(releaseResult)
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  store.set(rowsAtom, { remote: 'ada/other', rows: [row] })
  const view = render(
    <Provider store={store}>
      <PluginFrame path="index.dash.md" />
    </Provider>,
  )
  expect(capability.acquire).not.toHaveBeenCalled()
  await act(async () => {
    store.set(rowsAtom, { remote: 'ada/notes', rows: [row] })
  })
  await waitFor(() => expect(capability.acquire).toHaveBeenCalledTimes(1))
  view.unmount()
})

test('visibility toggles keep the same iframe document and lease', async () => {
  const acquisition = deferred<typeof releaseResult>()
  capability.acquire.mockReturnValue(acquisition.promise)
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  store.set(rowsAtom, { remote: 'ada/notes', rows: [row] })
  const view = render(
    <Provider store={store}>
      <PluginFrame path="index.dash.md" visible />
    </Provider>,
  )
  await waitFor(() => expect(capability.acquire).toHaveBeenCalledTimes(1))
  expect(view.container.querySelector('iframe')).toBeNull()
  await act(async () => {
    acquisition.resolve(releaseResult)
  })
  await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull())
  const iframe = view.container.querySelector('iframe')!
  const attributes = ['src', 'sandbox', 'allow'].map((name) => iframe.getAttribute(name))
  view.rerender(
    <Provider store={store}>
      <PluginFrame path="index.dash.md" visible={false} />
    </Provider>,
  )
  expect(view.container.querySelector('iframe')).toBe(iframe)
  expect(['src', 'sandbox', 'allow'].map((name) => iframe.getAttribute(name))).toEqual(attributes)
  expect(iframe).toHaveAttribute('inert')
  expect(capability.acquire).toHaveBeenCalledTimes(1)
  view.unmount()
})

test('unmount before acquire resolves releases the resulting lease once', async () => {
  const acquisition = deferred<typeof releaseResult>()
  capability.acquire.mockReturnValue(acquisition.promise)
  capability.release.mockResolvedValue(undefined)
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  store.set(rowsAtom, { remote: 'ada/notes', rows: [row] })
  const view = render(
    <Provider store={store}>
      <PluginFrame path="index.dash.md" />
    </Provider>,
  )
  await waitFor(() => expect(capability.acquire).toHaveBeenCalledTimes(1))
  view.unmount()
  acquisition.resolve(releaseResult)
  await waitFor(() => expect(capability.release).toHaveBeenCalledTimes(1))
  expect(capability.release).toHaveBeenCalledWith('ada/notes', {
    lease: '123e4567-e89b-12d3-a456-426614174000',
  })
})

test('failed acquire retries only after Start again', async () => {
  capability.acquire
    .mockRejectedValueOnce(new Error('server failed'))
    .mockResolvedValueOnce(releaseResult)
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  store.set(rowsAtom, { remote: 'ada/notes', rows: [row] })
  const view = render(
    <Provider store={store}>
      <PluginFrame path="index.dash.md" />
    </Provider>,
  )
  const restart = await screen.findByRole('button', { name: 'Start again' })
  expect(capability.acquire).toHaveBeenCalledTimes(1)
  await act(async () => {
    restart.click()
  })
  await waitFor(() => expect(capability.acquire).toHaveBeenCalledTimes(2))
  view.unmount()
})

test('a crashed server is retried only after Start again', async () => {
  capability.acquire.mockResolvedValue(releaseResult)
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  store.set(rowsAtom, { remote: 'ada/notes', rows: [row] })
  const view = render(
    <Provider store={store}>
      <PluginFrame path="index.dash.md" />
    </Provider>,
  )
  await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull())
  await act(async () => {
    store.set(serversAtom, { 'index.dash.md': { state: 'exited', log: [], message: 'crashed' } })
  })
  expect(await screen.findByRole('button', { name: 'Start again' })).toBeInTheDocument()
  expect(capability.acquire).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByRole('button', { name: 'Start again' }))
  await waitFor(() => expect(capability.acquire).toHaveBeenCalledTimes(2))
  view.unmount()
})

test('a serving plugin that becomes unready releases its lease and can be checked again', async () => {
  capability.acquire.mockResolvedValue(releaseResult)
  capability.release.mockResolvedValue(undefined)
  capability.list.mockResolvedValue([{ ...row, running: false, status: 'needs-consent' }])
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  store.set(rowsAtom, { remote: 'ada/notes', rows: [row] })
  const view = render(
    <Provider store={store}>
      <PluginFrame path="index.dash.md" />
    </Provider>,
  )
  await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull())
  await act(async () => {
    store.set(rowsAtom, {
      remote: 'ada/notes',
      rows: [{ ...row, running: false, status: 'needs-consent' }],
    })
  })
  expect(view.container.querySelector('iframe')).toBeNull()
  expect(await screen.findByText(/Dash needs permission to run this version/)).toBeInTheDocument()
  expect(capability.acquire).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(capability.release).toHaveBeenCalledTimes(1))
  await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
  await waitFor(() => expect(store.get(rowsAtom)?.rows[0]?.running).toBe(false))
  expect(capability.acquire).toHaveBeenCalledTimes(1)
})

test('losing the serving row releases the lease and removes the iframe', async () => {
  capability.acquire.mockResolvedValue(releaseResult)
  capability.release.mockResolvedValue(undefined)
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  store.set(rowsAtom, { remote: 'ada/notes', rows: [row] })
  const view = render(
    <Provider store={store}>
      <PluginFrame path="index.dash.md" />
    </Provider>,
  )
  await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull())
  await act(async () => {
    store.set(rowsAtom, { remote: 'ada/notes', rows: [] })
  })
  expect(view.container.querySelector('iframe')).toBeNull()
  await waitFor(() => expect(capability.release).toHaveBeenCalledTimes(1))
})

test.each([false, true])(
  'a disabled overlapping claim cannot shadow the running owner (present on open: %s)',
  async (presentOnOpen) => {
    capability.acquire.mockResolvedValue(releaseResult)
    const store = createStore()
    store.set(activeRemoteAtom, 'ada/notes')
    const disabled = { ...row, id: 'earlier', name: 'Earlier', on: false, running: false }
    store.set(rowsAtom, { remote: 'ada/notes', rows: presentOnOpen ? [disabled, row] : [row] })
    const view = render(
      <Provider store={store}>
        <PluginFrame path="index.dash.md" />
      </Provider>,
    )
    await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull())
    const frame = view.container.querySelector('iframe')
    await act(async () => {
      store.set(rowsAtom, {
        remote: 'ada/notes',
        rows: [disabled, row],
      })
    })
    expect(view.container.querySelector('iframe')).toBe(frame)
    expect(frame).toHaveAttribute('aria-label', 'Dash: index.dash.md')
    expect(capability.acquire).toHaveBeenCalledTimes(1)
    expect(capability.release).not.toHaveBeenCalled()
  },
)

test('a superseded Check again cannot release the frame restored by a newer refresh', async () => {
  capability.acquire.mockResolvedValue(releaseResult)
  const pending = deferred<PluginRow[]>()
  capability.list.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([row])
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  store.set(rowsAtom, { remote: 'ada/notes', rows: [] })
  const view = render(
    <Provider store={store}>
      <PluginFrame path="index.dash.md" />
    </Provider>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
  await act(async () => {
    await refreshRows('ada/notes', store)
  })
  await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull())
  const frame = view.container.querySelector('iframe')
  await act(async () => {
    pending.resolve([])
  })
  expect(store.get(rowsAtom)?.rows).toEqual([row])
  expect(view.container.querySelector('iframe')).toBe(frame)
  expect(capability.release).not.toHaveBeenCalled()
})

test('Check again from a previous A lifetime cannot replace the restored frame after A to B to A', async () => {
  capability.acquire.mockResolvedValue(releaseResult)
  capability.updates.mockResolvedValue({})
  const pending = deferred<PluginRow[]>()
  capability.list
    .mockResolvedValueOnce([])
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([row])
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  const stopA = followRows('ada/notes', store)
  await waitFor(() => expect(store.get(rowsAtom)?.rows).toEqual([]))
  const view = render(
    <Provider store={store}>
      <PluginFrame path="index.dash.md" />
    </Provider>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
  let stopAgain!: () => void
  await act(async () => {
    stopA()
    store.set(activeRemoteAtom, 'ada/other')
    const stopB = followRows('ada/other', store)
    stopB()
    store.set(activeRemoteAtom, 'ada/notes')
    stopAgain = followRows('ada/notes', store)
  })
  try {
    await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull())
    const frame = view.container.querySelector('iframe')
    await act(async () => {
      pending.resolve([])
    })
    expect(store.get(rowsAtom)?.rows).toEqual([row])
    expect(view.container.querySelector('iframe')).toBe(frame)
    expect(capability.release).not.toHaveBeenCalled()
  } finally {
    view.unmount()
    stopAgain()
  }
})

test('a failed Check again shows an inline error and recovers on retry', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  capability.list.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce([row])
  capability.acquire.mockResolvedValue(releaseResult)
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  store.set(rowsAtom, { remote: 'ada/notes', rows: [] })
  const view = render(
    <Provider store={store}>
      <PluginFrame path="index.dash.md" />
    </Provider>,
  )
  try {
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('connection lost')
    expect(capability.acquire).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(capability.acquire).toHaveBeenCalledTimes(1)
  } finally {
    errorLog.mockRestore()
  }
})

test.each([
  [{ ...row, running: false, status: 'needs-consent' as const }, /Dash needs permission to run/],
  [{ ...row, running: false, on: false }, /Dash is turned off/],
  [null, /No installed or pinned plugin claims this file/],
])('an unavailable frame names its known reason: %j', async (unavailableRow, reason) => {
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  store.set(rowsAtom, { remote: 'ada/notes', rows: unavailableRow ? [unavailableRow] : [] })
  render(
    <Provider store={store}>
      <PluginFrame path="index.dash.md" />
    </Provider>,
  )
  expect(await screen.findByText(reason)).toBeInTheDocument()
  expect(screen.queryByText(/Starting/)).not.toBeInTheDocument()
  expect(capability.acquire).not.toHaveBeenCalled()
})

test.each([false, true])(
  'a stale failed refresh cannot set the current error (vault reopened: %s)',
  async (reopen) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = createStore()
    store.set(activeRemoteAtom, 'ada/notes')
    capability.updates.mockResolvedValue({})
    capability.list.mockResolvedValueOnce([])
    let stop = followRows('ada/notes', store)
    await waitFor(() => expect(store.get(rowsAtom)?.rows).toEqual([]))
    const stale = deferred<PluginRow[]>()
    capability.list.mockReturnValueOnce(stale.promise).mockResolvedValueOnce([row])
    const first = refreshRows('ada/notes', store)
    try {
      if (reopen) {
        stop()
        store.set(activeRemoteAtom, 'ada/other')
        store.set(activeRemoteAtom, 'ada/notes')
        stop = followRows('ada/notes', store)
      } else {
        await refreshRows('ada/notes', store)
      }
      await waitFor(() => expect(store.get(rowsAtom)?.rows).toEqual([row]))
      stale.reject(new Error('outdated failure'))
      await first
      expect(store.get(rowsErrorAtom)).toBeNull()
      expect(errorLog).not.toHaveBeenCalled()
    } finally {
      stop()
      errorLog.mockRestore()
    }
  },
)

test('a superseded success cannot clear the latest refresh failure, and vault teardown clears it', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const store = createStore()
  store.set(activeRemoteAtom, 'ada/notes')
  capability.updates.mockResolvedValue({})
  capability.list.mockResolvedValueOnce([])
  const stop = followRows('ada/notes', store)
  await waitFor(() => expect(store.get(rowsAtom)?.rows).toEqual([]))
  const stale = deferred<PluginRow[]>()
  capability.list
    .mockReturnValueOnce(stale.promise)
    .mockRejectedValueOnce(new Error('latest failure'))
  const first = refreshRows('ada/notes', store)
  try {
    await refreshRows('ada/notes', store)
    expect(store.get(rowsErrorAtom)).toBe('latest failure')
    stale.resolve([row])
    await first
    expect(store.get(rowsErrorAtom)).toBe('latest failure')
    expect(store.get(rowsAtom)?.rows).toEqual([])
  } finally {
    stop()
    errorLog.mockRestore()
  }
  expect(store.get(rowsErrorAtom)).toBeNull()
})
