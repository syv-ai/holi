/**
 * The VAD in front of uploads (`main/vad.ts`): speech regions from Silero's
 * probabilities, the splice and its time map, which uploads a chunk makes,
 * Me/Them after splicing, and the fallback when the model is missing.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSileroVad } from '../main/silero'
import type { AsrSegment } from '../main/stitcher'
import {
  chunkTime,
  joinRegions,
  padRuns,
  speechRuns,
  splice,
  transcribeChunk,
  VAD_WINDOW,
  type ChunkVad,
} from '../main/vad'
import { parseWav, type Pcm } from '../main/wav'

const RATE = 16_000
const W = VAD_WINDOW
/** Probabilities, one per 512-sample window: `high` within the windows given. */
function probs(windows: number, ...high: Array<[number, number, number?]>): Float32Array {
  const p = new Float32Array(windows).fill(0.02)
  for (const [a, b, v] of high) p.fill(v ?? 0.9, a, b)
  return p
}

describe('speech regions', () => {
  it('finds a run, and pads it by 250 ms on each side', () => {
    const runs = speechRuns(probs(200, [50, 100]), 200 * W)
    expect(runs).toEqual([{ start: 50 * W, end: 100 * W }])
    expect(padRuns(runs, 200 * W)).toEqual([{ start: 50 * W - 4000, end: 100 * W + 4000 }])
  })

  it('drops speech shorter than 250 ms', () => {
    // 7 windows are 224 ms
    expect(speechRuns(probs(200, [50, 57]), 200 * W)).toEqual([])
    expect(speechRuns(probs(200, [50, 59]), 200 * W)).toHaveLength(1)
  })

  it('keeps speech through a pause under 300 ms, and through a doubtful stretch', () => {
    // a 160 ms pause does not split; a 480 ms one does
    expect(speechRuns(probs(300, [20, 60], [65, 120]), 300 * W)).toHaveLength(1)
    expect(speechRuns(probs(300, [20, 60], [75, 120]), 300 * W)).toHaveLength(2)
    // between 0.35 and 0.5 speech goes on, whatever its length
    expect(speechRuns(probs(300, [20, 60], [60, 100, 0.4], [100, 120]), 300 * W)).toEqual([
      { start: 20 * W, end: 120 * W },
    ])
  })

  it('runs to the end of the channel when speech does not stop', () => {
    expect(speechRuns(probs(100, [80, 100]), 100 * W - 100)).toEqual([
      { start: 80 * W, end: 100 * W - 100 },
    ])
  })

  it('lets close neighbours share the gap between them, so padding never overlaps', () => {
    const padded = padRuns(
      [
        { start: 10_000, end: 20_000 },
        { start: 26_000, end: 30_000 },
      ],
      40_000,
    )
    expect(padded).toEqual([
      { start: 6000, end: 23_000 },
      { start: 23_000, end: 34_000 },
    ])
    // padding stops at the channel's ends
    expect(padRuns([{ start: 1000, end: 39_000 }], 40_000)).toEqual([{ start: 0, end: 40_000 }])
  })

  it('joins regions of both channels that overlap or are closer than the gap', () => {
    expect(
      joinRegions(
        [
          { start: 0, end: 16_000 },
          { start: 80_000, end: 96_000 },
        ],
        [
          { start: 20_000, end: 40_000 },
          { start: 30_000, end: 50_000 },
        ],
      ),
    ).toEqual([
      // 4000 samples (250 ms) apart: joined; then 30 000 apart: kept apart
      { start: 0, end: 50_000 },
      { start: 80_000, end: 96_000 },
    ])
  })
})

/** A stereo chunk whose every sample says where it came from. */
function ramp(seconds: number): Pcm {
  const left = Int16Array.from({ length: seconds * RATE }, (_, i) => (i % 30_000) + 1)
  const right = Int16Array.from(left, (v) => -v)
  return { rate: RATE, left, right, channels: 2 }
}

describe('splice and time map', () => {
  const pcm = ramp(12)
  const cut = splice(pcm, [
    { start: 1 * RATE, end: 2 * RATE },
    { start: 5 * RATE, end: 6.5 * RATE },
  ])

  it('keeps only the regions, 0.3 s of silence apart, both channels alike', () => {
    expect(cut.pcm.left.length).toBe(2.8 * RATE)
    expect(cut.pieces).toEqual([
      { at: 0, from: 1, length: 1 },
      { at: 1.3, from: 5, length: 1.5 },
    ])
    expect(cut.pcm.left[0]).toBe(pcm.left[RATE])
    expect(cut.pcm.left[20_810]).toBe(pcm.left[5 * RATE + 10])
    expect(cut.pcm.right[20_810]).toBe(pcm.right[5 * RATE + 10])
    expect(cut.pcm.left.subarray(RATE, 20_800).every((v) => v === 0)).toBe(true)
  })

  it('maps every spliced sample back to the sample it came from', () => {
    for (const t of [0, 0.4, 0.999, 1.3, 2, 2.79]) {
      const back = chunkTime(cut.pieces, t, 'start')
      expect(cut.pcm.left[Math.round(t * RATE)]).toBe(pcm.left[Math.round(back * RATE)])
    }
  })

  it('maps a time in the silence to the next start, or the last end', () => {
    expect(chunkTime(cut.pieces, 1.15, 'start')).toBe(5)
    expect(chunkTime(cut.pieces, 1.15, 'end')).toBe(2)
    expect(chunkTime(cut.pieces, 9, 'end')).toBe(6.5)
  })

  it('splices nothing to an empty upload', () => {
    expect(splice(pcm, []).pcm.left.length).toBe(0)
  })
})

/** A stand-in for Silero: a window is speech when it is loud. */
const loudVad: ChunkVad = {
  async speech(samples) {
    const n = Math.ceil(samples.length / W)
    const p = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let k = i * W; k < Math.min(samples.length, (i + 1) * W); k++) sum += samples[k]! ** 2
      p[i] = Math.sqrt(sum / W) > 0.02 ? 0.95 : 0.01
    }
    return p
  },
}

/** A stereo chunk with a tone on each side over the windows given (seconds),
 *  the computer's at half the microphone's level, and the computer leaking
 *  into the microphone at `echo` of its level. */
function stereo(
  seconds: number,
  me: Array<[number, number]>,
  them: Array<[number, number]>,
  echo = 0,
): Pcm {
  const left = new Int16Array(seconds * RATE)
  const right = new Int16Array(seconds * RATE)
  for (const [a, b] of me) {
    for (let i = a * RATE; i < b * RATE; i++) left[i] = Math.round(8000 * Math.sin(i / 7))
  }
  for (const [a, b] of them) {
    for (let i = a * RATE; i < b * RATE; i++) {
      right[i] = Math.round(4000 * Math.sin(i / 5))
      left[i] = left[i]! + Math.round(echo * right[i]!)
    }
  }
  return { rate: RATE, left, right, channels: 2 }
}

/** The service: one line over each upload's first second, saying which side
 *  it heard by the upload's level, and the seconds of every upload. */
function service() {
  const heard: number[] = []
  const ask = vi.fn(async (wav: Uint8Array): Promise<AsrSegment[]> => {
    const pcm = parseWav(wav)
    heard.push(pcm.left.length / pcm.rate)
    const peak = pcm.left.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    return [{ start: 0.1, end: 1.1, text: peak > 6000 ? 'mine' : 'theirs' }]
  })
  return { ask, heard }
}

const chunk = { n: 3, start: 60, duration: 12 }

describe('which uploads a chunk makes', () => {
  it('uploads nothing for a silent chunk', async () => {
    const { ask } = service()
    const out = await transcribeChunk({
      pcm: stereo(12, [], []),
      chunk,
      roomDiarize: false,
      vad: loudVad,
      ask,
    })
    expect(out).toEqual([])
    expect(ask).not.toHaveBeenCalled()
  })

  it('uploads only the speech, and times its line in the meeting', async () => {
    const { ask, heard } = service()
    const out = await transcribeChunk({
      pcm: stereo(12, [[4, 6]], []),
      chunk,
      roomDiarize: false,
      vad: loudVad,
      ask,
    })
    // 2 s of speech, padded by about 250 ms each side
    expect(heard).toHaveLength(1)
    expect(heard[0]).toBeGreaterThan(2.3)
    expect(heard[0]).toBeLessThan(2.7)
    expect(out).toHaveLength(1)
    expect(out[0]!.speaker).toBe('Me')
    expect(out[0]!.start).toBeCloseTo(60 + 4 - 0.25 + 0.1, 1)
    expect(out[0]!.chunk).toBe(3)
  })

  it('labels a line from the computer Them, with the microphone hearing its echo', async () => {
    const { ask, heard } = service()
    const out = await transcribeChunk({
      pcm: stereo(12, [], [[7, 9]], 0.4),
      chunk,
      roomDiarize: false,
      vad: loudVad,
      ask,
    })
    // the echo is not the microphone speaking: one upload, a mix
    expect(heard).toHaveLength(1)
    expect(out.map((s) => s.speaker)).toEqual(['Them'])
    expect(out[0]!.start).toBeCloseTo(60 + 7 - 0.25 + 0.1, 1)
  })

  it('uploads each side apart when both speak, each line labelled and timed by its side', async () => {
    const { ask, heard } = service()
    const out = await transcribeChunk({
      pcm: stereo(12, [[1, 3]], [[8, 10]]),
      chunk,
      roomDiarize: false,
      vad: loudVad,
      ask,
    })
    expect(heard).toHaveLength(2)
    for (const s of heard) expect(s).toBeLessThan(2.7)
    expect(out.map((s) => [s.speaker, s.text])).toEqual([
      ['Me', 'mine'],
      ['Them', 'theirs'],
    ])
    expect(out[0]!.start).toBeCloseTo(60 + 1 - 0.25 + 0.1, 1)
    expect(out[1]!.start).toBeCloseTo(60 + 8 - 0.25 + 0.1, 1)
  })

  it('goes up whole, as before the VAD, when the VAD cannot judge the chunk', async () => {
    const { ask, heard } = service()
    const out = await transcribeChunk({
      pcm: stereo(12, [[4, 6]], []),
      chunk,
      roomDiarize: false,
      vad: { speech: async () => null },
      ask,
    })
    expect(heard).toEqual([12])
    expect(out.map((s) => s.speaker)).toEqual(['Me'])
  })

  it('goes up whole when the VAD throws', async () => {
    const { heard, ask } = service()
    await transcribeChunk({
      pcm: stereo(12, [[4, 6]], []),
      chunk,
      roomDiarize: false,
      vad: {
        speech: async () => {
          throw new Error('broken')
        },
      },
      ask,
    })
    expect(heard).toEqual([12])
  })
})

describe('the Silero detector', () => {
  it('answers null when the model cannot load, and says so once', async () => {
    const log = vi.fn()
    const vad = createSileroVad({
      model: () => {
        throw new Error('no model here')
      },
      log,
    })
    expect(await vad.speech(new Float32Array(RATE))).toBeNull()
    expect(await vad.speech(new Float32Array(RATE))).toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![1]).toContain('no model here')

    // and the chunk still goes up, whole
    const { ask, heard } = service()
    await transcribeChunk({ pcm: stereo(12, [[4, 6]], []), chunk, roomDiarize: false, vad, ask })
    expect(heard).toEqual([12])
  })
})
