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
import { describe, expect, it } from 'vitest'
import { requestFlush, type FlushChannel } from '../src/main/flush'

/** A renderer that acks after `delayMs`, or never if given `null`. */
function renderer(delayMs: number | null): FlushChannel & { sends: number; listening: boolean } {
  let done: (() => void) | null = null
  return {
    sends: 0,
    listening: false,
    send() {
      this.sends += 1
      if (delayMs !== null) setTimeout(() => done?.(), delayMs)
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

  it('gives up rather than trapping someone in an app they are leaving', async () => {
    // A renderer that is gone, wedged, or never loaded must not hold the quit
    // open. `index.ts` already vetoes the first quit to wait for the commit; if
    // this could hang, that veto would become permanent — and a lost second of
    // typing is a smaller harm than an app that will not close.
    const channel = renderer(null)

    expect(await requestFlush(channel, 30)).toBe('timeout')
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
