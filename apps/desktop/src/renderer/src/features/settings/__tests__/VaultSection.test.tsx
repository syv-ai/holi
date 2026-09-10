/**
 * What this vault is, and who can see it.
 *
 * The legacy side panel this was ported out of had **no tests at all**, and the
 * two things it owes are exactly the two nothing else in the app says: a vault
 * that has quietly become public, and *which* refusal is hiding the collaborator
 * list. Both were argued for in prose in the panel's own docstrings and pinned
 * by nothing.
 */
import { render, screen, waitFor } from '@/test/render'
import { Provider, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import type { VaultEntry } from '@holi/shared'
import { VaultSection } from '../VaultSection'
import { activeRemoteAtom, vaultsAtom } from '@/state/vaults'

const collaborators = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    github: {
      collaborators: { query: () => collaborators() },
      openCollaboratorSettings: { mutate: vi.fn() },
    },
  },
}))

const REMOTE = 'syv-ai/holi'
const ENTRY = {
  remote: REMOTE,
  path: '/Users/ada/Holi/syv-ai/holi',
} as unknown as VaultEntry

function setup() {
  const store = createStore()
  store.set(activeRemoteAtom, REMOTE)
  store.set(vaultsAtom, [ENTRY])
  return render(
    <Provider store={store}>
      <VaultSection />
    </Provider>,
  )
}

beforeEach(() => {
  collaborators.mockReset()
  collaborators.mockResolvedValue({ visibility: 'private', collaborators: [] })
})

test('names the remote a vault IS, and the clone it lives in', async () => {
  // A vault's identity is its remote; the local path is the clone FR-15
  // promises survives a sign-out. Until this section existed neither was
  // written down anywhere in the app.
  setup()
  expect(await screen.findByRole('button', { name: REMOTE })).toBeInTheDocument()
  // Shortened from the managed root, not the full home-directory prefix.
  expect(screen.getByRole('button', { name: 'Holi/syv-ai/holi' })).toBeInTheDocument()
})

test('calls out a vault that is public', async () => {
  // The highest-severity thing that can happen to a vault, and this is the only
  // surface that would ever show it.
  collaborators.mockResolvedValue({ visibility: 'public', collaborators: [] })
  setup()
  await waitFor(() => expect(screen.getByText('public')).toBeInTheDocument())
})

test('lists who has access, at what level', async () => {
  collaborators.mockResolvedValue({
    visibility: 'private',
    collaborators: [
      { accountId: 1, login: 'ada', permission: 'admin' },
      { accountId: 2, login: 'holm', permission: 'push' },
    ],
  })
  setup()
  expect(await screen.findByRole('button', { name: 'ada' })).toBeInTheDocument()
  expect(screen.getByText('admin')).toBeInTheDocument()
  expect(screen.getByText('push')).toBeInTheDocument()
})

test('says WHICH refusal hid the list, rather than showing an empty one', async () => {
  // An empty member list reads as "nobody else has access", which for a 404 on
  // a vault that is not backed by GitHub is a different and wrong statement.
  collaborators.mockRejectedValue(Object.assign(new Error('Not Found'), { data: { code: 'NOT_FOUND' } }))
  setup()
  await waitFor(() =>
    expect(screen.getByText(/isn't backed by GitHub, or your account can't see it/)).toBeInTheDocument(),
  )
})
