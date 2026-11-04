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
  /** Tell the renderer to flush for this request. */
  send(id: string): void
  /** Listen for this request's success/failure ack. Returns an unsubscribe. */
  onDone(cb: (id: string, error?: string) => void): () => void
  /** Release this request's editor lock when shutdown is cancelled. */
  cancel?(id?: string): void
}

/**
 * A slow renderer is not permission to discard dirty text: timeout is a
 * failure and the caller must keep the app open.
 */
const FLUSH_TIMEOUT_MS = 10_000
let nextRequest = 0

export async function requestFlush(
  channel: FlushChannel,
  timeoutMs = FLUSH_TIMEOUT_MS,
): Promise<'flushed' | 'failed' | 'timeout'> {
  const id = `${Date.now()}-${++nextRequest}`
  return new Promise((resolve) => {
    /**
     * Whichever arrives first wins, and the loser must leave nothing behind.
     *
     * A listener that outlives its request piles up on the `ipcMain` singleton;
     * a timer that outlives its ack keeps the event loop alive during a quit.
     */
    const settle = (outcome: 'flushed' | 'failed' | 'timeout') => {
      clearTimeout(timer)
      stop()
      if (outcome !== 'flushed') channel.cancel?.(id)
      resolve(outcome)
    }
    const timer = setTimeout(() => settle('timeout'), timeoutMs)
    const stop = channel.onDone((ackId, error) => {
      if (ackId !== id) return
      settle(error === undefined ? 'flushed' : 'failed')
    })
    channel.send(id)
  })
}
