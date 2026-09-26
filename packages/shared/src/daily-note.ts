/** Daily notes: the path shape, the seed, and the untouched-stub heuristic, shared by
 * main (which mints and sweeps the note) and the renderer (which displays it).
 * See docs/features/daily-notes.md.
 *
 * Every function takes the date as an ISO `YYYY-MM-DD` **string**, never a `Date` (D44):
 * the caller resolves the local date, and tests pass a date instead of injecting a clock.
 */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAILY_FILENAME_RE = /^\d{2}-\d{2}-\d{4}\.md$/
const DAILY_FRONTMATTER_RE = /^---\s*\n[^]*?\btype:\s*daily-note\b[^]*?\n---/

/** `YYYY-MM-DD` → `DD-MM-YYYY`. Throws on a date that isn't real: the stem becomes the
 * note's path, so a junk date must never get far enough to create a file. */
export function dailyNoteStem(isoDate: string): string {
  const m = ISO_DATE_RE.exec(isoDate)
  if (!m) throw new Error(`daily note: expected an ISO YYYY-MM-DD date, got "${isoDate}"`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  // Day 0 of the next month is the last of this one — catches 02-30 and friends.
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) {
    throw new Error(`daily note: "${isoDate}" is not a real date`)
  }
  return `${m[3]}-${m[2]}-${m[1]}`
}

/** The daily note's path: `DD-MM-YYYY.md`, at the personal vault root. */
export function dailyNoteFilename(isoDate: string): string {
  return `${dailyNoteStem(isoDate)}.md`
}

/** The seed, written when the note is created. Deterministic for a date, so two offline
 * devices write the same blob. The title is the `DD-MM-YYYY` stem so it matches the
 * filename, and so `isUntouchedDailyNote` can recognise a note nobody has written in.
 * The two are a matched pair; change one and the sweep stops deleting stubs (or starts
 * deleting real notes). */
export function buildDailyNoteContent(isoDate: string): string {
  return `---\ntype: daily-note\ndate: ${isoDate}\n---\n\n# ${dailyNoteStem(isoDate)}\n\n`
}

/** Path-shape check for tagging tree leaves without reading content. A **display
 * predicate only**: the sweep selects on the `type: daily-note` marker (D46), never on
 * this, so a hand-authored note that merely looks like a date is never swept or deleted. */
export function isDailyNoteFilename(name: string): boolean {
  return DAILY_FILENAME_RE.test(name)
}

/** Whether a note's frontmatter declares it a daily note: the sweep's selector (D46). */
export function isDailyNote(content: string): boolean {
  return DAILY_FRONTMATTER_RE.test(content)
}

/** Split `---\n…\n---\n` off the front, or null if there is no frontmatter block.
 *
 * Deliberately **not** `task-file.ts`'s splitter: that one *throws*, because malformed
 * task frontmatter must fail loudly. Here anything unclassifiable must be silently kept,
 * since the caller's next move is a delete.
 */
function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('---')) return null
  const afterOpen = trimmed.slice(3).replace(/^[\r\n]+/, '')
  const end = afterOpen.indexOf('\n---')
  if (end === -1) return null
  return { yaml: afterOpen.slice(0, end), body: afterOpen.slice(end + 4) }
}

/** Whether a daily note is a disposable stub: the body after the frontmatter is empty,
 * or is only the seeded `# <stem>` title.
 *
 * A note that cannot be **positively** classified as a stub returns false and is kept.
 * There is no orphan rescue, so a wrong `true` here is an unrecoverable delete.
 */
export function isUntouchedDailyNote(text: string, stem: string): boolean {
  const split = splitFrontmatter(text)
  if (!split) return false
  const body = split.body.trim()
  return body === '' || body === `# ${stem}`
}
