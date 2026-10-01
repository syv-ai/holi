/**
 * Whether a Google account is connected, in one place.
 *
 * Settings (where it changes) and the shell (which hides the agenda and mail
 * chips until Google is connected) must not disagree about it.
 *
 * **Three states, not two.** `undefined` means "not asked yet": without it the
 * shell cannot tell "no account" from "no answer", and would flash the chips on
 * every launch.
 */
import { atom, useAtom, useAtomValue } from 'jotai'
import { useCallback, useEffect } from 'react'
// eslint-disable-next-line no-restricted-imports -- until the views move into the Google plugin
import type { GoogleCapabilities } from '../../../plugins/google/main/capabilities'
// eslint-disable-next-line no-restricted-imports -- until the views move into the Google plugin
import type { GoogleAccount } from '../../../plugins/google/main/session'
import { capClient } from '../lib/cap-client'
import { activeRemoteAtom } from './vaults'

export type { GoogleAccount }

/** Google's capabilities at the UI door, each call naming the vault it is for. */
export const googleCap = capClient<GoogleCapabilities>('google')

/** `undefined`: not asked yet. `null`: asked, nothing connected. */
export const googleAccountAtom = atom<GoogleAccount | null | undefined>(undefined)

/**
 * Scopes this build needs that the connected grant does not carry.
 *
 * **Connected and insufficient is a real state**, produced by a widened
 * `GOOGLE_SCOPES`: the stored refresh token keeps working and only the new calls
 * fail. Held here rather than inferred from a failure.
 */
export const googleMissingScopesAtom = atom<string[]>([])

/** An account connected on this machine, as the picker needs it. */
export interface ConnectedGoogleAccount {
  sub: string
  email: string
}

/**
 * Every account connected on this machine, and the one the active vault uses.
 *
 * Two different facts: an account can be connected and used by no vault
 * at all, which is what a fresh vault sees.
 */
export const googleAccountsAtom = atom<ConnectedGoogleAccount[]>([])
export const googleCurrentSubAtom = atom<string | null>(null)

/**
 * The vault the held answer was fetched for.
 *
 * Shared rather than per component, and compared rather than assumed: a vault
 * switch has to re-ask, but a second component mounting must not, or there
 * would be one query per reader.
 */
export const googleFetchedForAtom = atom<string | null | undefined>(undefined)

export interface GoogleAccountState {
  /** `undefined`: not asked yet. `null`: asked, nothing connected. */
  account: GoogleAccount | null | undefined
  setAccount: (account: GoogleAccount | null | undefined) => void
  missingScopes: string[]
  /** Every account connected on this machine. */
  accounts: ConnectedGoogleAccount[]
  /** The account the active vault uses, or null. */
  currentSub: string | null
  /** Re-read every part from main. */
  refresh: () => Promise<void>
}

/**
 * Read the account, asking main the first time anyone does.
 *
 * The fetch is guarded on the atom rather than on a ref, so several components
 * mounting at once still produce one query: the first write moves every reader
 * out of `undefined` before the others' effects run.
 */
export function useGoogleAccount(): GoogleAccountState {
  const [account, setAccount] = useAtom(googleAccountAtom)
  const [missingScopes, setMissingScopes] = useAtom(googleMissingScopesAtom)
  const [accounts, setAccounts] = useAtom(googleAccountsAtom)
  const [currentSub, setCurrentSub] = useAtom(googleCurrentSubAtom)
  const [fetchedFor, setFetchedFor] = useAtom(googleFetchedForAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)

  /**
   * Re-read both halves from main.
   *
   * Used after connect and disconnect rather than assuming what they produced:
   * a half-completed reconnect grants an account *and* leaves scopes missing.
   */
  const refresh = useCallback(async () => {
    try {
      if (activeRemote === null) throw new Error('no vault is open')
      const [status, connected] = await Promise.all([
        googleCap.status(activeRemote),
        googleCap.accounts(activeRemote),
      ])
      setAccount(status.account)
      setMissingScopes(status.missingScopes)
      setAccounts(connected.accounts)
      setCurrentSub(connected.current)
      setFetchedFor(activeRemote)
    } catch {
      // The connector refuses outright when it is not configured, and so does a
      // vault that is not open yet. Both are normal states the user cannot act
      // on, so they read as "not connected" and settle, rather than
      // re-querying on every render.
      setAccount(null)
      setMissingScopes([])
      setAccounts([])
      setCurrentSub(null)
      setFetchedFor(activeRemote)
    }
  }, [activeRemote, setAccount, setMissingScopes, setAccounts, setCurrentSub, setFetchedFor])

  useEffect(() => {
    if (account !== undefined) return
    void refresh()
  }, [account, refresh])

  /**
   * A vault switch changes the answer without changing the account.
   *
   * Dropped back to `undefined` rather than re-fetched here, so the query
   * happens in exactly one place and the chips do not flash the previous vault's
   * answer. Guarded on the *held* vault rather than on mount: a second reader
   * mounting is not a switch.
   */
  useEffect(() => {
    if (account === undefined) return // already asking
    if (fetchedFor === activeRemote) return // the answer is for this vault
    setAccount(undefined)
  }, [account, fetchedFor, activeRemote, setAccount])

  return { account, setAccount, missingScopes, accounts, currentSub, refresh }
}
