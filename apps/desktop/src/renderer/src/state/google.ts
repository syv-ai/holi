/**
 * Whether a Google account is connected, in one place.
 *
 * Two components need this answer and must not disagree about it: vault
 * settings, which is where it changes, and the shell, which decides whether the
 * agenda and mail chips exist at all (D67 — they are hidden until Google is
 * connected, because a chip that only leads to "connect Google in settings" is
 * a dead end wearing the clothes of a feature).
 *
 * **Three states, not two.** `undefined` means "not asked yet", and it is load
 * bearing: without it the shell cannot tell "no account" from "no answer", and
 * would flash the chips on every launch before hiding them again.
 */
import { atom, useAtom, useAtomValue } from 'jotai'
import { useCallback, useEffect } from 'react'
import type { GoogleAccount } from '../../../main/google/session'
import { trpc } from '../lib/trpc'
import { activeRemoteAtom } from './vaults'

export type { GoogleAccount }

/** `undefined` — not asked yet. `null` — asked, nothing connected. */
export const googleAccountAtom = atom<GoogleAccount | null | undefined>(undefined)

/**
 * Scopes this build needs that the connected grant does not carry.
 *
 * **Connected and insufficient is a real state**, and it is the one a widened
 * `GOOGLE_SCOPES` produces: the stored refresh token keeps working, mail keeps
 * listing, and only the new calls fail. Nothing else in the UI can distinguish
 * that from a bug, so it is held here rather than inferred from a failure.
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
 * Two different facts since D87, and the second is the per-vault one: an account
 * can be connected and used by no vault at all, which is what a fresh vault sees
 * of the account you connected in another.
 */
export const googleAccountsAtom = atom<ConnectedGoogleAccount[]>([])
export const googleCurrentSubAtom = atom<string | null>(null)

/**
 * The vault the held answer was fetched for.
 *
 * Shared rather than per component, and compared rather than assumed: a vault
 * switch has to re-ask, but a second component mounting must not. Resetting on
 * mount instead broke "one query however many readers" — three probes, three
 * queries — which is the property the `undefined` guard below exists to give.
 */
export const googleFetchedForAtom = atom<string | null | undefined>(undefined)

export interface GoogleAccountState {
  /** `undefined` — not asked yet. `null` — asked, nothing connected. */
  account: GoogleAccount | null | undefined
  setAccount: (account: GoogleAccount | null | undefined) => void
  missingScopes: string[]
  /** Every account connected on this machine (D87). */
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
 * mounting at once still produce one query — the first write moves every reader
 * out of `undefined` before the others' effects run.
 *
 * **An object, not a tuple.** It was a tuple while it held two related things;
 * at four it had already produced `const [account, , missingScopes]` in a test,
 * and a positional API whose callers skip slots is one rename away from being
 * silently wrong.
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
   * a reconnect that the user half-completes — approving Gmail and declining
   * contacts — grants an account *and* leaves scopes missing, which is exactly
   * the case a hand-set `[]` would paper over.
   */
  const refresh = useCallback(async () => {
    try {
      const [status, connected] = await Promise.all([
        trpc.google.status.query(),
        trpc.google.accounts.query(),
      ])
      setAccount(status.account)
      setMissingScopes(status.missingScopes)
      setAccounts(connected.accounts)
      setCurrentSub(connected.current)
      setFetchedFor(activeRemote)
    } catch {
      // The connector refuses outright when it is not configured, and so does a
      // vault that is not open yet. Both are normal states the user cannot act
      // on, so they read as "not connected" — and settle, rather than
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
   * A vault switch changes the answer without changing the account (D87).
   *
   * Dropped back to `undefined` rather than re-fetched here, so the query still
   * happens in exactly one place and the shell's chips go through "not asked"
   * rather than flashing the previous vault's answer at the new one.
   *
   * Guarded on the *held* vault rather than on mount: a second reader mounting
   * is not a switch, and resetting for it would re-ask once per component.
   */
  useEffect(() => {
    if (account === undefined) return // already asking
    if (fetchedFor === activeRemote) return // the answer is for this vault
    setAccount(undefined)
  }, [account, fetchedFor, activeRemote, setAccount])

  return { account, setAccount, missingScopes, accounts, currentSub, refresh }
}
