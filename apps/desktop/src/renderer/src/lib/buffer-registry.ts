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

/** The two ways a buffer can be asked to write itself. */
interface Buffer {
  /** Unconditional — quit, blur, tab close. Losing keystrokes is worse than a
   *  file with temporarily-invalid syntax. */
  flush: Flusher
  /** Gated — ⌘S. Holds off while the buffer's syntax is broken, so a half-typed
   *  `tags: [` is never the saved (or committed) state. */
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
 * Never rejects. A failed write must not stop the others, and must not stop the
 * ack: main quits after a second either way, so a throw here would turn one
 * unwritable file into a one-second pause on every quit and no explanation.
 */
export async function flushAllBuffers(): Promise<void> {
  await writeAll((b) => b.flush, 'flush')
}

/**
 * Write every buffer that is willing to be written — ⌘S's half.
 *
 * Every buffer, not the focused one: ⌘S means "save my work", and a window with
 * two panes open has two lots of it. A buffer holding off on broken syntax
 * simply does not write, which is the same answer it gives the autosave.
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
