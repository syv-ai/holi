/**
 * Ask the renderer to put its buffer on disk, and wait for it to say it has.
 *
 * The one place main asks the renderer a *question*. Everything else on the
 * seam goes the other way (tRPC in) or expects no answer (snapshot and sync
 * pushes out), and this exists because those two directions cannot express the
 * ordering that matters: a commit commits what is on disk, and until the editor
 * writes, the newest words are not there. See `glossary.md` §Flush.
 *
 * Takes a channel rather than a `BrowserWindow` so the decision it encodes —
 * what to do when the answer does not come — can be tested without Electron.
 */
export interface FlushChannel {
  /** Tell the renderer to flush. */
  send(): void
  /** Listen for the ack. Returns an unsubscribe. */
  onDone(cb: () => void): () => void
}

/**
 * Long enough for a buffer write, short enough that nobody notices it on the
 * way out. A renderer that has not answered in a second is not slow, it is
 * gone — and the caller is a quit.
 */
export const FLUSH_TIMEOUT_MS = 1_000

export async function requestFlush(
  channel: FlushChannel,
  timeoutMs = FLUSH_TIMEOUT_MS,
): Promise<'flushed' | 'timeout'> {
  return new Promise((resolve) => {
    /**
     * Whichever arrives first wins, and the loser must leave nothing behind.
     *
     * Both directions matter. A listener that outlives its request piles up on
     * the `ipcMain` singleton across vault switches; a timer that outlives its
     * ack keeps the event loop alive after the work is done — during a quit,
     * which is the only caller.
     */
    const settle = (outcome: 'flushed' | 'timeout') => {
      clearTimeout(timer)
      stop()
      resolve(outcome)
    }
    const timer = setTimeout(() => settle('timeout'), timeoutMs)
    const stop = channel.onDone(() => settle('flushed'))
    channel.send()
  })
}
