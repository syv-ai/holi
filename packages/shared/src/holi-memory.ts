/**
 * A Holi's memory (docs/features/holis.md, Memory): `MEMORY.md` in its folder,
 * one dated fact per bullet, with topic notes in `memory/` beside it and what
 * no longer fits in `memory/archive.md`.
 *
 * ```
 * - 2026-10-04 · The customer prefers proposals in Danish · until 2026-11-01
 * - ~~2026-09-01 · Old fact~~ · superseded 2026-10-04
 * ```
 *
 * Edits are text in and text out, so every entry the agent writes has the same
 * shape: one dated bullet, superseded rather than deleted, and never a secret.
 * Lines without a date are a person's own and are never moved.
 *
 * Ported from MonoCode's `monoMemory.ts` (MIT, Copyright (c) 2026 Nick; see
 * apps/desktop/src/plugins/holis/NOTICE.md).
 *
 * Pure and browser-safe: the Memory page and `holi holis memory` read the same
 * rules.
 */

/** How much of `MEMORY.md` goes into a run: whole lines, up to both. */
export const MEMORY_MAX_LINES = 200
export const MEMORY_MAX_BYTES = 24 * 1024

/** One entry is at most this long, so a single note cannot crowd out the rest. */
export const MEMORY_ENTRY_MAX = 1000

/** The memory file, its topic folder and the archive, inside a Holi's folder. */
export const MEMORY_FILE = 'MEMORY.md'
export const MEMORY_TOPICS_DIR = 'memory'
export const MEMORY_ARCHIVE = 'archive'

const DATED = /^- (?:~~)?(\d{4}-\d{2}-\d{2}) · /
const UNTIL = / · until (\d{4}-\d{2}-\d{2})\s*$/

/** The local calendar date, the way entries are dated. */
export function memoryDate(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
]

/** Anything that looks like a credential, replaced before it reaches disk: a
 *  Holi's memory is committed and synced like any note. */
export function redactSecrets(text: string): string {
  return SECRETS.reduce(
    (out, pattern) => out.replace(pattern, (match) => `«redacted ${match.length} chars»`),
    text,
  )
}

/** A fact as one dated bullet: `- 2026-10-04 · fact · until 2026-11-01`. */
export function memoryEntry(fact: string, date: string, until?: string): string {
  const text = redactSecrets(fact).replace(/\s+/g, ' ').trim()
  if (text === '') throw new Error('the fact is empty')
  if (text.length > MEMORY_ENTRY_MAX) {
    throw new Error(`a fact is at most ${MEMORY_ENTRY_MAX} characters`)
  }
  if (until !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    throw new Error('`until` is a date like 2026-10-31')
  }
  return `- ${date} · ${text}${until === undefined ? '' : ` · until ${until}`}`
}

function lines(text: string): string[] {
  return text.trim() === '' ? [] : text.replace(/\s+$/, '').split('\n')
}

function join(list: readonly string[]): string {
  return list.length === 0 ? '' : `${list.join('\n')}\n`
}

/** The fact a line holds, without its date, strike-through or until. */
function factOf(line: string): string {
  return line
    .replace(DATED, '')
    .replace(/^- /, '')
    .replace(UNTIL, '')
    .replace(/~~/g, '')
    .replace(/ · superseded \d{4}-\d{2}-\d{2}$/, '')
    .trim()
}

/** The entry appended, unless the same fact is already there. */
export function addMemoryEntry(text: string, entry: string): { text: string; added: boolean } {
  const list = lines(text)
  const fact = factOf(entry)
  if (list.some((line) => !line.includes('~~') && factOf(line) === fact)) {
    return { text: join(list), added: false }
  }
  return { text: join([...list, entry]), added: true }
}

/** The one live line containing `find`; anything else is an error in words. */
function findLine(list: readonly string[], find: string): number {
  const needle = find.trim()
  if (needle === '') throw new Error('`find` is empty')
  const hits = list.flatMap((line, i) => (line.includes(needle) && !line.includes('~~') ? [i] : []))
  if (hits.length === 0)
    throw new Error('no memory entry contains that text; read the memory first')
  if (hits.length > 1) {
    throw new Error(`${hits.length} entries contain that text; quote more of the one you mean`)
  }
  return hits[0]!
}

/** The old line struck through and the new fact after it, so the file itself
 *  shows what changed and when. */
export function supersedeMemoryEntry(
  text: string,
  find: string,
  entry: string,
  date: string,
): string {
  const list = lines(text)
  const index = findLine(list, find)
  const old = list[index]!
  const struck = old.startsWith('- ')
    ? `- ~~${old.slice(2)}~~ · superseded ${date}`
    : `~~${old}~~ · superseded ${date}`
  list.splice(index, 1, struck, entry)
  return join(list)
}

/** A line taken out entirely, for an entry that was simply wrong. */
export function removeMemoryEntry(text: string, find: string): { text: string; removed: string } {
  const list = lines(text)
  const index = findLine(list, find)
  const [removed] = list.splice(index, 1)
  return { text: join(list), removed: removed! }
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length

function overBudget(list: readonly string[]): boolean {
  return list.length > MEMORY_MAX_LINES || bytesOf(join(list)) > MEMORY_MAX_BYTES
}

/**
 * `MEMORY.md` kept within what loads by moving the oldest dated entries out to
 * the archive: struck-through ones first, then expired ones, then the oldest
 * live ones. A person's undated lines and `keep` (the entry just written)
 * never move, so the file can still overflow when those fill it alone.
 */
export function fitMemoryBudget(
  text: string,
  keep: string | undefined,
  date: string,
): { text: string; moved: string[] } {
  const list = lines(text)
  const moved: string[] = []
  const movable = (line: string): boolean => DATED.test(line) && line !== keep
  const expired = (line: string): boolean => {
    const until = UNTIL.exec(line)?.[1]
    return until !== undefined && until < date
  }
  const passes = [
    (line: string) => movable(line) && line.includes('~~'),
    (line: string) => movable(line) && expired(line),
    movable,
  ]
  for (const pick of passes) {
    while (overBudget(list)) {
      const index = list.findIndex(pick)
      if (index < 0) break
      moved.push(...list.splice(index, 1))
    }
  }
  return { text: join(list), moved }
}

/** Lines moved out of `MEMORY.md`, appended to the archive with the day. */
export function archiveMemoryEntries(
  archive: string,
  moved: readonly string[],
  date: string,
): string {
  const header = lines(archive).length > 0 ? lines(archive) : ['# Archive', '']
  return join([...header, ...moved.map((line) => `${line} · moved ${date}`)])
}

/**
 * What of `MEMORY.md` goes into a run: whole lines from the top while they
 * fit, and how many did not.
 */
export function loadedMemory(text: string): { text: string; dropped: number } {
  const list = lines(text)
  const kept: string[] = []
  let bytes = 0
  for (const line of list) {
    const size = bytesOf(line) + 1
    if (kept.length >= MEMORY_MAX_LINES || bytes + size > MEMORY_MAX_BYTES) break
    kept.push(line)
    bytes += size
  }
  return { text: join(kept), dropped: list.length - kept.length }
}

/** A topic note's name: letters, digits, spaces, dots and dashes. */
export function topicName(value: string): string {
  const name = value.trim().replace(/\.md$/i, '')
  if (
    name === '' ||
    name.length > 80 ||
    name.startsWith('.') ||
    name.toLowerCase() === MEMORY_ARCHIVE ||
    !/^[A-Za-z0-9 ._-]+$/.test(name)
  ) {
    throw new Error('a topic is a short name of letters, digits, spaces, dots and dashes')
  }
  return name
}

export interface MemoryHit {
  file: string
  line: string
  date?: string
}

/** Words too common to say which note a question is after. */
const STOPWORDS = new Set(
  "the and for are was were with that this what when where which who how why did does have has had you your our not but can will from into about there their them then than just any all its it's".split(
    ' ',
  ),
)

function queryWords(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_.-]+/u)
        .map((word) => word.replace(/^[.-]+|[.-]+$/g, ''))
        .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
    ),
  ]
}

/** `2026-10-01`, or a span back from `today`: `7d`, `24h`, `2w`. */
export function sinceDate(value: string, today: Date): string {
  const span = /^(\d{1,4})\s*([hdw])$/i.exec(value.trim())
  if (span !== null) {
    const unit = span[2]!.toLowerCase() as 'h' | 'd' | 'w'
    const hours = Number(span[1]) * { h: 1, d: 24, w: 24 * 7 }[unit]
    return memoryDate(new Date(today.getTime() - hours * 3_600_000))
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim()
  throw new Error('`since` is a date like 2026-10-01 or a span like 7d')
}

/**
 * Lines across a Holi's memory that share words with `query`, best first. A
 * long query needs two of its words on a line, so common words alone do not
 * drag in half the file. Newer entries win ties.
 */
export function searchMemory(
  files: readonly { file: string; text: string }[],
  query: string,
  options: { since?: string; limit?: number } = {},
): MemoryHit[] {
  const words = queryWords(query)
  if (words.length === 0 && options.since === undefined) {
    throw new Error('the query needs a word of three letters or more')
  }
  const needed = words.length >= 4 ? 2 : words.length > 0 ? 1 : 0
  const hits: (MemoryHit & { score: number })[] = []
  for (const { file, text } of files) {
    for (const line of text.split('\n')) {
      if (line.trim() === '' || line.startsWith('# ')) continue
      const date = DATED.exec(line)?.[1]
      if (options.since !== undefined && (date === undefined || date < options.since)) continue
      const lower = line.toLowerCase()
      const score = words.filter((word) => lower.includes(word)).length
      if (score < needed) continue
      hits.push({ file, line, ...(date === undefined ? {} : { date }), score })
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, options.limit ?? 20)
    .map(({ score: _score, ...hit }) => hit)
}

/** One line of `MEMORY.md` as the Memory page lists it. */
export interface MemoryLine {
  /** The line's index in the file, for editing or forgetting it. */
  index: number
  /** The fact itself, without its bullet, date or markers. */
  text: string
  date?: string
  until?: string
  /** Superseded by a newer entry; kept for the record. */
  struck: boolean
}

/** `MEMORY.md` as a list of facts. Blank lines and headings are left out; any
 *  other line is a fact, dated or not, so a hand-written file lists too. */
export function memoryLines(text: string): MemoryLine[] {
  const out: MemoryLine[] = []
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    if (line === '' || /^#{1,6}\s/.test(line)) return
    const struck = /^- ~~/.test(line)
    const date = DATED.exec(line)?.[1]
    const until = UNTIL.exec(line)?.[1]
    const fact = line
      .replace(/^[-*]\s+/, '')
      .replace(/~~/g, '')
      .replace(/^\d{4}-\d{2}-\d{2} · /, '')
      .replace(UNTIL, '')
      .replace(/ · (?:superseded|moved) \d{4}-\d{2}-\d{2}.*$/, '')
      .trim()
    if (fact === '') return
    out.push({
      index,
      text: fact,
      struck,
      ...(date === undefined ? {} : { date }),
      ...(until === undefined ? {} : { until }),
    })
  })
  return out
}

/** The file without one of its lines. */
export function withoutLine(text: string, index: number): string {
  const list = text.split('\n')
  list.splice(index, 1)
  return list.join('\n')
}

/** The file with one fact reworded in place. A dated entry is redated to
 *  today and keeps its until; a line a person wrote stays undated. */
export function withLineEdited(text: string, index: number, fact: string, date: string): string {
  const list = text.split('\n')
  const old = list[index] ?? ''
  if (DATED.test(old.trim())) {
    list[index] = memoryEntry(fact, date, UNTIL.exec(old)?.[1])
  } else {
    const clean = redactSecrets(fact).replace(/\s+/g, ' ').trim()
    if (clean === '') throw new Error('the fact is empty')
    list[index] = `${/^\s*[-*]\s+/.exec(old)?.[0] ?? '- '}${clean}`
  }
  return list.join('\n')
}
