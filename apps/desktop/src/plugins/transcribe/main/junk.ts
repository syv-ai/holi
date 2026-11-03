/**
 * What the speech model says that nobody said (docs/features/meetings.md).
 *
 * The VAD keeps silence and noise from the model, but a short burst it lets
 * through (laughter, a jingle, music) still comes back as a line, and the
 * service gives no confidence to judge it by (`avg_logprob` and
 * `no_speech_prob` are always 0). So a line is judged by what it says, how
 * long it is and what is around it:
 *
 * - **Junk** (`ASR_JUNK`): broadcast credits and captions, dropped wherever
 *   they are.
 * - **Loops**: a line of subtitle timestamps ("05:03: Sygt nok * 06:03: Sygt
 *   nok"), or one that compresses past Whisper's 2.4 (`compression_ratio`).
 * - **Echo**: a Me line that is the speakers heard by the microphone, the same
 *   words at the same time as a Them line.
 * - **Bursts**: a line under 2.5 s that is a broadcast cliché
 *   (`BROADCAST_CLICHES`: "TV 2", "Horsens centrum", "Det er den sidste
 *   station i Herning"), or one or two words under 1.5 s with nobody speaking
 *   within 3 s either side.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { gzipSync } from 'node:zlib'
import type { ChunkSegment } from './stitcher'

/**
 * Whole segments that are a model's hallucination, never speech: Danish
 * broadcast credits and subtitle captions, and their English kin. Matched
 * against the segment's text trimmed of surrounding punctuation, whole,
 * case-insensitively; a sentence that merely mentions DR is kept. What a
 * person could say, only short, is in `BROADCAST_CLICHES`.
 *
 * @public exported for its test
 */
export const ASR_JUNK: readonly RegExp[] = [
  // "DR", "DR1", "DR P1", "DR P4 Fælles", "DR K", "DR Ramasjang"
  /^dr ?(\d|p ?\d( [a-zæøå]+)?|k|ramasjang|nyheder)?$/i,
  // "P2:", "P1"
  /^p ?\d$/i,
  // "Tekster af …", "Tekstet af …", "Tekst: …"
  /^tekst(er|et)?( af\b|:)/i,
  /^tekst(er|et)?$/i,
  // "Undertekster …", "Undertekstning …"
  /^undertekst\w*\b/i,
  // "Danske tekster …"
  /^danske tekster\b/i,
  // "Tak fordi du så med", "Tak, fordi I lyttede med"
  /^tak,? fordi (du|i) (så|lyttede|kiggede|fulgte) med$/i,
  /^(subtitles?|captions?) (by|from)\b/i,
  /^thanks? (you )?for watching\b/i,
  /^amara\.org\b/i,
]

/** A line's text without surrounding punctuation, its spaces single. */
export const trimmed = (text: string): string =>
  text
    .trim()
    .replace(/^[\s"'“”«»().,:;!?…*[\]-]+|[\s"'“”«»().,:;!?…*[\]-]+$/g, '')
    .replace(/\s+/g, ' ')

/** @public exported for its test */
export function isAsrJunk(text: string): boolean {
  const t = trimmed(text)
  return t === '' || ASR_JUNK.some((re) => re.test(t))
}

/** A place's name: a capitalised word or two ("Horsens", "Aarhus Nord"). */
const PLACE = String.raw`\p{Lu}[\p{L}-]*(?: \p{Lu}[\p{L}-]*)?`

/** One entry of `BROADCAST_CLICHES`. */
interface Cliche {
  /** Matched against the whole line, trimmed of surrounding punctuation. */
  re: RegExp
  /**
   * A name a sentence may end on ("…og så tog vi til Horsens centrum"): only
   * a line at most five words long with no other line on its channel within
   * 3 s is dropped. Otherwise the whole announcement is the cliché, and a
   * line of at most eight words is dropped wherever it is.
   */
  alone: boolean
}

/**
 * What the model answers a jingle, laughter or a second of music with: the
 * broadcast captions it was trained on. A person may say any of them, so only
 * a line shorter than 2.5 s is dropped for it. Matched whole, against the
 * line trimmed of surrounding punctuation; a place's name must be
 * capitalised, as the model writes one.
 *
 * @public exported for its test
 */
export const BROADCAST_CLICHES: readonly Cliche[] = [
  // Channels: "TV 2", "TV2 News", "TV 3", "DR", "DR P3", "P4 København", "Kanal 5", "Radio 24syv"
  {
    re: /^(tv ?\d+( (news|nyhederne|sport|charlie|echo|fri|play|lorry|øst|fyn|nord|syd))?|dr ?(\d|p ?\d|k|tv|nyheder)?|p ?\d( \p{L}+)?|kanal ?\d+|radio \p{L}+)$/iu,
    alone: true,
  },
  // "Station", "Næste station", "Stop", "Næste stop"
  { re: /^(næste )?(station|stop|stoppested)$/iu, alone: true },
  // A place and nothing more: "Horsens centrum", "Nørreport station", "Aarhus H"
  {
    re: new RegExp(`^${PLACE} (centrum|station|st|havn|banegård|H)$`, 'u'),
    alone: true,
  },
  // What a caption says of music: "Musik", "[Musik]", "Applaus"
  { re: /^(musik|applaus|latter|klapsalver|jingle|music|applause)$/iu, alone: true },
  // Announcements: "Det er den sidste station i Herning", "Næste station er Aarhus H",
  // "Næste stop: Nørreport", "Endestation Hillerød"
  {
    re: new RegExp(
      `^(?:[Dd]et er )?(?:[Dd]en )?(?:(?:[Ss]idste|[Nn]æste) (?:station|stop)(?:pested)?|[Ee]ndestation)(?:en)?(?: er)?:?(?: i| på| ved)? ${PLACE}$`,
      'u',
    ),
    alone: false,
  },
  // "Velkommen til TV 2", "Velkommen til DR Nyheder"
  { re: /^(og )?velkommen til (tv ?\d|dr|p ?\d|kanal ?\d)\b/i, alone: false },
]

/** Normalised words: lowercase, no punctuation. */
const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')

/** Whisper's measure of a loop, as the service computes it: the text's UTF-8
 *  bytes over their gzip. @public exported for its test */
export function compressionRatio(text: string): number {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length === 0) return 0
  return bytes.length / gzipSync(bytes, { level: 9 }).length
}

/** Whisper's threshold: above it, a decode is a loop. */
const MAX_COMPRESSION = 2.4

const STAMP = /\b\d{1,2}:\d{2}\b/

/**
 * Subtitle cues instead of speech: two or more timestamps, used as cues
 * ("05:03: …", a stamp followed by a colon) or each followed by the same
 * words ("05:03 sygt nok 06:03 sygt nok"). "Fra 10:00 til 11:00" says times
 * and is kept.
 *
 * @public exported for its test
 */
export function isTimestampLoop(text: string): boolean {
  const parts = text.split(STAMP)
  if (parts.length < 3) return false
  const cues = parts.slice(1).filter((p) => /^:(\s|$)/.test(p)).length
  if (cues >= 2) return true
  const said = parts
    .slice(1)
    .map((p) => words(p).join(' '))
    .filter((p) => p.split(' ').length >= 2)
  return new Set(said).size < said.length
}

/** Token-set (Jaccard) similarity of two lines' normalised words, 0 to 1.
 *  @public exported for its test */
export function similarity(a: string, b: string): number {
  const x = new Set(words(a))
  const y = new Set(words(b))
  if (x.size === 0 || y.size === 0) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / (x.size + y.size - both)
}

/**
 * Echo: a Me line at least half of which a Them line covers, with at least
 * this similarity. The one real echo measured (a 6 s sentence, the
 * microphone's copy garbled) was 0.36; the most two people talking over each
 * other came to was 0.19. Half of the Me line, not of the shorter: a long Me
 * line over a short Them line that shares a few of its words (0.33 seen) is
 * someone speaking, and holds more than any echo of the short one.
 */
const ECHO_SIMILARITY = 0.3
const ECHO_OVERLAP = 0.5
/** Bursts: shorter than this… */
const BURST_SECONDS = 2.5
/** …at most this many words for a name, or for an announcement… */
const NAME_WORDS = 5
const PHRASE_WORDS = 8
/** …and a neighbour is a line within this many seconds. */
const NEIGHBOUR_SECONDS = 3
/** A line this short, of at most this many words, with no neighbour on
 *  either channel, is a burst whatever it says. */
const LONE_SECONDS = 1.5
const LONE_WORDS = 2

type Timed = Pick<ChunkSegment, 'speaker' | 'start' | 'end'>

const seconds = (s: Timed): number => s.end - s.start
const gap = (a: Timed, b: Timed): number => Math.max(0, b.start - a.end, a.start - b.end)
const overlap = (a: Timed, b: Timed): number =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/** A line dropped, and why. */
export interface Dropped {
  segment: ChunkSegment
  reason: string
}

const loopOf = (s: ChunkSegment): string | null => {
  if (isTimestampLoop(s.text)) return 'timestamp loop'
  const ratio = s.compression ?? compressionRatio(s.text)
  return ratio > MAX_COMPRESSION ? `compression ratio ${ratio.toFixed(2)}` : null
}

const echoOf = (s: ChunkSegment, lines: readonly ChunkSegment[]): string | null => {
  if (s.speaker !== 'Me') return null
  for (const t of lines) {
    if (t.speaker !== 'Them') continue
    if (seconds(s) <= 0 || overlap(s, t) < ECHO_OVERLAP * seconds(s)) continue
    const alike = similarity(s.text, t.text)
    if (alike >= ECHO_SIMILARITY)
      return `echo of Them at ${t.start.toFixed(1)}s (${alike.toFixed(2)})`
  }
  return null
}

const burstOf = (s: ChunkSegment, around: readonly Timed[]): string | null => {
  const long = seconds(s)
  if (long >= BURST_SECONDS) return null
  const n = words(s.text).length
  const near = (same: boolean) =>
    around.some(
      (o) => o !== s && (o.speaker === s.speaker) === same && gap(s, o) <= NEIGHBOUR_SECONDS,
    )
  const text = trimmed(s.text)
  const cliche = BROADCAST_CLICHES.find((c) => c.re.test(text))
  if (cliche !== undefined && (cliche.alone ? n <= NAME_WORDS && !near(true) : n <= PHRASE_WORDS)) {
    return `broadcast cliché, ${long.toFixed(1)}s`
  }
  if (n <= LONE_WORDS && long < LONE_SECONDS && !near(true) && !near(false)) {
    return `lone burst, ${long.toFixed(1)}s`
  }
  return null
}

/**
 * One chunk's lines without what nobody said: loops first, then echo (the Them
 * line is kept: the computer's own sound is the clean copy), then bursts,
 * judged against the lines left and `earlier`, the transcript before the
 * chunk. Lines of later chunks are not here yet, so a burst near a chunk's
 * end is judged on what came before it, as an answer is.
 */
export function dropHallucinations(
  lines: readonly ChunkSegment[],
  earlier: readonly Timed[] = [],
): { kept: ChunkSegment[]; dropped: Dropped[] } {
  const dropped: Dropped[] = []
  const pass = (list: readonly ChunkSegment[], why: (s: ChunkSegment) => string | null) =>
    list.filter((s) => {
      const reason = why(s)
      if (reason !== null) dropped.push({ segment: s, reason })
      return reason === null
    })
  const looped = pass(lines, loopOf)
  const echoed = pass(looped, (s) => echoOf(s, looped))
  const around = [...earlier, ...echoed]
  const kept = pass(echoed, (s) => burstOf(s, around))
  return { kept, dropped }
}
