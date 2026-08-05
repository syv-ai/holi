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
import { atom, useAtom } from 'jotai'
import { useCallback, useEffect } from 'react'
import type { GoogleAccount } from '../../../main/google/session'
import { trpc } from '../lib/trpc'

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

export interface GoogleAccountState {
  /** `undefined` — not asked yet. `null` — asked, nothing connected. */
  account: GoogleAccount | null | undefined
  setAccount: (account: GoogleAccount | null | undefined) => void
  missingScopes: string[]
  /** Re-read both halves from main. */
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
      const status = await trpc.google.status.query()
      setAccount(status.account)
      setMissingScopes(status.missingScopes)
    } catch {
      // The connector refuses outright when it is not configured. That is a
      // normal state and not one the user can act on, so it reads as "not
      // connected" — and settles, rather than re-querying on every render.
      setAccount(null)
      setMissingScopes([])
    }
  }, [setAccount, setMissingScopes])

  useEffect(() => {
    if (account !== undefined) return
    void refresh()
  }, [account, refresh])

  return { account, setAccount, missingScopes, refresh }
}
