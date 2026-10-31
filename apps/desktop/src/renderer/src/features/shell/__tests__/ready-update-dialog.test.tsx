import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { createStore, Provider } from 'jotai'
import { afterEach, describe, expect, test } from 'vitest'
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

afterEach(() => {
  window.localStorage.clear()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
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

  test('waits until the window is visible and does not prompt after a download failure', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const store = mount()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    store.set(updateStatusAtom, { ...ready, state: 'available', lastError: 'download failed' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
