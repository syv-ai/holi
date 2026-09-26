/**
 * Ask the renderer to put its buffer on disk, and wait for it to say it has.
 *
 * The one place main asks the renderer a *question*: a commit commits what is
 * on disk, and until the editor writes, the newest words are not there. See
 * `docs/glossary.md` §Flush.
 *
 * Takes a channel rather than a `BrowserWindow` so the timeout behaviour can be
 * tested without Electron.
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
 * gone, and the caller is a quit.
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
     * A listener that outlives its request piles up on the `ipcMain` singleton;
     * a timer that outlives its ack keeps the event loop alive during a quit.
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
