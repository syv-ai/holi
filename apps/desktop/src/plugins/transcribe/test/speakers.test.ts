/**
 * Who spoke: a chunk with speech on both channels goes up as two mono
 * requests at once, the microphone's lines Me and the computer's Them, and a
 * chunk with speech on one side goes up once. The microphone's copy of the
 * computer's sound (echo) is not Me. Synthetic stereo PCM and a fake service
 * that hears where the uploaded audio is loud.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Fetch } from '../main/asr'
import { encodeWav, parseWav, rms } from '../main/wav'
import { engineRig, until } from './engine-helpers'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const RATE = 16_000

/** A tone on one side of a stereo chunk, from one second to another. */
interface Part {
  side: 'mic' | 'computer'
  from: number
  to: number
  amp: number
}

function stereo(seconds: number, parts: Part[]): Uint8Array {
  const left = new Int16Array(seconds * RATE)
  const right = new Int16Array(seconds * RATE)
  for (const { side, from, to, amp } of parts) {
    const ch = side === 'mic' ? left : right
    for (let i = from * RATE; i < to * RATE; i++) {
      ch[i] = Math.max(-32768, Math.min(32767, ch[i]! + Math.round(amp * Math.sin(i / 8))))
    }
  }
  return encodeWav(RATE, [left, right])
}

/** The service: a segment for each loud stretch of the file it is sent, so a
 *  mono mix of both sides is one long segment across every change of
 *  speaker. Counts the requests in flight at once. */
function hearingService() {
  let inflight = 0
  let most = 0
  const files: number[] = []
  const fetch = vi.fn<Fetch>(async (_url, init) => {
    inflight++
    most = Math.max(most, inflight)
    const blob = (init.body as FormData).get('file') as Blob
    const pcm = parseWav(new Uint8Array(await blob.arrayBuffer()))
    files.push(pcm.channels)
    for (let k = 0; k < 5; k++) await new Promise((resolve) => setImmediate(resolve))
    const seconds = pcm.left.length / pcm.rate
    const segments: Array<{ start: number; end: number; text: string }> = []
    let open: number | null = null
    for (let t = 0; t <= seconds; t = Math.round((t + 0.1) * 10) / 10) {
      const loud = t < seconds && rms(pcm.left, pcm.rate, t, t + 0.1) > 300
      if (loud && open === null) open = t
      if (!loud && open !== null) {
        segments.push({ start: open, end: t, text: `heard ${open}-${t}` })
        open = null
      }
    }
    inflight--
    return Response.json({ text: '', segments })
  })
  return { fetch, files, most: () => most }
}

async function meeting(service: ReturnType<typeof hearingService>) {
  const rig = await engineRig({ fetch: service.fetch })
  const { meetingId } = await rig.meetings.start({ title: 'Planning', profileId: 'default' })
  const m = await rig.meetings.get(meetingId)
  const send = (n: number, audio: Uint8Array) =>
    rig.meetings.chunk({ meetingId, n, start: n * 8, duration: 8, audio })
  return { rig, m, send }
}

const lines = (m: { segments: Array<{ i: number; speaker: string; start: number }> }) =>
  m.segments.map((s) => [s.i, s.speaker, s.start])

describe('who spoke', () => {
  it('is one upload when only one side speaks', async () => {
    const service = hearingService()
    const { m, send } = await meeting(service)
    await send(0, stereo(8, [{ side: 'mic', from: 1, to: 7, amp: 6000 }]))
    await until(() => m.chunks[0]?.state === 'done')
    expect(service.files).toEqual([1])
    expect(lines(m)).toEqual([[0, 'Me', 1]])
  })

  it('splits a chunk where both sides take turns into two uploads at once, each line labelled exactly', async () => {
    const service = hearingService()
    const { m, send } = await meeting(service)
    await send(
      0,
      stereo(8, [
        { side: 'mic', from: 0, to: 2, amp: 6000 },
        { side: 'computer', from: 2, to: 4, amp: 6000 },
        { side: 'mic', from: 4, to: 6, amp: 6000 },
        { side: 'computer', from: 6, to: 8, amp: 6000 },
      ]),
    )
    await until(() => m.chunks[0]?.state === 'done')
    expect(service.files).toEqual([1, 1])
    expect(service.most()).toBe(2)
    expect(lines(m)).toEqual([
      [0, 'Me', 0],
      [1, 'Them', 2],
      [2, 'Me', 4],
      [3, 'Them', 6],
    ])
    // The next chunk's lines follow, in order, the earlier ones unchanged.
    await send(1, stereo(8, [{ side: 'computer', from: 1, to: 3, amp: 6000 }]))
    await until(() => m.chunks[1]?.state === 'done')
    expect(lines(m)).toEqual([
      [0, 'Me', 0],
      [1, 'Them', 2],
      [2, 'Me', 4],
      [3, 'Them', 6],
      [4, 'Them', 9],
    ])
  })

  it('drops the microphone’s echo of the computer’s sound', async () => {
    const service = hearingService()
    const { m, send } = await meeting(service)
    await send(
      0,
      stereo(8, [
        { side: 'computer', from: 0, to: 5, amp: 6000 },
        // The speakers, heard by the microphone a little quieter.
        { side: 'mic', from: 0, to: 5, amp: 1500 },
        { side: 'mic', from: 6, to: 8, amp: 6000 },
      ]),
    )
    await until(() => m.chunks[0]?.state === 'done')
    expect(service.files).toEqual([1, 1])
    expect(lines(m)).toEqual([
      [0, 'Them', 0],
      [1, 'Me', 6],
    ])
  })

  it('is one upload when the microphone only echoes the computer', async () => {
    const service = hearingService()
    const { m, send } = await meeting(service)
    await send(
      0,
      stereo(8, [
        { side: 'computer', from: 0, to: 8, amp: 6000 },
        { side: 'mic', from: 0, to: 8, amp: 1500 },
      ]),
    )
    await until(() => m.chunks[0]?.state === 'done')
    expect(service.files).toEqual([1])
    expect(lines(m)).toEqual([[0, 'Them', 0]])
  })
})
