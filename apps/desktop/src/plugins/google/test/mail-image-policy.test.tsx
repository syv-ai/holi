import { act, render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { resolveVaultSettings } from '@holi/shared'
import { activeRemoteAtom, loadVaultSettingsAtom } from '@/plugin-api'
import { GOOGLE_INFO } from '../info'
import { useRemoteContent, useSetAllSenderImages } from '../renderer/mail-images'

const read = vi.fn()
const write = vi.fn()
const disk = new Map<string, { imagesFromAllSenders: boolean; imageSenders: string[] }>()
const A = 'team/alpha'
const B = 'team/beta'

function settings(remote: string) {
  return resolveVaultSettings(
    {
      app: null,
      appLocal: null,
      plugins: null,
      pluginsLocal: JSON.stringify({ google: disk.get(remote) }),
    },
    [GOOGLE_INFO],
  )
}

vi.mock('@/lib/trpc', () => ({
  trpc: {
    settings: { read: { query: (params: { remote: string }) => read(params.remote) } },
    cap: { run: { mutate: (params: unknown) => write(params) } },
  },
}))

function Choice({ name = 'choice', sender = null }: { name?: string; sender?: string | null }) {
  const policy = useRemoteContent({ key: 'same-message', sender })
  const setAll = useSetAllSenderImages()
  const [error, setError] = useState(false)
  const save = async (enabled: boolean) => {
    setError(false)
    try {
      await setAll(enabled)
    } catch {
      setError(true)
    }
  }
  return (
    <section aria-label={name}>
      <output aria-label={`${name} allowed`}>{String(policy.allowed)}</output>
      <button type="button" disabled={policy.pending} onClick={() => void save(true)}>
        Enable {name}
      </button>
      <button type="button" disabled={policy.pending} onClick={() => void save(false)}>
        Disable {name}
      </button>
      {error && <span role="status">Save failed</span>}
    </section>
  )
}

beforeEach(() => {
  disk.clear()
  disk.set(A, { imagesFromAllSenders: false, imageSenders: [] })
  disk.set(B, { imagesFromAllSenders: false, imageSenders: [] })
  read.mockReset().mockImplementation(async (remote: string) => settings(remote))
  write
    .mockReset()
    .mockImplementation(async ({ remote, paramsJson }: { remote: string; paramsJson: string }) => {
      const { enabled } = JSON.parse(paramsJson)
      disk.set(remote, { ...disk.get(remote)!, imagesFromAllSenders: enabled })
      return { ok: true }
    })
})

async function mount(sender: string | null = null) {
  const store = createStore()
  store.set(activeRemoteAtom, A)
  await store.set(loadVaultSettingsAtom, { force: true })
  const view = render(
    <Provider store={store}>
      <Choice sender={sender} />
    </Provider>,
  )
  return { store, ...view }
}

const allowed = () => screen.getByLabelText('choice allowed')

test('authoritative false-true-false settings never resurrect an earlier grant', async () => {
  const { store } = await mount()
  const user = userEvent.setup()
  expect(allowed()).toHaveTextContent('false')
  await user.click(screen.getByRole('button', { name: 'Enable choice' }))
  await waitFor(() => expect(allowed()).toHaveTextContent('true'))
  disk.set(A, { imagesFromAllSenders: false, imageSenders: [] })
  await act(async () => {
    await store.set(loadVaultSettingsAtom, { force: true })
  })
  expect(allowed()).toHaveTextContent('false')
  await act(async () => {
    await store.set(loadVaultSettingsAtom, { force: true })
  })
  expect(allowed()).toHaveTextContent('false')
})

test('unknown senders retain persisted opt-in after a fresh store and settings reload', async () => {
  const view = await mount()
  await userEvent.click(screen.getByRole('button', { name: 'Enable choice' }))
  await waitFor(() => expect(allowed()).toHaveTextContent('true'))
  view.unmount()
  await mount(null)
  expect(allowed()).toHaveTextContent('true')
})

test('disabling global loading preserves separately trusted senders', async () => {
  disk.set(A, { imagesFromAllSenders: true, imageSenders: ['friend@example.com'] })
  const { store } = await mount('friend@example.com')
  await userEvent.click(screen.getByRole('button', { name: 'Disable choice' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Enable choice' })).toBeEnabled())
  expect(allowed()).toHaveTextContent('true')
  expect(disk.get(A)).toEqual({ imagesFromAllSenders: false, imageSenders: ['friend@example.com'] })
  act(() => store.set(activeRemoteAtom, B))
  expect(allowed()).toHaveTextContent('false')
})

test('a returned vault stays blocked while its new authoritative settings are loading', async () => {
  disk.set(A, { imagesFromAllSenders: true, imageSenders: [] })
  const { store } = await mount()
  act(() => store.set(activeRemoteAtom, B))
  await act(async () => {
    await store.set(loadVaultSettingsAtom, { force: true })
  })
  act(() => store.set(activeRemoteAtom, A))
  expect(allowed()).toHaveTextContent('false')
  disk.set(A, { imagesFromAllSenders: false, imageSenders: [] })
  await act(async () => {
    await store.set(loadVaultSettingsAtom, { force: true })
  })
  expect(allowed()).toHaveTextContent('false')
})

test('a failed post-write settings refresh stays blocked and exposes failure until retry', async () => {
  await mount()
  read.mockRejectedValueOnce(new Error('read failed'))
  await userEvent.click(screen.getByRole('button', { name: 'Enable choice' }))
  expect(await screen.findByText('Save failed')).toBeInTheDocument()
  expect(allowed()).toHaveTextContent('false')
  await userEvent.click(screen.getByRole('button', { name: 'Enable choice' }))
  await waitFor(() => expect(allowed()).toHaveTextContent('true'))
})

test('a late write response cannot override a newer authoritative revocation', async () => {
  let finish!: (value: { ok: true }) => void
  write.mockImplementationOnce(({ remote }: { remote: string }) => {
    disk.set(remote, { imagesFromAllSenders: true, imageSenders: [] })
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const { store } = await mount()
  await userEvent.click(screen.getByRole('button', { name: 'Enable choice' }))
  disk.set(A, { imagesFromAllSenders: false, imageSenders: [] })
  await act(async () => {
    await store.set(loadVaultSettingsAtom, { force: true })
  })
  await act(async () => finish({ ok: true }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Enable choice' })).toBeEnabled())
  expect(allowed()).toHaveTextContent('false')
})

test('independent stores and overlapping settings reads do not cancel one another', async () => {
  let finish!: (value: ReturnType<typeof settings>) => void
  const first = createStore()
  const second = createStore()
  first.set(activeRemoteAtom, A)
  second.set(activeRemoteAtom, B)
  disk.set(A, { imagesFromAllSenders: true, imageSenders: [] })
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = first.set(loadVaultSettingsAtom, { force: true })
  await second.set(loadVaultSettingsAtom, { force: true })
  finish(settings(A))
  await pending
  render(
    <Provider store={first}>
      <Choice />
    </Provider>,
  )
  expect(allowed()).toHaveTextContent('true')
})
