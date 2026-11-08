/**
 * Where the reader is in each book, on this machine (docs/features/reader.md):
 * the book's location (an EPUB CFI) per vault and path, kept in local storage
 * and read back when the book opens. Read and written directly, not through an
 * atom: a page turn saves it, and nothing on screen depends on it.
 */
const KEY = 'holi.reader.epubPositions'

/** How many books are remembered; the least recently read go first. */
const MAX_BOOKS = 200

type Positions = Record<string, string>

function load(): Positions {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return parsed !== null && typeof parsed === 'object' ? (parsed as Positions) : {}
  } catch {
    return {}
  }
}

const bookKey = (remote: string, path: string) => `${remote}\n${path}`

/** The location this machine last read `path` at, if any. */
export function readPosition(remote: string, path: string): string | undefined {
  const cfi = load()[bookKey(remote, path)]
  return typeof cfi === 'string' ? cfi : undefined
}

/** Remembers `cfi` as where `path` was last read, as the most recent book. */
export function savePosition(remote: string, path: string, cfi: string): void {
  const positions = load()
  const key = bookKey(remote, path)
  delete positions[key]
  positions[key] = cfi
  const keys = Object.keys(positions)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_BOOKS))) delete positions[old]
  try {
    localStorage.setItem(KEY, JSON.stringify(positions))
  } catch {
    // Storage full or unavailable: the book opens at its start next time.
  }
}
