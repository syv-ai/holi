import { render, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { expect, test, vi } from 'vitest'
import { initialStatus } from '../../../../../main/updates/state'
import { updateStatusAtom } from '@/state/updates'
import { UpdatesSection } from '../UpdatesSection'

const setChannel = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    updates: { setChannel: { mutate: (input: unknown) => setChannel(input) } },
    app: { loginItem: { query: async () => ({ openAtLogin: false }) } },
  },
}))

test('turning off dev prereleases selects stable even when its version is older', async () => {
  const store = createStore()
  const status = initialStatus({
    supported: true,
    enabled: false,
    version: '0.1.2-dev.4',
    channel: 'dev',
  })
  store.set(updateStatusAtom, status)
  setChannel.mockResolvedValue({ ...status, channel: 'stable', state: 'checking' })

  render(
    <Provider store={store}>
      <UpdatesSection />
    </Provider>,
  )
  const checkbox = screen.getByRole('checkbox', { name: 'Dev prereleases' })
  expect(checkbox).toBeChecked()
  expect(
    screen.getByText(/downloads the latest stable release, even if it is older/),
  ).toBeInTheDocument()
  await userEvent.click(checkbox)
  expect(setChannel).toHaveBeenCalledWith({ channel: 'stable' })
  expect(checkbox).not.toBeChecked()
})
