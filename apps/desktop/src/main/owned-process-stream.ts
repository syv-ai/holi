import { Transform, type TransformCallback } from 'node:stream'

/** Strip one private completion marker while preserving every preceding byte. */
export function completionStream(marker: Buffer): Transform {
  if (marker.length === 0) throw new Error('completion marker must not be empty')
  let pending = Buffer.alloc(0)
  let complete = false

  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback: TransformCallback) {
      if (complete) return callback(new Error('data received after completion marker'))
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      pending = Buffer.concat([pending, bytes])
      const markerAt = pending.indexOf(marker)
      if (markerAt >= 0) {
        if (markerAt > 0) this.push(pending.subarray(0, markerAt))
        pending = Buffer.alloc(0)
        complete = true
        this.push(null)
        return callback()
      }
      const retain = Math.min(marker.length - 1, pending.length)
      const emitLength = pending.length - retain
      if (emitLength > 0) {
        this.push(pending.subarray(0, emitLength))
        pending = pending.subarray(emitLength)
      }
      callback()
    },
    flush(callback) {
      if (!complete && pending.length) this.push(pending)
      pending = Buffer.alloc(0)
      callback()
    },
  })
}
