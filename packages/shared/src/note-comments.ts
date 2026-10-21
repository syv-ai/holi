/**
 * Comment threads on a note (docs/features/note-comments.md): where they are
 * kept, how a thread finds its passage again after the note changed, how two
 * people's comments merge, and who a comment mentions.
 *
 * **A sidecar per note.** A note's threads live in
 * `.holi/comments/<note path>.json`, committed like the note, so a thread never
 * touches the note's text, its diffs or anything exported from it, and one file
 * per note keeps a merge to the two people who commented on the same note.
 *
 * **Keyed, never listed.** Threads and comments are objects keyed by a random
 * id, not arrays, so two comments added on two machines are two keys and merge
 * without a conflict (`mergeCommentsText`). The text is `formatRecord`'s:
 * keys sorted, so equal content is equal bytes.
 *
 * **Anchored to a quote, not a position.** A thread holds the text it is about
 * with a little context either side and the line it was on, and is placed
 * again every time the note is read (`locateAnchor`), the way the W3C's
 * TextQuoteSelector does it. A thread whose passage cannot be found is
 * detached: still listed, never dropped.
 *
 * Browser-safe: no `node:` imports.
 */
import { formatRecord } from './app-store'
import { sameLogin } from './task-file'

/** Where every note's threads live. */
export const COMMENTS_DIR = '.holi/comments'

/** The sidecar holding `notePath`'s threads. */
export function commentsPathFor(notePath: string): string {
  return `${COMMENTS_DIR}/${notePath}.json`
}

/** The note a sidecar belongs to, or null for a path that is not one. */
export function notePathOfComments(path: string): string | null {
  if (!path.startsWith(`${COMMENTS_DIR}/`) || !path.endsWith('.json')) return null
  const note = path.slice(COMMENTS_DIR.length + 1, -'.json'.length)
  return note === '' ? null : note
}

/** How much text either side of a quote the anchor keeps. */
export const ANCHOR_CONTEXT = 32

/** What a thread is about: the passage, the text around it, and its line. */
export interface CommentAnchor {
  quote: string
  prefix: string
  suffix: string
  /** 1-based, where the passage started when the thread was made. A hint for
   *  choosing between equal matches, never a position on its own. */
  line: number
}

export interface NoteComment {
  id: string
  /** The GitHub login of the person who wrote it. */
  author: string
  /** Written by that person's agent, on their behalf. */
  agent?: true
  /** ISO 8601. */
  at: string
  /** Markdown text. */
  body: string
}

/** The last resolve or reopen. A thread that has neither is open. */
export interface CommentStatus {
  resolved: boolean
  by: string
  at: string
}

export interface CommentThread {
  id: string
  anchor: CommentAnchor
  /** Oldest first; the first opened the thread. */
  comments: NoteComment[]
  status: CommentStatus | null
}

/** The sidecar as it is on disk, by id. */
export interface CommentsFile {
  threads: Record<string, StoredThread>
}

interface StoredThread {
  anchor: CommentAnchor
  comments: Record<string, Omit<NoteComment, 'id'>>
  status?: CommentStatus
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const str = (v: unknown): v is string => typeof v === 'string'

function readAnchor(v: unknown): CommentAnchor | null {
  if (!isObject(v) || !str(v.quote) || v.quote === '') return null
  const line = typeof v.line === 'number' && Number.isInteger(v.line) && v.line > 0 ? v.line : 1
  return {
    quote: v.quote,
    prefix: str(v.prefix) ? v.prefix : '',
    suffix: str(v.suffix) ? v.suffix : '',
    line,
  }
}

function readComment(v: unknown): Omit<NoteComment, 'id'> | null {
  if (!isObject(v) || !str(v.author) || !str(v.at) || !str(v.body)) return null
  return { author: v.author, at: v.at, body: v.body, ...(v.agent === true ? { agent: true } : {}) }
}

function readStatus(v: unknown): CommentStatus | null {
  if (!isObject(v) || typeof v.resolved !== 'boolean' || !str(v.by) || !str(v.at)) return null
  return { resolved: v.resolved, by: v.by, at: v.at }
}

/**
 * A sidecar's text as threads. Lenient: a thread without a quote, or a comment
 * missing its author, time or body, is left out rather than failing the file,
 * which a person may have edited by hand. Null when it is not a JSON object.
 */
export function parseCommentsFile(text: string): CommentsFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw)) return null
  const threads: Record<string, StoredThread> = {}
  for (const [id, t] of Object.entries(isObject(raw.threads) ? raw.threads : {})) {
    if (!isObject(t)) continue
    const anchor = readAnchor(t.anchor)
    if (anchor === null) continue
    const comments: StoredThread['comments'] = {}
    for (const [cid, c] of Object.entries(isObject(t.comments) ? t.comments : {})) {
      const comment = readComment(c)
      if (comment !== null) comments[cid] = comment
    }
    if (Object.keys(comments).length === 0) continue
    const status = readStatus(t.status)
    threads[id] = { anchor, comments, ...(status === null ? {} : { status }) }
  }
  return { threads }
}

export const emptyCommentsFile = (): CommentsFile => ({ threads: {} })

/** A sidecar's text: keys sorted, so equal threads are equal bytes. */
export function formatCommentsFile(file: CommentsFile): string {
  return formatRecord(file)
}

const byTime = (a: { at: string; id: string }, b: { at: string; id: string }): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** The threads in reading order: by line, then by when each was opened. */
export function commentThreads(file: CommentsFile): CommentThread[] {
  const threads = Object.entries(file.threads).map(([id, t]) => ({
    id,
    anchor: t.anchor,
    comments: Object.entries(t.comments)
      .map(([cid, c]) => ({ id: cid, ...c }))
      .sort(byTime),
    status: t.status ?? null,
  }))
  const opened = (t: CommentThread) => t.comments[0]?.at ?? ''
  return threads.sort(
    (a, b) =>
      a.anchor.line - b.anchor.line ||
      (opened(a) < opened(b) ? -1 : opened(a) > opened(b) ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  )
}

export const isResolved = (t: { status: CommentStatus | null }): boolean =>
  t.status?.resolved === true

/** `file` with a new thread opened by `comment`. */
export function withThread(
  file: CommentsFile,
  id: string,
  anchor: CommentAnchor,
  comment: NoteComment,
): CommentsFile {
  const { id: cid, ...rest } = comment
  return { threads: { ...file.threads, [id]: { anchor, comments: { [cid]: rest } } } }
}

/** `file` with `comment` added to thread `threadId`, or null when there is no
 *  such thread. */
export function withReply(
  file: CommentsFile,
  threadId: string,
  comment: NoteComment,
): CommentsFile | null {
  const thread = file.threads[threadId]
  if (thread === undefined) return null
  const { id: cid, ...rest } = comment
  return {
    threads: {
      ...file.threads,
      [threadId]: { ...thread, comments: { ...thread.comments, [cid]: rest } },
    },
  }
}

/** `file` with thread `threadId` resolved or reopened, or null when there is
 *  no such thread. */
export function withStatus(
  file: CommentsFile,
  threadId: string,
  status: CommentStatus,
): CommentsFile | null {
  const thread = file.threads[threadId]
  if (thread === undefined) return null
  return { threads: { ...file.threads, [threadId]: { ...thread, status } } }
}

// ------------------------------------------------------------------ anchoring

/** 1-based line of offset `pos`. */
function lineOf(doc: string, pos: number): number {
  let line = 1
  for (let i = doc.indexOf('\n'); i !== -1 && i < pos; i = doc.indexOf('\n', i + 1)) line++
  return line
}

/** The anchor for `doc.slice(from, to)`. */
export function anchorAt(doc: string, from: number, to: number): CommentAnchor {
  return {
    quote: doc.slice(from, to),
    prefix: doc.slice(Math.max(0, from - ANCHOR_CONTEXT), from),
    suffix: doc.slice(to, to + ANCHOR_CONTEXT),
    line: lineOf(doc, from),
  }
}

function occurrences(doc: string, needle: string): number[] {
  const out: number[] = []
  if (needle === '') return out
  for (let i = doc.indexOf(needle); i !== -1; i = doc.indexOf(needle, i + 1)) out.push(i)
  return out
}

/** How much of `prefix` ends right before `pos`, plus how much of `suffix`
 *  starts right at `end`. */
function contextScore(doc: string, from: number, to: number, a: CommentAnchor): number {
  let score = 0
  while (
    score < a.prefix.length &&
    from - score - 1 >= 0 &&
    doc[from - score - 1] === a.prefix[a.prefix.length - score - 1]
  ) {
    score++
  }
  let after = 0
  while (after < a.suffix.length && doc[to + after] === a.suffix[after]) after++
  return score + after
}

export interface AnchorRange {
  from: number
  to: number
}

/** The best of `candidates`: most context matching, then nearest the line. */
function best(doc: string, a: CommentAnchor, candidates: AnchorRange[]): AnchorRange | null {
  let pick: AnchorRange | null = null
  let pickScore = -1
  let pickDistance = Infinity
  for (const c of candidates) {
    const score = contextScore(doc, c.from, c.to, a)
    const distance = Math.abs(lineOf(doc, c.from) - a.line)
    if (score > pickScore || (score === pickScore && distance < pickDistance)) {
      pick = c
      pickScore = score
      pickDistance = distance
    }
  }
  return pick
}

/** The shortest a quote's head or tail may be and still mean something. */
const MIN_PIECE = 6

/**
 * Where `anchor`'s passage is in `doc` now, or null when it cannot be found
 * (the thread is then detached). Tried in order, the first that finds anything
 * winning:
 *
 * 1. **The quote, exactly**: wherever it moved to. Several matches are told
 *    apart by the context around them, then by the line.
 * 2. **Between its context**: the text before and after the passage are still
 *    there with something between them, of a plausible length: the passage was
 *    edited in place.
 * 3. **Between its own ends**: the quote's first and last thirds are still
 *    there, a plausible distance apart: it was edited in the middle.
 */
export function locateAnchor(doc: string, anchor: CommentAnchor): AnchorRange | null {
  const q = anchor.quote
  const exact = occurrences(doc, q).map((from) => ({ from, to: from + q.length }))
  if (exact.length > 0) return best(doc, anchor, exact)

  const longest = Math.max(q.length * 2, q.length + 64)
  const bracketed: AnchorRange[] = []
  if (anchor.prefix.length >= MIN_PIECE && anchor.suffix.length >= MIN_PIECE) {
    for (const p of occurrences(doc, anchor.prefix)) {
      const from = p + anchor.prefix.length
      const s = doc.indexOf(anchor.suffix, from)
      if (s > from && s - from <= longest) bracketed.push({ from, to: s })
    }
  }
  if (bracketed.length > 0) return best(doc, anchor, bracketed)

  const piece = Math.floor(q.length / 3)
  if (piece < MIN_PIECE) return null
  const head = q.slice(0, piece)
  const tail = q.slice(-piece)
  const ends: AnchorRange[] = []
  for (const h of occurrences(doc, head)) {
    const t = doc.indexOf(tail, h + head.length)
    if (t === -1) continue
    const to = t + tail.length
    if (to - h >= q.length / 2 && to - h <= q.length * 1.5 + 16) ends.push({ from: h, to })
  }
  return best(doc, anchor, ends)
}

// ---------------------------------------------------------------------- merge

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * One key's three-way choice: what changed on one side wins, an absent value
 * counts as a change (a deletion), and `both` settles a change on both sides.
 */
function pick<T>(
  base: T | undefined,
  ours: T | undefined,
  theirs: T | undefined,
  both: (ours: T, theirs: T) => T,
): T | undefined {
  if (same(ours, theirs) || same(theirs, base)) return ours
  if (same(ours, base)) return theirs
  // Changed on both sides. A deletion against an edit keeps the edit: a
  // comment someone answered is not one to lose.
  if (ours === undefined) return theirs
  if (theirs === undefined) return ours
  return both(ours, theirs)
}

function mergeKeyed<T>(
  base: Record<string, T>,
  ours: Record<string, T>,
  theirs: Record<string, T>,
  both: (ours: T, theirs: T, base: T | undefined) => T,
): Record<string, T> {
  const out: Record<string, T> = {}
  const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])
  for (const key of keys) {
    const b = Object.hasOwn(base, key) ? base[key] : undefined
    const value = pick(
      b,
      Object.hasOwn(ours, key) ? ours[key] : undefined,
      Object.hasOwn(theirs, key) ? theirs[key] : undefined,
      (o, t) => both(o, t, b),
    )
    if (value !== undefined) out[key] = value
  }
  return out
}

function mergeThread(
  ours: StoredThread,
  theirs: StoredThread,
  base: StoredThread | undefined,
): StoredThread {
  const anchor = pick(base?.anchor, ours.anchor, theirs.anchor, (o) => o) ?? ours.anchor
  // A comment is written once; both sides holding one id differently is a hand
  // edit, and ours is as good an answer as theirs.
  const comments = mergeKeyed(base?.comments ?? {}, ours.comments, theirs.comments, (o) => o)
  // Resolved on one machine, reopened on another: the later one stands.
  const status = pick(base?.status, ours.status, theirs.status, (o, t) => (t.at > o.at ? t : o))
  return { anchor, comments, ...(status === undefined ? {} : { status }) }
}

/**
 * Three-way merge of one sidecar: the git merge driver's body. Threads and
 * comments are unioned by id, so concurrent comments never conflict; a resolve
 * against a reopen keeps the later. It refuses only text that is not a
 * sidecar, which git then records as an ordinary conflict. `base` is null when
 * both sides created the file.
 */
export function mergeCommentsText(
  base: string | null,
  ours: string,
  theirs: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  const b = base === null ? emptyCommentsFile() : parseCommentsFile(base)
  const o = parseCommentsFile(ours)
  const t = parseCommentsFile(theirs)
  if (b === null || o === null || t === null) return { ok: false, reason: 'not a comments file' }
  return {
    ok: true,
    text: formatCommentsFile({ threads: mergeKeyed(b.threads, o.threads, t.threads, mergeThread) }),
  }
}

// ------------------------------------------------------------------- mentions

/**
 * The GitHub logins a comment mentions, lowercased: `@` and a login, not
 * inside a word, so `ada@syv.ai` mentions nobody.
 */
export function mentionedLogins(body: string): string[] {
  const out = new Set<string>()
  for (const m of body.matchAll(/(?:^|[^\w@./-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/g)) {
    out.add(m[1]!.toLowerCase())
  }
  return [...out]
}

export interface CommentMention {
  threadId: string
  comment: NoteComment
  /** The passage the thread is about. */
  quote: string
}

/**
 * The comments in `after` that `before` did not have, that mention `login`
 * and were written by someone else: what a pull brought that is addressed to
 * the person signed in here.
 */
export function newMentions(
  before: CommentsFile | null,
  after: CommentsFile,
  login: string,
): CommentMention[] {
  const me = login.toLowerCase()
  const out: CommentMention[] = []
  for (const thread of commentThreads(after)) {
    const had = before?.threads[thread.id]?.comments ?? {}
    for (const comment of thread.comments) {
      if (Object.hasOwn(had, comment.id)) continue
      if (sameLogin(comment.author, login)) continue
      if (!mentionedLogins(comment.body).includes(me)) continue
      out.push({ threadId: thread.id, comment, quote: thread.anchor.quote })
    }
  }
  return out
}

// ---------------------------------------------------------------- the CLI form

/** `YYYY-MM-DD HH:MM`, in local time unless a zone is given (tests pass UTC). */
function minute(iso: string, timeZone: string | undefined): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** Who wrote a comment, as the panel says it. */
export const commentByline = (c: Pick<NoteComment, 'author' | 'agent'>): string =>
  c.agent === true ? `${c.author}'s agent` : c.author

/** A thread as `holi comments list` prints it, with where it is now. */
export interface LocatedThread extends CommentThread {
  /** 1-based line the passage is on now, or null when it is detached. */
  line: number | null
}

const quoted = (text: string): string[] =>
  text.split(/\r\n|\r|\n/).map((line) => `  > ${line}`.trimEnd())

export function formatNoteComments(
  path: string,
  threads: LocatedThread[],
  opts: { timeZone?: string } = {},
): string {
  if (threads.length === 0) return `No comments on ${path}.`
  const open = threads.filter((t) => !isResolved(t)).length
  const count = [
    `${open} open`,
    ...(threads.length > open ? [`${threads.length - open} resolved`] : []),
  ].join(', ')
  const blocks = threads.map((t) => {
    const where = t.line === null ? 'detached, the passage is gone' : `line ${t.line}`
    const on = t.anchor.quote.replace(/\s+/g, ' ').trim()
    const lines = [`Thread ${t.id} on "${on}" (${where})`]
    t.comments.forEach((c, i) => {
      const lead = i === 0 ? '' : 'Reply, '
      lines.push(`  ${lead}${commentByline(c)}, ${minute(c.at, opts.timeZone)}`, ...quoted(c.body))
    })
    if (t.status !== null) {
      const verb = t.status.resolved ? 'Resolved' : 'Reopened'
      lines.push(`  ${verb} by ${t.status.by}, ${minute(t.status.at, opts.timeZone)}`)
    }
    return lines.join('\n')
  })
  return [`[From ${path}, ${count}]`, ...blocks].join('\n\n')
}
