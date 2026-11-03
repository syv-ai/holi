/**
 * Every editor buffer that might have unsaved text in it.
 *
 * Main commits only what is on disk, and at quit asks once and waits one
 * second, so the flush must cover every open buffer, not whichever pane is
 * mounted. It must answer with no buffers too (the sign-in screen), or every
 * quit waits a second.
 */

type Flusher = () => Promise<void>

/** Each buffer's writer: unconditional (quit, blur, tab close), since losing
 *  keystrokes is worse than briefly invalid syntax. */
const buffers = new Set<Flusher>()

/**
 * Register a buffer's writer. Returns the deregistration.
 * @public exported for its test
 */
export function registerBuffer(flush: Flusher): () => void {
  buffers.add(flush)
  return () => void buffers.delete(flush)
}

/**
 * Write every dirty buffer.
 *
 * Never rejects: a failed write must not stop the others or the ack.
 */
export async function flushAllBuffers(): Promise<void> {
  await Promise.all(
    [...buffers].map((flush) =>
      flush().catch((err: unknown) => console.error('[flush] buffer failed:', err)),
    ),
  )
}
