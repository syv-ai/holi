import { Transform, type TransformCallback } from 'node:stream'

/** Strip one private completion marker while preserving every preceding byte. */
export function completionStream(marker: Buffer): Transform {
  if (marker.length === 0) throw new Error('completion marker must not be empty')
  let pending = Buffer.alloc(0)
  let complete = false

  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback: TransformCallback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (complete) {
        const kind = bytes.includes(Buffer.from('[holi-complete-'))
          ? 'private-completion'
          : bytes.includes(Buffer.from('[holi-owned-process]'))
            ? 'private-trace'
            : bytes.includes(Buffer.from('CLIXML')) || bytes.includes(Buffer.from('<Objs'))
              ? 'powershell-xml'
              : bytes.length === 0
                ? 'empty'
                : /^\s+$/.test(bytes.toString('utf8'))
                  ? 'whitespace'
                  : 'other'
        return callback(
          Object.assign(new Error('data received after completion marker'), {
            afterMarkerBytes: bytes.length,
            afterMarkerKind: kind,
          }),
        )
      }
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
