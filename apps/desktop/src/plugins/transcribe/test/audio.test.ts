import { describe, expect, it } from 'vitest'
import { PCM_TAP, PCM_TAP_SOURCE, type TapMessage } from '../renderer/audio/pcm-tap'
import { Resampler } from '../renderer/audio/resampler'
import { loudness, rms, toDb } from '../renderer/audio/rms'
import { encodeWav } from '../renderer/audio/wav'

function sine(rate: number, seconds: number, hz: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate)
  return out
}

function resampleAll(input: Float32Array, from: number, to: number, block = 0): Float32Array {
  const r = new Resampler(from, to)
  const parts: Float32Array[] = []
  if (block === 0) parts.push(r.push(input))
  else
    for (let i = 0; i < input.length; i += block) parts.push(r.push(input.subarray(i, i + block)))
  parts.push(r.flush())
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

describe('encodeWav', () => {
  const left = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2])
  const right = Float32Array.from([0.25, -0.25, 0, 0.1, -0.1, 0.999, -0.999])
  const wav = encodeWav([left, right], 16_000)
  const view = new DataView(wav)
  const text = (at: number, n: number): string => String.fromCharCode(...new Uint8Array(wav, at, n))

  it('writes a canonical 16 kHz, 2-channel, 16-bit PCM header with the right sizes', () => {
    const dataBytes = left.length * 2 * 2
    expect(wav.byteLength).toBe(44 + dataBytes)
    expect(text(0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + dataBytes)
    expect(text(8, 4)).toBe('WAVE')
    expect(text(12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(16_000 * 4)
    expect(view.getUint16(32, true)).toBe(4)
    expect(view.getUint16(34, true)).toBe(16)
    expect(text(36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(dataBytes)
  })

  it('interleaves the channels and round-trips the samples, clipping outside -1..1', () => {
    const pcm = new Int16Array(wav, 44)
    for (let i = 0; i < left.length; i++) {
      const l = Math.max(-1, Math.min(1, left[i]!))
      const r = Math.max(-1, Math.min(1, right[i]!))
      expect(Math.abs(pcm[2 * i]! / 32768 - l)).toBeLessThan(1 / 16384)
      expect(Math.abs(pcm[2 * i + 1]! / 32768 - r)).toBeLessThan(1 / 16384)
    }
    expect(pcm[6]).toBe(32767)
    expect(pcm[8]).toBe(-32768)
  })

  it('refuses channels of different lengths', () => {
    expect(() => encodeWav([new Float32Array(2), new Float32Array(3)], 16_000)).toThrow()
  })
})

describe('Resampler', () => {
  it.each([48_000, 44_100, 8_000])('turns %i Hz into 16 kHz of the same length', (from) => {
    const input = sine(from, 1.5, 440)
    const out = resampleAll(input, from, 16_000)
    expect(out.length).toBe(Math.ceil((input.length * 16_000) / from))
  })

  it.each([48_000, 44_100])('keeps a 1 kHz sine at %i Hz in time and in level', (from) => {
    const out = resampleAll(sine(from, 1, 1000), from, 16_000)
    const want = sine(16_000, 1, 1000)
    // Away from the edges, where the filter sees silence beyond the signal.
    let worst = 0
    for (let i = 200; i < out.length - 200; i++)
      worst = Math.max(worst, Math.abs(out[i]! - want[i]!))
    expect(worst).toBeLessThan(0.005)
  })

  it('filters out what 16 kHz cannot hold instead of folding it back', () => {
    const out = resampleAll(sine(48_000, 1, 11_000), 48_000, 16_000)
    expect(rms(out, 200, out.length - 200)).toBeLessThan(0.005)
  })

  it('gives the same samples whatever the block size', () => {
    const input = sine(48_000, 0.5, 700)
    const whole = resampleAll(input, 48_000, 16_000)
    const blocks = resampleAll(input, 48_000, 16_000, 128)
    const odd = resampleAll(input, 48_000, 16_000, 1001)
    expect(blocks.length).toBe(whole.length)
    expect(odd.length).toBe(whole.length)
    for (let i = 0; i < whole.length; i++) {
      expect(blocks[i]).toBeCloseTo(whole[i]!, 6)
      expect(odd[i]).toBeCloseTo(whole[i]!, 6)
    }
  })

  it('holds only the filter’s reach between blocks, however long it runs', () => {
    const r = new Resampler(48_000, 16_000)
    const block = sine(48_000, 1024 / 48_000, 440)
    for (let i = 0; i < 48_000 * 60 * 10; i += block.length) r.push(block)
    expect((r as unknown as { buf: Float32Array }).buf.length).toBeLessThanOrEqual(4096)
  })

  it('passes the signal through at the same rate', () => {
    const input = sine(16_000, 0.1, 440)
    expect(resampleAll(input, 16_000, 16_000)).toEqual(input)
  })
})

describe('rms and loudness', () => {
  it('measures a sine at amplitude/√2 and maps loudness into 0..1', () => {
    expect(rms(sine(16_000, 1, 400, 1))).toBeCloseTo(Math.SQRT1_2, 3)
    expect(rms(new Float32Array(0))).toBe(0)
    expect(toDb(0)).toBe(-200)
    expect(loudness(0)).toBe(0)
    expect(loudness(1)).toBe(1)
    expect(loudness(10 ** (-30 / 20))).toBeCloseTo(0.6, 6)
  })
})

describe('the PCM tap worklet', () => {
  /** Runs the worklet source against stand-ins for the AudioWorklet globals. */
  function load(): {
    tap: { process: (inputs: Float32Array[][]) => boolean; receive: (data: unknown) => void }
    posted: TapMessage[]
  } {
    const posted: TapMessage[] = []
    let made: unknown
    class Processor {
      port = {
        onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
        postMessage: (data: TapMessage) => posted.push(data),
      }
    }
    const register = (name: string, ctor: new () => unknown): void => {
      expect(name).toBe(PCM_TAP)
      made = new ctor()
    }
    new Function('AudioWorkletProcessor', 'registerProcessor', PCM_TAP_SOURCE)(Processor, register)
    const tap = made as Processor & { process: (inputs: Float32Array[][]) => boolean }
    return {
      tap: { process: (i) => tap.process(i), receive: (data) => tap.port.onmessage?.({ data }) },
      posted,
    }
  }

  it('posts blocks of both channels, silence for a missing input, and the rest on flush', () => {
    const { tap, posted } = load()
    const l = Float32Array.from({ length: 128 }, (_, i) => i / 128)
    const r = Float32Array.from({ length: 128 }, (_, i) => -i / 128)
    for (let q = 0; q < 8; q++) expect(tap.process([[l, r]])).toBe(true)
    tap.process([[]])
    expect(posted).toHaveLength(1)
    const first = posted[0] as { left: Float32Array; right: Float32Array }
    expect(first.left.length).toBe(1024)
    expect(first.left.subarray(0, 128)).toEqual(l)
    expect(first.right.subarray(128, 256)).toEqual(r)
    tap.receive('flush')
    expect(posted).toHaveLength(3)
    const rest = posted[1] as { left: Float32Array; right: Float32Array }
    expect(rest.left).toEqual(new Float32Array(128))
    expect(posted[2]).toBe('flushed')
  })
})
