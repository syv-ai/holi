/**
 * Whether a Google account is connected to the open vault, in one place.
 *
 * Settings (where it changes) and the nav menu (which shows Mail and Agenda
 * only once Google is connected) must not disagree about it, so both read
 * these atoms. They are derived from the open vault and a refresh nonce:
 * a vault switch asks again by itself, and so does `refreshGoogleAtom`, which
 * the Connections section sets after every change it makes. Nothing has to be
 * mounted for the answer to be asked for.
 *
 * **Three states, not two.** `undefined` means "not asked yet" for this vault:
 * without it the nav menu could not tell "no account" from "no answer", and
 * would flash its items on every launch.
 */
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { unwrap } from 'jotai/utils'
import { activeRemoteAtom, capClient } from '@/plugin-api'
import type { GoogleCapabilities } from '../main/capabilities'
import type { GoogleAccount } from '../main/session'

export type { GoogleAccount }

/** Google's capabilities at the UI door, each call naming the vault it is for. */
export const googleCap = capClient<GoogleCapabilities>('google')

/** An account connected on this machine, as the picker needs it. */
export interface ConnectedGoogleAccount {
  sub: string
  email: string
}

interface Connection {
  /** The vault this answer is for. */
  remote: string | null
  account: GoogleAccount | null
  /**
   * Scopes this build needs that the connected grant does not carry.
   * **Connected and insufficient is a real state**, produced by a widened
   * `GOOGLE_SCOPES`: the stored refresh token keeps working and only the new
   * calls fail.
   */
  missingScopes: string[]
  /** Every account connected on this machine: an account can be connected
   *  and used by no vault at all, which is what a fresh vault sees. */
  accounts: ConnectedGoogleAccount[]
  /** The account the open vault uses, or null. */
  currentSub: string | null
}

const refreshNonceAtom = atom(0)

/** Ask main again: after a connect, a disconnect or a change of account. */
export const refreshGoogleAtom = atom(null, (_get, set) => set(refreshNonceAtom, (n) => n + 1))

const connectionAtom = atom(async (get): Promise<Connection> => {
  const remote = get(activeRemoteAtom)
  get(refreshNonceAtom)
  const none: Connection = {
    remote,
    account: null,
    missingScopes: [],
    accounts: [],
    currentSub: null,
  }
  if (remote === null) return none
  try {
    const [status, connected] = await Promise.all([
      googleCap.status(remote),
      googleCap.accounts(remote),
    ])
    return {
      remote,
      account: status.account,
      missingScopes: status.missingScopes,
      accounts: connected.accounts,
      currentSub: connected.current,
    }
  } catch {
    // A vault Holi cannot resolve, or Google off in it: a normal state the
    // person cannot act on here, so it reads as "not connected" and settles.
    return none
  }
})

/** The last answer while a refresh is in flight, so a refresh never flashes
 *  the nav menu's items away; `undefined` before the first. */
const heldConnectionAtom = unwrap(connectionAtom, (previous) => previous)

/** The held answer, if it is for the open vault: another vault's answer is
 *  not this one's, so a switch reads as "not asked yet" until it lands. */
const currentConnectionAtom = atom((get): Connection | undefined => {
  const held = get(heldConnectionAtom)
  return held !== undefined && held.remote === get(activeRemoteAtom) ? held : undefined
})

/** `undefined`: not asked yet. `null`: asked, nothing connected. */
export const googleAccountAtom = atom(
  (get): GoogleAccount | null | undefined => get(currentConnectionAtom)?.account,
)

/** Mail and the agenda show once Google is connected; "not asked yet" hides
 *  them too, so they never flash in. */
export const googleConnectedAtom = atom((get) => get(googleAccountAtom) != null)

export interface GoogleAccountState {
  /** `undefined`: not asked yet. `null`: asked, nothing connected. */
  account: GoogleAccount | null | undefined
  missingScopes: string[]
  /** Every account connected on this machine. */
  accounts: ConnectedGoogleAccount[]
  /** The account the open vault uses, or null. */
  currentSub: string | null
  /** Re-read every part from main. */
  refresh: () => void
}

export function useGoogleAccount(): GoogleAccountState {
  const connection = useAtomValue(currentConnectionAtom)
  const refresh = useSetAtom(refreshGoogleAtom)
  return {
    account: connection?.account,
    missingScopes: connection?.missingScopes ?? [],
    accounts: connection?.accounts ?? [],
    currentSub: connection?.currentSub ?? null,
    refresh,
  }
}
