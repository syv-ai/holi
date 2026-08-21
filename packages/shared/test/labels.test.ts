import { describe, expect, it } from 'vitest'
import { allLabels, virtualLabels } from '../src/labels'
import type { Task } from '../src/types'

// `now` is a TIMED stamp (D79) — the overdue rule reads the clock, not just
// the calendar. Mid-afternoon, so both sides of the day boundary are reachable.
const NOW = '2026-07-14T14:00'
const TODAY = NOW

const task = (over: Partial<Task> = {}): Task => ({
  path: 'task.t.md',
  title: 'T',
  status: 'todo',
  tags: [],
  description: '',
  ...over,
})

describe('virtualLabels (D41 — computed, never stored)', () => {
  it('maps priority to p1/p2/p3', () => {
    expect(virtualLabels(task({ priority: 'high' }), TODAY)).toEqual(['p1'])
    expect(virtualLabels(task({ priority: 'medium' }), TODAY)).toEqual(['p2'])
    expect(virtualLabels(task({ priority: 'low' }), TODAY)).toEqual(['p3'])
  })

  it('no priority yields no pN', () => {
    expect(virtualLabels(task(), TODAY)).toEqual([])
  })

  it('a past due date is overdue', () => {
    expect(virtualLabels(task({ due: '2026-07-13' }), TODAY)).toContain('overdue')
  })

  it('due TODAY is not overdue — you still have the day', () => {
    expect(virtualLabels(task({ due: TODAY }), TODAY)).not.toContain('overdue')
  })

  it('a future due date is not overdue', () => {
    expect(virtualLabels(task({ due: '2026-07-15' }), TODAY)).not.toContain('overdue')
  })

  it('a DONE task is never overdue, however old', () => {
    expect(virtualLabels(task({ due: '2020-01-01', status: 'done' }), TODAY)).toEqual([])
  })

  it('no due date is never overdue', () => {
    expect(virtualLabels(task({ priority: 'high' }), TODAY)).toEqual(['p1'])
  })

  it('overdue and priority compose', () => {
    expect(virtualLabels(task({ due: '2026-01-01', priority: 'high' }), TODAY)).toEqual([
      'overdue',
      'p1',
    ])
  })
})

describe('allLabels', () => {
  it('puts virtual labels before the task’s real tags', () => {
    const t = task({ due: '2026-01-01', priority: 'medium', tags: ['finance', 'q2'] })
    expect(allLabels(t, TODAY)).toEqual(['overdue', 'p2', 'finance', 'q2'])
  })

  it('a task with only real tags renders only those', () => {
    expect(allLabels(task({ tags: ['finance'] }), TODAY)).toEqual(['finance'])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D79: `due` may name an hour, and when it does, overdue means past that
// minute. When it does not, overdue still means the DAY has passed — an
// all-day task due today is not late at 00:01, which is the boundary the
// day-granular rule got right and must keep getting right.
describe('virtualLabels — a due date that names an hour', () => {
  it('is not overdue one minute before its time', () => {
    expect(virtualLabels(task({ due: '2026-07-14T14:01' }), NOW)).not.toContain('overdue')
  })

  it('is overdue one minute after its time', () => {
    expect(virtualLabels(task({ due: '2026-07-14T13:59' }), NOW)).toContain('overdue')
  })

  it('is not overdue at exactly its own minute', () => {
    expect(virtualLabels(task({ due: '2026-07-14T14:00' }), NOW)).not.toContain('overdue')
  })

  it('a DONE task with a timed due is never overdue', () => {
    expect(virtualLabels(task({ due: '2020-01-01T09:00', status: 'done' }), NOW)).toEqual([])
  })
})

describe('virtualLabels — a timeless due stays day-granular', () => {
  it('is not overdue late on its own day', () => {
    expect(virtualLabels(task({ due: '2026-07-14' }), '2026-07-14T23:59')).not.toContain('overdue')
  })

  it('is overdue in the first minute of the next day', () => {
    expect(virtualLabels(task({ due: '2026-07-14' }), '2026-07-15T00:01')).toContain('overdue')
  })
})

describe('virtualLabels — unparseable input', () => {
  it('an unparseable due yields no overdue label, and does not throw', () => {
    expect(virtualLabels(task({ due: 'not-a-date' }), NOW)).toEqual([])
    expect(virtualLabels(task({ due: '1d', priority: 'high' }), NOW)).toEqual(['p1'])
  })
})
