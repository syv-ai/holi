/**
 * The session list's rules: how the slots' rows and the live sessions merge,
 * the state each row shows (working, needs you, done until opened), the
 * search and filter, the groups, and the age.
 */
import { expect, test, vi } from 'vitest'
import type { AgentsSessionItem } from '@/plugin-api'
import {
  age,
  groupRows,
  mergeSessionItems,
  modelLabel,
  nextEndedAt,
  NO_FILTER,
  rowMatches,
  rowState,
  type SessionRow,
} from '../renderer/state/session-list'
import type { AgentSession } from '../renderer/state/sessions'

vi.mock('../renderer/agent-cap', () => ({ agentCap: {} }))

const item = (over: Partial<AgentsSessionItem> = {}): AgentsSessionItem => ({
  key: 'chat:1',
  selection: { owner: 'chat', id: '1' },
  title: 'Plan the week',
  state: 'idle',
  updatedAt: 1_000,
  ...over,
})

const seen = (since = 0, map: Record<string, number> = {}) => ({ since, seen: map })

test('model names read as a person says them', () => {
  expect(modelLabel(undefined)).toBe('Claude')
  expect(modelLabel('opus')).toBe('Opus')
  expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
  expect(modelLabel('Opus 5.5')).toBe('Opus 5.5')
})

test('working and needs you are the session own; a finished turn is done until opened', () => {
  expect(rowState(item({ state: 'working' }), seen(), false)).toBe('working')
  expect(rowState(item({ state: 'needs-you' }), seen(), true)).toBe('needs-you')
  // Ended after it was last opened: done, unread.
  expect(rowState(item({ endedAt: 500 }), seen(0, { 'chat:1': 100 }), false)).toBe('done')
  // Opened since: read.
  expect(rowState(item({ endedAt: 500 }), seen(0, { 'chat:1': 900 }), false)).toBe('idle')
  // The open row is never news, and a turn before tracking began is not either.
  expect(rowState(item({ endedAt: 500 }), seen(), true)).toBe('idle')
  expect(rowState(item({ endedAt: 500 }), seen(600), false)).toBe('idle')
  // Never ran a turn: nothing to say.
  expect(rowState(item(), seen(), false)).toBe('idle')
})

test("a live session that is a plugin's run takes the run's row, with the session's state", () => {
  const live: AgentSession[] = [
    {
      id: 'j1',
      provider: 'claude',
      name: 'Scout · Week kickoff',
      state: 'needs-you',
      waitingFor: 'Run holi?',
      model: 'Opus 5.5',
      startedAt: 2_000,
    },
    { id: 'j2', provider: 'claude', name: 'Free session', state: 'working' },
  ]
  const holiRun = item({
    key: 'holis:j1',
    selection: undefined,
    jobId: 'j1',
    title: 'Week kickoff',
    by: { kind: 'holi', name: 'Scout', mascot: 'scout', color: '#ff0000' },
  })
  // The same session as an automation's run: the Holi's row wins.
  const autoRun = item({ key: 'automations:j1', selection: undefined, jobId: 'j1', title: 'Daily' })
  const gone = item({ key: 'holis:j9', selection: undefined, jobId: 'j9', state: 'needs-you' })
  const merged = mergeSessionItems([holiRun, autoRun, gone, item()], live)
  expect(merged.map((i) => i.key)).toEqual(['holis:j1', 'holis:j9', 'chat:1', 'agent:j2'])
  expect(merged[0]).toMatchObject({
    title: 'Week kickoff',
    state: 'needs-you',
    waitingFor: 'Run holi?',
    model: 'Opus 5.5',
    updatedAt: 2_000,
    by: { name: 'Scout' },
  })
  // A run whose session is gone is not in flight.
  expect(merged[1]!.state).toBe('idle')
  expect(merged[3]).toMatchObject({ title: 'Free session', state: 'working', jobId: 'j2' })
})

test('a row that stops working ended its turn now', () => {
  const prev = new Map<string, AgentsSessionItem['state']>([
    ['a', 'working'],
    ['b', 'idle'],
    ['c', 'needs-you'],
  ])
  const items = [
    item({ key: 'a', state: 'idle' }),
    item({ key: 'b', state: 'idle' }),
    item({ key: 'c', state: 'working' }),
  ]
  expect(nextEndedAt(prev, items, {}, 42)).toEqual({ a: 42 })
  const same = {}
  expect(nextEndedAt(new Map(), items, same, 42)).toBe(same)
})

const row = (
  over: Partial<AgentsSessionItem>,
  state: SessionRow['state'] = 'idle',
): SessionRow => ({
  item: item(over),
  state,
  current: false,
})

test('search reads the title, who ran it, where and the model', () => {
  const r = row({
    title: 'Inbox cleanup',
    by: { kind: 'holi', name: 'Scout' },
    location: 'Meetings/Kickoff.md',
    model: 'opus',
  })
  for (const q of ['inbox', 'SCOUT', 'kickoff', 'opus'])
    expect(rowMatches(r, q, NO_FILTER)).toBe(true)
  expect(rowMatches(r, 'nothing', NO_FILTER)).toBe(false)
})

test('the filter keeps states, who started it, and archived on request', () => {
  const mine = row({}, 'working')
  const holis = row({ by: { kind: 'holi', name: 'Scout' } }, 'needs-you')
  const read = row({}, 'idle')
  const unread = row({}, 'done')
  const archived = row({ archived: true }, 'idle')
  const all = [mine, holis, read, unread, archived]
  const keep = (f: Partial<typeof NO_FILTER>) =>
    all.filter((r) => rowMatches(r, '', { ...NO_FILTER, ...f }))
  expect(keep({})).toEqual([mine, holis, read, unread])
  expect(keep({ states: ['working', 'needs-you'] })).toEqual([mine, holis])
  // Done is every finished row, read or not.
  expect(keep({ states: ['done'] })).toEqual([read, unread])
  expect(keep({ source: 'mine' })).toEqual([mine, read, unread])
  expect(keep({ source: 'agents' })).toEqual([holis])
  expect(keep({ archived: true })).toEqual(all)
})

test('what needs you is pinned first, then today, yesterday and earlier, newest first', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime()
  const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime()
  const rows = [
    row({ key: 'old', updatedAt: at(10, 9) }),
    row({ key: 'y', updatedAt: at(22, 9) }),
    row({ key: 't1', updatedAt: at(23, 9) }),
    row({ key: 't2', updatedAt: at(23, 14) }, 'working'),
    row({ key: 'ask', updatedAt: at(1, 9) }, 'needs-you'),
  ]
  const groups = groupRows(rows, now)
  expect(groups.map((g) => [g.label, g.rows.map((r) => r.item.key)])).toEqual([
    ['Needs you', ['ask']],
    ['Today', ['t2', 't1']],
    ['Yesterday', ['y']],
    ['Earlier', ['old']],
  ])
})

test('ages as MonoCode puts them', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime()
  expect(age(now - 20_000, now)).toBe('now')
  expect(age(now - 10 * 60_000, now)).toBe('10m')
  expect(age(now - (5 * 60 + 43) * 60_000, now)).toBe('5h 43m')
  expect(age(now - 3 * 86_400_000, now)).toBe('3d')
  expect(age(new Date(2026, 9, 7).getTime(), now)).toMatch(/7/)
})

test('a pinned row sits in Pinned, under what needs you and above the days', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime()
  const rows = [
    row({ key: 't', updatedAt: now - 60_000 }),
    row({ key: 'p', updatedAt: 1, pinned: true }),
    row({ key: 'ask', updatedAt: 1, pinned: true }, 'needs-you'),
  ]
  expect(groupRows(rows, now).map((g) => [g.label, g.rows.map((r) => r.item.key)])).toEqual([
    ['Needs you', ['ask']],
    ['Pinned', ['p']],
    ['Today', ['t']],
  ])
})

test('a row marked unread is done until it is opened, whenever it ended', () => {
  const unread = { since: 900, seen: { 'chat:1': 950 }, unread: { 'chat:1': true as const } }
  expect(rowState(item(), unread, false)).toBe('done')
  expect(rowState(item({ endedAt: 100 }), unread, false)).toBe('done')
  expect(rowState(item(), unread, true)).toBe('idle')
  expect(rowState(item({ state: 'working' }), unread, false)).toBe('working')
})
