/**
 * A meeting's groups (docs/features/meetings.md): contiguous stretches of
 * the transcript on one subject, the backbone of the minutes and tasks.
 *
 * - **The scribe writes them** with `holi meeting group` (`parseGroup`,
 *   `applyGroup`): one group a call, named by the `[i]` of its first line.
 *   That line starting an existing group writes it; a line inside the open
 *   group cuts it there and starts a new open group; a line inside a closed
 *   group is refused, since a closed group's start does not move. Fields
 *   left out keep their value. Code derives every group's lines and times;
 *   the model never gives one.
 * - **A person reshapes them** (`splitTopic`, `mergeTopic`, `editTopic`), and
 *   joins groups from different parts of the meeting into one topic
 *   (`joinTopic`, `separateTopic`, `../shared/joins.ts`) without moving a
 *   line.
 *   Groups stay contiguous: re-sorting single lines into groups was measured
 *   and is not reliable (not-built). A split or merge marks the groups it
 *   touched stale, for the scribe to write again; a field a person edited is
 *   theirs, and the scribe's write leaves it (`kept`).
 * - **New lines join the open group** (`extendTopics`); the first line of a
 *   meeting starts it.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { CapabilityError } from '../../../main/plugin-api'
import { tidyJoins } from '../shared/joins'
import {
  lineAt,
  type CardKind,
  type Segment,
  type Suggestion,
  type Topic,
  type TopicField,
} from '../shared/meeting'

/** The most groups a meeting keeps: about one every two minutes of a long one. */
const MAX_TOPICS = 60
const MAX_TITLE_WORDS = 8
const MAX_TITLE_CHARS = 60
/** A person's title is theirs: longer, and not cut at words. */
const MAX_PERSON_TITLE = 120
const MAX_BULLETS = 4
const MIN_KEYWORDS = 2
const MAX_KEYWORDS = 5
const MAX_KEYWORD = 40
const MAX_ITEMS = 8
const MAX_ITEM = 300
const MAX_SUGGESTIONS = 8
const MAX_SUGGESTION_SEGMENTS = 6
const MAX_SUGGESTION_TITLE = 120
const MAX_WHY = 2000

const TOPIC_FIELDS: readonly TopicField[] = [
  'title',
  'summary',
  'keywords',
  'decisions',
  'questions',
]

const GROUP_KEYS = new Set(['startIndex', ...TOPIC_FIELDS, 'suggestions', 'people'])
/** At most this many people a group names, each a name of at most `MAX_NAME`. */
const MAX_PEOPLE = 20
const MAX_NAME = 80
const SUGGESTION_KEYS = new Set(['kind', 'title', 'why', 'segments'])

/** A suggestion as the scribe gives it: code gives its id. */
type SuggestionInput = Omit<Suggestion, 'id'>

/** One group as the scribe gives it. */
export interface GroupInput {
  startIndex: number
  title: string
  keywords: string[]
  summary?: string[]
  decisions?: string[]
  questions?: string[]
  suggestions?: SuggestionInput[]
  people?: string[]
}

const EXAMPLE =
  'send {"startIndex":41,"title":"…","keywords":["…","…"],"summary":["…"],"decisions":[],"questions":[],"suggestions":[{"kind":"feature","title":"…","why":"…","segments":[44]}]}'

function bad(message: string, hint = EXAMPLE): never {
  throw new CapabilityError('BAD_REQUEST', message, hint)
}

const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** A list of text: each item on one line and cut, empty ones and repeats
 *  (ignoring case) dropped, the list cut to `max`. */
function texts(raw: unknown, key: string, max: number, itemMax: number): string[] {
  if (!Array.isArray(raw)) bad(`${key} is a list of text`)
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') bad(`${key} is a list of text`)
    const value = cut(oneLine(item), itemMax)
    if (value === '' || seen.has(value.toLowerCase())) continue
    seen.add(value.toLowerCase())
    out.push(value)
  }
  return out.slice(0, max)
}

/** A title of at most 8 words and 60 characters. */
function scribeTitle(raw: unknown): string {
  if (typeof raw !== 'string') bad('a group’s title is text')
  const words = oneLine(raw).split(' ').filter(Boolean)
  if (words.length === 0) bad('a group needs a title')
  return cut(words.slice(0, MAX_TITLE_WORDS).join(' '), MAX_TITLE_CHARS)
}

function keywords(raw: unknown): string[] {
  const out = texts(raw, 'keywords', MAX_KEYWORDS, MAX_KEYWORD)
  if (out.length < MIN_KEYWORDS) bad(`give each group ${MIN_KEYWORDS} to ${MAX_KEYWORDS} keywords`)
  return out
}

function kindOf(raw: unknown): CardKind {
  if (raw !== 'feature' && raw !== 'action') bad('a suggestion’s kind is "feature" or "action"')
  return raw
}

function suggestions(raw: unknown): SuggestionInput[] {
  if (!Array.isArray(raw)) bad('suggestions is a list')
  return raw.slice(0, MAX_SUGGESTIONS).map((s): SuggestionInput => {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) bad('a suggestion is an object')
    const p = s as Record<string, unknown>
    for (const key of Object.keys(p)) {
      if (!SUGGESTION_KEYS.has(key)) bad(`a suggestion has no field ${key}`)
    }
    const title =
      typeof p['title'] === 'string' ? cut(oneLine(p['title']), MAX_SUGGESTION_TITLE) : ''
    if (title === '') bad('a suggestion needs a title')
    const why = p['why'] ?? ''
    if (typeof why !== 'string') bad('a suggestion’s why is text')
    const segments = p['segments']
    if (
      !Array.isArray(segments) ||
      segments.length === 0 ||
      segments.some((i) => typeof i !== 'number' || !Number.isInteger(i) || i < 0)
    ) {
      bad('a suggestion’s segments are the [i] of the lines that say it, at least one')
    }
    return {
      kind: kindOf(p['kind']),
      title,
      why: cut(why.trim(), MAX_WHY),
      segments: [...new Set(segments as number[])].slice(0, MAX_SUGGESTION_SEGMENTS),
    }
  })
}

/** The group the scribe sent, read from its JSON: every field typed and
 *  bounded, a field a group does not have refused. */
export function parseGroup(json: string): GroupInput {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return bad('the group is not JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('a group is an object')
  const p = raw as Record<string, unknown>
  for (const key of Object.keys(p)) if (!GROUP_KEYS.has(key)) bad(`a group has no field ${key}`)
  const start = p['startIndex']
  if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) {
    bad('startIndex is the [i] of the group’s first line')
  }
  const out: GroupInput = {
    startIndex: start,
    title: scribeTitle(p['title']),
    keywords: keywords(p['keywords']),
  }
  if (p['summary'] !== undefined)
    out.summary = texts(p['summary'], 'summary', MAX_BULLETS, MAX_ITEM)
  if (p['decisions'] !== undefined) {
    out.decisions = texts(p['decisions'], 'decisions', MAX_ITEMS, MAX_ITEM)
  }
  if (p['questions'] !== undefined) {
    out.questions = texts(p['questions'], 'questions', MAX_ITEMS, MAX_ITEM)
  }
  if (p['suggestions'] !== undefined) out.suggestions = suggestions(p['suggestions'])
  if (p['people'] !== undefined) out.people = texts(p['people'], 'people', MAX_PEOPLE, MAX_NAME)
  return out
}

/** A group over `lines` with nothing written yet. */
function blank(lines: readonly number[], open: boolean): Topic {
  return {
    id: `t${lines[0]}`,
    title: '',
    summary: [],
    keywords: [],
    lines: [...lines],
    start: 0,
    end: 0,
    open,
    decisions: [],
    questions: [],
    suggestions: [],
  }
}

/** Every group's id, start and end from its lines, each end no later than
 *  the next group's start. */
function timed(topics: readonly Topic[], segments: readonly Segment[]): Topic[] {
  const at = new Map(segments.map((s) => [s.i, s]))
  const out = topics.map((t) => ({
    ...t,
    id: `t${t.lines[0]}`,
    start: at.get(t.lines[0]!)?.start ?? t.start,
    end: at.get(t.lines.at(-1)!)?.end ?? t.end,
  }))
  for (let k = 0; k < out.length - 1; k++) {
    out[k]!.end = Math.min(out[k]!.end, out[k + 1]!.start)
  }
  return out
}

/** The groups with every line newer than any group's joining the open one
 *  (the last, when none is open): new lines belong to what is being talked
 *  about now. The meeting's first line starts its first group. */
export function extendTopics(topics: readonly Topic[], segments: readonly Segment[]): Topic[] {
  if (segments.length === 0) return [...topics]
  if (topics.length === 0)
    return timed(
      [
        blank(
          segments.map((s) => s.i),
          true,
        ),
      ],
      segments,
    )
  const newest = Math.max(-1, ...topics.flatMap((t) => t.lines.slice(-1)))
  const fresh = segments.filter((s) => s.i > newest)
  if (fresh.length === 0) return [...topics]
  const at = topics.findIndex((t) => t.open)
  const k = at < 0 ? topics.length - 1 : at
  return timed(
    topics.map((t, j) => (j === k ? { ...t, lines: [...t.lines, ...fresh.map((s) => s.i)] } : t)),
    segments,
  )
}

/** The groups with none open: the meeting stopped. One closed unwritten is
 *  stale, for the scribe's final pass to write. */
export function closeTopics(topics: readonly Topic[]): Topic[] {
  return topics.map((t) =>
    t.open ? { ...t, open: false, ...(t.summary.length === 0 ? { stale: true } : {}) } : t,
  )
}

/** The index of the group holding line `i`. */
const holding = (topics: readonly Topic[], i: number): number =>
  topics.findIndex((t) => t.lines.includes(i))

/** Same suggestion: same kind, and the same title or a line in common. */
const sameSuggestion = (a: SuggestionInput, b: Suggestion): boolean =>
  a.kind === b.kind &&
  (a.title.toLowerCase() === b.title.toLowerCase() ||
    a.segments.some((i) => b.segments.includes(i)))

/** The scribe's suggestions for a group, each keeping the id of the one it
 *  rewrites, a new one numbered past every id in the meeting; and every
 *  suggestion a person sent (`sent`) that the scribe left out, kept. */
function suggestionsFor(
  given: readonly SuggestionInput[],
  old: readonly Suggestion[],
  topics: readonly Topic[],
  sent: ReadonlySet<string>,
): Suggestion[] {
  let next =
    Math.max(
      0,
      ...topics.flatMap((t) => t.suggestions.map((s) => Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0))),
    ) + 1
  const left = [...old]
  const out = given.map((s): Suggestion => {
    const k = left.findIndex((o) => sameSuggestion(s, o))
    const id = k < 0 ? `s${next++}` : left.splice(k, 1)[0]!.id
    return { id, ...s }
  })
  return [...out, ...left.filter((o) => sent.has(o.id))]
}

/** What `applyGroup` did: the groups after, the one written, and the fields
 *  of it a person edited, which the scribe's write left as they were. */
export interface GroupResult {
  topics: Topic[]
  topic: Topic
  kept: TopicField[]
}

/**
 * The scribe's group written into `topics`. Its `startIndex` is a line the
 * scribe was sent (up to `cursor`): the first line of a group writes that
 * group; a line inside the open group starts a new open group there, the one
 * before closing (stale if it was never written); a line inside a closed
 * group is refused. A suggestion cites lines of this group or an earlier one.
 * `sent` are the ids of suggestions a person sent: kept if the scribe drops
 * them.
 */
export function applyGroup(
  topics: readonly Topic[],
  segments: readonly Segment[],
  input: GroupInput,
  opts: { cursor: number; sent: ReadonlySet<string> },
): GroupResult {
  const i = input.startIndex
  if (i > opts.cursor || lineAt(segments, i) === undefined) {
    bad(
      `line ${i} is not one you were sent; the last is ${opts.cursor}`,
      '`holi meeting context` prints the groups and the last line',
    )
  }
  let list = [...topics]
  let k = holding(list, i)
  if (k < 0) bad(`line ${i} is in no group`, '`holi meeting context` prints the groups')
  const holder = list[k]!
  if (holder.lines[0] !== i) {
    if (!holder.open) {
      bad(
        `line ${i} is inside the closed group [${holder.lines[0]}] ${holder.title === '' ? '(untitled)' : `»${holder.title}«`}, lines ${holder.lines[0]}..${holder.lines.at(-1)}; a closed group’s start does not move`,
        'give the startIndex of a group, or of a line in the open group; the person splits and merges groups in Holi',
      )
    }
    if (list.length >= MAX_TOPICS) {
      bad(
        `this meeting already has ${MAX_TOPICS} groups`,
        'write the open group instead of starting one',
      )
    }
    const before = holder.lines.filter((x) => x < i)
    const after = holder.lines.filter((x) => x >= i)
    const moved = holder.suggestions.filter((s) => Math.max(...s.segments) >= i)
    const closed: Topic = {
      ...holder,
      lines: before,
      open: false,
      suggestions: holder.suggestions.filter((s) => !moved.includes(s)),
      ...(holder.summary.length === 0 ? { stale: true } : {}),
    }
    list.splice(k, 1, closed, { ...blank(after, true), suggestions: moved })
    k += 1
  }
  const topic = list[k]!
  const last = topic.lines.at(-1)!
  const known = new Set(segments.map((s) => s.i))
  for (const s of input.suggestions ?? []) {
    const outside = s.segments.filter((x) => x > last || !known.has(x))
    if (outside.length > 0) {
      bad(
        `segment${outside.length === 1 ? '' : 's'} ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not in this group or an earlier one (it ends at [${last}])`,
        'cite the lines of this group, or of an earlier one, that say it',
      )
    }
  }
  const edited = new Set(topic.edited ?? [])
  const kept: TopicField[] = []
  const written: Topic = { ...topic }
  const set = <F extends TopicField>(field: F, value: Topic[F] | undefined) => {
    if (value === undefined) return
    if (edited.has(field)) {
      if (JSON.stringify(value) !== JSON.stringify(topic[field])) kept.push(field)
      return
    }
    written[field] = value
  }
  set('title', input.title)
  set('keywords', input.keywords)
  set('summary', input.summary)
  set('decisions', input.decisions)
  set('questions', input.questions)
  if (input.suggestions !== undefined) {
    written.suggestions = suggestionsFor(input.suggestions, topic.suggestions, list, opts.sent)
  }
  if (input.people !== undefined) {
    if (input.people.length === 0) delete written.people
    else written.people = input.people
  }
  // Written as it stands: a closed group the scribe wrote is current.
  if (!written.open) delete written.stale
  list.splice(k, 1, written)
  list = timed(list, segments)
  return { topics: list, topic: list[k]!, kept }
}

/** The groups with a new one starting at line `i`, a person's split. Both
 *  halves are stale: the scribe writes them again. The new one takes the
 *  suggestions that cite a line from `i` on, and stays open if the split one
 *  was. */
export function splitTopic(
  topics: readonly Topic[],
  segments: readonly Segment[],
  i: number,
): Topic[] {
  const k = holding(topics, i)
  if (k < 0) throw new CapabilityError('NOT_FOUND', `no line ${i} in this meeting’s groups`)
  const holder = topics[k]!
  if (holder.lines[0] === i)
    throw new CapabilityError('CONFLICT', 'a group starts at this line already')
  if (topics.length >= MAX_TOPICS) {
    throw new CapabilityError('CONFLICT', `this meeting already has ${MAX_TOPICS} groups`)
  }
  const moved = holder.suggestions.filter((s) => Math.max(...s.segments) >= i)
  const first: Topic = {
    ...holder,
    lines: holder.lines.filter((x) => x < i),
    open: false,
    suggestions: holder.suggestions.filter((s) => !moved.includes(s)),
    stale: true,
  }
  const second: Topic = {
    ...blank(
      holder.lines.filter((x) => x >= i),
      holder.open,
    ),
    suggestions: moved,
    ...(holder.open ? {} : { stale: true }),
  }
  return timed([...topics.slice(0, k), first, second, ...topics.slice(k + 1)], segments)
}

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])]

/** The groups with `id` joined to the one before it, a person's merge: one
 *  group with both's lines, words and suggestions, stale unless open, the
 *  earlier one's title kept. */
export function mergeTopic(
  topics: readonly Topic[],
  segments: readonly Segment[],
  id: string,
): Topic[] {
  const k = topics.findIndex((t) => t.id === id)
  if (k < 0) throw new CapabilityError('NOT_FOUND', `no group ${id}`)
  if (k === 0) throw new CapabilityError('CONFLICT', 'the first group has none before it')
  const a = topics[k - 1]!
  const b = topics[k]!
  const edited = union(a.edited ?? [], b.edited ?? []) as TopicField[]
  const editedAt = Math.max(a.editedAt ?? 0, b.editedAt ?? 0)
  const merged: Topic = {
    ...a,
    title: a.title === '' ? b.title : a.title,
    summary: [...a.summary, ...b.summary],
    keywords: union(a.keywords, b.keywords).slice(0, MAX_KEYWORDS),
    lines: [...a.lines, ...b.lines],
    open: b.open,
    decisions: union(a.decisions, b.decisions),
    questions: union(a.questions, b.questions),
    suggestions: [...a.suggestions, ...b.suggestions],
    ...(a.people !== undefined || b.people !== undefined
      ? { people: union(a.people ?? [], b.people ?? []) }
      : {}),
    ...(edited.length === 0 ? {} : { edited }),
    ...(editedAt === 0 ? {} : { editedAt }),
  }
  if (b.open) delete merged.stale
  else merged.stale = true
  // Groups joined to the later one are joined to the merged one now.
  const rest = topics.map((t) => (t.joinedTo === b.id ? { ...t, joinedTo: a.id } : t))
  return tidyJoins(timed([...rest.slice(0, k - 1), merged, ...rest.slice(k + 1)], segments))
}

/** The set a group is in, by its head's id. */
const setOf = (t: Topic): string => t.joinedTo ?? t.id

/** A person joins group `id`, and any it was joined with, to the set of
 *  `into`: one topic from then on, headed by the earliest. The open group
 *  cannot be joined while it is still being written. */
export function joinTopic(topics: readonly Topic[], id: string, into: string): Topic[] {
  const tidy = tidyJoins(topics)
  const a = tidy.find((t) => t.id === id)
  const b = tidy.find((t) => t.id === into)
  if (a === undefined) throw new CapabilityError('NOT_FOUND', `no group ${id}`)
  if (b === undefined) throw new CapabilityError('NOT_FOUND', `no group ${into}`)
  if (a.open || b.open) {
    throw new CapabilityError('CONFLICT', 'the topic being talked about now cannot be joined yet')
  }
  if (setOf(a) === setOf(b)) throw new CapabilityError('CONFLICT', 'these are one topic already')
  const from = setOf(a)
  const to = setOf(b)
  return tidyJoins(
    tidy.map((t) => (t.id === from || t.joinedTo === from ? { ...t, joinedTo: to } : t)),
  )
}

/** A person separates a joined topic: each of its groups its own again. */
export function separateTopic(topics: readonly Topic[], id: string): Topic[] {
  const tidy = tidyJoins(topics)
  const t = tidy.find((x) => x.id === id)
  if (t === undefined) throw new CapabilityError('NOT_FOUND', `no group ${id}`)
  const set = setOf(t)
  return tidy.map((x) => {
    if (x.joinedTo !== set) return x
    const { joinedTo: _gone, ...rest } = x
    return rest
  })
}

/** What a person may change of a group. */
export type TopicPatch = Partial<Pick<Topic, TopicField>>

/** A person's patch, checked: the fields a group has, typed and bounded. */
export function topicPatchParam(raw: unknown): TopicPatch {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CapabilityError('BAD_REQUEST', 'patch is an object')
  }
  const p = raw as Record<string, unknown>
  const out: TopicPatch = {}
  for (const key of Object.keys(p)) {
    if (!(TOPIC_FIELDS as readonly string[]).includes(key)) {
      throw new CapabilityError('BAD_REQUEST', `a group has no field ${key}`)
    }
  }
  if (p['title'] !== undefined) {
    if (typeof p['title'] !== 'string') throw new CapabilityError('BAD_REQUEST', 'title is text')
    const title = oneLine(p['title'])
    if (title === '') throw new CapabilityError('BAD_REQUEST', 'a group needs a title')
    if (title.length > MAX_PERSON_TITLE) {
      throw new CapabilityError('BAD_REQUEST', `title is over ${MAX_PERSON_TITLE} characters`)
    }
    out.title = title
  }
  const list = (key: Exclude<TopicField, 'title'>, max: number, itemMax: number) => {
    if (p[key] === undefined) return
    const items = p[key]
    if (!Array.isArray(items) || items.length > max * 4) {
      throw new CapabilityError('BAD_REQUEST', `${key} is a list of at most ${max} items`)
    }
    try {
      out[key] = texts(items, key, max, itemMax)
    } catch (err) {
      throw new CapabilityError('BAD_REQUEST', (err as Error).message)
    }
  }
  list('summary', MAX_ITEMS, MAX_ITEM)
  list('keywords', MAX_KEYWORDS, MAX_KEYWORD)
  list('decisions', MAX_ITEMS * 2, MAX_ITEM)
  list('questions', MAX_ITEMS * 2, MAX_ITEM)
  return out
}

/** The group with a person's edits, which are theirs from now on. */
export function editTopic(topic: Topic, patch: TopicPatch, now: number): Topic {
  const fields = Object.keys(patch) as TopicField[]
  if (fields.length === 0) return topic
  return {
    ...topic,
    ...patch,
    edited: [...new Set([...(topic.edited ?? []), ...fields])],
    editedAt: now,
  }
}
