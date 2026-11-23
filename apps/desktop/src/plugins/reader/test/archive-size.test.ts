import { crc32, deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { checkBookArchive, checkOfficeArchive } from '../renderer/archive-size'

interface Entry {
  name: string
  /** What it unpacks to. */
  size: number
  /** What its directory claims it unpacks to, as a hostile file may lie;
   *  given, the entry is deflated, otherwise stored. */
  declare?: number
  /** Flagged a directory (the MS-DOS attribute), whatever it holds. */
  directory?: boolean
}

/** A zip of `entries`. `count` is what the end record says it holds. */
function zip(entries: Entry[], count = entries.length): Uint8Array<ArrayBuffer> {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const { name, size, declare, directory } of entries) {
    const nameBytes = Buffer.from(name)
    const raw = Buffer.alloc(size, 0x61)
    const crc = crc32(raw)
    const data = declare === undefined ? raw : deflateRawSync(raw)
    const method = declare === undefined ? 0 : 8
    const claimed = declare ?? size
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(claimed, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(method, 10)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(data.length, 20)
    record.writeUInt32LE(claimed, 24)
    record.writeUInt16LE(nameBytes.length, 28)
    record.writeUInt32LE(directory === true ? 0x10 : 0, 38)
    record.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    central.push(record, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, directory, end]))
}

const LIMITS = { maxEntries: 3, maxEntryBytes: 100, maxTotalBytes: 250 }

const sized = (sizes: number[], declare?: number): Entry[] =>
  sizes.map((size, i) => ({ name: `f${i}`, size, declare }))

describe.each([
  ['Word or deck', checkOfficeArchive],
  ['book', checkBookArchive],
])('a %s archive’s size', (_, check) => {
  it('lets a file within every limit through, stored or deflated', async () => {
    await expect(check(zip(sized([100, 100])), LIMITS)).resolves.toBeUndefined()
    await expect(check(zip(sized([100, 100], 100)), LIMITS)).resolves.toBeUndefined()
  })

  it('refuses one entry that unpacks too large', async () => {
    await expect(check(zip(sized([101])), LIMITS)).rejects.toThrow(/too large/)
  })

  it('refuses entries that together unpack too large', async () => {
    await expect(check(zip(sized([100, 100, 51])), LIMITS)).rejects.toThrow(/too large/)
  })

  it('refuses an entry that inflates past the few bytes it declares', async () => {
    await expect(check(zip(sized([101], 10)), LIMITS)).rejects.toThrow(/too large/)
  })

  it('refuses too many entries', async () => {
    await expect(check(zip(sized([1, 1, 1, 1])), LIMITS)).rejects.toThrow(/too many/)
  })

  it('refuses a file it cannot unpack, rather than leave it to the renderer', async () => {
    const junk = new Uint8Array(new TextEncoder().encode('not a zip at all'))
    await expect(check(junk, LIMITS)).rejects.toThrow(/can be unpacked/)
  })
})

describe('what each renderer’s own reader finds', () => {
  it('counts the entries JSZip reads past an end record that undercounts them', async () => {
    const hidden = zip(
      [
        { name: 'a', size: 1 },
        { name: 'word/document.xml', size: 101, declare: 10 },
      ],
      1,
    )
    await expect(checkOfficeArchive(hidden, LIMITS)).rejects.toThrow(/too large/)
  })

  it('counts a book entry flagged as a directory, which foliate still reads by name', async () => {
    const flagged = zip([{ name: 'OEBPS/ch1.xhtml', size: 101, directory: true }])
    await expect(checkBookArchive(flagged, LIMITS)).rejects.toThrow(/too large/)
  })
})
