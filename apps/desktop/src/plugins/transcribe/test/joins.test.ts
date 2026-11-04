/**
 * Topics a person joins: groups from different parts of the meeting read as
 * one topic, headed by the earliest; the lines stay where they are; the open
 * group cannot join; a merge, a split or a group gone keeps the joins tidy;
 * separating gives each group back; and the minutes write a joined topic
 * once, with every stretch's time.
 */
import { describe, expect, it } from 'vitest'
import { CapabilityError } from '../../../main/capabilities/error'
import { joinedSets, tidyJoins } from '../shared/joins'
import type { MeetingState, Segment, Topic } from '../shared/meeting'
import { renderMinutes } from '../main/minutes'
import { joinTopic, mergeTopic, separateTopic, splitTopic } from '../main/topics'

const segments: Segment[] = Array.from({ length: 10 }, (_v, i) => ({
  i,
  speaker: 'Me',
  start: i * 10,
  end: i * 10 + 10,
  text: `line ${i}`,
  chunk: 0,
}))

const topic = (first: number, last: number, title: string, open = false): Topic => ({
  id: `t${first}`,
  title,
  summary: [`About ${title.toLowerCase()}`],
  keywords: [title.toLowerCase()],
  lines: Array.from({ length: last - first + 1 }, (_v, k) => first + k),
  start: first * 10,
  end: last * 10 + 10,
  open,
  decisions: [`Decided on ${title.toLowerCase()}`],
  questions: [],
  suggestions: [],
})

/** Budget 0–1, Export 2–3, Hiring 4–5, Budget again 6–7, Now 8–9. */
const five = (): Topic[] => [
  topic(0, 1, 'Budget'),
  topic(2, 3, 'Export'),
  topic(4, 5, 'Hiring'),
  topic(6, 7, 'Licences'),
  topic(8, 9, 'Wrap-up', true),
]

const refused = (f: () => unknown): string => {
  try {
    f()
  } catch (err) {
    if (err instanceof CapabilityError) return err.code
    throw err
  }
  throw new Error('expected a refusal')
}

const sets = (topics: Topic[]) => joinedSets(topics).map((s) => s.map((t) => t.id))

describe('joining topics', () => {
  it('reads groups from different parts as one topic, headed by the earliest', () => {
    // Dropped either way round, the earlier group heads it.
    const a = joinTopic(five(), 't6', 't0')
    const b = joinTopic(five(), 't0', 't6')
    for (const t of [a, b]) {
      expect(sets(t)).toEqual([['t0', 't6'], ['t2'], ['t4'], ['t8']])
      expect(t.map((x) => x.lines)).toEqual(five().map((x) => x.lines))
    }
    // A third joins the set, and a set joins a set.
    const c = joinTopic(a, 't4', 't6')
    expect(sets(c)).toEqual([['t0', 't4', 't6'], ['t2'], ['t8']])
    const d = joinTopic(joinTopic(five(), 't4', 't2'), 't2', 't6')
    expect(sets(d)).toEqual([['t0'], ['t2', 't4', 't6'], ['t8']])
  })

  it('refuses the open group, and two groups that are one topic already', () => {
    expect(refused(() => joinTopic(five(), 't8', 't0'))).toBe('CONFLICT')
    expect(refused(() => joinTopic(five(), 't0', 't8'))).toBe('CONFLICT')
    expect(refused(() => joinTopic(joinTopic(five(), 't6', 't0'), 't0', 't6'))).toBe('CONFLICT')
    expect(refused(() => joinTopic(five(), 't0', 't40'))).toBe('NOT_FOUND')
  })

  it('separates a joined topic into its groups', () => {
    const t = joinTopic(joinTopic(five(), 't6', 't0'), 't4', 't0')
    expect(sets(separateTopic(t, 't4'))).toEqual([['t0'], ['t2'], ['t4'], ['t6'], ['t8']])
  })

  it('stays tidy through a merge, a split and a group gone', () => {
    const joined = joinTopic(five(), 't6', 't2')
    // Merging the head into the group before it: the set follows the merged group.
    expect(sets(mergeTopic(joined, segments, 't2'))).toEqual([['t0', 't6'], ['t4'], ['t8']])
    // A split-off part is a topic of its own.
    expect(sets(tidyJoins(splitTopic(joined, segments, 7)))).toEqual([
      ['t0'],
      ['t2', 't6'],
      ['t4'],
      ['t7'],
      ['t8'],
    ])
    // A join to a group that is gone is dropped.
    expect(sets(tidyJoins(joined.filter((t) => t.id !== 't2')))).toEqual([
      ['t0'],
      ['t4'],
      ['t6'],
      ['t8'],
    ])
  })
})

describe('the minutes of a joined topic', () => {
  it('write it once, under the earliest title, with every stretch’s time', () => {
    const topics = joinTopic(five(), 't6', 't0')
    const minutes = renderMinutes(
      {
        title: 'Planning',
        startedAt: 0,
        phase: 'done',
        segments: [],
        topics,
        cards: [],
      } as unknown as MeetingState,
      'en',
    )
    expect(minutes).toContain(
      '### Budget (0:00–0:20, 1:00–1:20)\n\n- About budget\n- About licences\n\nKeywords: budget, licences',
    )
    expect(minutes).not.toContain('### Licences')
    expect(minutes).toContain('- Decided on licences (Budget)')
  })
})
