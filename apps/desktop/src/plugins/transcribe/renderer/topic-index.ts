/**
 * What the transcript views need of the topics: where each starts, which
 * lines are in one, and what a topic is called before the scribe has named it.
 */
import type { MeetingState, Topic } from '../shared/meeting'

/** A topic's name: its title, else Now while it is open, else Untitled. */
export const topicName = (t: Topic): string =>
  t.title.trim() !== '' ? t.title.trim() : t.open ? 'Now' : 'Untitled'

export interface TopicIndex {
  /** The topic that starts at a line. */
  startsAt: ReadonlyMap<number, Topic>
  /** Whether a line can start a new topic: it is in one, and not its first. */
  canSplit: (i: number) => boolean
}

export function topicIndex(meeting: MeetingState): TopicIndex {
  const startsAt = new Map<number, Topic>()
  const inside = new Set<number>()
  for (const t of meeting.topics) {
    const [first, ...rest] = t.lines
    if (first !== undefined) startsAt.set(first, t)
    for (const i of rest) inside.add(i)
  }
  return { startsAt, canSplit: (i) => inside.has(i) }
}
