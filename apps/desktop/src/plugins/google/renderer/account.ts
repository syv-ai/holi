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
import { activeRemoteAtom } from '@/plugin-api'
import { googleCap } from './google-cap'
import type { GoogleAccount } from '../main/session'

export type { GoogleAccount }

/** An account connected on this machine, as the picker needs it. */
interface ConnectedGoogleAccount {
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
  /** Google refused this vault's grant, and it has neither connected again
   *  nor let go. */
  needsReconnect: boolean
  /** Every account connected on this machine: an account can be connected
   *  and used by no vault at all, which is what a fresh vault sees. */
  accounts: ConnectedGoogleAccount[]
  /** The account the open vault uses, or null. */
  currentSub: string | null
}

const refreshNonceAtom = atom(0)
const retryTimers = new Set<() => void>()
const lifecycleAtom = atom(0)
lifecycleAtom.onMount = () => () => {
  for (const cancel of retryTimers) cancel()
}
const lastGoodConnections = new Map<string, Connection>()

const retryDelays = [250, 1_000]

/**
 * Ask main again: after a connect, a disconnect or a change of account.
 * @public exported for its test
 */
export const refreshGoogleAtom = atom(null, (_get, set) => set(refreshNonceAtom, (n) => n + 1))

const connectionAtom = atom(async (get, { signal }): Promise<Connection | undefined> => {
  const remote = get(activeRemoteAtom)
  get(refreshNonceAtom)
  get(lifecycleAtom)
  const none: Connection = {
    remote,
    account: null,
    missingScopes: [],
    needsReconnect: false,
    accounts: [],
    currentSub: null,
  }
  if (remote === null) return none
  for (let attempt = 0; ; attempt += 1) {
    try {
      const [status, connected] = await Promise.all([
        googleCap.status(remote),
        googleCap.allAccounts(remote),
      ])
      if (signal.aborted) return undefined
      const connection: Connection = {
        remote,
        account: status.account,
        missingScopes: status.missingScopes,
        needsReconnect: status.needsReconnect === true,
        accounts: connected.accounts,
        currentSub: connected.current,
      }
      lastGoodConnections.set(remote, connection)
      return connection
    } catch {
      if (signal.aborted) return undefined
      const delay = retryDelays[attempt]
      if (delay === undefined || !(await waitForRetry(delay, signal))) {
        return lastGoodConnections.get(remote)
      }
    }
  }
})

function waitForRetry(delay: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (shouldRetry: boolean) => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      retryTimers.delete(onAbort)
      resolve(shouldRetry)
    }
    const onAbort = () => finish(false)
    const timeout = setTimeout(() => finish(true), delay)
    retryTimers.add(onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

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
const googleAccountAtom = atom(
  (get): GoogleAccount | null | undefined => get(currentConnectionAtom)?.account,
)

/** Mail and the agenda show once Google is connected; "not asked yet" hides
 *  them too, so they never flash in. */
export const googleConnectedAtom = atom((get) => get(googleAccountAtom) != null)

export interface GoogleAccountState {
  /** `undefined`: not asked yet. `null`: asked, nothing connected. */
  account: GoogleAccount | null | undefined
  missingScopes: string[]
  needsReconnect: boolean
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
    needsReconnect: connection?.needsReconnect ?? false,
    accounts: connection?.accounts ?? [],
    currentSub: connection?.currentSub ?? null,
    refresh,
  }
}
