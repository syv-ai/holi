/**
 * The minutes as code renders them from the groups and tasks: the topics
 * with summaries and keywords, the open one as Now, the decisions and open
 * questions gathered under their group's title, and the tasks people made.
 */
import { describe, expect, it } from 'vitest'
import type { Card, MeetingState, Topic } from '../shared/meeting'
import { renderMinutes } from '../main/minutes'

const topic = (over: Partial<Topic> & Pick<Topic, 'id'>): Topic => ({
  title: '',
  summary: [],
  keywords: [],
  lines: [0],
  start: 0,
  end: 0,
  open: false,
  decisions: [],
  questions: [],
  suggestions: [],
  ...over,
})

const task = (over: Partial<Card> & Pick<Card, 'id' | 'title'>): Card => ({
  kind: 'feature',
  why: 'Asked',
  segments: [0],
  acceptance: [],
  openQuestions: [],
  quotes: [],
  status: 'accepted',
  origin: 'person',
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const meetingWith = (topics: Topic[], cards: Card[] = []) =>
  ({ topics, cards }) as unknown as MeetingState

describe('the minutes', () => {
  it('are empty without groups', () => {
    expect(renderMinutes(meetingWith([]))).toBe('')
  })

  it('list the topics, gather decisions and questions, and the tasks with where they stand', () => {
    const md = renderMinutes(
      meetingWith(
        [
          topic({
            id: 't0',
            title: 'Budget',
            summary: ['The pilot costs 40k', 'Finance signs off'],
            keywords: ['budget', 'pilot'],
            start: 0,
            end: 252,
            decisions: ['Pilot runs in Q1'],
            questions: ['Who pays for licences?'],
          }),
          topic({ id: 't9', start: 252, end: 300, stale: true }),
          topic({
            id: 't20',
            title: 'Export',
            start: 300,
            end: 400,
            open: true,
            summary: ['not shown while open'],
            decisions: ['CSV first'],
          }),
        ],
        [
          task({ id: 'c1', title: 'Export to CSV' }),
          task({
            id: 'c2',
            title: 'Send the offer',
            kind: 'action',
            status: 'building',
            target: { kind: 'holi', id: 'sales' },
          }),
          task({ id: 'c3', title: 'Search', status: 'building' }),
          task({ id: 'c4', title: 'Gone', status: 'dismissed' }),
        ],
      ),
    )
    expect(md).toBe(
      [
        '## Topics',
        '',
        '### Budget (0:00–4:12)',
        '',
        '- The pilot costs 40k',
        '- Finance signs off',
        '',
        'Keywords: budget, pilot',
        '',
        '### Untitled (4:12–5:00)',
        '',
        '### Now: Export (from 5:00)',
        '',
        '## Decisions',
        '',
        '- Pilot runs in Q1 (Budget)',
        '- CSV first (Export)',
        '',
        '## Open questions',
        '',
        '- Who pays for licences? (Budget)',
        '',
        '## Tasks',
        '',
        '- [ ] Export to CSV (feature): not sent',
        '- [ ] Send the offer (to-do): sent to sales',
        '- [ ] Search (feature): sent to Claude',
        '',
      ].join('\n'),
    )
  })

  it('show an untitled open group as Now, and leave out empty sections', () => {
    const md = renderMinutes(meetingWith([topic({ id: 't0', open: true, start: 3 })]))
    expect(md).toBe('## Topics\n\n### Now (from 0:03)\n')
  })
})
