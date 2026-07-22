/**
 * Every editor buffer that might have unsaved text in it.
 *
 * FR-6's flush points are a flush *then* a commit, and main can only commit
 * what is on disk. Main asks once, at quit, and waits one second — so the
 * answer has to cover every open buffer, not whichever pane happens to be
 * mounted. A registry makes "write every dirty buffer" a statement about all of
 * them rather than a hope about one.
 *
 * It also has to answer when there are **no** buffers at all — a window on the
 * sign-in screen still gets asked, and silence there costs a second on every
 * quit for nothing.
 */

type Flusher = () => Promise<void>

const flushers = new Set<Flusher>()

/** Register a buffer's writer. Returns the deregistration. */
export function registerBuffer(flush: Flusher): () => void {
  flushers.add(flush)
  return () => void flushers.delete(flush)
}

/**
 * Write every dirty buffer.
 *
 * Never rejects. A failed write must not stop the others, and must not stop the
 * ack: main quits after a second either way, so a throw here would turn one
 * unwritable file into a one-second pause on every quit and no explanation.
 */
export async function flushAllBuffers(): Promise<void> {
  await Promise.all(
    [...flushers].map((flush) =>
      flush().catch((err: unknown) => console.error('[flush] buffer failed:', err)),
    ),
  )
}
