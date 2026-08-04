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
import { useEffect } from 'react'
import type { GoogleAccount } from '../../../main/google/session'
import { trpc } from '../lib/trpc'

export type { GoogleAccount }

/** `undefined` — not asked yet. `null` — asked, nothing connected. */
export const googleAccountAtom = atom<GoogleAccount | null | undefined>(undefined)

/**
 * Read the account, asking main the first time anyone does.
 *
 * The fetch is guarded on the atom rather than on a ref, so several components
 * mounting at once still produce one query — the first write moves every reader
 * out of `undefined` before the others' effects run.
 */
export function useGoogleAccount() {
  const [account, setAccount] = useAtom(googleAccountAtom)

  useEffect(() => {
    if (account !== undefined) return
    void trpc.google.status
      .query()
      .then((status) => setAccount(status.account))
      // The connector refuses outright when it is not configured. That is a
      // normal state and not one the user can act on, so it reads as "not
      // connected" — and settles, rather than re-querying on every render.
      .catch(() => setAccount(null))
  }, [account, setAccount])

  return [account, setAccount] as const
}
