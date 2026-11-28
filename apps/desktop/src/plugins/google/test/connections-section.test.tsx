/**
 * A vault's Google account is its own.
 *
 * An account connected on this machine is not an account *this vault uses*.
 * A vault sees only its own opaque Google subject and email; connecting requires consent.
 */
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SandboxedHtml } from '../renderer/sandboxed-html'
import { ConnectionsSection } from '../renderer/connections-section'
import { activeRemoteAtom, loadVaultSettingsAtom, registerBuffer } from '@/plugin-api'

/** A fresh jotai store per test: the google atoms are module level, so one
 *  case's answer would otherwise still be held when the next one renders. */
const render = (visible = true) => {
  const store = createStore()
  store.set(activeRemoteAtom, 'syv-ai/vault')
  const result = rtlRender(
    <Provider store={store}>
      <ConnectionsSection visible={visible} />
    </Provider>,
  )
  return { ...result, store }
}

const status = vi.fn()
const disconnectVault = vi.fn()
const client = vi.fn()
const setClient = vi.fn()
const connect = vi.fn()
const awaitConnect = vi.fn()
const cancelConnect = vi.fn()
const setAllImages = vi.fn()
const mailMarkerPreferences = vi.fn()
const setMailMarkerPreferences = vi.fn()
const settingsRead = vi.fn()
let allImages = false

/** Google's capabilities, by name, through the UI door. */
const google: Record<string, (params: unknown, remote?: string) => unknown> = {
  'google.status': () => status(),
  'google.disconnectVault': () => disconnectVault(),
  'google.connect': (_p, remote) => connect(remote),
  'google.awaitConnect': (_p, remote) => awaitConnect(remote),
  'google.cancelConnect': (p) => cancelConnect(p),
  'google.imageSenders': async () => ({ senders: [], allSenders: false }),
  'google.setImagesFromAllSenders': async (p) => {
    const result = await setAllImages(p)
    allImages = (p as { enabled: boolean }).enabled
    return result
  },
  'google.mailMarkerPreferences': (p) => mailMarkerPreferences(p),
  'google.setMailMarkerPreferences': (p) => setMailMarkerPreferences(p),
  'google.client': (_p, remote) => client(remote),
  'google.setClient': (p) => setClient(p),
}

vi.mock('@/lib/trpc', () => ({
  trpc: {
    settings: { read: { query: () => settingsRead() } },
    cap: {
      run: {
        mutate: async ({
          name,
          paramsJson,
          remote,
        }: {
          name: string
          paramsJson?: string
          remote?: string
        }) => {
          const verb = google[name]
          if (verb === undefined) throw new Error(`unexpected ${name}`)
          return verb(paramsJson === undefined ? undefined : JSON.parse(paramsJson), remote)
        },
      },
    },
  },
}))

const ADA = { sub: 'sub-1', email: 'ada@syv.ai' }
const WORK = { sub: 'sub-2', email: 'work@syv.ai' }

afterEach(() => vi.useRealTimers())

beforeEach(() => {
  vi.clearAllMocks()
  status.mockResolvedValue({ account: null, currentSub: null, missingScopes: [] })
  // Resolved, not bare: the component chains `.catch` on every mutation, and an
  // undefined return there is an unhandled rejection that still lets the
  // assertion pass.
  disconnectVault.mockResolvedValue({ ok: true })
  client.mockResolvedValue({ id: 'holi.apps.googleusercontent.com', source: 'shipped' })
  setClient.mockResolvedValue({ ok: true })
  connect.mockResolvedValue(undefined)
  awaitConnect.mockResolvedValue({ kind: 'granted' })
  cancelConnect.mockResolvedValue(undefined)
  setAllImages.mockResolvedValue({ ok: true })
  mailMarkerPreferences.mockResolvedValue({ enabledOrder: ['yellow-star'] })
  setMailMarkerPreferences.mockResolvedValue({ ok: true })
  allImages = false
  settingsRead.mockImplementation(async () => ({
    pluginValues: { google: { imageSenders: [], imagesFromAllSenders: allImages } },
    plugins: { vault: {}, localOff: [] },
  }))
})

describe('ConnectionsSection', () => {
  it('shows a settings read retry and retries a failed write without racing the switch', async () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/vault')
    status.mockResolvedValue({ account: ADA, currentSub: ADA.sub, missingScopes: [] })
    settingsRead.mockRejectedValueOnce(new Error('read failed'))
    await expect(store.set(loadVaultSettingsAtom, { force: true })).rejects.toThrow('read failed')
    setAllImages.mockRejectedValueOnce(new Error('write failed'))
    rtlRender(
      <Provider store={store}>
        <ConnectionsSection />
      </Provider>,
    )

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Retry' }))
    const toggle = await screen.findByRole('switch', {
      name: 'Always load images from all senders',
    })
    expect(toggle).toBeEnabled()
    await user.click(toggle)
    expect(await screen.findByText(/could not save or read/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(setAllImages).toHaveBeenCalledTimes(2))
    expect(setAllImages).toHaveBeenNthCalledWith(2, { enabled: true })
    expect(screen.queryByText(/could not save or read/i)).toBeNull()

    setAllImages.mockRejectedValueOnce(new Error('disable failed'))
    await user.click(toggle)
    expect(await screen.findByText(/could not save or read/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(setAllImages).toHaveBeenCalledTimes(4))
    expect(setAllImages).toHaveBeenNthCalledWith(4, { enabled: false })
  })
  it('shares pending consent between the banner and actual settings controls', async () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/vault')
    await store.set(loadVaultSettingsAtom, { force: true })
    status.mockResolvedValue({ account: ADA, currentSub: ADA.sub, missingScopes: [] })
    let finish!: (value: { ok: true }) => void
    setAllImages.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    rtlRender(
      <Provider store={store}>
        <ConnectionsSection />
        <SandboxedHtml
          html='<img src="https://cdn.test/logo.png">'
          label="Message"
          identity={{ key: 'm1', sender: 'new@example.com' }}
        />
      </Provider>,
    )
    const user = userEvent.setup()
    const toggle = await screen.findByRole('switch', {
      name: 'Always load images from all senders',
    })
    await user.click(screen.getByRole('button', { name: 'Always from all senders' }))
    expect(toggle).toBeDisabled()
    await act(async () => finish({ ok: true }))
    await waitFor(() => expect(toggle).toBeChecked())
    await waitFor(() => expect(toggle).toBeEnabled())
    setAllImages.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    await user.click(toggle)
    expect(await screen.findByRole('button', { name: 'Always from all senders' })).toBeDisabled()
    await act(async () => finish({ ok: true }))
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(screen.getByRole('button', { name: 'Always from all senders' })).toBeEnabled()
  })

  it('closes the OAuth dialog when its Settings page is hidden and preserves its draft', async () => {
    const mounted = render()
    await screen.findByRole('button', { name: 'Use your own client…' })
    await userEvent.click(screen.getByRole('button', { name: 'Use your own client…' }))
    const id = screen.getByLabelText('Client ID')
    await userEvent.type(id, 'unfinished-client')
    expect(screen.getByRole('dialog', { name: 'Your own OAuth client' })).toBeInTheDocument()

    mounted.rerender(
      <Provider store={mounted.store}>
        <ConnectionsSection visible={false} />
      </Provider>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    mounted.rerender(
      <Provider store={mounted.store}>
        <ConnectionsSection visible />
      </Provider>,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Use your own client…' }))
    expect(screen.getByLabelText('Client ID')).toHaveValue('unfinished-client')
  })

  it('ignores a delayed connect phase after Settings hides and returns', async () => {
    let finishConnect!: () => void
    connect.mockReturnValueOnce(new Promise<void>((resolve) => (finishConnect = resolve)))
    const mounted = render()
    const button = await screen.findByRole('button', { name: 'Connect' })
    await userEvent.click(button)
    expect(button).toBeDisabled()

    mounted.rerender(
      <Provider store={mounted.store}>
        <ConnectionsSection visible={false} />
      </Provider>,
    )
    mounted.rerender(
      <Provider store={mounted.store}>
        <ConnectionsSection visible />
      </Provider>,
    )
    await act(async () => finishConnect())

    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled())
    expect(awaitConnect).not.toHaveBeenCalled()
  })

  it('keeps the current attempt cancellable when an older attempt settles late', async () => {
    let settleFirst!: (value: { kind: 'cancelled' }) => void
    let settleSecond!: (value: { kind: 'granted' | 'cancelled' }) => void
    awaitConnect
      .mockReturnValueOnce(new Promise((resolve) => (settleFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (settleSecond = resolve)))

    const mounted = render()
    const label = 'Connect'
    await userEvent.click(await screen.findByRole('button', { name: label }))
    await waitFor(() => expect(awaitConnect).toHaveBeenCalledTimes(1))

    mounted.rerender(
      <Provider store={mounted.store}>
        <ConnectionsSection visible={false} />
      </Provider>,
    )
    expect(cancelConnect).toHaveBeenCalledTimes(1)
    mounted.rerender(
      <Provider store={mounted.store}>
        <ConnectionsSection visible />
      </Provider>,
    )
    await userEvent.click(await screen.findByRole('button', { name: label }))
    await waitFor(() => expect(awaitConnect).toHaveBeenCalledTimes(2))

    await act(async () => settleFirst({ kind: 'cancelled' }))
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()

    mounted.rerender(
      <Provider store={mounted.store}>
        <ConnectionsSection visible={false} />
      </Provider>,
    )
    expect(cancelConnect).toHaveBeenCalledTimes(2)
    await act(async () => settleSecond({ kind: 'cancelled' }))
  })

  it('invalidates a pending connect when unmounted', async () => {
    let settle!: (value: { kind: 'granted' }) => void
    awaitConnect.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)))
    const mounted = render()
    const button = await screen.findByRole('button', { name: 'Connect' })
    await userEvent.click(button)
    await waitFor(() => expect(awaitConnect).toHaveBeenCalledTimes(1))

    mounted.unmount()
    expect(cancelConnect).toHaveBeenCalledTimes(1)
    await act(async () => settle({ kind: 'granted' }))
    expect(status).toHaveBeenCalledTimes(1)
  })

  it('keeps foreign machine accounts out of the vault and connects only through consent', async () => {
    render()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled())
    expect(screen.queryByText(ADA.email)).not.toBeInTheDocument()
    expect(screen.queryByText(WORK.email)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /use in this vault/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(connect).toHaveBeenCalledWith('syv-ai/vault'))
    expect(awaitConnect).toHaveBeenCalledWith('syv-ai/vault')
  })

  it('exposes a failed status read with Retry and recovers without switching vaults', async () => {
    vi.useFakeTimers()
    status.mockRejectedValue(new Error('main is still starting'))
    render()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_250)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/could not read/i)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^Connect$/ })).toBeEnabled()

    status.mockResolvedValue({
      account: { email: 'ada@syv.ai' },
      currentSub: 'sub-1',
      missingScopes: [],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_250)
    })
    expect(screen.getByText(/Mail and Calendar, as/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('treats a successful disconnected read as authoritative, not a read error', async () => {
    let finishRead!: (value: { account: null; currentSub: null; missingScopes: string[] }) => void
    status.mockReturnValueOnce(new Promise((resolve) => (finishRead = resolve)))
    render()
    const connect = screen.getByRole('button', { name: /^Connect$/ })
    expect(connect).toBeDisabled()
    await act(async () => finishRead({ account: null, currentSub: null, missingScopes: [] }))
    await waitFor(() => expect(connect).toBeEnabled())
    expect(status).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('keeps every account/client lifecycle change behind a successful draft flush', async () => {
    status.mockResolvedValue({ account: null, currentSub: null, missingScopes: [] })
    const unregister = registerBuffer(async () => {
      throw new Error('offline')
    })
    try {
      render()
      await userEvent.click(await screen.findByRole('button', { name: 'Connect' }))
      expect(await screen.findByRole('alert')).toBeInTheDocument()
      expect(connect).not.toHaveBeenCalled()
      expect(disconnectVault).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()

      await userEvent.click(screen.getByRole('button', { name: 'Use your own client…' }))
      await userEvent.type(screen.getByLabelText('Client ID'), 'new-client')
      await userEvent.type(screen.getByLabelText('Client secret'), 'secret')
      await userEvent.click(screen.getByRole('button', { name: /^Save/ }))
      expect(setClient).not.toHaveBeenCalled()
      expect(await screen.findByRole('alert')).toBeInTheDocument()
      expect(screen.getByLabelText('Client ID')).toHaveValue('new-client')
      expect(screen.getByLabelText('Client secret')).toHaveValue('secret')
    } finally {
      unregister()
    }
  })

  it('unlinks the vault rather than revoking the account', async () => {
    // The two are different acts and the panel must not conflate them: another
    // vault may be using this account.
    status.mockResolvedValue({
      account: { email: 'ada@syv.ai' },
      currentSub: 'sub-1',
      missingScopes: [],
    })
    render()

    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect this vault' }))

    await waitFor(() => expect(disconnectVault).toHaveBeenCalled())
  })

  it('lets a vault whose grant Google refused forget it', async () => {
    status.mockResolvedValue({
      account: null,
      currentSub: 'sub-1',
      missingScopes: [],
      needsReconnect: true,
    })
    render()

    await userEvent.click(
      await screen.findByRole('button', { name: "Forget this vault's connection" }),
    )

    await waitFor(() => expect(disconnectVault).toHaveBeenCalled())
  })
})

describe('the OAuth client', () => {
  it('changes the future-connect client without disconnecting existing accounts', async () => {
    const user = userEvent.setup()
    status.mockResolvedValue({ account: ADA, currentSub: ADA.sub, missingScopes: ['calendar'] })
    render()
    expect(
      await screen.findByText(/Holi’s client, which accepts syv.ai accounts only/),
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Use your own client…' }))
    await user.type(screen.getByLabelText('Client ID'), 'mine.apps.googleusercontent.com')
    await user.type(screen.getByLabelText('Client secret'), 's3cret')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(setClient).toHaveBeenCalledWith({
        id: 'mine.apps.googleusercontent.com',
        secret: 's3cret',
      }),
    )
    expect(disconnectVault).not.toHaveBeenCalled()
    expect(await screen.findByText(ADA.email)).toBeInTheDocument()
  })

  it('says a refusal in the form, and keeps what was typed', async () => {
    const user = userEvent.setup()
    setClient.mockRejectedValue(new Error('a client id ends in .apps.googleusercontent.com'))
    render()
    await user.click(await screen.findByRole('button', { name: 'Use your own client…' }))
    await user.type(screen.getByLabelText('Client ID'), 'nope')
    await user.type(screen.getByLabelText('Client secret'), 'x')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/a client id ends in/)).toBeTruthy()
    expect((screen.getByLabelText('Client ID') as HTMLInputElement).value).toBe('nope')
  })
})

it('drops unsaved OAuth client fields when the active vault changes', async () => {
  client.mockImplementation(async (remote: string) => ({
    source: 'own',
    id:
      remote === 'syv-ai/vault'
        ? 'vault-a.apps.googleusercontent.com'
        : 'vault-b.apps.googleusercontent.com',
  }))
  const { store } = render()
  const user = userEvent.setup()
  await screen.findByText(/vault-a\.apps\.googleusercontent\.com/)
  await user.click(screen.getByRole('button', { name: 'Change client…' }))
  await user.type(screen.getByLabelText('Client ID'), 'unsaved-vault-a.apps.googleusercontent.com')
  await user.type(screen.getByLabelText('Client secret'), 'synthetic-vault-a-secret')

  act(() => store.set(activeRemoteAtom, 'syv-ai/second-vault'))
  await screen.findByText(/vault-b\.apps\.googleusercontent\.com/)
  expect(screen.queryByRole('dialog')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Change client…' }))
  expect(screen.getByLabelText('Client ID')).toHaveValue('')
  expect(screen.getByLabelText('Client secret')).toHaveValue('')
  expect(setClient).not.toHaveBeenCalled()
})
