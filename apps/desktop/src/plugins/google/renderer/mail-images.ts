/**
 * Who is allowed to know you opened their mail.
 *
 * Remote content is blocked by default: an image fetched from a sender's server
 * is a read receipt nobody agreed to. The two ways to say otherwise are
 * deliberately different promises:
 *
 * - **This message**: remembered while the app runs, and no longer. Held in an
 *   atom rather than the component, because the reader unmounts every time a
 *   thread is closed.
 * - **This sender, always**: kept in the vault's local Google settings and
 *   applied to every message from that address.
 *
 * **`undefined` means "not asked yet"**, as in `account.ts`: the banner
 * must not flash for an already-allowed sender while the query is in flight.
 */
import { atom, getDefaultStore, useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect } from 'react'
import { googleCap } from './account'
import { activeRemoteAtom } from '@/plugin-api'

/** Message keys unblocked this session. A `ReadonlySet` replaced wholesale, so
 *  a mutation cannot fail to notify. */
const unblockedMessagesAtom = atom<ReadonlySet<string>>(new Set<string>())

/** Lowercased sender addresses whose images always load. `undefined` until main
 *  has answered. */
const alwaysAllowedSendersAtom = atom<ReadonlySet<string> | undefined>(undefined)

/** Identifies a block of HTML for the purposes of remembering a choice. */
export interface RemoteContentIdentity {
  /** Stable for the life of the message: a Gmail message id. Blocks with no
   *  stable identity (a calendar description) pass `null`, and their choice
   *  then lasts only as long as they are mounted. */
  key: string | null
  /** Whose images these are. `null` when there is nobody to attribute them to,
   *  which is what hides the "always" offer rather than showing one that would
   *  store an empty address. */
  sender: string | null
}

export interface RemoteContentChoice {
  /** Load remote content for this block now. */
  allowed: boolean
  /** Named so the caller cannot offer "always" for a block with no sender. */
  sender: string | null
  allowOnce: () => void
  allowSenderAlways: () => void
}

/**
 * The standing exceptions, read once per session.
 *
 * Guarded on the atom rather than a ref, so several messages rendering at once
 * still produce one query.
 */
export function useAlwaysAllowedSenders(): ReadonlySet<string> | undefined {
  const [senders, setSenders] = useAtom(alwaysAllowedSendersAtom)
  const remote = useAtomValue(activeRemoteAtom)

  useEffect(() => {
    // Kept per machine, but every UI-door call names a vault.
    if (senders !== undefined || remote === null) return
    void googleCap
      .imageSenders(remote)
      .then((list) => setSenders(new Set(list)))
      // Not configured, or a read that failed. Blocking is the safe direction
      // to fail in, and an empty set settles rather than re-querying forever.
      .catch(() => setSenders(new Set<string>()))
  }, [senders, setSenders, remote])

  return senders
}

/** Forget every standing exception. Settings owns the affordance; this owns the
 *  atom, so the UI updates without a refetch. */
export function useForgetImageSenders(): () => Promise<void> {
  const setSenders = useSetAtom(alwaysAllowedSendersAtom)
  const remote = useAtomValue(activeRemoteAtom)
  return useCallback(async () => {
    if (remote !== null) await googleCap.forgetImageSenders(remote).catch(() => undefined)
    setSenders(new Set<string>())
  }, [setSenders, remote])
}

/** Whether this block's remote content may load, and the two ways to say yes. */
export function useRemoteContent(identity: RemoteContentIdentity): RemoteContentChoice {
  const [unblocked, setUnblocked] = useAtom(unblockedMessagesAtom)
  const senders = useAlwaysAllowedSenders()
  const setSenders = useSetAtom(alwaysAllowedSendersAtom)
  const remote = useAtomValue(activeRemoteAtom)

  const { key, sender } = identity
  const normalisedSender = sender === null || sender === '' ? null : sender.toLowerCase()

  const allowed =
    (key !== null && unblocked.has(key)) ||
    (normalisedSender !== null && senders?.has(normalisedSender) === true)

  const allowOnce = useCallback(() => {
    // A block with no key still unblocks: the local fallback in the component
    // carries it.
    if (key === null) return
    setUnblocked((previous) => new Set(previous).add(key))
  }, [key, setUnblocked])

  const allowSenderAlways = useCallback(() => {
    if (normalisedSender === null) return
    // Painted first: the write goes to disk and the banner must not sit there
    // looking unclicked while it does. A failure leaves the session-level
    // unblock below in place, so the images the user asked for still load.
    setSenders((previous) => new Set(previous ?? []).add(normalisedSender))
    if (key !== null) setUnblocked((previous) => new Set(previous).add(key))
    if (remote !== null) {
      void googleCap.allowImagesFrom(remote, { sender: normalisedSender }).catch(() => undefined)
    }
  }, [normalisedSender, key, setSenders, setUnblocked, remote])

  return { allowed, sender: normalisedSender, allowOnce, allowSenderAlways }
}

/**
 * Back to "nothing is allowed", for a test.
 *
 * These atoms are module state on jotai's default store, shared across every
 * test in a file. `alwaysAllowedSenders` goes back to `undefined`, not an empty
 * set, so a test sees the same first render the app does.
 */
export function resetMailImagesForTests(): void {
  const store = getDefaultStore()
  store.set(unblockedMessagesAtom, new Set<string>())
  store.set(alwaysAllowedSendersAtom, undefined)
}
