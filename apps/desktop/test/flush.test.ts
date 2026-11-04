/**
 * Asking the renderer to put its buffer on disk, and knowing when it has.
 *
 * The only main→renderer *question* on the seam — everything else is either a
 * tRPC call inward or a fire-and-forget push outward. It exists because a
 * commit commits what is on disk, and the editor holds text that is not there
 * yet: `glossary.md` §Flush separates the two dirtinesses this closes.
 *
 * Tested against fakes rather than Electron, which cannot be imported here.
 * That is not a compromise — every interesting case is timing (an ack that
 * never comes, one that comes late), and none of it is about IPC.
 */
import { describe, expect, it, vi } from 'vitest'
import { requestFlush, type FlushChannel } from '../src/main/flush'

/** A renderer that acks after `delayMs`, or never if given `null`. */
function renderer(delayMs: number | null): FlushChannel & { sends: number; listening: boolean } {
  let done: ((id: string, error?: string) => void) | null = null
  let requestId = ''
  return {
    sends: 0,
    listening: false,
    send(id) {
      this.sends += 1
      requestId = id
      if (delayMs !== null) setTimeout(() => done?.(requestId), delayMs)
    },
    onDone(cb) {
      done = cb
      this.listening = true
      return () => {
        done = null
        this.listening = false
      }
    },
  }
}

describe('requestFlush', () => {
  it('resolves once the renderer says it has written', async () => {
    const channel = renderer(10)

    expect(await requestFlush(channel, 1_000)).toBe('flushed')
    expect(channel.sends).toBe(1)
  })

  it('times out rather than waiting forever for a missing renderer', async () => {
    // A missing acknowledgement cancels shutdown instead of discarding text.
    // The caller remains usable and can retry the quit.
    const channel = renderer(null)

    expect(await requestFlush(channel, 30)).toBe('timeout')
  })

  it('does not accept an ack for an older request', async () => {
    let ack: ((id: string) => void) | undefined
    const channel: FlushChannel = {
      send: () => {},
      onDone: (cb) => {
        ack = cb
        return () => {}
      },
    }
    const pending = requestFlush(channel, 20)
    ack?.('old-request')
    expect(await pending).toBe('timeout')
  })

  it('reports a renderer write failure', async () => {
    let ack: ((id: string, error?: string) => void) | undefined
    const channel: FlushChannel = {
      send: (id) => ack?.(id, 'disk full'),
      onDone: (cb) => {
        ack = cb
        return () => {}
      },
    }
    expect(await requestFlush(channel, 100)).toBe('failed')
  })

  it('releases the shutdown lock on failure or timeout, but not success', async () => {
    for (const outcome of ['flushed', 'failed', 'timeout'] as const) {
      let ack!: (id: string, error?: string) => void
      const cancel = vi.fn()
      const channel: FlushChannel = {
        onDone: (cb) => {
          ack = cb
          return () => {}
        },
        send: (id) => {
          if (outcome === 'flushed') ack(id)
          if (outcome === 'failed') ack(id, 'disk full')
        },
        cancel,
      }
      expect(await requestFlush(channel, 10)).toBe(outcome)
      expect(cancel).toHaveBeenCalledTimes(outcome === 'flushed' ? 0 : 1)
    }
  })

  it('stops listening once it has an answer, either way', async () => {
    // A per-quit listener that outlives its request accumulates on the ipcMain
    // singleton across vault switches, and a late ack must not resolve a
    // promise that already timed out.
    const acked = renderer(10)
    await requestFlush(acked, 1_000)
    expect(acked.listening).toBe(false)

    const silent = renderer(60)
    expect(await requestFlush(silent, 20)).toBe('timeout')
    expect(silent.listening).toBe(false)
  })
})
