import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { checkArchiveSize } from '../renderer/archive-size'

/** A zip of `files`, stored rather than deflated: what the check reads is
 *  the size each entry declares, whatever its compression. */
function zip(files: Record<string, number>): Uint8Array<ArrayBuffer> {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, size] of Object.entries(files)) {
    const nameBytes = Buffer.from(name)
    const data = Buffer.alloc(size, 0x61)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(size, 20)
    entry.writeUInt32LE(size, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    central.push(entry, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, directory, end]))
}

const LIMITS = { maxEntries: 3, maxEntryBytes: 100, maxTotalBytes: 250 }

describe('an archive’s size', () => {
  it('lets a file within every limit through', async () => {
    await expect(checkArchiveSize(zip({ a: 100, b: 100 }), LIMITS)).resolves.toBeUndefined()
  })

  it('refuses one entry that unpacks too large', async () => {
    await expect(checkArchiveSize(zip({ a: 101 }), LIMITS)).rejects.toThrow(/too large/)
  })

  it('refuses entries that together unpack too large', async () => {
    await expect(checkArchiveSize(zip({ a: 100, b: 100, c: 51 }), LIMITS)).rejects.toThrow(
      /too large/,
    )
  })

  it('leaves a file whose directory it cannot read to the renderer', async () => {
    const junk = new Uint8Array(new TextEncoder().encode('not a zip at all'))
    await expect(checkArchiveSize(junk, LIMITS)).resolves.toBeUndefined()
  })

  it('refuses too many entries', async () => {
    await expect(checkArchiveSize(zip({ a: 1, b: 1, c: 1, d: 1 }), LIMITS)).rejects.toThrow(
      /too many/,
    )
  })
})
