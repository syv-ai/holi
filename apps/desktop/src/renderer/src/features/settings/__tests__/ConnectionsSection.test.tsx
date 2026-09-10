/**
 * A vault's Google account is its own (D87).
 *
 * The point of these is the distinction the panel has to make legible: an
 * account connected on this machine, and an account *this vault uses*. Reusing
 * the first as the second is a mapping and no consent, and unlinking a vault is
 * not the same act as removing an account.
 */
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider, createStore } from 'jotai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionsSection } from '../ConnectionsSection'

/** A fresh jotai store per test: the google atoms are module level, so one
 *  case's answer would otherwise still be held when the next one renders. */
const render = () =>
  rtlRender(
    <Provider store={createStore()}>
      <ConnectionsSection />
    </Provider>,
  )

const status = vi.fn()
const accounts = vi.fn()
const useAccount = vi.fn()
const removeAccount = vi.fn()
const disconnectVault = vi.fn()

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    google: {
      status: { query: () => status() },
      accounts: { query: () => accounts() },
      useAccount: { mutate: (input: unknown) => useAccount(input) },
      removeAccount: { mutate: (input: unknown) => removeAccount(input) },
      disconnectVault: { mutate: () => disconnectVault() },
      connect: { mutate: vi.fn() },
      awaitConnect: { mutate: vi.fn() },
      cancelConnect: { mutate: vi.fn() },
      imageSenders: { query: async () => [] },
    },
  },
}))

const ADA = { sub: 'sub-1', email: 'ada@syv.ai' }
const WORK = { sub: 'sub-2', email: 'work@syv.ai' }

beforeEach(() => {
  vi.clearAllMocks()
  status.mockResolvedValue({ account: null, missingScopes: [] })
  accounts.mockResolvedValue({ accounts: [ADA, WORK], current: null })
  // Resolved, not bare: the component chains `.catch` on every mutation, and an
  // undefined return there is an unhandled rejection that still lets the
  // assertion pass — a false green vitest is right to shout about.
  useAccount.mockResolvedValue({ ok: true })
  removeAccount.mockResolvedValue({ ok: true })
  disconnectVault.mockResolvedValue({ ok: true })
})

describe('ConnectionsSection', () => {
  it('offers the accounts already connected here to a vault with none', async () => {
    render()

    expect(await screen.findByText('ada@syv.ai')).toBeInTheDocument()
    expect(screen.getByText('work@syv.ai')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Use in this vault' })).toHaveLength(2)
  })

  it('says plainly "Connect" when there is no account on this machine to differ from', async () => {
    // The label follows the machine list, not this vault's link: offering a
    // "different" account to a first-run user names one they do not have.
    accounts.mockResolvedValue({ accounts: [], current: null })
    render()

    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument()
  })

  it('offers a different account only when this machine already has one', async () => {
    // Accounts exist and this vault uses none: the rows above are the offer, and
    // this button is the escape hatch from them.
    render()

    expect(
      await screen.findByRole('button', { name: 'Connect a different account…' }),
    ).toBeInTheDocument()
  })

  it('reuses an account with one click and no consent round trip', async () => {
    render()
    await screen.findByText('ada@syv.ai')

    await userEvent.click(screen.getAllByRole('button', { name: 'Use in this vault' })[0]!)

    await waitFor(() => expect(useAccount).toHaveBeenCalledWith({ sub: 'sub-1' }))
  })

  it('does not offer the account this vault is already using', async () => {
    accounts.mockResolvedValue({ accounts: [ADA, WORK], current: 'sub-1' })
    status.mockResolvedValue({ account: { email: 'ada@syv.ai' }, missingScopes: [] })
    render()

    expect(await screen.findByText('work@syv.ai')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Use in this vault' })).toHaveLength(1)
  })

  it('unlinks the vault rather than revoking the account', async () => {
    // The two are different acts and the panel must not conflate them: another
    // vault may be using this account.
    accounts.mockResolvedValue({ accounts: [ADA], current: 'sub-1' })
    status.mockResolvedValue({ account: { email: 'ada@syv.ai' }, missingScopes: [] })
    render()

    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect this vault' }))

    await waitFor(() => expect(disconnectVault).toHaveBeenCalled())
    expect(removeAccount).not.toHaveBeenCalled()
  })

  it('removes an account by name when that is what was asked for', async () => {
    render()
    await screen.findByText('ada@syv.ai')

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove from Holi' })[0]!)

    await waitFor(() => expect(removeAccount).toHaveBeenCalledWith({ sub: 'sub-1' }))
  })
})
