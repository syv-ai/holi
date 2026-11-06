import { describe, expect, it } from 'vitest'
import { Chunker, type ChunkerOptions, type ClosedChunk } from '../renderer/audio/chunker'

const RATE = 16_000

/** A deterministic noise source, uniform in ±amplitude. */
function noise(seconds: number, amplitude: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  let s = seed
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = (s / 0xffffffff - 0.5) * 2 * amplitude
  }
  return out
}

/** Speech stands in as a 300 Hz tone (6 whole cycles a frame, so every frame is equally loud). */
function tone(seconds: number, amplitude = 0.1): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 300 * i) / RATE)
  return out
}

/** A quiet room: about -65 dBFS. */
const hush = (seconds: number): Float32Array => noise(seconds, 0.001)

function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Feeds a mono signal to the left (or right) channel in odd-sized blocks, then flushes. */
function run(
  signal: Float32Array,
  options: Partial<ChunkerOptions> = {},
  side: 'left' | 'right' = 'left',
): ClosedChunk[] {
  const chunker = new Chunker({ sampleRate: RATE, ...options })
  const silent = new Float32Array(signal.length)
  const [l, r] = side === 'left' ? [signal, silent] : [silent, signal]
  const out: ClosedChunk[] = []
  for (let i = 0; i < signal.length; i += 1013) {
    out.push(...chunker.push(l.subarray(i, i + 1013), r.subarray(i, i + 1013)))
  }
  const last = chunker.flush()
  if (last) out.push(last)
  return out
}

const shape = (chunks: ClosedChunk[]): [number, number, number][] =>
  chunks.map((c) => [c.n, +c.start.toFixed(3), +c.duration.toFixed(3)])

describe('Chunker', () => {
  it('closes nonstop speech at maxChunk and flushes the rest as the last chunk', () => {
    const chunks = run(tone(30))
    expect(shape(chunks)).toEqual([
      [0, 0, 12],
      [1, 12, 12],
      [2, 24, 6],
    ])
  })

  it('cuts at the first 300 ms pause after minChunk, in the middle of the pause', () => {
    const chunks = run(join(tone(7), hush(1), tone(7), hush(1), tone(2)))
    // The pause starts at 7 s and is a pause by 7.3 s; the cut leaves 140 ms of it to the next chunk.
    expect(shape(chunks)).toEqual([
      [0, 0, 7.16],
      [1, 7.16, 8],
      [2, 15.16, 2.84],
    ])
  })

  it('ignores a pause that ends before minChunk', () => {
    const chunks = run(join(tone(3), hush(0.5), tone(4), hush(1), tone(1)))
    expect(chunks[0]!.duration).toBeCloseTo(7.66, 3)
    expect(chunks).toHaveLength(2)
  })

  it('closes at minChunk exactly when it is already in a pause', () => {
    const chunks = run(join(tone(5.5), hush(2), tone(3)))
    expect(shape(chunks)[0]).toEqual([0, 0, 6])
  })

  it('treats a pause shorter than 300 ms as speech', () => {
    const chunks = run(join(tone(7), hush(0.28), tone(3)))
    expect(shape(chunks)).toEqual([[0, 0, 10.28]])
  })

  it('honours custom chunk lengths', () => {
    const chunks = run(join(tone(2.5), hush(0.4), tone(5)), { minChunk: 2, maxChunk: 4 })
    expect(shape(chunks)).toEqual([
      [0, 0, 2.66],
      [1, 2.66, 4],
      [2, 6.66, 1.24],
    ])
  })

  it('makes a forced cut at the quietest place of the last two seconds', () => {
    // Quieter speech (still speech) from 11.0 to 11.1 s: the cut lands at its end.
    const chunks = run(join(tone(11), tone(0.1, 0.02), tone(3)))
    expect(chunks[0]!.duration).toBeCloseTo(11.1, 6)
    expect(chunks[1]!.start).toBeCloseTo(11.1, 6)
  })

  it('numbers chunks from 0 and gives each its start in seconds since capture start', () => {
    const chunks = run(join(tone(7), hush(1), tone(7), hush(1), tone(7), hush(1)))
    expect(chunks.map((c) => c.n)).toEqual([0, 1, 2])
    for (let i = 1; i < chunks.length; i++) {
      const before = chunks[i - 1]!
      expect(chunks[i]!.start).toBeCloseTo(before.start + before.duration, 9)
    }
  })

  it('drops a chunk of silence mid-stream without leaving a gap in the numbers or the clock', () => {
    const chunks = run(join(tone(7), hush(20), tone(7)))
    expect(chunks.map((c) => c.n)).toEqual([0, 1])
    // The second chunk starts once the long silence is over, true to the clock.
    expect(chunks[1]!.start).toBeGreaterThan(20)
    expect(chunks[1]!.start).toBeLessThanOrEqual(27)
  })

  it('keeps the last partial chunk', () => {
    expect(shape(run(tone(8)))).toEqual([[0, 0, 8]])
  })

  it('skips a last chunk shorter than half a second', () => {
    expect(shape(run(tone(12.3)))).toEqual([[0, 0, 12]])
  })

  it('skips a last chunk that is only silence', () => {
    expect(run(hush(3))).toEqual([])
    expect(run(new Float32Array(RATE * 2))).toEqual([])
  })

  it('adapts its threshold to a noisy room', () => {
    // A -40 dBFS hiss under speech 25 dB louder: the hiss alone still counts as a pause.
    const room = (seconds: number, seed: number): Float32Array => noise(seconds, 0.017, seed)
    const speech = (seconds: number, seed: number): Float32Array => {
      const out = room(seconds, seed)
      const t = tone(seconds, 0.25)
      for (let i = 0; i < out.length; i++) out[i]! += t[i]!
      return out
    }
    const chunks = run(join(speech(7, 2), room(1, 3), speech(7, 4), room(1, 5)))
    expect(shape(chunks).map(([n, start]) => [n, start])).toEqual([
      [0, 0],
      [1, 7.16],
    ])
    expect(chunks[0]!.duration).toBeCloseTo(7.16, 3)
  })

  it('hears speech on either side, and keeps the sides apart', () => {
    const right = run(join(tone(7), hush(1)), {}, 'right')
    expect(shape(right)).toEqual([[0, 0, 7.16]])
    const left = run(join(tone(7), hush(1)))
    const chunk = left[0]!
    expect(chunk.left.length).toBe(chunk.duration * RATE)
    expect(chunk.right.length).toBe(chunk.left.length)
    expect(chunk.right.every((v) => v === 0)).toBe(true)
    expect(chunk.left.subarray(0, 1000)).toEqual(tone(7).subarray(0, 1000))
  })

  it('reports every 20 ms frame', () => {
    const levels: number[] = []
    run(tone(1), { onFrame: (level) => levels.push(level) })
    expect(levels).toHaveLength(50)
    expect(levels[0]).toBeCloseTo(0.1 / Math.SQRT2, 3)
  })

  it('refuses channels of different lengths and pushes after a flush', () => {
    const chunker = new Chunker({ sampleRate: RATE })
    expect(() => chunker.push(new Float32Array(3), new Float32Array(4))).toThrow()
    chunker.flush()
    expect(() => chunker.push(new Float32Array(3), new Float32Array(3))).toThrow()
    expect(chunker.flush()).toBeUndefined()
  })
})
