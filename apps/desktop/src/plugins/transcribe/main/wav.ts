/**
 * The captured audio as main reads it: 16-bit PCM WAV, stereo with the
 * microphone left and the computer's sound right (a mono file is all
 * microphone). Main uploads a mono mix, which halves the upload, or, when both
 * sides speak in a chunk, each channel on its own (`stitcher.ts` says which).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */

export interface Pcm {
  rate: number
  /** The microphone. */
  left: Int16Array
  /** The computer's sound; the microphone again for a mono file. */
  right: Int16Array
  channels: 1 | 2
}

function bad(why: string): never {
  throw new Error(`not a 16-bit PCM WAV: ${why}`)
}

/** Read a RIFF/WAVE file's `fmt ` and `data` chunks. */
export function parseWav(bytes: Uint8Array): Pcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') bad('no RIFF header')
  let format: { channels: number; rate: number; bits: number } | null = null
  let at = 12
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ') {
      if (view.getUint16(body, true) !== 1) bad('not PCM')
      format = {
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      if (format === null) bad('data before fmt')
      if (format.bits !== 16) bad(`${format.bits}-bit`)
      if (format.channels !== 1 && format.channels !== 2) bad(`${format.channels} channels`)
      // A recorder that stopped mid-write leaves a size past the end.
      const end = Math.min(body + size, bytes.byteLength)
      const frames = Math.floor((end - body) / (2 * format.channels))
      const left = new Int16Array(frames)
      const right = new Int16Array(frames)
      for (let f = 0; f < frames; f++) {
        const o = body + f * 2 * format.channels
        left[f] = view.getInt16(o, true)
        right[f] = format.channels === 2 ? view.getInt16(o + 2, true) : left[f]!
      }
      return { rate: format.rate, left, right, channels: format.channels }
    }
    at = body + size + (size % 2)
  }
  return bad('no data chunk')
}

/** A 16-bit PCM WAV of `channels` interleaved. */
export function encodeWav(rate: number, channels: Int16Array[]): Uint8Array {
  const frames = channels[0]?.length ?? 0
  const n = channels.length
  const bytes = new Uint8Array(44 + frames * n * 2)
  const view = new DataView(bytes.buffer)
  const put = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) bytes[at + i] = s.charCodeAt(i)
  }
  put(0, 'RIFF')
  view.setUint32(4, 36 + frames * n * 2, true)
  put(8, 'WAVE')
  put(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, n, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * n * 2, true)
  view.setUint16(32, n * 2, true)
  view.setUint16(34, 16, true)
  put(36, 'data')
  view.setUint32(40, frames * n * 2, true)
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < n; c++) view.setInt16(44 + (f * n + c) * 2, channels[c]![f]!, true)
  }
  return bytes
}

/** The two channels averaged, as a mono WAV. */
export function monoWav(pcm: Pcm): Uint8Array {
  if (pcm.channels === 1) return encodeWav(pcm.rate, [pcm.left])
  const mono = new Int16Array(pcm.left.length)
  for (let i = 0; i < mono.length; i++) mono[i] = (pcm.left[i]! + pcm.right[i]!) >> 1
  return encodeWav(pcm.rate, [mono])
}

/** One channel as a mono WAV: the microphone (`left`) or the computer. */
export function channelWav(pcm: Pcm, side: 'left' | 'right'): Uint8Array {
  return encodeWav(pcm.rate, [pcm[side]])
}

/** Root mean square of one channel between two times, in seconds. */
export function rms(samples: Int16Array, rate: number, from: number, to: number): number {
  const a = Math.max(0, Math.floor(from * rate))
  const b = Math.min(samples.length, Math.ceil(to * rate))
  if (b <= a) return 0
  let sum = 0
  for (let i = a; i < b; i++) sum += samples[i]! * samples[i]!
  return Math.sqrt(sum / (b - a))
}

/** Seconds of audio in a WAV, or null when it cannot be read. */
export function wavSeconds(bytes: Uint8Array): number | null {
  try {
    const pcm = parseWav(bytes)
    return pcm.left.length / pcm.rate
  } catch {
    return null
  }
}
