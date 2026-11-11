/** Loudness arithmetic for captured audio: plain numbers, no DOM. */

/** Root mean square of `samples[from..to)`; 0 for an empty range. */
export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  if (to <= from) return 0
  let sum = 0
  for (let i = from; i < to; i++) {
    const v = samples[i]!
    sum += v * v
  }
  return Math.sqrt(sum / (to - from))
}

/** Decibels relative to full scale. Silence is a very low number, never -Infinity. */
export function toDb(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-10))
}

/** How loud an RMS sounds, 0..1: -60 dBFS and below is 0, -10 dBFS and above is 1.
 *  Speech at an ordinary level (about -30 dBFS) sits a little past the middle. */
export function loudness(value: number): number {
  return Math.min(1, Math.max(0, (toDb(value) + 60) / 50))
}
