/**
 * Who is allowed to know you opened their mail.
 *
 * Remote content is blocked by default and stays that way — an image fetched
 * from a sender's server is a read receipt nobody agreed to. What lives here is
 * the two ways a user says otherwise, and they are deliberately different
 * promises with different lifetimes:
 *
 * - **This message** — remembered for as long as the app is running, and no
 *   longer. It answers "show me this one", which has no business surviving a
 *   restart. Held in an atom rather than in the component, because the reader
 *   unmounts every time a thread is closed and the choice was being lost on the
 *   way out: reopening a message you had just unblocked put the banner straight
 *   back.
 * - **This sender, always** — persisted in main (`google/image-prefs.ts`) and
 *   applied to every message from that address, forever. It answers "I do not
 *   mind telling Jane", which would be worthless if it evaporated.
 *
 * Offering only the first makes the user re-decide the same newsletter weekly;
 * offering only the second makes a one-off peek into a standing disclosure.
 * Both, or the affordance is dishonest.
 *
 * **`undefined` means "not asked yet"**, exactly as in [[state/google]] — the
 * banner must not flash for a sender that is already allowed while the query is
 * in flight.
 */
import { atom, getDefaultStore, useAtom, useSetAtom } from 'jotai'
import { useCallback, useEffect } from 'react'
import { trpc } from '../lib/trpc'

/** Message keys unblocked this session. A `ReadonlySet` replaced wholesale, so
 *  a mutation cannot fail to notify. */
const unblockedMessagesAtom = atom<ReadonlySet<string>>(new Set<string>())

/** Lowercased sender addresses whose images always load. `undefined` until main
 *  has answered. */
const alwaysAllowedSendersAtom = atom<ReadonlySet<string> | undefined>(undefined)

/** Identifies a block of HTML for the purposes of remembering a choice. */
export interface RemoteContentIdentity {
  /** Stable for the life of the message — a Gmail message id. Blocks with no
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
 * still produce one query — the first write moves every reader out of
 * `undefined` before the others' effects run.
 */
export function useAlwaysAllowedSenders(): ReadonlySet<string> | undefined {
  const [senders, setSenders] = useAtom(alwaysAllowedSendersAtom)

  useEffect(() => {
    if (senders !== undefined) return
    void trpc.google.imageSenders
      .query()
      .then((list) => setSenders(new Set(list)))
      // Not configured, or a read that failed. Blocking is the safe direction
      // to fail in, and an empty set settles rather than re-querying forever.
      .catch(() => setSenders(new Set<string>()))
  }, [senders, setSenders])

  return senders
}

/** Forget every standing exception. Settings owns the affordance; this owns the
 *  atom, so the UI updates without a refetch. */
export function useForgetImageSenders(): () => Promise<void> {
  const setSenders = useSetAtom(alwaysAllowedSendersAtom)
  return useCallback(async () => {
    await trpc.google.forgetImageSenders.mutate().catch(() => undefined)
    setSenders(new Set<string>())
  }, [setSenders])
}

/** Whether this block's remote content may load, and the two ways to say yes. */
export function useRemoteContent(identity: RemoteContentIdentity): RemoteContentChoice {
  const [unblocked, setUnblocked] = useAtom(unblockedMessagesAtom)
  const senders = useAlwaysAllowedSenders()
  const setSenders = useSetAtom(alwaysAllowedSendersAtom)

  const { key, sender } = identity
  const normalisedSender = sender === null || sender === '' ? null : sender.toLowerCase()

  const allowed =
    (key !== null && unblocked.has(key)) ||
    (normalisedSender !== null && senders?.has(normalisedSender) === true)

  const allowOnce = useCallback(() => {
    // A block with no key still unblocks — it simply has nothing to remember
    // it by, so the local fallback in the component carries it.
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
    void trpc.google.allowImagesFrom.mutate({ sender: normalisedSender }).catch(() => undefined)
  }, [normalisedSender, key, setSenders, setUnblocked])

  return { allowed, sender: normalisedSender, allowOnce, allowSenderAlways }
}

/**
 * Back to "nothing is allowed", for a test.
 *
 * These atoms are module state on jotai's default store, which a suite shares
 * across every test in a file — so a test that unblocks a message would
 * otherwise hand the next one a message that is already unblocked, and the
 * banner assertions would pass or fail depending on the order they ran in.
 *
 * `alwaysAllowedSenders` goes back to `undefined` rather than to an empty set,
 * because "not asked yet" is a distinct state and a test that never re-queries
 * should see the same first render the app does.
 */
export function resetMailImagesForTests(): void {
  const store = getDefaultStore()
  store.set(unblockedMessagesAtom, new Set<string>())
  store.set(alwaysAllowedSendersAtom, undefined)
}
