/**
 * The documents a thread's messages are actually rendered into.
 *
 * A mail body lives in its own sandboxed frame, so "find in this thread" needs
 * the frames' `Document`s, which are created three components below the search.
 * A frame publishes its document here on write and withdraws it on cleanup.
 * **Order is not this module's business**: the caller looks each message up by
 * id, so results follow the conversation rather than mount order.
 *
 * **The frame is same-origin and carries no `allow-scripts`**: reaching into
 * its document is the app's own script touching an inert page, as
 * `SandboxedHtml` already does. Nothing here widens what the frame can do.
 *
 * A version counter rather than a snapshot of the map: the documents are
 * mutable, so subscribers re-read the registry when the version moves.
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
 * Withdrawal is conditional on still being the registered document: a replaced
 * frame ("load images", since a document cannot shed a CSP) runs the new effect
 * before React runs the old cleanup, so an unconditional delete would remove the
 * *new* document.
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
 * A number that changes whenever the set of live frame documents does: a signal
 * to re-read the registry. It lets a search survive a frame being rebuilt
 * underneath it (unblocking images or switching theme rewrites the document).
 */
export function useMailFrameVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  )
}

/** Back to an empty registry, for a test: this is module state the whole suite
 *  shares. */
export function resetMailFramesForTests(): void {
  frames.clear()
  announce()
}
