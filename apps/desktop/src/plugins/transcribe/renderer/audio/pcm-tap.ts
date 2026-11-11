/**
 * The AudioWorklet that hands the merged stereo signal to the page as raw
 * samples. It is source text, loaded through a `blob:` URL: a worklet module
 * must be its own script, and a string needs nothing from the bundler (the
 * renderer's CSP sets no `script-src`, so `blob:` is allowed in dev and in a
 * packaged build alike). It stays tiny on purpose; everything that can be a
 * plain function lives in the modules beside it.
 *
 * It batches render quanta into blocks of `BLOCK` frames and posts each as
 * `{ left, right }` (transferred, not copied). A missing input (nothing playing
 * yet) is posted as silence, so the stream's clock never skips. Sent `'flush'`,
 * it posts what it holds and then `'flushed'`.
 */

export const PCM_TAP = 'holi-pcm-tap'

/** What the tap posts to the page. */
export type TapMessage = { left: Float32Array; right: Float32Array } | 'flushed'

export const PCM_TAP_SOURCE = `
const BLOCK = 1024
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.left = new Float32Array(BLOCK)
    this.right = new Float32Array(BLOCK)
    this.fill = 0
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return
      this.send()
      this.port.postMessage('flushed')
    }
  }
  send() {
    if (this.fill === 0) return
    const left = this.left.slice(0, this.fill)
    const right = this.right.slice(0, this.fill)
    this.fill = 0
    this.port.postMessage({ left, right }, [left.buffer, right.buffer])
  }
  process(inputs) {
    const input = inputs[0] || []
    const l = input[0]
    const r = input[1]
    const frames = l ? l.length : 128
    for (let i = 0; i < frames; i++) {
      this.left[this.fill] = l ? l[i] : 0
      this.right[this.fill] = r ? r[i] : 0
      this.fill++
      if (this.fill === BLOCK) this.send()
    }
    return true
  }
}
registerProcessor('${PCM_TAP}', PcmTap)
`
