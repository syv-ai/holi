/**
 * Cuts a live stereo stream into self-contained chunks at pauses, so speech is
 * not split mid-word and each chunk can be transcribed on its own. No DOM: it
 * takes float samples and hands back closed chunks.
 *
 * The stream is judged in 20 ms frames by the louder channel's RMS (a pause is
 * when neither the mic nor the computer's sound has speech). A frame is speech
 * when it is 10 dB above the noise floor, the quietest frame of the last two
 * seconds, so a fan or a hiss raises the bar and a quiet room lowers it.
 *
 * A chunk closes at the first pause of 300 ms once it is `minChunk` long,
 * cutting in the middle of the pause so both chunks keep a little silence
 * around their words. At `maxChunk` it closes anyway, at the quietest frame of
 * its last two seconds. Chunks never overlap. A chunk with no speech in it is
 * dropped rather than sent (speech models invent words in silence); numbering
 * counts only the chunks handed back, while `start` stays true to the clock.
 */

import { FRAME_SECONDS, MARGIN_DB, MAX_THRESHOLD_DB, MIN_THRESHOLD_DB } from '../../shared/speech'
import { rms, toDb } from './rms'

/** A pause is this many quiet frames in a row (300 ms). */
const PAUSE_FRAMES = 15
/** The noise floor is the quietest frame over this many (2 s). */
const FLOOR_FRAMES = 100
/** A chunk with less speech than this (100 ms) is silence. */
const MIN_SPEECH_FRAMES = 5
/** A forced cut looks back this many frames (2 s) for the quietest place. */
const SEARCH_FRAMES = 100
/** The last chunk is dropped when shorter than this. */
const MIN_FINAL_SECONDS = 0.5

export interface ChunkerOptions {
  sampleRate: number
  /** Seconds. Defaults 6 and 12. */
  minChunk?: number
  maxChunk?: number
  /** Each 20 ms frame's RMS (the louder channel), as it is judged. */
  onFrame?: (rms: number) => void
}

export interface ClosedChunk {
  n: number
  /** Seconds from the stream's start. */
  start: number
  duration: number
  left: Float32Array
  right: Float32Array
}

export class Chunker {
  private readonly rate: number
  private readonly frameSize: number
  private readonly minFrames: number
  private readonly maxFrames: number
  private readonly onFrame: ((rms: number) => void) | undefined
  /** The open chunk's samples; reused for every chunk, so memory stays flat. */
  private readonly left: Float32Array
  private readonly right: Float32Array
  private len = 0
  /** Complete frames in the open chunk, with each one's loudness and verdict. */
  private frames = 0
  private readonly frameLevel: Float32Array
  private readonly frameSpeech: Uint8Array
  private readonly floorRing = new Float32Array(FLOOR_FRAMES).fill(Infinity)
  private floorAt = 0
  private quietRun = 0
  /** Samples before the open chunk. */
  private startSample = 0
  private n = 0
  private done = false

  constructor(options: ChunkerOptions) {
    this.rate = options.sampleRate
    this.frameSize = Math.round(this.rate * FRAME_SECONDS)
    const min = options.minChunk ?? 6
    const max = Math.max(options.maxChunk ?? 12, min)
    if (!(min > 0)) throw new Error('minChunk must be positive')
    this.minFrames = Math.max(1, Math.ceil(min / FRAME_SECONDS - 1e-9))
    this.maxFrames = Math.max(this.minFrames, Math.floor(max / FRAME_SECONDS + 1e-9))
    this.onFrame = options.onFrame
    const capacity = (this.maxFrames + 1) * this.frameSize
    this.left = new Float32Array(capacity)
    this.right = new Float32Array(capacity)
    this.frameLevel = new Float32Array(this.maxFrames)
    this.frameSpeech = new Uint8Array(this.maxFrames)
  }

  /** Takes the next samples of both channels; returns the chunks that closed. */
  push(left: Float32Array, right: Float32Array): ClosedChunk[] {
    if (left.length !== right.length) throw new Error('channels differ in length')
    if (this.done) throw new Error('the chunker was flushed')
    const out: ClosedChunk[] = []
    for (let i = 0; i < left.length;) {
      const frameEnd = (this.frames + 1) * this.frameSize
      const take = Math.min(left.length - i, frameEnd - this.len)
      this.left.set(left.subarray(i, i + take), this.len)
      this.right.set(right.subarray(i, i + take), this.len)
      this.len += take
      i += take
      if (this.len === frameEnd) this.endFrame(out)
    }
    return out
  }

  /** The open chunk as the last one, unless it is too short or silent. The chunker is spent. */
  flush(): ClosedChunk | undefined {
    if (this.done) return undefined
    this.done = true
    const out: ClosedChunk[] = []
    if (this.len >= MIN_FINAL_SECONDS * this.rate) this.close(this.len, this.frames, out)
    return out[0]
  }

  private endFrame(out: ClosedChunk[]): void {
    const from = this.frames * this.frameSize
    const to = from + this.frameSize
    const level = Math.max(rms(this.left, from, to), rms(this.right, from, to))
    const db = toDb(level)
    this.floorRing[this.floorAt] = db
    this.floorAt = (this.floorAt + 1) % FLOOR_FRAMES
    let floor = Infinity
    for (const v of this.floorRing) if (v < floor) floor = v
    const threshold = Math.min(MAX_THRESHOLD_DB, Math.max(MIN_THRESHOLD_DB, floor + MARGIN_DB))
    const speech = db >= threshold
    this.frameLevel[this.frames] = level
    this.frameSpeech[this.frames] = speech ? 1 : 0
    this.frames++
    this.quietRun = speech ? 0 : this.quietRun + 1
    this.onFrame?.(level)

    if (this.frames >= this.maxFrames) {
      this.cutAt(this.quietestCut(), out)
    } else if (this.frames >= this.minFrames && this.quietRun >= PAUSE_FRAMES) {
      // Cut in the pause's middle, leaving the next chunk a little of its silence.
      const carry = Math.min(
        Math.floor(this.quietRun / 2),
        Math.floor(PAUSE_FRAMES / 2),
        this.frames - this.minFrames,
      )
      this.cutAt(this.frames - carry, out)
    }
  }

  /** The frame boundary just after the quietest frame of the last two seconds (the latest, on a tie). */
  private quietestCut(): number {
    const lo = Math.max(this.minFrames, this.frames - SEARCH_FRAMES) - 1
    let best = this.frames - 1
    for (let f = this.frames - 1; f >= Math.max(0, lo); f--) {
      if (this.frameLevel[f]! < this.frameLevel[best]!) best = f
    }
    return best + 1
  }

  private cutAt(cutFrames: number, out: ClosedChunk[]): void {
    this.close(cutFrames * this.frameSize, cutFrames, out)
  }

  /** Hands back the first `samples` (the first `frames` complete frames) and keeps the rest open. */
  private close(samples: number, frames: number, out: ClosedChunk[]): void {
    let speech = 0
    for (let f = 0; f < frames; f++) speech += this.frameSpeech[f]!
    if (speech >= MIN_SPEECH_FRAMES) {
      out.push({
        n: this.n++,
        start: this.startSample / this.rate,
        duration: samples / this.rate,
        left: this.left.slice(0, samples),
        right: this.right.slice(0, samples),
      })
    }
    this.startSample += samples
    this.left.copyWithin(0, samples, this.len)
    this.right.copyWithin(0, samples, this.len)
    this.len -= samples
    this.frameLevel.copyWithin(0, frames, this.frames)
    this.frameSpeech.copyWithin(0, frames, this.frames)
    this.frames -= frames
  }
}
