import type { Task } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import {
  NO_AREA,
  applyPresence,
  applyTasksEvent,
  laneFor,
  laneOrder,
  pruneExpired,
  availableLabels,
  matchesFilter,
  type PresenceEvent,
} from '../src/renderer/src/state/tasks'

const TODAY = '2026-07-14'
const T1 = 'aaaaaaaa-1111-4111-8111-111111111111'
const AREA = 'dddddddd-4444-4444-8444-444444444444'

const task = (over: Partial<Task> = {}): Task => ({
  id: T1,
  vaultId: 'v',
  title: 'Review the Q2 doc',
  status: 'todo',
  tags: [],
  related: [],
  version: 1,
  createdAt: '2026-07-14T00:00:00Z',
  updatedAt: '2026-07-14T00:00:00Z',
  ...over,
})

const beat = (over: Partial<PresenceEvent> = {}): PresenceEvent => ({
  taskId: T1,
  userId: 'u1',
  name: 'Nicolai',
  expiresAt: '2026-07-14T12:00:10Z',
  ...over,
})

describe('tasks reducer', () => {
  it('upsert sets, delete removes', () => {
    let m = applyTasksEvent(new Map(), { type: 'upserted', task: task() })
    expect(m.get(T1)?.title).toBe('Review the Q2 doc')

    m = applyTasksEvent(m, { type: 'upserted', task: task({ status: 'doing' }) })
    expect(m.get(T1)?.status).toBe('doing') // an upsert of a known task replaces it

    m = applyTasksEvent(m, { type: 'deleted', taskId: T1 })
    expect(m.has(T1)).toBe(false)
  })
})

describe('presence', () => {
  it('a fresh heartbeat replaces the same user’s last one — entries do not stack', () => {
    let p = applyPresence(new Map(), beat())
    p = applyPresence(p, beat({ expiresAt: '2026-07-14T12:00:20Z' }))
    expect(p.get(T1)).toHaveLength(1)
    expect(p.get(T1)![0].expiresAt).toBe('2026-07-14T12:00:20Z')
  })

  it('two different users on one task both show', () => {
    let p = applyPresence(new Map(), beat())
    p = applyPresence(p, beat({ userId: 'u2', name: 'Ada' }))
    expect(p.get(T1)!.map((e) => e.name).sort()).toEqual(['Ada', 'Nicolai'])
  })

  it('an entry expires on its own — a heartbeat that stops arriving IS the release', () => {
    const p = applyPresence(new Map(), beat({ expiresAt: '2026-07-14T12:00:10Z' }))
    expect(pruneExpired(p, '2026-07-14T12:00:05Z').get(T1)).toHaveLength(1) // still live
    expect(pruneExpired(p, '2026-07-14T12:00:11Z').has(T1)).toBe(false) // gone, no event needed
  })

  it('pruning one user leaves the other', () => {
    let p = applyPresence(new Map(), beat({ expiresAt: '2026-07-14T12:00:10Z' }))
    p = applyPresence(p, beat({ userId: 'u2', name: 'Ada', expiresAt: '2026-07-14T12:00:30Z' }))
    const left = pruneExpired(p, '2026-07-14T12:00:20Z').get(T1)!
    expect(left.map((e) => e.name)).toEqual(['Ada'])
  })
})

describe('lanes', () => {
  const folders = new Map([[AREA, 'projects/q2']])

  it('a task with an area lands in its folder’s lane', () => {
    expect(laneFor(task({ area: AREA }), folders)).toBe('projects/q2')
  })

  it('no area lands in "(no area)"', () => {
    expect(laneFor(task(), folders)).toBe(NO_AREA)
  })

  it('an area the renderer does not know yet falls into "(no area)" — the card must not vanish', () => {
    // folders appear as a side effect of note paths and have no SSE channel; a card the
    // user cannot see anywhere is worse than a card in the wrong lane
    expect(laneFor(task({ area: 'unknown-folder-id' }), folders)).toBe(NO_AREA)
  })

  it('"(no area)" sorts first, then alphabetical', () => {
    expect(laneOrder(['work', NO_AREA, 'admin', 'work'])).toEqual([NO_AREA, 'admin', 'work'])
  })

  it('"(no area)" is present even when no task is unfiled', () => {
    expect(laneOrder(['work'])).toEqual([NO_AREA, 'work'])
  })
})

describe('filter (three controls, and one vocabulary)', () => {
  const F = { search: '', tags: [] as string[], hideDone: false }

  it('search matches the title', () => {
    expect(matchesFilter(task({ title: 'Review the Q2 doc' }), { ...F, search: 'q2' }, TODAY)).toBe(true)
    expect(matchesFilter(task({ title: 'Call the vendor' }), { ...F, search: 'q2' }, TODAY)).toBe(false)
  })

  it('search matches the DESCRIPTION too — the body is part of the task', () => {
    const t = task({ title: 'Call the vendor', description: 'ask about the Q2 invoice' })
    expect(matchesFilter(t, { ...F, search: 'invoice' }, TODAY)).toBe(true)
  })

  it('search is case-insensitive and ignores surrounding space', () => {
    expect(matchesFilter(task({ title: 'Review' }), { ...F, search: '  REVIEW ' }, TODAY)).toBe(true)
  })

  it('the tag filter matches a REAL tag', () => {
    expect(matchesFilter(task({ tags: ['finance'] }), { ...F, tags: ['finance'] }, TODAY)).toBe(true)
    expect(matchesFilter(task({ tags: ['ops'] }), { ...F, tags: ['finance'] }, TODAY)).toBe(false)
  })

  it('the tag filter matches a VIRTUAL label identically — that is the point of D41', () => {
    const overdue = task({ due: '2020-01-01' })
    expect(matchesFilter(overdue, { ...F, tags: ['overdue'] }, TODAY)).toBe(true)
    expect(matchesFilter(task({ due: '2030-01-01' }), { ...F, tags: ['overdue'] }, TODAY)).toBe(false)
  })

  it('selected tags are ANDed — "the overdue p1s" is one query', () => {
    const t = task({ due: '2020-01-01', priority: 'high' })
    expect(matchesFilter(t, { ...F, tags: ['overdue', 'p1'] }, TODAY)).toBe(true)
    // high priority but not overdue
    expect(matchesFilter(task({ priority: 'high' }), { ...F, tags: ['overdue', 'p1'] }, TODAY)).toBe(false)
  })

  it('the done toggle hides done tasks and nothing else', () => {
    expect(matchesFilter(task({ status: 'done' }), { ...F, hideDone: true }, TODAY)).toBe(false)
    expect(matchesFilter(task({ status: 'doing' }), { ...F, hideDone: true }, TODAY)).toBe(true)
    expect(matchesFilter(task({ status: 'done' }), F, TODAY)).toBe(true)
  })

  it('an empty filter matches everything', () => {
    expect(matchesFilter(task({ status: 'done', due: '2020-01-01' }), F, TODAY)).toBe(true)
  })
})

describe('availableLabels', () => {
  it('offers virtual labels and real tags together, sorted', () => {
    const tasks = [task({ due: '2020-01-01', priority: 'high', tags: ['finance'] }), task({ tags: ['ops'] })]
    expect(availableLabels(tasks, TODAY)).toEqual(['finance', 'ops', 'overdue', 'p1'])
  })
})
