/** A meeting mid-call, for the surface's tests: twelve lines in three
 *  topics (two closed, the last open), and the tasks people made. */
import type { Card, MeetingProfile, MeetingState, Segment, Topic } from '../shared/meeting'

export const profile: MeetingProfile = {
  id: 'planning',
  name: 'Planning',
  platform: 'Holi',
  focus: 'Features',
  ignore: 'Budget',
  glossary: [{ term: 'Claude', heardAs: ['klot'] }],
  instructions: '',
  language: 'da',
  shareMinutes: false,
  keepAudio: false,
}

const segments: Segment[] = Array.from({ length: 12 }, (_v, i) => ({
  i,
  speaker: i % 2 === 0 ? 'Me' : 'Them',
  start: i * 10,
  end: i * 10 + 8,
  text: `Line ${i} of the call`,
  chunk: Math.floor(i / 2),
}))

export const topics: Topic[] = [
  {
    id: 't0',
    title: 'Budget',
    summary: ['The pilot costs too much as planned.', 'Licences are the big item.'],
    keywords: ['budget', 'licences'],
    lines: [0, 1, 2, 3],
    start: 0,
    end: 38,
    open: false,
    decisions: ['Cap the pilot at ten seats'],
    questions: ['Who signs off the licences?'],
    suggestions: [
      {
        id: 's1',
        kind: 'action',
        title: 'Ask finance for the licence quote',
        why: 'Anna will ask finance before Friday.',
        segments: [2],
      },
    ],
  },
  {
    id: 't4',
    title: 'Export',
    summary: ['Finance wants the board as a CSV.'],
    keywords: ['csv', 'finance'],
    lines: [4, 5, 6, 7],
    start: 40,
    end: 78,
    open: false,
    decisions: [],
    questions: ['Which columns go in?'],
    suggestions: [
      {
        id: 's2',
        kind: 'feature',
        title: 'Export the board to CSV',
        why: 'Finance copies the board by hand every month.',
        segments: [5, 6],
      },
      {
        id: 's3',
        kind: 'feature',
        title: 'Search in notes',
        why: 'People lose decisions in old notes.',
        segments: [7],
      },
    ],
  },
  {
    id: 't8',
    title: 'Release plan',
    summary: [],
    keywords: ['release'],
    lines: [8, 9, 10, 11],
    start: 80,
    end: 118,
    open: true,
    decisions: [],
    questions: [],
    suggestions: [],
  },
]

function card(over: Partial<Card> & Pick<Card, 'id' | 'title'>): Card {
  return {
    kind: 'feature',
    why: 'People asked for it.',
    segments: [3],
    acceptance: [],
    openQuestions: [],
    quotes: [{ i: 3, speaker: 'Them', start: 30, text: 'Line 3 of the call' }],
    status: 'accepted',
    origin: 'person',
    range: { start: 30, end: 38, lines: 1 },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

export const meeting: MeetingState = {
  id: 'm1',
  title: 'Planning call',
  profileId: 'planning',
  startedAt: Date.UTC(2026, 10, 2, 9),
  phase: 'recording',
  segments,
  minutes: '## Topics\n\n### Budget (0:00–0:38)\n',
  minutesAt: Date.now() - 5_000,
  cards: [
    card({
      id: 'export',
      title: 'Export to CSV',
      acceptance: ['A CSV downloads from the board'],
      openQuestions: ['Which columns go in?'],
    }),
    card({
      id: 'invite',
      kind: 'action',
      title: 'Send the invite',
      owner: 'Anna',
      createdAt: 3,
    }),
    card({
      id: 'search',
      title: 'Search in notes',
      status: 'building',
      buildSessionId: 'job-7',
      from: { topicId: 't4', suggestionId: 's3' },
      createdAt: 4,
    }),
    card({ id: 'gone', title: 'A dismissed idea', status: 'dismissed' }),
    card({ id: 'old', title: 'An old suggestion', status: 'suggested', origin: undefined }),
  ],
  topics,
  scribeSessionId: 'scribe-1',
  scribeState: 'working',
  scribeCursor: 11,
  chunks: [
    { n: 0, start: 0, duration: 12, state: 'done', tries: 1, latencyMs: 2100 },
    { n: 1, start: 12, duration: 12, state: 'uploading', tries: 1 },
  ],
  folder: 'Meetings/2026-11-02 Planning call',
  minutesPath: 'Meetings/2026-11-02 Planning call/minutes.local.md',
}
