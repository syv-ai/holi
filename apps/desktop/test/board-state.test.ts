import type { Task } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import {
  ROOT_LANE,
  availableLabels,
  laneLabel,
  laneOrder,
  matchesFilter,
} from '../src/renderer/src/state/tasks'

const TODAY = '2026-07-14'

const task = (over: Partial<Task> = {}): Task => ({
  path: 'task.review-the-q2-doc.md',
  title: 'Review the Q2 doc',
  status: 'todo',
  tags: [],
  description: '',
  ...over,
})

describe('lanes', () => {
  it('the vault-root lane sorts first, then alphabetical by path', () => {
    expect(laneOrder(['work', ROOT_LANE, 'admin', 'work'])).toEqual([ROOT_LANE, 'admin', 'work'])
  })

  it('the root lane is present even when nothing is filed there', () => {
    // Quick-add needs a cell to land in; a vault whose every task sits in a
    // folder would otherwise have nowhere to drop a new root-level task.
    expect(laneOrder(['work'])).toEqual([ROOT_LANE, 'work'])
  })

  it('names the root lane, since its path is the empty string', () => {
    expect(laneLabel(ROOT_LANE)).toBe('(vault root)')
    expect(laneLabel('projects/q2')).toBe('projects/q2')
  })
})

describe('filter (three controls, and one vocabulary)', () => {
  const F = { search: '', tags: [] as string[], hideDone: false }

  it('search matches the title', () => {
    expect(matchesFilter(task({ title: 'Review the Q2 doc' }), { ...F, search: 'q2' }, TODAY)).toBe(
      true,
    )
    expect(matchesFilter(task({ title: 'Call the vendor' }), { ...F, search: 'q2' }, TODAY)).toBe(
      false,
    )
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

  it('the tag filter matches a VIRTUAL label identically — one vocabulary', () => {
    expect(matchesFilter(task({ due: '2020-01-01' }), { ...F, tags: ['overdue'] }, TODAY)).toBe(true)
    expect(matchesFilter(task({ due: '2030-01-01' }), { ...F, tags: ['overdue'] }, TODAY)).toBe(
      false,
    )
  })

  it('selected tags are ANDed — "the overdue p1s" is one query', () => {
    const t = task({ due: '2020-01-01', priority: 'high' })
    expect(matchesFilter(t, { ...F, tags: ['overdue', 'p1'] }, TODAY)).toBe(true)
    expect(
      matchesFilter(task({ priority: 'high' }), { ...F, tags: ['overdue', 'p1'] }, TODAY),
    ).toBe(false)
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
    const tasks = [
      task({ due: '2020-01-01', priority: 'high', tags: ['finance'] }),
      task({ tags: ['ops'] }),
    ]
    expect(availableLabels(tasks, TODAY)).toEqual(['finance', 'ops', 'overdue', 'p1'])
  })
})
