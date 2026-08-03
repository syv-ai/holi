import type { Task } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import {
  ROOT_LANE,
  availableLabels,
  countOpenTasksLinking,
  dropIntent,
  laneLabel,
  laneOrder,
  matchesFilter,
  taskCreateFolders,
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

describe('countOpenTasksLinking (daily-notes FR-6)', () => {
  const DAILY = '14-07-2026.md'

  it('counts open tasks whose body links to the note, labelled links included', () => {
    const tasks = [
      task({ path: 'a.md', description: 'see [[14-07-2026.md]]' }),
      task({ path: 'b.md', description: 'ref [[14-07-2026.md|Today]] here' }),
      task({ path: 'c.md', description: 'no link' }),
    ]
    expect(countOpenTasksLinking(tasks, DAILY)).toBe(2)
  })

  it('excludes done tasks even when they link', () => {
    const tasks = [
      task({ path: 'a.md', status: 'done', description: '[[14-07-2026.md]]' }),
      task({ path: 'b.md', status: 'doing', description: '[[14-07-2026.md]]' }),
    ]
    expect(countOpenTasksLinking(tasks, DAILY)).toBe(1)
  })

  it('counts a task once however many times it links', () => {
    const tasks = [task({ description: '[[14-07-2026.md]] and again [[14-07-2026.md]]' })]
    expect(countOpenTasksLinking(tasks, DAILY)).toBe(1)
  })

  it('ignores links to other notes', () => {
    expect(countOpenTasksLinking([task({ description: '[[other.md]]' })], DAILY)).toBe(0)
  })
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

describe('taskCreateFolders', () => {
  it('lists every ancestor folder, unique and sorted, excluding the root', () => {
    expect(
      taskCreateFolders(['a.md', 'projects/q2/task.x.md', 'projects/b.md', 'personal/note.md']),
    ).toEqual(['personal', 'projects', 'projects/q2'])
  })

  it('is empty when everything lives in the vault root', () => {
    expect(taskCreateFolders(['a.md', 'task.b.md'])).toEqual([])
  })
})

describe('dropIntent', () => {
  // A card at `work/task.foo.md` (lane 'work', status 'todo').
  const card = task({ path: 'work/task.foo.md', status: 'todo' })

  it('same lane, diff column → a vertical status change', () => {
    expect(dropIntent(card, 'work', 'doing')).toEqual({ kind: 'status', status: 'doing' })
  })

  it('diff lane, same column → a pure horizontal move, no status', () => {
    expect(dropIntent(card, 'personal', 'todo')).toEqual({ kind: 'move', folder: 'personal' })
  })

  it('diff lane, diff column → a diagonal move carrying the new status', () => {
    expect(dropIntent(card, 'personal', 'done')).toEqual({
      kind: 'move',
      folder: 'personal',
      status: 'done',
    })
  })

  it('same lane, same column → nothing to do', () => {
    expect(dropIntent(card, 'work', 'todo')).toEqual({ kind: 'noop' })
  })
})
