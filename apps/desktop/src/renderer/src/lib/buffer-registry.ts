/**
 * Every editor buffer that might have unsaved text in it.
 *
 * Main commits only what is on disk, so the flush covers every open buffer, not
 * whichever pane is mounted. It answers with no buffers too (the sign-in screen).
 */

type Flusher = () => Promise<void>

/** The two ways a buffer can be asked to write itself. */
interface Buffer {
  /** Unconditional (quit, vault switch, a rename, move or delete): losing
   *  keystrokes is worse than briefly invalid syntax; failures reject flush. */
  flush: Flusher
  /** Gated (⌘S, window blur): holds off while syntax is broken, so a half-typed `tags: [`
   *  is never the saved state. */
  save: Flusher
  freeze?: (frozen: boolean) => void
  frozen: boolean
}

const buffers = new Set<Buffer>()
let freezeDepth = 0

/** Synchronously freeze mounted and subsequently-mounted editors until released. */
export function freezeBuffers(): () => void {
  freezeDepth += 1
  if (freezeDepth === 1) setFrozen(true)
  let released = false
  return () => {
    if (released) return
    released = true
    freezeDepth -= 1
    if (freezeDepth === 0) setFrozen(false)
  }
}

function setFrozen(frozen: boolean): void {
  for (const buffer of buffers) {
    if (buffer.frozen === frozen) continue
    buffer.frozen = frozen
    buffer.freeze?.(frozen)
  }
}

/** Register a buffer's writers. Returns the deregistration. */
export function registerBuffer(
  flush: Flusher,
  save: Flusher = flush,
  freeze?: (frozen: boolean) => void,
): () => void {
  const entry: Buffer = { flush, save, freeze, frozen: false }
  buffers.add(entry)
  if (freezeDepth > 0) {
    entry.frozen = true
    freeze?.(true)
  }
  return () => void buffers.delete(entry)
}

/**
 * Write every dirty buffer.
 *
 * Waits for every buffer and rejects if any write fails, so a caller can stop
 * a destructive lifecycle operation rather than discard dirty text.
 */
export async function flushAllBuffers(): Promise<void> {
  await writeAll((b) => b.flush, 'flush', true)
}

/** Keep editors mounted and stable until closing can preserve their text. */
export async function saveBeforeClosing(close: () => void, rejectErrors = false): Promise<void> {
  const release = freezeBuffers()
  try {
    await flushAllBuffers()
    close()
  } catch (error) {
    console.error('[close] save failed; tab retained:', error)
    if (rejectErrors) throw error
  } finally {
    release()
  }
}

/**
 * Write every buffer willing to be written, for ⌘S: every pane's work, not
 * just the focused one.
 */
/** @public Used by buffer-registry tests to exercise the save policy directly. */
export async function saveAllBuffers(): Promise<void> {
  await writeAll((b) => b.save, 'save')
}

/**
 * Leaving the window saves every buffer, gated: nothing is lost by waiting,
 * and a half-typed settings file written on the way out would be read back
 * as empty. Returns the unsubscribe.
 */
export function saveBuffersOnBlur(target: Window = window): () => void {
  const onBlur = () => void saveAllBuffers()
  target.addEventListener('blur', onBlur)
  return () => target.removeEventListener('blur', onBlur)
}

async function writeAll(
  pick: (b: Buffer) => Flusher,
  what: string,
  rejectErrors = false,
): Promise<void> {
  const results = await Promise.allSettled([...buffers].map(async (b) => pick(b)()))
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  )
  for (const error of errors) console.error(`[${what}] buffer failed:`, error)
  if (rejectErrors && errors.length > 0) throw errors[0]
}
