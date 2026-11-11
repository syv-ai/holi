/**
 * What else in the meeting a person's prompt is about: BM25 over ~20 s
 * windows of consecutive lines (docs/features/meetings.md, Send). Measured
 * on five labelled meetings against syv.ai's Claes classifier, this free
 * ranking matched or beat it (held-out AUC 0.84, recall@5 0.65), so it is
 * what Send offers (not-built has the measurement).
 *
 * The configuration is the measured one: windows cut where a line starts 20
 * s or more after the window's first, lowercased words, Danish stopwords,
 * each word cut to its first five characters (a cheap stemmer that measured
 * best), k1 1.2, b 0.75, the top five with any match.
 *
 * Pure: no `electron`, no I/O.
 */
import type { Segment } from '../shared/meeting'

/** One window of lines and how well it matches. */
export interface Related {
  /** Its lines' `i`, ascending and consecutive. */
  lines: number[]
  start: number
  end: number
  /** Its lines' words, joined. */
  text: string
  score: number
}

const WINDOW_S = 20
const PREFIX = 5
const TOP = 5
const K1 = 1.2
const B = 0.75

/** Words that say nothing about a subject: Danish function words and the
 *  fillers a transcript is full of. */
const STOP = new Set(
  `og i at det en den til er som på de med han af for ikke der var mig sig men et har om vi min havde
ham hun nu over da fra du ud sin dem os op man hans hvor eller hvad skal selv her alle vil blev kunne
ind når være dog noget ville jo deres efter ned skulle denne end dette mit også under have dig anden
hende mine alt meget sit sine vor mod disse hvis din nogle hos blive mange ad bliver hendes været
thi jer sådan øh øhm mh ja nej okay altså så lige godt bare kan få gør gøre ik jeg
lidt sige siger tror tænker ved nogen hele helt rigtig rigtigt fordi egentlig jamen
nå nåh yes mhm hm sgu vel nok mere måske faktisk`.split(/\s+/),
)

/** A text's words as BM25 counts them. */
function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-zæøåéü0-9]+/g) ?? [])
    .filter((t) => t.length >= 2 && !STOP.has(t))
    .map((t) => t.slice(0, PREFIX))
}

/** The lines cut into windows: a new one where a line starts 20 s or more
 *  after the window's first, or where the lines stop being consecutive. */
function windows(segments: readonly Segment[]): Segment[][] {
  const out: Segment[][] = []
  let cur: Segment[] = []
  for (const s of segments) {
    const first = cur[0]
    const prev = cur.at(-1)
    if (first !== undefined && (s.start >= first.start + WINDOW_S || s.i !== prev!.i + 1)) {
      out.push(cur)
      cur = []
    }
    cur.push(s)
  }
  if (cur.length > 0) out.push(cur)
  return out
}

/**
 * The windows of `segments` outside `exclude` that best match `query`, best
 * first: at most five, only those sharing a word with it. Nothing for a
 * query with no words that count.
 */
export function relatedWindows(
  segments: readonly Segment[],
  query: string,
  exclude: ReadonlySet<number> = new Set(),
): Related[] {
  const q = [...new Set(terms(query))]
  if (q.length === 0) return []
  const ws = windows(segments.filter((s) => !exclude.has(s.i)))
  const docs = ws.map((w) => terms(w.map((s) => s.text).join(' ')))
  const n = docs.length
  if (n === 0) return []
  const avg = docs.reduce((a, d) => a + d.length, 0) / n
  const df = new Map<string, number>()
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1)
  const idf = (t: string) => {
    const c = df.get(t) ?? 0
    return Math.log(1 + (n - c + 0.5) / (c + 0.5))
  }
  const scored = docs.map((d, k) => {
    const tf = new Map<string, number>()
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const t of q) {
      const f = tf.get(t)
      if (f === undefined) continue
      score += (idf(t) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / (avg || 1)))
    }
    return { k, score }
  })
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.k - b.k)
    .slice(0, TOP)
    .map(({ k, score }) => {
      const w = ws[k]!
      return {
        lines: w.map((s) => s.i),
        start: w[0]!.start,
        end: w.at(-1)!.end,
        text: w.map((s) => s.text.trim()).join(' '),
        score: Math.round(score * 1000) / 1000,
      }
    })
}
