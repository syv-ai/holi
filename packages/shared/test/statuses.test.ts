import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STATUSES,
  categoryOf,
  columnFor,
  completedStatus,
  isClosedStatus,
  openingStatus,
  parseStatusesFile,
} from '../src/statuses'

const CUSTOM = `
# Our columns
statuses:
  - id: ideas
    name: Ideas
    category: backlog
  - id: next
    name: Next up
    category: unstarted
  - id: building
    category: started
  - id: shipped
    name: Shipped
    category: completed
`

describe('parseStatusesFile', () => {
  it('is gr8r’s five without a file, todo/doing/done among them', () => {
    const { statuses, warnings } = parseStatusesFile(null)
    expect(statuses.map((s) => s.name)).toEqual([
      'Backlog',
      'To do',
      'In progress',
      'Review',
      'Done',
    ])
    expect(statuses.map((s) => s.id)).toEqual(['backlog', 'todo', 'doing', 'review', 'done'])
    expect(warnings).toEqual([])
  })

  it('reads a vault’s own list, in its order, naming a nameless status by its id', () => {
    const { statuses, warnings } = parseStatusesFile(CUSTOM)
    expect(statuses).toEqual([
      { id: 'ideas', name: 'Ideas', category: 'backlog' },
      { id: 'next', name: 'Next up', category: 'unstarted' },
      { id: 'building', name: 'building', category: 'started' },
      { id: 'shipped', name: 'Shipped', category: 'completed' },
    ])
    expect(warnings).toEqual([])
  })

  it('drops a bad entry with a warning and keeps the rest', () => {
    const { statuses, warnings } = parseStatusesFile(
      `statuses:
  - id: Todo Now
    category: unstarted
  - id: todo
    category: unstarted
  - id: todo
    category: started
  - id: x
    category: maybe
  - id: done
    category: completed
`,
    )
    expect(statuses.map((s) => s.id)).toEqual(['todo', 'done'])
    expect(warnings).toHaveLength(3)
  })

  it('falls back to the defaults when it cannot place new or finished tasks', () => {
    const noDone = parseStatusesFile('statuses:\n  - id: a\n    category: unstarted\n')
    expect(noDone.statuses).toEqual(DEFAULT_STATUSES)
    expect(noDone.warnings.at(-1)).toMatch(/no completed status/)
    expect(parseStatusesFile('statuses: [').warnings[0]).toMatch(/not valid YAML/)
    expect(parseStatusesFile('columns: []').warnings[0]).toMatch(/no `statuses` list/)
  })
})

describe('where a task shows', () => {
  const custom = parseStatusesFile(CUSTOM).statuses

  it('under its own status when the vault lists it', () => {
    expect(columnFor(DEFAULT_STATUSES, 'doing').name).toBe('In progress')
    expect(columnFor(custom, 'building').id).toBe('building')
  })

  it('the three old words go where they meant, in a vault that renamed them', () => {
    expect(columnFor(custom, 'todo').id).toBe('next')
    expect(columnFor(custom, 'doing').id).toBe('building')
    expect(columnFor(custom, 'done').id).toBe('shipped')
    expect(isClosedStatus(custom, 'done')).toBe(true)
  })

  it('any other unknown word shows in the first unstarted column and is open', () => {
    expect(columnFor(DEFAULT_STATUSES, 'blocked').id).toBe('todo')
    expect(categoryOf(custom, 'blocked')).toBe('unstarted')
    expect(isClosedStatus(custom, 'blocked')).toBe(false)
  })

  it('names where completion and reopening go', () => {
    expect(completedStatus(custom).id).toBe('shipped')
    expect(openingStatus(custom).id).toBe('next')
    expect(completedStatus(DEFAULT_STATUSES).id).toBe('done')
    expect(openingStatus(DEFAULT_STATUSES).id).toBe('todo')
  })
})
