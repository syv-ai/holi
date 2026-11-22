/**
 * How large a Word document or a book may unpack (docs/features/reader.md).
 * Both are zip archives, and a small one can hold far more than it weighs:
 * neither docx-preview nor foliate bounds what it inflates, so an archive is
 * checked first, against the sizes its own directory declares, as the deck
 * renderer does with its `zipLimits`. The limits are that renderer's
 * recommended ones, so all three formats open under the same bound.
 */
import { BlobReader, ZipReader, configure } from './vendor/foliate/vendor/zip.js'

interface ArchiveLimits {
  maxEntries: number
  maxEntryBytes: number
  maxTotalBytes: number
}

const MB = 1024 * 1024

/** `RECOMMENDED_ZIP_LIMITS` of `@aiden0z/pptx-renderer`. */
const LIMITS: ArchiveLimits = { maxEntries: 4000, maxEntryBytes: 32 * MB, maxTotalBytes: 256 * MB }

/** Rejects, saying why, when `bytes` would unpack past `limits`. Reads only
 *  the archive's directory; nothing is inflated. */
export async function checkArchiveSize(
  bytes: Uint8Array<ArrayBuffer>,
  limits: ArchiveLimits = LIMITS,
): Promise<void> {
  configure({ useWebWorkers: false })
  const reader = new ZipReader(new BlobReader(new Blob([bytes])))
  let files
  try {
    files = (await reader.getEntries()).filter((entry) => !entry.directory)
  } finally {
    await reader.close()
  }
  if (files.length > limits.maxEntries)
    throw new Error(`It holds too many files (${files.length}) to open.`)
  let total = 0
  for (const file of files) {
    total += file.uncompressedSize
    if (file.uncompressedSize > limits.maxEntryBytes || total > limits.maxTotalBytes)
      throw new Error('It unpacks too large to open.')
  }
}
