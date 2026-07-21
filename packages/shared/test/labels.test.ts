import { describe, expect, it } from 'vitest'
import { allLabels, virtualLabels } from '../src/labels'
import type { Task } from '../src/types'

const TODAY = '2026-07-14'

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
