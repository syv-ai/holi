/**
 * A meeting's tasks: what a person makes from the meeting (`taskCard`: a
 * group, a suggestion in one, or a stretch they picked, with what they ask
 * for) and what they change on one later (the UI's patch).
 *
 * A task carries transcript lines by index. Each quote is copied from the
 * stored segment by this code, so a quote on a task is what the transcript
 * says by construction, never a model's paraphrase.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { CapabilityError } from '../../../main/plugin-api'
import {
  lineAt,
  MAX_PROMPT,
  type Card,
  type CardKind,
  type CardStatus,
  type MeetingState,
  type Quote,
} from '../shared/meeting'

/**
 * The most tasks one meeting holds.
 *
 * @public exported for its test
 */
export const MAX_CARDS = 60
const MAX_TITLE = 120
const MAX_TEXT = 2000
const MAX_ITEMS = 20
const MAX_ITEM = 500

function bad(message: string): never {
  throw new CapabilityError('BAD_REQUEST', message)
}

function line(raw: unknown, key: string, max: number): string {
  if (typeof raw !== 'string') bad(`${key} must be text`)
  const value = raw.trim()
  if (value.length > max) bad(`${key} is over ${max} characters`)
  return value
}

function items(raw: unknown, key: string): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) bad(`${key} must be a list of text`)
  if (raw.length > MAX_ITEMS) bad(`${key} has over ${MAX_ITEMS} items`)
  return raw.map((x) => line(x, key, MAX_ITEM)).filter((x) => x !== '')
}

export function kindOf(raw: unknown): CardKind {
  if (raw !== 'feature' && raw !== 'action') bad('kind is feature or action')
  return raw
}

/** The quotes for `segments`, copied from the meeting's transcript. */
function quotesFor(meeting: MeetingState, segments: readonly number[]): Quote[] {
  return segments.map((i) => {
    const seg = lineAt(meeting.segments, i)
    if (seg === undefined) bad(`line ${i} is not in this meeting's transcript`)
    return { i, speaker: seg.speaker, start: seg.start, text: seg.text }
  })
}

/** A line's words changed: every card quoting it quotes the new words,
 *  still copied from the transcript. Changes `meeting.cards` in place. */
export function requote(meeting: MeetingState, i: number, now: number): void {
  const seg = meeting.segments[i]
  if (seg === undefined || seg.i !== i) return
  meeting.cards = meeting.cards.map((card) =>
    card.quotes.some((q) => q.i === i)
      ? {
          ...card,
          quotes: card.quotes.map((q) => (q.i === i ? { ...q, text: seg.text } : q)),
          updatedAt: now,
        }
      : card,
  )
}

/**
 * The most lines a task holds: a long stretch keeps its first lines, and
 * says how many it had.
 *
 * @public exported for its test
 */
export const MAX_TASK_LINES = 400
/** A title from the ask's first line, cut to this. */
const PROMPT_TITLE = 80

/** What a person makes a task from (`meeting.task.create`). */
export interface TaskRequest {
  /** The transcript lines it carries, any order: a group's, a suggestion's,
   *  related lines, or a stretch's. */
  lines: number[]
  /** What should be done. */
  prompt: string
  kind: CardKind
  /** Its title; else the ask's first line. */
  title?: string
  /** The group, and suggestion, it was made from. */
  from?: { topicId: string; suggestionId?: string }
  /** A task of this meeting not sent yet, made again from this request in
   *  its place: the retry of a send that failed, with the form as it is now. */
  cardId?: string
}

/** A task a person made, at once: its title given or the ask's first line,
 *  its why the ask, its segments the lines (sorted, the first
 *  `MAX_TASK_LINES`), quoted by code, accepted. Pushed onto
 *  `meeting.cards`, or, given `cardId`, put in that unsent task's place,
 *  keeping its id, its task file and when it was made. */
export function taskCard(meeting: MeetingState, req: TaskRequest, now: number): Card {
  const at = req.cardId === undefined ? -1 : meeting.cards.findIndex((c) => c.id === req.cardId)
  if (req.cardId !== undefined && at < 0) bad(`no task ${req.cardId} in this meeting`)
  const old = at < 0 ? undefined : meeting.cards[at]!
  if (old?.status === 'building') {
    throw new CapabilityError('CONFLICT', 'this task was sent already')
  }
  const prompt = req.prompt.trim()
  if (prompt === '') bad('say what should be done')
  if (prompt.length > MAX_PROMPT) bad(`the ask is over ${MAX_PROMPT} characters`)
  const lines = [...new Set(req.lines)].sort((a, b) => a - b)
  if (lines.length === 0) bad('a task needs lines of the meeting')
  if (old === undefined && meeting.cards.length >= MAX_CARDS) {
    bad(`this meeting already has ${MAX_CARDS} tasks`)
  }
  const segments = lines.slice(0, MAX_TASK_LINES)
  const quotes = quotesFor(meeting, segments)
  const first = prompt.split('\n', 1)[0]!.trim()
  const given = req.title?.trim() ?? ''
  const title =
    given !== ''
      ? given.slice(0, MAX_TITLE)
      : first.length > PROMPT_TITLE
        ? `${first.slice(0, PROMPT_TITLE - 1).trimEnd()}…`
        : first
  const byI = new Map(meeting.segments.map((s) => [s.i, s]))
  const card: Card = {
    id: old?.id ?? `c${meeting.cards.length + 1}`,
    kind: req.kind,
    title,
    why: prompt,
    segments,
    acceptance: [],
    openQuestions: [],
    quotes,
    status: 'accepted',
    origin: 'person',
    range: {
      start: byI.get(lines[0]!)!.start,
      end: Math.max(...lines.map((i) => byI.get(i)?.end ?? 0)),
      lines: lines.length,
    },
    ...(req.from === undefined ? {} : { from: req.from }),
    ...(old?.taskPath === undefined ? {} : { taskPath: old.taskPath }),
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
  }
  if (old === undefined) meeting.cards.push(card)
  else meeting.cards[at] = card
  return card
}

/** What a person may change on a task from the UI. `building` is Send's,
 *  not a patch's. */
export interface CardPatch {
  status?: Exclude<CardStatus, 'building' | 'suggested'>
  title?: string
  why?: string
  acceptance?: string[]
  openQuestions?: string[]
  owner?: string
}

const PATCH_KEYS = new Set(['status', 'title', 'why', 'acceptance', 'openQuestions', 'owner'])

export function cardPatchParam(raw: unknown): CardPatch {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('patch is an object')
  const p = raw as Record<string, unknown>
  for (const key of Object.keys(p))
    if (!PATCH_KEYS.has(key)) bad(`a card patch has no field ${key}`)
  const out: CardPatch = {}
  if (p.status !== undefined) {
    if (p.status !== 'accepted' && p.status !== 'dismissed') {
      bad('status is accepted or dismissed')
    }
    out.status = p.status
  }
  if (p.title !== undefined) {
    const title = line(p.title, 'title', MAX_TITLE)
    if (title === '') bad('title is required')
    out.title = title
  }
  if (p.why !== undefined) out.why = line(p.why, 'why', MAX_TEXT)
  if (p.acceptance !== undefined) out.acceptance = items(p.acceptance, 'acceptance')
  if (p.openQuestions !== undefined) out.openQuestions = items(p.openQuestions, 'openQuestions')
  if (p.owner !== undefined) out.owner = line(p.owner, 'owner', 80)
  return out
}

/** The card with the person's edits. An empty owner clears it. */
export function applyPatch(card: Card, patch: CardPatch, now: number): Card {
  const { owner, ...rest } = patch
  const kept = owner === undefined ? card.owner : owner === '' ? undefined : owner
  return withOwner({ ...card, ...rest, updatedAt: now }, kept)
}

function withOwner(card: Card, owner: string | undefined): Card {
  const out = { ...card }
  if (owner === undefined) delete out.owner
  else out.owner = owner
  return out
}
