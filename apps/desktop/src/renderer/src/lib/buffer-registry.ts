/**
 * Every editor buffer that might have unsaved text in it.
 *
 * Main commits only what is on disk, and at quit asks once and waits one
 * second, so the flush must cover every open buffer, not whichever pane is
 * mounted. It must answer with no buffers too (the sign-in screen), or every
 * quit waits a second.
 */

type Flusher = () => Promise<void>

/** The two ways a buffer can be asked to write itself. */
interface Buffer {
  /** Unconditional (quit, blur, tab close): losing keystrokes is worse than
   *  briefly invalid syntax. */
  flush: Flusher
  /** Gated (⌘S): holds off while syntax is broken, so a half-typed `tags: [`
   *  is never the saved state. */
  save: Flusher
}

const buffers = new Set<Buffer>()

/** Register a buffer's writers. Returns the deregistration. */
export function registerBuffer(flush: Flusher, save: Flusher = flush): () => void {
  const entry: Buffer = { flush, save }
  buffers.add(entry)
  return () => void buffers.delete(entry)
}

/**
 * Write every dirty buffer.
 *
 * Never rejects: a failed write must not stop the others or the ack.
 */
export async function flushAllBuffers(): Promise<void> {
  await writeAll((b) => b.flush, 'flush')
}

/**
 * Write every buffer willing to be written, for ⌘S: every pane's work, not
 * just the focused one.
 */
export async function saveAllBuffers(): Promise<void> {
  await writeAll((b) => b.save, 'save')
}

async function writeAll(pick: (b: Buffer) => Flusher, what: string): Promise<void> {
  await Promise.all(
    [...buffers].map((b) =>
      pick(b)().catch((err: unknown) => console.error(`[${what}] buffer failed:`, err)),
    ),
  )
}
