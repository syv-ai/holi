/**
 * The minutes as code renders them from the groups and tasks: the title,
 * date and participants, then the decisions, action points (tasks and the
 * to-dos taken on) and open questions, then the discussion by topic; a draft
 * while it records or a topic is unwritten, and in the meeting's language.
 */
import { describe, expect, it } from 'vitest'
import type { Card, MeetingState, Segment, Topic } from '../shared/meeting'
import { minutesLanguage, renderMinutes } from '../main/minutes'

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

/** 4 November 2026, 10:00 to 10:45 on this machine's clock. */
const STARTED = new Date(2026, 10, 4, 10, 0).getTime()
const ENDED = new Date(2026, 10, 4, 10, 45).getTime()

const meetingWith = (
  topics: Topic[],
  cards: Card[] = [],
  over: Partial<MeetingState> = {},
): MeetingState =>
  ({
    title: 'Planning',
    startedAt: STARTED,
    endedAt: ENDED,
    phase: 'done',
    segments: [],
    topics,
    cards,
    ...over,
  }) as unknown as MeetingState

const said = (...texts: string[]): Segment[] =>
  texts.map((text, i) => ({ i, start: i, end: i + 1, text, speaker: 'Me', chunk: 0 }) as Segment)

describe('the minutes', () => {
  it('are empty without groups', () => {
    expect(renderMinutes(meetingWith([]))).toBe('')
  })

  it('say what the meeting was, what came of it, then the discussion by topic', () => {
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
            people: ['Mette', 'Simon'],
            suggestions: [
              { id: 's1', kind: 'action', title: 'Send the offer', why: 'Simon', segments: [0] },
              { id: 's2', kind: 'action', title: 'Book the room', why: 'Mette', segments: [0] },
              { id: 's3', kind: 'feature', title: 'Budget board', why: 'Asked', segments: [0] },
            ],
          }),
          topic({
            id: 't20',
            title: 'Export',
            summary: ['CSV is wanted first'],
            start: 300,
            end: 400,
            decisions: ['CSV first'],
            people: ['Simon'],
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
      'en',
    )
    expect(md).toBe(
      [
        '# Planning',
        '',
        '2026-11-04 · 10:00–10:45',
        '',
        'Participants: Mette, Simon',
        '',
        '## Decisions',
        '',
        '- Pilot runs in Q1 (Budget)',
        '- CSV first (Export)',
        '',
        '## Action points',
        '',
        '- [ ] Export to CSV (feature): not sent',
        '- [ ] Send the offer (to-do): sent to sales',
        '- [ ] Search (feature): sent to the agent',
        '- [ ] Book the room (Budget)',
        '',
        '## Open questions',
        '',
        '- Who pays for licences? (Budget)',
        '',
        '## Discussion',
        '',
        '### Budget (0:00–4:12)',
        '',
        '- The pilot costs 40k',
        '- Finance signs off',
        '',
        'Keywords: budget, pilot',
        '',
        '### Export (5:00–6:40)',
        '',
        '- CSV is wanted first',
        '',
      ].join('\n'),
    )
  })

  it('are a draft while the meeting records, and say a topic is not written rather than stand empty', () => {
    const recording = renderMinutes(
      meetingWith([topic({ id: 't0', open: true, start: 3 })], [], {
        phase: 'recording',
        endedAt: undefined,
      }),
      'en',
    )
    expect(recording).toBe(
      [
        '# Planning',
        '',
        '2026-11-04 · from 10:00',
        '',
        '> Draft: the meeting is still being recorded, and the topics fill in as it goes.',
        '',
        '## Discussion',
        '',
        '### Now (from 0:03)',
        '',
      ].join('\n'),
    )
    const unwritten = renderMinutes(
      meetingWith([topic({ id: 't0', start: 0, end: 60, stale: true })]),
      'en',
    )
    expect(unwritten).toContain('> Draft: some topics are not summarised yet.')
    expect(unwritten).toContain('### Untitled (0:00–1:00)\n\n_Not summarised yet._')
  })

  it('are in Danish for a Danish meeting, headings and all', () => {
    const md = renderMinutes(
      meetingWith(
        [
          topic({
            id: 't0',
            title: 'Budget',
            summary: ['Piloten koster 40.000'],
            decisions: ['Piloten kører i Q1'],
            questions: ['Hvem betaler licenserne?'],
          }),
          topic({ id: 't1', open: true, start: 60 }),
        ],
        [task({ id: 'c1', title: 'Send tilbuddet', kind: 'action' })],
        { phase: 'recording', endedAt: undefined },
      ),
      'da',
    )
    for (const heading of [
      '## Beslutninger',
      '## Handlingspunkter',
      '## Åbne spørgsmål',
      '## Drøftelse',
      '### Nu (fra 1:00)',
      '- [ ] Send tilbuddet (opgave): ikke sendt',
      '> Udkast: mødet optages stadig',
    ]) {
      expect(md).toContain(heading)
    }
    expect(md).not.toMatch(/Topics|Decisions|Open questions|Tasks/)
  })

  it('take the language the transcript is in when the profile says auto', () => {
    expect(
      minutesLanguage({ segments: said('Jeg tror det er godt, og vi skal ikke vente') }, 'auto'),
    ).toBe('da')
    expect(
      minutesLanguage({ segments: said('I think that is fine and we can just wait') }, 'auto'),
    ).toBe('en')
    expect(minutesLanguage({ segments: [] }, 'auto')).toBe('en')
    expect(minutesLanguage({ segments: said('the and is') }, 'da')).toBe('da')
  })
})
