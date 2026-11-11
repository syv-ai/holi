/**
 * The real Silero model on onnxruntime-web, under plain Node: it hears a
 * synthetic voice and not the noise around it, and a chunk built from both
 * uploads only the voice.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSileroVad } from '../main/silero'
import type { AsrSegment } from '../main/stitcher'
import { padRuns, speechRuns, transcribeChunk } from '../main/vad'
import { parseWav, type Pcm } from '../main/wav'

const RATE = 16_000

let seed = 7
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}

/** Formant synthesis: a glottal pulse train with a moving pitch through three
 *  vowel resonators, a syllable every 220 ms. Silero takes it for a voice. */
function voice(seconds: number): Float32Array {
  const vowels = [
    [730, 1090, 2440],
    [270, 2290, 3010],
    [300, 870, 2240],
    [530, 1840, 2480],
    [570, 840, 2410],
  ]
  const out = new Float32Array(seconds * RATE)
  const state = new Float64Array(6)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE
    const syllable = Math.floor(t / 0.22)
    const at = (t % 0.22) / 0.22
    const envelope = at < 0.8 ? Math.sin((Math.PI * at) / 0.8) : 0
    phase += (120 + 30 * Math.sin(2 * Math.PI * 0.7 * t) + 15 * Math.sin(syllable)) / RATE
    const pulse = phase >= 1 ? 1 : 0
    if (phase >= 1) phase -= 1
    const source = pulse + 0.02 * (rand() - 0.5)
    const formants = vowels[syllable % vowels.length]!
    let y = 0
    for (let k = 0; k < 3; k++) {
      const r = Math.exp((-Math.PI * (80 + 40 * k)) / RATE)
      const c = 2 * r * Math.cos((2 * Math.PI * formants[k]!) / RATE)
      const v = source + c * state[2 * k]! - r * r * state[2 * k + 1]!
      state[2 * k + 1] = state[2 * k]!
      state[2 * k] = v
      y += v / (k + 1)
    }
    out[i] = y * envelope
  }
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  return out.map((v) => (v / peak) * 0.3)
}

/** White noise at about -45 dBFS. */
const noise = (seconds: number) =>
  Float32Array.from({ length: seconds * RATE }, () => (rand() - 0.5) * 0.02)

const model = () => readFile(join(__dirname, '../main/assets/silero-vad.onnx'))
const vad = createSileroVad({
  model: async () => new Uint8Array(await model()),
  log: (_level, message) => {
    throw new Error(message)
  },
})

describe('Silero VAD', () => {
  it('hears the voice and not the noise around it, in tens of milliseconds', async () => {
    const samples = noise(12)
    voice(2).forEach((v, i) => (samples[4 * RATE + i]! += v))
    await vad.speech(new Float32Array(RATE)) // the model loads once
    const t = performance.now()
    const probs = await vad.speech(samples)
    const ms = performance.now() - t
    expect(probs).not.toBeNull()
    expect(probs!.length).toBe(Math.ceil((12 * RATE) / 512))
    const regions = padRuns(speechRuns(probs!, samples.length), samples.length)
    expect(regions).toHaveLength(1)
    expect(regions[0]!.start / RATE).toBeGreaterThan(3.5)
    expect(regions[0]!.start / RATE).toBeLessThan(4.1)
    expect(regions[0]!.end / RATE).toBeGreaterThan(5.9)
    expect(regions[0]!.end / RATE).toBeLessThan(6.6)
    // A loose bound for CI; on a laptop it is about 60 ms.
    expect(ms).toBeLessThan(2000)
  })

  it('finds no speech in noise alone', async () => {
    const samples = noise(12)
    const probs = await vad.speech(samples)
    expect(speechRuns(probs!, samples.length)).toEqual([])
  })

  it('uploads only the voice of a chunk, labelled by its side', async () => {
    const left = new Int16Array(12 * RATE)
    const right = new Int16Array(12 * RATE)
    noise(12).forEach((v, i) => (left[i] = Math.round(v * 32768)))
    voice(2).forEach((v, i) => (right[7 * RATE + i] = Math.round(v * 32768)))
    const pcm: Pcm = { rate: RATE, left, right, channels: 2 }
    const heard: number[] = []
    const ask = async (wav: Uint8Array): Promise<AsrSegment[]> => {
      const up = parseWav(wav)
      heard.push(up.left.length / up.rate)
      return [{ start: 0.3, end: 2, text: 'hej' }]
    }
    const out = await transcribeChunk({
      pcm,
      chunk: { n: 0, start: 30, duration: 12 },
      roomDiarize: false,
      vad,
      ask,
    })
    expect(heard).toHaveLength(1)
    expect(heard[0]).toBeLessThan(3)
    expect(out.map((s) => s.speaker)).toEqual(['Them'])
    expect(out[0]!.start).toBeGreaterThan(37)
    expect(out[0]!.start).toBeLessThan(37.5)
  })
})
