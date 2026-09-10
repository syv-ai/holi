/**
 * Signing out, which is the one destructive control in the settings tab.
 *
 * Also untested in the legacy panel it came from. The thing worth pinning is
 * FR-15's promise: signing out drops the credential, the clones survive unless
 * you say otherwise, and if saying otherwise would discard commits that never
 * reached the remote you are told before you do it.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { AccountSection } from '../AccountSection'
import { sessionAtom } from '@/state/session'

const unpushed = vi.fn()
const signOut = vi.fn()
const deleteClones = vi.fn()

// The real `signOutAtom` is exercised, not stubbed: `store.set` on a write-only
// atom INVOKES its writer rather than replacing it, and the two calls that
// writer makes are exactly what this section is responsible for reaching.
vi.mock('@/lib/trpc', () => ({
  trpc: {
    auth: { signOut: { mutate: () => signOut() } },
    vaults: {
      unpushed: { query: () => unpushed() },
      deleteClones: { mutate: () => deleteClones() },
    },
  },
}))

/**
 * A user that will click inside an open dialog.
 *
 * **`pointerEventsCheck` off, and only here.** Radix marks the page inert while
 * a modal is open by putting `pointer-events: none` on `body` and restoring
 * `auto` on the dialog content. jsdom resolves the first and not the second, so
 * user-event walks up from a button that is genuinely clickable in the real app,
 * finds BODY, and refuses. This is the first test in the repo that clicks a
 * control inside a dialog, which is why nothing had hit it before. The check is
 * disabled for the file rather than globally: everywhere else it is a real
 * guard against clicking something inert.
 */
const user = userEvent.setup({ pointerEventsCheck: 0 })

function setup() {
  const store = createStore()
  store.set(sessionAtom, { login: 'ada' } as never)
  return render(
    <Provider store={store}>
      <AccountSection />
    </Provider>,
  )
}

beforeEach(() => {
  unpushed.mockReset()
  unpushed.mockResolvedValue([])
  signOut.mockReset()
  signOut.mockResolvedValue(undefined)
  deleteClones.mockReset()
  deleteClones.mockResolvedValue(undefined)
})

test('names who you are signed in as', () => {
  setup()
  expect(screen.getByRole('button', { name: 'ada' })).toBeInTheDocument()
})

test('signing out is confirmed, and keeps the clones unless you say otherwise', async () => {
  setup()
  await user.click(screen.getByRole('button', { name: 'Sign out' }))

  const dialog = await screen.findByRole('dialog')
  expect(dialog).toHaveTextContent('Your local clones stay on disk')
  expect(screen.getByRole('checkbox')).not.toBeChecked()

  await user.click(within(dialog).getByRole('button', { name: 'Sign out' }))
  await waitFor(() => expect(signOut).toHaveBeenCalled())
  // The clones are a separate, deliberate act (FR-15).
  expect(deleteClones).not.toHaveBeenCalled()
})

test('ticking the box is what deletes the clones', async () => {
  setup()
  await user.click(screen.getByRole('button', { name: 'Sign out' }))
  const dialog = await screen.findByRole('dialog')
  await user.click(within(dialog).getByRole('checkbox'))
  await user.click(within(dialog).getByRole('button', { name: 'Sign out' }))
  await waitFor(() => expect(deleteClones).toHaveBeenCalled())
  // Trashed BEFORE the keychain goes, so even a private vault can be restored.
  expect(signOut).toHaveBeenCalled()
})

test('warns before deleting clones that hold unpushed work', async () => {
  // Advisory rather than blocking — the Trash makes it recoverable — but it has
  // to be said, because the commits exist nowhere else.
  unpushed.mockResolvedValue([{ remote: 'syv-ai/holi', ahead: 3 }])
  setup()
  await user.click(screen.getByRole('button', { name: 'Sign out' }))

  await waitFor(() =>
    expect(screen.getByText(/syv-ai\/holi has 3 unpushed commits/)).toBeInTheDocument(),
  )
})

test('a cancel signs nobody out', async () => {
  setup()
  await user.click(screen.getByRole('button', { name: 'Sign out' }))
  await user.click(await screen.findByRole('button', { name: 'Cancel' }))
  expect(signOut).not.toHaveBeenCalled()
})
