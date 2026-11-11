/**
 * From a task to work: the spec its task file holds and the brief the
 * session it is sent to starts with. One spec for both, so the task a person
 * reads and the run an agent does say the same thing.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { localDate } from '@holi/shared'
import type { Card, CardRange, MeetingProfile } from '../shared/meeting'
import { speakerName } from '../shared/meeting'
import { clock } from '../shared/scribe-prompt'

export interface SpecContext {
  meetingTitle: string
  startedAt: number
  /** The vault path of the meeting's minutes. */
  minutesPath: string
  /** How the person who sent the card wants it done, in their words. */
  context?: string
  /** The group the task was made from, as it reads now. */
  group?: { title: string; summary: readonly string[]; start: number; end: number }
}

const bullets = (items: readonly string[], box = false): string =>
  items.map((x) => `- ${box ? '[ ] ' : ''}${x}`).join('\n')

/**
 * How much of a task's transcript a spec carries: about 15,000 words, far
 * past a long task's 400 lines of speech, short of a prompt that would
 * crowd out the work.
 *
 * @public exported for its test
 */
export const MAX_RANGE_TEXT = 100_000

const quoteLine = (q: Card['quotes'][number]): string =>
  `> **${speakerName(q.speaker)}** (${clock(q.start)}): ${q.text}`

/** The quotes cut into stretches of consecutive lines. */
function stretches(quotes: Card['quotes']): Array<Card['quotes']> {
  const out: Array<Card['quotes']> = []
  for (const q of quotes) {
    const cur = out.at(-1)
    if (cur !== undefined && cur.at(-1)!.i + 1 === q.i) cur.push(q)
    else out.push([q])
  }
  return out
}

/** What was said in a person's task, every line of it up to the cap: one
 *  stretch under its times, or each stretch under its own. */
function taskTranscript(quotes: Card['quotes'], range: CardRange): string {
  let size = 0
  let carried = 0
  const parts: string[] = []
  const runs = stretches(quotes)
  for (const run of runs) {
    const lines: string[] = []
    for (const q of run) {
      const line = quoteLine(q)
      if (size + line.length > MAX_RANGE_TEXT) break
      lines.push(line)
      size += line.length + 3
    }
    if (lines.length === 0) break
    carried += lines.length
    const head = runs.length === 1 ? '' : `### ${clock(run[0]!.start)}\n\n`
    parts.push(`${head}${lines.join('\n>\n')}`)
    if (lines.length < run.length) break
  }
  const left = range.lines - carried
  const head =
    runs.length === 1
      ? `## What was said from ${clock(range.start)} to ${clock(range.end)}`
      : `## What was said, in ${runs.length} stretches of the meeting`
  const note =
    left > 0
      ? `\n\nThe task has ${range.lines} lines; the first ${carried} are here, and the rest are in the meeting's transcript (\`transcript.local.md\` in its folder).`
      : ''
  return `${head}\n\n${parts.join('\n\n')}${note}`
}

/**
 * A card as markdown: its title as the first heading (a task keeps its title
 * there), why, the acceptance criteria as a checklist, the open questions,
 * how the person wants it done, the group it came from, and what was said,
 * quoted from the transcript with who and when: for a person's task, every
 * line of it (up to `MAX_RANGE_TEXT`), in its stretches.
 */
export function cardSpec(card: Card, ctx: SpecContext): string {
  const day = localDate(new Date(ctx.startedAt))
  const parts = [
    `# ${card.title}`,
    `From the meeting "${ctx.meetingTitle}" on ${day} (minutes: \`${ctx.minutesPath}\`).`,
  ]
  if (card.why !== '') {
    parts.push(`## ${card.origin === 'person' ? 'What the person asks' : 'Why'}\n\n${card.why}`)
  }
  if (ctx.group !== undefined) {
    const g = ctx.group
    const bullets = g.summary.map((b) => `- ${b}`).join('\n')
    parts.push(
      `## The part of the meeting it came from\n\n**${g.title}** (${clock(g.start)}–${clock(g.end)})${bullets === '' ? '' : `\n\n${bullets}`}`,
    )
  }
  if (card.acceptance.length > 0) {
    parts.push(`## Acceptance criteria\n\n${bullets(card.acceptance, true)}`)
  }
  if (card.openQuestions.length > 0) {
    parts.push(`## Open questions\n\n${bullets(card.openQuestions)}`)
  }
  const context = ctx.context?.trim() ?? ''
  if (context !== '') parts.push(`## How the person wants it done\n\n${context}`)
  if (card.range !== undefined) {
    parts.push(taskTranscript(card.quotes, card.range))
  } else if (card.quotes.length > 0) {
    parts.push(`## What was said\n\n${card.quotes.map(quoteLine).join('\n>\n')}`)
  }
  if (card.owner !== undefined) parts.push(`Owner: ${card.owner}`)
  return `${parts.join('\n\n')}\n`
}

/**
 * The first turn of the session a card is sent to. A feature is built, in
 * the profile's repository; an action is a to-do someone took on, which the
 * agent does or prepares (drafts the email, gathers the material) rather than
 * writing software.
 */
export function buildBrief(
  card: Card,
  ctx: SpecContext & { taskPath: string; profile: MeetingProfile },
): string {
  const { profile } = ctx
  const spec = cardSpec(card, ctx).trim()
  const how = `The meeting's minutes are in \`${ctx.minutesPath}\`; read them for context, and expect them to change while the meeting goes on.`
  if (card.kind === 'action') {
    return [
      `Do or prepare this to-do, which came up in a meeting: draft what can be drafted (the email, the message, the document) and gather what it needs, then say what is left for the person to do. Don't build software unless the to-do asks for it. Its task is @${ctx.taskPath}: keep the task's checklist current as you go.`,
      spec,
      `## How\n\n${how} Ask before sending anything on the person's behalf: \`holi agent notify\` reaches them.`,
    ].join('\n\n')
  }
  const where = [
    profile.platform.trim() === '' ? '' : `What we build on: ${profile.platform.trim()}`,
    profile.repoPath === undefined ? '' : `Work in ${profile.repoPath}.`,
  ].filter((x) => x !== '')
  return [
    `Build this feature, which came up in a meeting. Its task is @${ctx.taskPath}: keep the task's checklist current as you go.`,
    spec,
    ...(where.length === 0 ? [] : [`## Where\n\n${where.join('\n')}`]),
    `## How\n\n${how} Raise the open questions early, before building on a guess: \`holi agent notify\` reaches the person.`,
  ].join('\n\n')
}
