/**
 * A streaming sample-rate converter for one channel: a Blackman-windowed sinc,
 * low-passed below the lower rate's Nyquist so 48 kHz speech folds no hiss into
 * 16 kHz. Output sample j is the input at time j/to exactly (the filter looks
 * ahead rather than delaying), so a channel's length and timing survive the
 * conversion. Blocks may be any size; only the filter's reach is kept between them.
 */

/** Zero crossings of the sinc on each side of the centre: the filter's sharpness. */
const ZERO_CROSSINGS = 10
/** Where the pass band ends, as a share of the lower rate's Nyquist. */
const PASS = 0.92
/** Kernel table steps per input sample (linear interpolation between them). */
const TABLE_STEPS = 256

export class Resampler {
  /** Input samples per output sample. */
  private readonly step: number
  /** Kernel reach on each side, in input samples. */
  private readonly half: number
  private readonly table: Float32Array
  private buf = new Float32Array(4096)
  private bufLen = 0
  /** Absolute input index of `buf[0]`. */
  private bufStart = 0
  /** Output samples made so far. */
  private made = 0
  private readonly same: boolean

  constructor(from: number, to: number) {
    if (!(from > 0 && to > 0)) throw new Error('sample rates must be positive')
    this.same = from === to
    this.step = from / to
    // Cut-off in cycles per input sample.
    const cutoff = 0.5 * Math.min(1, to / from) * PASS
    this.half = Math.ceil(ZERO_CROSSINGS / (2 * cutoff))
    const size = this.half * TABLE_STEPS + 2
    this.table = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      const d = i / TABLE_STEPS
      const x = d / this.half
      if (x >= 1) continue
      const arg = 2 * cutoff * d
      const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg)
      const window = 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x)
      this.table[i] = sinc * window
    }
  }

  /** Converts the next block; returns what is ready (the last few samples wait for more input). */
  push(input: Float32Array): Float32Array {
    if (this.same) return input.slice()
    this.append(input)
    return this.produce(Infinity)
  }

  /** The rest, as if the input ended in silence. The resampler is spent afterwards. */
  flush(): Float32Array {
    if (this.same) return new Float32Array(0)
    const end = this.bufStart + this.bufLen
    this.append(new Float32Array(this.half + 1))
    return this.produce(end)
  }

  private append(input: Float32Array): void {
    // Drop what no later output can reach, then make room.
    const keepFrom = Math.max(this.bufStart, Math.floor(this.made * this.step) - this.half)
    const drop = keepFrom - this.bufStart
    if (drop > 0) {
      this.buf.copyWithin(0, drop, this.bufLen)
      this.bufLen -= drop
      this.bufStart = keepFrom
    }
    if (this.bufLen + input.length > this.buf.length) {
      const grown = new Float32Array(Math.max(this.buf.length * 2, this.bufLen + input.length))
      grown.set(this.buf.subarray(0, this.bufLen))
      this.buf = grown
    }
    this.buf.set(input, this.bufLen)
    this.bufLen += input.length
  }

  /** Makes every output that lies before input index `end` and whose kernel the buffer covers. */
  private produce(end: number): Float32Array {
    const available = this.bufStart + this.bufLen
    const out = new Float32Array(Math.ceil(this.bufLen / this.step) + 1)
    let n = 0
    for (;;) {
      const p = this.made * this.step
      if (p >= end || Math.floor(p) + this.half >= available) break
      out[n++] = this.sample(p)
      this.made++
    }
    return out.slice(0, n)
  }

  private sample(p: number): number {
    const centre = Math.floor(p)
    let sum = 0
    let weight = 0
    for (let k = centre - this.half + 1; k <= centre + this.half; k++) {
      const pos = Math.abs(p - k) * TABLE_STEPS
      const i = Math.floor(pos)
      const t = pos - i
      const h = this.table[i]! * (1 - t) + this.table[i + 1]! * t
      weight += h
      const at = k - this.bufStart
      // Before the first sample there is silence.
      if (at >= 0 && at < this.bufLen) sum += this.buf[at]! * h
    }
    return weight === 0 ? 0 : sum / weight
  }
}
