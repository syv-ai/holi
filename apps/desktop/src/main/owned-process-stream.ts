import { Transform, type TransformCallback } from 'node:stream'

/** The marker terminates retained output, not the native ownership proof. */
export function completionStream(marker: Buffer): Transform {
  if (marker.length === 0) throw new Error('completion marker must not be empty')
  let pending = Buffer.alloc(0)
  let complete = false
  const trailing = () => new Error('data received after completion marker')

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      if (complete) return callback(chunk.length ? trailing() : undefined)
      const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk
      const markerAt = bytes.indexOf(marker)
      if (markerAt >= 0) {
        if (markerAt > 0) this.push(bytes.subarray(0, markerAt))
        if (markerAt + marker.length !== bytes.length) return callback(trailing())
        pending = Buffer.alloc(0)
        complete = true
        this.push(null)
      } else {
        const emit = Math.max(0, bytes.length - marker.length + 1)
        if (emit) this.push(bytes.subarray(0, emit))
        pending = Buffer.from(bytes.subarray(emit))
      }
      callback()
    },
    flush(callback) {
      if (pending.length) this.push(pending)
      pending = Buffer.alloc(0)
      callback()
    },
  })
}
