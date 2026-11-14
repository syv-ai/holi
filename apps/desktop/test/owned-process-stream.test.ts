import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { completionStream } from '../src/main/owned-process-stream'

async function read(stream: PassThrough): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

describe('owned process completion stream', () => {
  it('strips markers across every byte boundary without changing binary payload', async () => {
    const marker = Buffer.from('marker-☃-private')
    const payload = Buffer.from([0, 0xff, 0xc3, 0x28, 10, 13])
    for (let split = 0; split <= marker.length; split++) {
      const stream = new PassThrough()
      const clean = completionStream(marker)
      stream.pipe(clean)
      const result = read(clean as PassThrough)
      stream.write(payload)
      stream.write(marker.subarray(0, split))
      stream.end(marker.subarray(split))
      expect(await result).toEqual(payload)
    }
  })

  it('keeps an ordinary EOF and payload intact when there is no marker', async () => {
    const source = new PassThrough()
    const clean = completionStream(Buffer.from('secret-marker'))
    source.pipe(clean)
    const result = read(clean as PassThrough)
    source.end(Buffer.from('ordinary eof'))
    expect(await result).toEqual(Buffer.from('ordinary eof'))
  })

  it('bounds retained bytes to the possible marker prefix', () => {
    const marker = Buffer.from('a sufficiently long completion marker')
    const clean = completionStream(marker)
    clean.write(Buffer.alloc(4096, 0x78))
    expect((clean as unknown as { _writableState: { length: number } })._writableState.length).toBe(
      0,
    )
  })
})
