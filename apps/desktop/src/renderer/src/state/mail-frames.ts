/**
 * The documents a thread's messages are actually rendered into.
 *
 * A mail body lives in its own sandboxed frame ([[mail-frame]]), which is what
 * keeps a stranger's markup out of the app's document — and it is also why
 * "find in this thread" needs a channel that did not exist. The frames are
 * created three components below the thing that wants to search them, and the
 * useful handle is a `Document`, not a React value.
 *
 * So a frame publishes its document here on write and withdraws it on cleanup,
 * and the search reads the registry. **Order is deliberately not this module's
 * business**: the caller walks the thread's messages and looks each one up by
 * id, so the order of results is the order of the conversation rather than
 * whatever order the frames happened to mount in.
 *
 * **The frame is same-origin and carries no `allow-scripts`** — reaching into
 * its document is the app's own script touching an inert page, which is the
 * same thing `SandboxedHtml` already does to size it and to catch link clicks.
 * Nothing here widens what the frame can do.
 *
 * A version counter rather than a snapshot of the map: the documents are
 * mutable objects and a "snapshot" of them would be a lie. Subscribers re-read
 * the registry when the version moves, which is the only honest contract for a
 * store of live DOM handles.
 */
import { useSyncExternalStore } from 'react'

const frames = new Map<string, Document>()
const listeners = new Set<() => void>()
let version = 0

function announce(): void {
  version++
  for (const listener of listeners) listener()
}

/**
 * Publish a frame's document, and hand back the withdrawal.
 *
 * Withdrawal is conditional on still being the registered document: a frame
 * that is replaced — which is exactly what "load images" does, since a document
 * cannot shed a CSP — runs the new effect before React runs the old cleanup, so
 * an unconditional delete would remove the *new* document a moment after it
 * arrived.
 */
export function registerMailFrame(key: string, document_: Document): () => void {
  frames.set(key, document_)
  announce()
  return () => {
    if (frames.get(key) === document_) {
      frames.delete(key)
      announce()
    }
  }
}

export function mailFrameFor(key: string): Document | undefined {
  return frames.get(key)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * A number that changes whenever the set of live frame documents does.
 *
 * The value means nothing on its own — it is a signal to go and read the
 * registry again. It is what makes a search survive a frame being rebuilt
 * underneath it: unblocking images or switching theme rewrites the document,
 * and marks that were in the old one are simply gone.
 */
export function useMailFrameVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  )
}

/**
 * Back to an empty registry, for a test.
 *
 * Module state on a store the whole suite shares, so a test that mounted a
 * message would otherwise hand the next one a document belonging to a component
 * that has since unmounted.
 */
export function resetMailFramesForTests(): void {
  frames.clear()
  announce()
}
