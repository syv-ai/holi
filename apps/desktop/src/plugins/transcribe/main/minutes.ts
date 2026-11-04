/**
 * The minutes, rendered by code from the groups and the tasks
 * (docs/features/meetings.md), as minutes are read: what the meeting was
 * (its title, date, time and the participants the meeting named), then what
 * came of it (the decisions, the action points: the to-dos it took on and
 * the tasks sent from it, and the questions left open), then the discussion,
 * a section per topic with its summary (groups a person joined as one topic,
 * with each stretch's time). While the meeting records, or a topic is still
 * to be written, the minutes say they are a draft, and an unwritten topic
 * says so rather than stand empty.
 *
 * In the meeting's language, the headings included: the profile's, or the
 * one the transcript is in when the profile says auto (`minutesLanguage`).
 *
 * The scribe writes groups, never minutes: what a person edits in a group is
 * in the minutes the moment they save it.
 *
 * Pure: no `electron`, no I/O.
 */
import { joinedSets } from '../shared/joins'
import type { Card, MeetingProfile, MeetingState, Topic } from '../shared/meeting'
import { clock } from '../shared/scribe-prompt'

type Language = 'da' | 'en'

/** Everything the minutes say themselves, in each language they are kept in. */
const WORDS = {
  en: {
    participants: 'Participants',
    decisions: 'Decisions',
    actions: 'Action points',
    questions: 'Open questions',
    discussion: 'Discussion',
    keywords: 'Keywords',
    now: 'Now',
    untitled: 'Untitled',
    from: 'from',
    recording: 'Draft: the meeting is still being recorded, and the topics fill in as it goes.',
    unwritten: 'Draft: some topics are not summarised yet.',
    notSummarised: 'Not summarised yet.',
    feature: 'feature',
    todo: 'to-do',
    notSent: 'not sent',
    sentToAgent: 'sent to the agent',
    sentTo: (who: string) => `sent to ${who}`,
  },
  da: {
    participants: 'Deltagere',
    decisions: 'Beslutninger',
    actions: 'Handlingspunkter',
    questions: 'Åbne spørgsmål',
    discussion: 'Drøftelse',
    keywords: 'Nøgleord',
    now: 'Nu',
    untitled: 'Uden titel',
    from: 'fra',
    recording: 'Udkast: mødet optages stadig, og emnerne udfyldes undervejs.',
    unwritten: 'Udkast: nogle emner er ikke opsummeret endnu.',
    notSummarised: 'Ikke opsummeret endnu.',
    feature: 'funktion',
    todo: 'opgave',
    notSent: 'ikke sendt',
    sentToAgent: 'sendt til agenten',
    sentTo: (who: string) => `sendt til ${who}`,
  },
} as const

type Words = (typeof WORDS)[Language]

/** Words that are common in Danish speech and rare in English, and back. */
const DANISH = new Set(
  'og det er ikke jeg vi at på med har skal kan så der den til som også hvad hvis eller men nu godt lige bare måske'.split(
    ' ',
  ),
)
const ENGLISH = new Set(
  'the and is not we to of that it you have this with for are but what if or just so maybe can will'.split(
    ' ',
  ),
)

/**
 * The language to keep the minutes in: the profile's, or, for auto, the one
 * the transcript is mostly in (Danish or English, by their common words;
 * English when it cannot tell).
 *
 * @public exported for its test
 */
export function minutesLanguage(
  meeting: Pick<MeetingState, 'segments'>,
  language: MeetingProfile['language'],
): Language {
  if (language !== 'auto') return language
  let da = 0
  let en = 0
  for (const s of meeting.segments) {
    for (const word of s.text.toLowerCase().match(/[a-zæøå]+/g) ?? []) {
      if (DANISH.has(word)) da++
      else if (ENGLISH.has(word)) en++
    }
  }
  return da > en ? 'da' : 'en'
}

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** The date and time it ran, as this machine tells time. */
function when(meeting: MeetingState, w: Words): string {
  const start = new Date(meeting.startedAt)
  const day = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`
  const end = meeting.endedAt === undefined ? null : new Date(meeting.endedAt)
  return end === null ? `${day} · ${w.from} ${hhmm(start)}` : `${day} · ${hhmm(start)}–${hhmm(end)}`
}

const titleOf = (t: Topic, w: Words): string =>
  t.title.trim() === '' ? w.untitled : t.title.trim()

/** One topic: a group, or groups a person joined, under the first's title
 *  with every stretch's time. One not written yet says so. */
function topicSection(set: readonly Topic[], w: Words): string {
  const t = set[0]!
  if (t.open) {
    return `### ${w.now}${t.title.trim() === '' ? '' : `: ${t.title.trim()}`} (${w.from} ${clock(t.start)})`
  }
  const times = set.map((x) => `${clock(x.start)}–${clock(x.end)}`).join(', ')
  const lines = [`### ${titleOf(t, w)} (${times})`]
  const summary = set.flatMap((x) => x.summary)
  lines.push('', ...(summary.length > 0 ? summary.map((b) => `- ${b}`) : [`_${w.notSummarised}_`]))
  const keywords = [...new Set(set.flatMap((x) => x.keywords))]
  if (keywords.length > 0) lines.push('', `${w.keywords}: ${keywords.join(', ')}`)
  return lines.join('\n')
}

/** Every item of one kind across the topics, each with its topic's title. */
function gathered(
  sets: readonly Topic[][],
  pick: (t: Topic) => readonly string[],
  w: Words,
): string[] {
  return sets.flatMap((set) =>
    set.flatMap((t) => pick(t).map((item) => `- ${item} (${titleOf(set[0]!, w)})`)),
  )
}

function taskState(card: Card, w: Words): string {
  if (card.status === 'building') {
    return card.target?.kind === 'holi' ? w.sentTo(card.target.id) : w.sentToAgent
  }
  return w.notSent
}

/** What the meeting took on: the tasks people made or sent, then the to-dos
 *  the scribe heard someone commit to that no task covers yet. */
function actionPoints(meeting: MeetingState, sets: readonly Topic[][], w: Words): string[] {
  const tasks = meeting.cards.filter(
    (c) => c.status === 'building' || (c.origin === 'person' && c.status === 'accepted'),
  )
  const covered = new Set(tasks.map((c) => c.title.trim().toLowerCase()))
  const made = tasks.map(
    (c) => `- [ ] ${c.title} (${c.kind === 'action' ? w.todo : w.feature}): ${taskState(c, w)}`,
  )
  const todos = sets.flatMap((set) =>
    set.flatMap((t) =>
      t.suggestions
        .filter((s) => s.kind === 'action' && !covered.has(s.title.trim().toLowerCase()))
        .map((s) => `- [ ] ${s.title} (${titleOf(set[0]!, w)})`),
    ),
  )
  return [...made, ...todos]
}

/** The minutes as markdown; empty for a meeting with no groups. */
export function renderMinutes(
  meeting: MeetingState,
  language: MeetingProfile['language'] = 'auto',
): string {
  const { topics } = meeting
  if (topics.length === 0) return ''
  const w = WORDS[minutesLanguage(meeting, language)]
  const sets = joinedSets(topics)
  const head = [`# ${meeting.title}`, '', when(meeting, w)]
  const people = [...new Set(topics.flatMap((t) => t.people ?? []))]
  if (people.length > 0) head.push('', `${w.participants}: ${people.join(', ')}`)
  const recording = meeting.phase === 'recording' || meeting.phase === 'finishing'
  const unwritten = sets.some(
    (set) => set[0]!.open || set.some((t) => t.stale === true || t.summary.length === 0),
  )
  if (recording) head.push('', `> ${w.recording}`)
  else if (unwritten) head.push('', `> ${w.unwritten}`)
  const parts = [head.join('\n')]
  const decisions = gathered(sets, (t) => t.decisions, w)
  if (decisions.length > 0) parts.push(`## ${w.decisions}\n\n${decisions.join('\n')}`)
  const actions = actionPoints(meeting, sets, w)
  if (actions.length > 0) parts.push(`## ${w.actions}\n\n${actions.join('\n')}`)
  const questions = gathered(sets, (t) => t.questions, w)
  if (questions.length > 0) parts.push(`## ${w.questions}\n\n${questions.join('\n')}`)
  parts.push(`## ${w.discussion}\n\n${sets.map((set) => topicSection(set, w)).join('\n\n')}`)
  return `${parts.join('\n\n')}\n`
}
