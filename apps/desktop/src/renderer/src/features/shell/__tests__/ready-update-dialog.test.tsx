import { act, render, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { createStore, Provider } from 'jotai'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { UpdateStatus } from '../../../../../main/updates/state'
import { updateStatusAtom } from '@/state/updates'
import { ReadyUpdateDialog } from '../ready-update-dialog'

const ready: UpdateStatus = {
  channel: 'stable',
  supported: true,
  enabled: true,
  version: '1.0.0',
  state: 'ready',
  availableVersion: '1.1.0',
  percent: null,
  lastCheckAt: null,
  checkStartedAt: null,
  lastError: null,
}

function mount(status: UpdateStatus = ready) {
  const store = createStore()
  store.set(updateStatusAtom, status)
  render(
    <Provider store={store}>
      <ReadyUpdateDialog />
    </Provider>,
  )
  return store
}

let sendVisibility: (visible: boolean) => void
let nativeVisible = true
const trpc = vi.fn(async () => ({ ok: true as const, data: undefined }))

beforeEach(() => {
  sendVisibility = () => {}
  nativeVisible = true
  trpc.mockClear()
  vi.stubGlobal('holi', {
    trpc,
    window: {
      onVisible: (cb: (visible: boolean) => void) => {
        sendVisibility = cb
        return () => {}
      },
      isVisible: async () => nativeVisible,
    },
  })
})

afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('ReadyUpdateDialog', () => {
  test('shows ready version and saves Later once per version and channel', async () => {
    mount()
    expect(await screen.findByRole('dialog', { name: 'Holi 1.1.0 is ready' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('holi:ready-update-dismissed:stable:1.1.0')).toBe('true')

    mount()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    mount({ ...ready, channel: 'dev' })
    expect(await screen.findByRole('dialog', { name: 'Holi 1.1.0 is ready' })).toBeInTheDocument()
  })

  test('waits for a hidden-at-login native window even when the document is visible', async () => {
    nativeVisible = false
    expect(document.visibilityState).toBe('visible')
    const store = mount()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    sendVisibility(true)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    act(() =>
      store.set(updateStatusAtom, { ...ready, state: 'available', lastError: 'download failed' }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  test('ignores a stale initial visibility answer after a show event', async () => {
    let answer: (visible: boolean) => void = () => {}
    window.holi.window.isVisible = () => new Promise((resolve) => (answer = resolve))
    mount()
    sendVisibility(true)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    answer(false)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  test('Restart now uses the existing guarded install action', async () => {
    mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Restart now' }))
    await waitFor(() =>
      expect(trpc).toHaveBeenCalledWith({
        path: 'updates.install',
        type: 'mutation',
        input: undefined,
      }),
    )
  })

  test('drops a stale ready candidate after changing channels', async () => {
    const store = mount()
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    act(() =>
      store.set(updateStatusAtom, {
        ...ready,
        state: 'checking',
        channel: 'dev',
        availableVersion: null,
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    act(() => store.set(updateStatusAtom, { ...ready, channel: 'dev', availableVersion: '1.2.0' }))
    expect(await screen.findByRole('dialog', { name: 'Holi 1.2.0 is ready' })).toBeInTheDocument()
  })
})
