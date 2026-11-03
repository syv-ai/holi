/**
 * The minutes, rendered by code from the groups and the tasks
 * (docs/features/meetings.md): the topics with their summaries and
 * keywords (groups a person joined as one topic, with each stretch's time), then the decisions and open questions gathered from them with
 * the group each came from, then the tasks people made and where they
 * stand. The open group shows as Now, without a summary, until it closes.
 * The scribe writes groups, never minutes: what a person edits in a group
 * is in the minutes the moment they save it.
 *
 * Pure: no `electron`, no I/O.
 */
import { joinedSets } from '../shared/joins'
import type { Card, MeetingState, Topic } from '../shared/meeting'
import { clock } from '../shared/scribe-prompt'

const titleOf = (t: Topic): string => (t.title.trim() === '' ? 'Untitled' : t.title.trim())

/** One topic: a group, or groups a person joined, under the first's title
 *  with every stretch's time. */
function topicSection(set: readonly Topic[]): string {
  const t = set[0]!
  if (t.open) {
    return `### Now${t.title.trim() === '' ? '' : `: ${t.title.trim()}`} (from ${clock(t.start)})`
  }
  const times = set.map((x) => `${clock(x.start)}–${clock(x.end)}`).join(', ')
  const lines = [`### ${titleOf(t)} (${times})`]
  const summary = set.flatMap((x) => x.summary)
  if (summary.length > 0) lines.push('', ...summary.map((b) => `- ${b}`))
  const keywords = [...new Set(set.flatMap((x) => x.keywords))]
  if (keywords.length > 0) lines.push('', `Keywords: ${keywords.join(', ')}`)
  return lines.join('\n')
}

/** Every item of one kind across the topics, each with its topic's title. */
function gathered(sets: readonly Topic[][], pick: (t: Topic) => readonly string[]): string[] {
  return sets.flatMap((set) =>
    set.flatMap((t) => pick(t).map((item) => `- ${item} (${titleOf(set[0]!)})`)),
  )
}

function taskState(card: Card): string {
  if (card.status === 'building') {
    return card.target?.kind === 'holi' ? `sent to ${card.target.id}` : 'sent to Claude'
  }
  return 'not sent'
}

/** The minutes as markdown; empty for a meeting with no groups. */
export function renderMinutes(meeting: MeetingState): string {
  const { topics } = meeting
  if (topics.length === 0) return ''
  const sets = joinedSets(topics)
  const parts = [`## Topics\n\n${sets.map(topicSection).join('\n\n')}`]
  const decisions = gathered(sets, (t) => t.decisions)
  if (decisions.length > 0) parts.push(`## Decisions\n\n${decisions.join('\n')}`)
  const questions = gathered(sets, (t) => t.questions)
  if (questions.length > 0) parts.push(`## Open questions\n\n${questions.join('\n')}`)
  const tasks = meeting.cards.filter(
    (c) => c.status === 'building' || (c.origin === 'person' && c.status === 'accepted'),
  )
  if (tasks.length > 0) {
    parts.push(
      `## Tasks\n\n${tasks
        .map(
          (c) => `- [ ] ${c.title} (${c.kind === 'action' ? 'to-do' : 'feature'}): ${taskState(c)}`,
        )
        .join('\n')}`,
    )
  }
  return `${parts.join('\n\n')}\n`
}
