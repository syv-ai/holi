import type { Task } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import { sweep } from '../src/main/reminders/sweep'
import type { Delivered } from '../src/main/reminders/sweep'

const task = (over: Partial<Task> = {}): Task => ({
  path: 'task.t.md',
  title: 'a task',
  status: 'todo',
  tags: [],
  description: '',
  ...over,
})

const NONE = (): Delivered => ({})

// due 2026-07-29, reminder '1d' → fire 2026-07-28T09:00 (ANCHOR_HOUR local).
const DUE = '2026-07-29'
const FIRE = '2026-07-28T09:00'

describe('sweep', () => {
  it('fires a task whose reminder time has arrived', () => {
    const vaults = [{ remote: 'o/r', tasks: [task({ due: DUE, reminder: '1d' })] }]
    const { event, marks } = sweep(vaults, '2026-07-28T10:00', NONE)
    expect(event).not.toBeNull()
    expect(event!.fires).toEqual([
      { remote: 'o/r', path: 'task.t.md', title: 'a task', fireAt: FIRE },
    ])
    expect(event!.coalesced).toBe(false)
    expect(marks).toEqual([{ remote: 'o/r', path: 'task.t.md', fireAt: FIRE }])
  })

  it('does not fire before the reminder time', () => {
    const vaults = [{ remote: 'o/r', tasks: [task({ due: DUE, reminder: '1d' })] }]
    const { event, marks } = sweep(vaults, '2026-07-28T08:00', NONE)
    expect(event).toBeNull()
    expect(marks).toEqual([])
  })

  it('respects the delivery watermark — a fire already delivered does not re-fire', () => {
    const vaults = [{ remote: 'o/r', tasks: [task({ due: DUE, reminder: '1d' })] }]
    const delivered = () => ({ 'task.t.md': FIRE })
    const { event } = sweep(vaults, '2026-07-28T10:00', delivered)
    expect(event).toBeNull()
  })

  it('catches up a past-due undelivered fire', () => {
    // fire was 2026-07-25T09:00 (due 2026-07-26, 1d before); now is days later, undelivered.
    const vaults = [{ remote: 'o/r', tasks: [task({ due: '2026-07-26', reminder: '1d' })] }]
    const { event } = sweep(vaults, '2026-07-28T10:00', NONE)
    expect(event).not.toBeNull()
    expect(event!.fires[0]!.fireAt).toBe('2026-07-25T09:00')
  })

  it('is inert for a reminderless task, a relative reminder with no due, and a done task', () => {
    const vaults = [
      {
        remote: 'o/r',
        tasks: [
          task({ path: 'task.a.md', due: DUE }), // no reminder
          task({ path: 'task.b.md', reminder: '1d' }), // relative, no due
          task({ path: 'task.c.md', due: DUE, reminder: '1d', status: 'done' }), // done
        ],
      },
    ]
    const { event, marks } = sweep(vaults, '2026-07-28T10:00', NONE)
    expect(event).toBeNull()
    expect(marks).toEqual([])
  })

  it('coalesces when more than three tasks fire at once', () => {
    const tasks = Array.from({ length: 4 }, (_, i) =>
      task({ path: `task.t${i}.md`, due: DUE, reminder: '1d' }),
    )
    const { event } = sweep([{ remote: 'o/r', tasks }], '2026-07-28T10:00', NONE)
    expect(event!.fires).toHaveLength(4)
    expect(event!.coalesced).toBe(true)
  })

  it('does not coalesce exactly three fires', () => {
    const tasks = Array.from({ length: 3 }, (_, i) =>
      task({ path: `task.t${i}.md`, due: DUE, reminder: '1d' }),
    )
    const { event } = sweep([{ remote: 'o/r', tasks }], '2026-07-28T10:00', NONE)
    expect(event!.fires).toHaveLength(3)
    expect(event!.coalesced).toBe(false)
  })

  it('aggregates across vaults, tagging each fire with its own remote', () => {
    const vaults = [
      { remote: 'o/a', tasks: [task({ path: 'task.a.md', due: DUE, reminder: '1d' })] },
      { remote: 'o/b', tasks: [task({ path: 'task.b.md', due: DUE, reminder: '1d' })] },
    ]
    const { event } = sweep(vaults, '2026-07-28T10:00', NONE)
    expect(event!.fires.map((f) => f.remote).sort()).toEqual(['o/a', 'o/b'])
  })
})
