/**
 * Whether a Google account is connected to the open vault, in one place.
 *
 * Settings (where it changes) and the nav menu (which shows Mail and Agenda
 * only once Google is connected) must not disagree about it, so both read
 * these atoms. They are derived from the open vault and a refresh nonce:
 * a vault switch asks again by itself, and so does `refreshGoogleAtom`, which
 * the Connections section sets after every change it makes. A subscriber to
 * the shared atoms owns the request; no particular React hook must be mounted.
 *
 * **Three states, not two.** An undefined account means there is no
 * authoritative answer for this vault yet: the shared subscription has not
 * completed a read, or bounded retries failed (`readError` distinguishes the
 * latter). Without this state the nav menu could not tell "no account" from
 * "no answer", and would flash its items on every launch.
 */
import { atom, useAtomValue, useSetAtom, useStore, type Atom } from 'jotai'
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

interface LifecycleState {
  generation: number
  cancelRequests: Set<() => void>
}

const refreshNonceAtom = atom(0)
const lifecycleAtom = atom<LifecycleState | null>(null)
interface CachedConnection {
  connection: Connection
  request: number
  lifecycle: number
}

// Atom state belongs to each Jotai store, so this preserves only the latest
// successful remote in that store without sharing results across windows.
const lastGoodConnectionAtom = atom<CachedConnection | undefined>(undefined)
lifecycleAtom.onMount = (set) => {
  let mountedState!: LifecycleState
  set((previous) => {
    mountedState = {
      generation: (previous?.generation ?? 0) + 1,
      cancelRequests: new Set(),
    }
    return mountedState
  })
  return () => {
    // The lifecycle state is local to the Jotai store. Its request owners are
    // canceled whether fetching or waiting, without touching another store.
    for (const cancel of mountedState.cancelRequests) cancel()
  }
}

// Initial request plus at most two retries: 250 ms and then 1 second. When
// those three reads fail, Connections exposes Retry; there is no polling.
const retryDelays = [250, 1_000]

/**
 * Ask main again: after a connect, a disconnect or a change of account.
 * @public exported for its test
 */
export const refreshGoogleAtom = atom(null, (_get, set) => set(refreshNonceAtom, (n) => n + 1))

interface ConnectionRead {
  remote: string | null
  connection?: Connection
  request: number
  error: boolean
}

const connectionAtom = atom(
  async (get, { signal, setSelf }): Promise<ConnectionRead> => {
    const remote = get(activeRemoteAtom)
    const request = get(refreshNonceAtom)
    const lifecycle = get(lifecycleAtom)
    const cached = get(lastGoodConnectionAtom)
    if (
      lifecycle !== null &&
      cached?.request === request &&
      cached.lifecycle === lifecycle.generation &&
      cached.connection.remote === remote
    ) {
      return { remote, connection: cached.connection, request, error: false }
    }
    const none: Connection = {
      remote,
      account: null,
      missingScopes: [],
      needsReconnect: false,
      accounts: [],
      currentSub: null,
    }
    if (remote === null) return { remote, connection: none, request, error: false }
    if (lifecycle === null) return { remote, request, error: false }

    const owner = new AbortController()
    const cancel = () => owner.abort()
    lifecycle.cancelRequests.add(cancel)
    const abortOnRefresh = () => owner.abort()
    signal.addEventListener('abort', abortOnRefresh, { once: true })
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const [status, connected] = await Promise.all([
            googleCap.status(remote),
            googleCap.allAccounts(remote),
          ])
          if (owner.signal.aborted || signal.aborted || get(lifecycleAtom) !== lifecycle) {
            return { remote, request, error: false }
          }
          const connection: Connection = {
            remote,
            account: status.account,
            missingScopes: status.missingScopes,
            needsReconnect: status.needsReconnect === true,
            accounts: connected.accounts,
            currentSub: connected.current,
          }
          // Keep the cache in this Jotai store's shared request lifecycle, rather
          // than relying on a mounted React consumer to observe the result.
          setSelf({ cacheConnection: { connection, request, lifecycle: lifecycle.generation } })
          return { remote, connection, request, error: false }
        } catch {
          // An abandoned request belongs to an earlier lifecycle. In particular,
          // do not schedule a retry after its last subscriber has gone away.
          if (owner.signal.aborted || signal.aborted || get(lifecycleAtom) !== lifecycle) {
            return { remote, request, error: false }
          }
          const delay = retryDelays[attempt]
          if (delay === undefined || !(await waitForRetry(delay, owner.signal))) {
            if (owner.signal.aborted || signal.aborted || get(lifecycleAtom) !== lifecycle) {
              return { remote, request, error: false }
            }
            const lastGood = get(lastGoodConnectionAtom)?.connection
            return {
              remote,
              connection: lastGood?.remote === remote ? lastGood : undefined,
              request,
              error: true,
            }
          }
        }
      }
    } finally {
      signal.removeEventListener('abort', abortOnRefresh)
      lifecycle.cancelRequests.delete(cancel)
    }
  },
  (_get, set, action: { cacheConnection: CachedConnection }) => {
    set(lastGoodConnectionAtom, action.cacheConnection)
  },
)

function waitForRetry(delay: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (shouldRetry: boolean) => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      resolve(shouldRetry)
    }
    const onAbort = () => finish(false)
    const timeout = setTimeout(() => finish(true), delay)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/** The last answer while a refresh is in flight, so a refresh never flashes
 *  the nav menu's items away; `undefined` before the first. */
const heldConnectionReadAtom = unwrap(
  connectionAtom as unknown as Atom<Promise<ConnectionRead>>,
  (previous) => previous,
)

/** The held answer, if it is for the open vault: another vault's answer is
 *  not this one's, so a switch reads as "not asked yet" until it lands. */
const currentConnectionReadAtom = atom((get): ConnectionRead | undefined => {
  const held = get(heldConnectionReadAtom)
  return held !== undefined && held.remote === get(activeRemoteAtom) ? held : undefined
})

/** `undefined`: not asked yet. `null`: asked, nothing connected. */
const googleAccountAtom = atom(
  (get): GoogleAccount | null | undefined => get(currentConnectionReadAtom)?.connection?.account,
)

/** Mail and the agenda show once Google is connected; "not asked yet" hides
 *  them too, so they never flash in. The shared subscription owns retries and
 *  last-success retention; it does not depend on `useGoogleAccount` mounting. */
export const googleConnectedAtom = atom((get) => get(googleAccountAtom) != null)

export interface GoogleAccountState {
  /** `undefined`: no authoritative answer yet; `null`: confirmed disconnected. */
  account: GoogleAccount | null | undefined
  /** The initial read or an explicit refresh is still in progress. */
  loading: boolean
  /** All bounded reads failed; this is not an authoritative disconnected result. */
  readError: boolean
  missingScopes: string[]
  needsReconnect: boolean
  /** Every account connected on this machine. */
  accounts: ConnectedGoogleAccount[]
  /** The account the open vault uses, or null. */
  currentSub: string | null
  /** Re-read every part from main. */
  refresh: () => void
  refreshAndWait: () => Promise<void>
}

export function useGoogleAccount(): GoogleAccountState {
  const result = useAtomValue(currentConnectionReadAtom)
  const refresh = useSetAtom(refreshGoogleAtom)
  const store = useStore()
  const refreshAndWait = async () => {
    store.set(refreshGoogleAtom)
    await store.get(connectionAtom)
  }
  const request = useAtomValue(refreshNonceAtom)
  const connection = result?.connection
  return {
    account: connection?.account,
    loading:
      result === undefined ||
      result.request !== request ||
      (connection === undefined && !result.error),
    readError: result?.error ?? false,
    missingScopes: connection?.missingScopes ?? [],
    needsReconnect: connection?.needsReconnect ?? false,
    accounts: connection?.accounts ?? [],
    currentSub: connection?.currentSub ?? null,
    refresh,
    refreshAndWait,
  }
}
