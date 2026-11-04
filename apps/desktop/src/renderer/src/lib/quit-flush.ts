import { flushAllBuffers, freezeBuffers } from './buffer-registry'

type QuitChannel = Pick<
  Window['holi']['vault'],
  'onFlushRequest' | 'onFlushCancelled' | 'flushDone'
>

/** Hold editor text stable from the quit flush through process teardown.
 * A cancelled or failed request releases only its own lock, so retries and
 * late completions cannot unlock a newer shutdown.
 */
export function listenForQuitFlush(channel: QuitChannel): () => void {
  const pending = new Map<string, () => void>()
  function release(id: string): void {
    pending.get(id)?.()
    pending.delete(id)
  }
  const offCancel = channel.onFlushCancelled(({ id }) => release(id))
  const offRequest = channel.onFlushRequest(({ id }) => {
    if (pending.has(id)) return
    pending.set(id, freezeBuffers())
    void flushAllBuffers().then(
      () => channel.flushDone(id),
      (error: unknown) => {
        release(id)
        channel.flushDone(id, error instanceof Error ? error.message : String(error))
      },
    )
  })
  return () => {
    offCancel()
    offRequest()
    for (const id of pending.keys()) release(id)
  }
}
