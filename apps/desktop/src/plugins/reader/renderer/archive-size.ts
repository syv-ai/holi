/**
 * How large a file may unpack (docs/features/reader.md). Every format is a zip
 * archive, and a small one can hold far more than it weighs: docx-preview and
 * foliate bound nothing they inflate, and the deck renderer's `zipLimits` only
 * weigh an entry once it is inflated. An archive's directory declares its own
 * sizes, so a hostile one can claim a few bytes and inflate to gigabytes.
 *
 * So a file is unpacked here first, every entry as a stream into a counter
 * that stops at a limit, before its renderer sees it. It is unpacked by the
 * same zip reader its renderer uses, since two readers can find different
 * entries in the same bytes: JSZip for Word and PowerPoint, foliate's zip.js
 * for books. Each is imported only when its format opens. An archive the
 * reader cannot unpack is refused: the renderer would fail on it too. The
 * limits are the deck renderer's recommended ones.
 */
import type JSZip from 'jszip'

interface ArchiveLimits {
  maxEntries: number
  maxEntryBytes: number
  maxTotalBytes: number
}

const MB = 1024 * 1024

/** `RECOMMENDED_ZIP_LIMITS` of `@aiden0z/pptx-renderer`. */
const LIMITS: ArchiveLimits = { maxEntries: 4000, maxEntryBytes: 32 * MB, maxTotalBytes: 256 * MB }

const UNREADABLE = 'It is not an archive that can be unpacked.'

/** Why a file is not opened, as the reader shows it. */
class Refused extends Error {}

/** What an archive has unpacked so far, against `limits`. Throws `Refused`
 *  the moment an entry, or all of them together, goes past. */
class Budget {
  private total = 0

  constructor(private readonly limits: ArchiveLimits) {}

  entries(count: number): void {
    if (count > this.limits.maxEntries)
      throw new Refused(`It holds too many files (${count}) to open.`)
  }

  /** A counter for one entry's output, chunk by chunk. */
  entry(): (bytes: number) => void {
    let entry = 0
    return (bytes) => {
      entry += bytes
      this.total += bytes
      if (entry > this.limits.maxEntryBytes || this.total > this.limits.maxTotalBytes)
        throw new Refused('It unpacks too large to open.')
    }
  }
}

/** An entry's output as a stream: the JSZip method `async()` is built on
 *  (`lib/zipObject.js`), documented, but left out of its type declarations. */
type Streamable = { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> }

/** A Word document or a deck, unpacked as their renderers' JSZip unpacks it. */
export async function checkOfficeArchive(
  bytes: Uint8Array<ArrayBuffer>,
  limits: ArchiveLimits = LIMITS,
): Promise<void> {
  const { default: JSZip } = await import('jszip')
  const budget = new Budget(limits)
  let zip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    throw new Refused(UNREADABLE)
  }
  // Every entry, directories too: the renderers look files up by name.
  const files = Object.values(zip.files)
  budget.entries(files.length)
  for (const file of files) {
    const count = budget.entry()
    await new Promise<void>((resolve, reject) => {
      const stream = (file as unknown as Streamable).internalStream('uint8array')
      stream
        .on('data', (chunk) => {
          try {
            count(chunk.byteLength)
          } catch (refused) {
            stream.pause()
            reject(refused)
          }
        })
        .on('error', () => reject(new Refused(UNREADABLE)))
        .on('end', () => resolve())
        .resume()
    })
  }
}

/** A book, unpacked as foliate's zip.js unpacks it. */
export async function checkBookArchive(
  bytes: Uint8Array<ArrayBuffer>,
  limits: ArchiveLimits = LIMITS,
): Promise<void> {
  const { BlobReader, ZipReader, configure } = await import('./vendor/foliate/vendor/zip.js')
  configure({ useWebWorkers: false })
  const budget = new Budget(limits)
  const reader = new ZipReader(new BlobReader(new Blob([bytes])))
  // Kept as well as thrown: zip.js may not pass the counter's own error through.
  const stopped: { by?: unknown } = {}
  try {
    // Every entry, those flagged as directories too: foliate looks files up
    // by name and never reads the flag.
    const files = await reader.getEntries()
    budget.entries(files.length)
    for (const file of files) {
      const count = budget.entry()
      await file.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            try {
              count(chunk.byteLength)
            } catch (refused) {
              stopped.by = refused
              throw refused
            }
          },
        }),
      )
    }
  } catch (error) {
    if (error instanceof Refused) throw error
    throw stopped.by ?? new Refused(UNREADABLE)
  } finally {
    await reader.close()
  }
}
