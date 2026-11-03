/**
 * Groups as code keeps them: the scribe's `holi meeting group` checked and
 * written (a start writes its group, a line in the open group cuts it, a
 * line in a closed group is refused), lines and times derived, fields a
 * person edited kept, suggestion ids stable; new lines joining the open
 * group; and a person's split, merge and edit.
 */
import { describe, expect, it } from 'vitest'
import { CapabilityError } from '../../../main/capabilities/error'
import type { Segment, Topic } from '../shared/meeting'
import {
  applyGroup,
  closeTopics,
  editTopic,
  extendTopics,
  mergeTopic,
  parseGroup,
  splitTopic,
  topicPatchParam,
  type GroupInput,
} from '../main/topics'

const segments: Segment[] = Array.from({ length: 10 }, (_v, i) => ({
  i,
  speaker: 'Me',
  start: i * 10,
  end: i * 10 + 12,
  text: `line ${i}`,
  chunk: 0,
}))

const group = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ startIndex: 0, title: 'Budget', keywords: ['budget', 'pilot'], ...over })

const refused = (f: () => unknown): CapabilityError => {
  try {
    f()
  } catch (err) {
    if (err instanceof CapabilityError) return err
    throw err
  }
  throw new Error('expected a refusal')
}

/** The meeting's first group, open over every line, as the first line makes it. */
const opened = (): Topic[] => extendTopics([], segments)

const write = (
  topics: readonly Topic[],
  input: Partial<GroupInput> & Pick<GroupInput, 'startIndex'>,
  sent: ReadonlySet<string> = new Set(),
) =>
  applyGroup(
    topics,
    segments,
    { title: 'A title', keywords: ['a', 'b'], ...input },
    { cursor: 9, sent },
  )

describe('a group the scribe sends', () => {
  it('is typed and bounded: title cut to 8 words, keywords to 5 with repeats dropped', () => {
    const g = parseGroup(
      group({
        title: '  one two three four five six seven eight nine ten ',
        keywords: ['a', 'A', 'b', 'c', 'd', 'e', 'f'],
        summary: ['  one  ', '', 'two', 'three', 'four', 'five'],
        decisions: ['We ship'],
        questions: [],
        suggestions: [{ kind: 'feature', title: 'Export', why: 'asked', segments: [3, 3, 4] }],
      }),
    )
    expect(g).toEqual({
      startIndex: 0,
      title: 'one two three four five six seven eight',
      keywords: ['a', 'b', 'c', 'd', 'e'],
      summary: ['one', 'two', 'three', 'four'],
      decisions: ['We ship'],
      questions: [],
      suggestions: [{ kind: 'feature', title: 'Export', why: 'asked', segments: [3, 4] }],
    })
    // Fields left out stay out: they keep their value when written.
    expect(parseGroup(group())).toEqual({
      startIndex: 0,
      title: 'Budget',
      keywords: ['budget', 'pilot'],
    })
  })

  it('is refused malformed', () => {
    for (const json of [
      'not json',
      '[]',
      group({ minutes: 'x' }),
      group({ startIndex: -1 }),
      group({ startIndex: 1.5 }),
      group({ title: '   ' }),
      group({ title: undefined }),
      group({ keywords: ['one'] }),
      group({ keywords: undefined }),
      group({ summary: 'one line' }),
      group({ suggestions: [{ kind: 'idea', title: 'x', segments: [1] }] }),
      group({ suggestions: [{ kind: 'feature', title: 'x', segments: [] }] }),
      group({ suggestions: [{ kind: 'feature', title: '', segments: [1] }] }),
      group({ suggestions: [{ kind: 'feature', title: 'x', segments: [1], quotes: [] }] }),
    ]) {
      expect(refused(() => parseGroup(json)).code, json).toBe('BAD_REQUEST')
    }
  })
})

describe('new lines', () => {
  it('start the first group at the meeting’s first line, open', () => {
    expect(extendTopics([], [])).toEqual([])
    const [first] = opened()
    expect(first).toMatchObject({
      id: 't0',
      title: '',
      lines: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      start: 0,
      end: 102,
      open: true,
      summary: [],
      suggestions: [],
    })
  })

  it('join the open group, and the last when none is open', () => {
    const early = extendTopics([], segments.slice(0, 3))
    expect(extendTopics(early, segments)[0]!.lines).toHaveLength(10)
    const closed = closeTopics(early)
    expect(closed[0]).toMatchObject({ open: false, stale: true })
    expect(extendTopics(closed, segments)[0]).toMatchObject({ open: false })
    expect(extendTopics(closed, segments)[0]!.lines).toHaveLength(10)
  })
})

describe('writing a group', () => {
  it('by its first line writes it; fields left out keep their value', () => {
    const { topics, topic, kept } = write(opened(), {
      startIndex: 0,
      title: 'Budget',
      summary: ['Costs'],
    })
    expect(kept).toEqual([])
    expect(topic).toMatchObject({ id: 't0', title: 'Budget', summary: ['Costs'], open: true })
    const again = write(topics, { startIndex: 0, title: 'Budget talk' })
    expect(again.topic).toMatchObject({ title: 'Budget talk', summary: ['Costs'] })
  })

  it('at a line inside the open group cuts it: the earlier part closes, stale only unwritten', () => {
    const one = write(opened(), { startIndex: 4, title: 'Export' })
    expect(one.topics.map((t) => [t.id, t.lines, t.open, t.stale])).toEqual([
      ['t0', [0, 1, 2, 3], false, true],
      ['t4', [4, 5, 6, 7, 8, 9], true, undefined],
    ])
    // Ends never pass the next group's start.
    expect(one.topics[0]!.end).toBe(40)
    expect(one.topics[1]).toMatchObject({ start: 40, end: 102, title: 'Export' })

    // A group the scribe summarised before it was cut is not stale.
    const summed = write(opened(), { startIndex: 0, summary: ['So far'] }).topics
    const cut = write(summed, { startIndex: 6 }).topics
    expect(cut[0]).toMatchObject({ open: false, summary: ['So far'] })
    expect(cut[0]!.stale).toBeUndefined()

    // Writing the closed one clears its stale mark.
    const written = write(one.topics, { startIndex: 0, title: 'Budget', summary: ['Costs'] })
    expect(written.topics[0]!.stale).toBeUndefined()
  })

  it('at a line inside a closed group is refused: its start does not move', () => {
    const { topics } = write(opened(), { startIndex: 4 })
    const err = refused(() => write(topics, { startIndex: 2 }))
    expect(err.code).toBe('BAD_REQUEST')
    expect(err.message).toContain('closed group [0]')
  })

  it('names only lines the scribe was sent', () => {
    const err = refused(() =>
      applyGroup(
        opened(),
        segments,
        { startIndex: 7, title: 'x', keywords: ['a', 'b'] },
        { cursor: 5, sent: new Set() },
      ),
    )
    expect(err.message).toContain('not one you were sent')
    expect(refused(() => write(opened(), { startIndex: 42 })).code).toBe('BAD_REQUEST')
  })

  it('takes suggestions citing lines of the group or an earlier one, not later ones', () => {
    const { topics } = write(opened(), { startIndex: 5 })
    const ok = write(topics, {
      startIndex: 0,
      suggestions: [{ kind: 'feature', title: 'Export', why: '', segments: [1, 3] }],
    })
    expect(ok.topic.suggestions).toEqual([
      { id: 's1', kind: 'feature', title: 'Export', why: '', segments: [1, 3] },
    ])
    const err = refused(() =>
      write(topics, {
        startIndex: 0,
        suggestions: [{ kind: 'feature', title: 'Export', why: '', segments: [6] }],
      }),
    )
    expect(err.message).toContain('not in this group or an earlier one')
    // The open group may cite an earlier group's lines.
    const later = write(ok.topics, {
      startIndex: 5,
      suggestions: [{ kind: 'action', title: 'Send it', why: '', segments: [2, 7] }],
    })
    expect(later.topic.suggestions[0]).toMatchObject({ id: 's2', segments: [2, 7] })
  })

  it('keeps suggestion ids across rewrites, and a sent suggestion the scribe drops', () => {
    const first = write(opened(), {
      startIndex: 0,
      suggestions: [
        { kind: 'feature', title: 'Export', why: '', segments: [1] },
        { kind: 'action', title: 'Send the offer', why: '', segments: [2] },
        { kind: 'feature', title: 'Search', why: '', segments: [3] },
      ],
    })
    expect(first.topic.suggestions.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    const again = write(
      first.topics,
      {
        startIndex: 0,
        suggestions: [
          // Same title, other lines; same lines, other title; and a new one.
          { kind: 'feature', title: 'export', why: 'sharper', segments: [4] },
          { kind: 'action', title: 'Mail the offer', why: '', segments: [2] },
          { kind: 'feature', title: 'Dark mode', why: '', segments: [5] },
        ],
      },
      new Set(['s3']),
    )
    expect(again.topic.suggestions.map((s) => [s.id, s.title])).toEqual([
      ['s1', 'export'],
      ['s2', 'Mail the offer'],
      ['s4', 'Dark mode'],
      ['s3', 'Search'],
    ])
  })

  it('leaves the fields a person edited, and says which it kept', () => {
    const base = write(opened(), { startIndex: 0, title: 'Budget', summary: ['Costs'] }).topics
    const edited = [editTopic(base[0]!, { title: 'Money', keywords: ['cash', 'pay'] }, 5)]
    const { topic, kept } = write(edited, {
      startIndex: 0,
      title: 'Budget again',
      keywords: ['cash', 'pay'],
      summary: ['New'],
    })
    expect(topic).toMatchObject({ title: 'Money', keywords: ['cash', 'pay'], summary: ['New'] })
    // The same keywords are no change; only the title was refused.
    expect(kept).toEqual(['title'])
  })
})

describe('a person', () => {
  const three = (): Topic[] => {
    let t = write(opened(), { startIndex: 0, title: 'Budget', summary: ['Costs'] }).topics
    t = write(t, {
      startIndex: 4,
      title: 'Export',
      suggestions: [
        { kind: 'feature', title: 'CSV', why: '', segments: [4] },
        { kind: 'feature', title: 'PDF', why: '', segments: [6] },
      ],
    }).topics
    t = write(t, { startIndex: 0, title: 'Budget', summary: ['Costs'] }).topics
    return write(t, { startIndex: 8, title: 'Wrap-up' }).topics
  }

  it('splits a group at a line: both halves stale, suggestions from the line on move', () => {
    const t = splitTopic(three(), segments, 6)
    expect(t.map((x) => [x.id, x.lines, x.open, x.stale === true, x.title])).toEqual([
      ['t0', [0, 1, 2, 3], false, false, 'Budget'],
      ['t4', [4, 5], false, true, 'Export'],
      ['t6', [6, 7], false, true, ''],
      ['t8', [8, 9], true, false, 'Wrap-up'],
    ])
    expect(t[1]!.suggestions.map((s) => s.title)).toEqual(['CSV'])
    expect(t[2]!.suggestions.map((s) => s.title)).toEqual(['PDF'])
    // Splitting the open group leaves its second half open, not stale.
    const open = splitTopic(three(), segments, 9)
    expect(open.at(-1)).toMatchObject({ id: 't9', open: true })
    expect(open.at(-1)!.stale).toBeUndefined()
    expect(open.at(-2)).toMatchObject({ id: 't8', open: false, stale: true })
  })

  it('cannot split at a group’s first line or a line no group has', () => {
    expect(refused(() => splitTopic(three(), segments, 4)).code).toBe('CONFLICT')
    expect(refused(() => splitTopic(three(), segments, 40)).code).toBe('NOT_FOUND')
  })

  it('merges a group into the one before: lines, words and suggestions joined', () => {
    const t = mergeTopic(three(), segments, 't4')
    expect(t.map((x) => x.id)).toEqual(['t0', 't8'])
    expect(t[0]).toMatchObject({
      title: 'Budget',
      lines: [0, 1, 2, 3, 4, 5, 6, 7],
      stale: true,
      open: false,
      start: 0,
      end: 80,
    })
    expect(t[0]!.suggestions.map((s) => s.title)).toEqual(['CSV', 'PDF'])
    // Merging the open group keeps the merged one open.
    const last = mergeTopic(three(), segments, 't8')
    expect(last.at(-1)).toMatchObject({ id: 't4', open: true, lines: [4, 5, 6, 7, 8, 9] })
    expect(last.at(-1)!.stale).toBeUndefined()
  })

  it('cannot merge the first group, or one that does not exist', () => {
    expect(refused(() => mergeTopic(three(), segments, 't0')).code).toBe('CONFLICT')
    expect(refused(() => mergeTopic(three(), segments, 't5')).code).toBe('NOT_FOUND')
  })

  it('edits a group: the fields become theirs, with when', () => {
    const t = editTopic(three()[0]!, { title: 'Money', summary: ['A', 'B'] }, 1234)
    expect(t).toMatchObject({
      title: 'Money',
      summary: ['A', 'B'],
      edited: ['title', 'summary'],
      editedAt: 1234,
    })
    expect(editTopic(t, { questions: ['Who pays?'] }, 99).edited).toEqual([
      'title',
      'summary',
      'questions',
    ])
  })

  it('patches are checked', () => {
    expect(topicPatchParam({ title: '  Money  ', keywords: ['a', 'a', 'b'] })).toEqual({
      title: 'Money',
      keywords: ['a', 'b'],
    })
    for (const patch of [null, [], { title: '' }, { colour: 'red' }, { summary: 'one' }]) {
      expect(refused(() => topicPatchParam(patch)).code, JSON.stringify(patch)).toBe('BAD_REQUEST')
    }
  })
})
