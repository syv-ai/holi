/** A WAV file from float samples: 16-bit PCM, channels interleaved. No DOM. */

const HEADER_BYTES = 44

/** Encodes equally long channels (-1..1, clipped outside) as a 16-bit PCM WAV. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  const count = channels.length
  if (count === 0) throw new Error('a WAV needs at least one channel')
  const frames = channels[0]!.length
  if (channels.some((c) => c.length !== frames)) throw new Error('WAV channels differ in length')
  const blockAlign = count * 2
  const dataBytes = frames * blockAlign
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, count, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true) // byte rate
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  const pcm = new Int16Array(buffer, HEADER_BYTES)
  for (let c = 0; c < count; c++) {
    const channel = channels[c]!
    for (let i = 0, o = c; i < frames; i++, o += count) {
      const s = Math.max(-1, Math.min(1, channel[i]!))
      pcm[o] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff)
    }
  }
  return buffer
}
