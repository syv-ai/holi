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

// A reminder is the moment itself now (D79), so the fire time IS the stored
// value — `due` is along for the ride and no longer participates.
const DUE = '2026-07-29'
const FIRE = '2026-07-28T09:00'
const REMINDER = FIRE

describe('sweep', () => {
  it('fires a task whose reminder time has arrived', () => {
    const vaults = [{ remote: 'o/r', tasks: [task({ due: DUE, reminder: REMINDER })] }]
    const { event, marks } = sweep(vaults, '2026-07-28T10:00', NONE)
    expect(event).not.toBeNull()
    expect(event!.fires).toEqual([
      { remote: 'o/r', path: 'task.t.md', title: 'a task', fireAt: FIRE },
    ])
    expect(event!.coalesced).toBe(false)
    expect(marks).toEqual([{ remote: 'o/r', path: 'task.t.md', fireAt: FIRE }])
  })

  it('does not fire before the reminder time', () => {
    const vaults = [{ remote: 'o/r', tasks: [task({ due: DUE, reminder: REMINDER })] }]
    const { event, marks } = sweep(vaults, '2026-07-28T08:00', NONE)
    expect(event).toBeNull()
    expect(marks).toEqual([])
  })

  it('respects the delivery watermark — a fire already delivered does not re-fire', () => {
    const vaults = [{ remote: 'o/r', tasks: [task({ due: DUE, reminder: REMINDER })] }]
    const delivered = () => ({ 'task.t.md': FIRE })
    const { event } = sweep(vaults, '2026-07-28T10:00', delivered)
    expect(event).toBeNull()
  })

  it('catches up a past-due undelivered fire', () => {
    // The fire was days ago and was never delivered; the sweep must still raise
    // it rather than skip a moment it slept through.
    const vaults = [
      { remote: 'o/r', tasks: [task({ due: '2026-07-26', reminder: '2026-07-25T09:00' })] },
    ]
    const { event } = sweep(vaults, '2026-07-28T10:00', NONE)
    expect(event).not.toBeNull()
    expect(event!.fires[0]!.fireAt).toBe('2026-07-25T09:00')
  })

  it('is inert for a reminderless task, a legacy relative value, and a done task', () => {
    const vaults = [
      {
        remote: 'o/r',
        tasks: [
          task({ path: 'task.a.md', due: DUE }), // no reminder
          task({ path: 'task.b.md', reminder: '1d' }), // legacy grammar — inert, never an error
          task({ path: 'task.c.md', due: DUE, reminder: REMINDER, status: 'done' }), // done
        ],
      },
    ]
    const { event, marks } = sweep(vaults, '2026-07-28T10:00', NONE)
    expect(event).toBeNull()
    expect(marks).toEqual([])
  })

  it('coalesces when more than three tasks fire at once', () => {
    const tasks = Array.from({ length: 4 }, (_, i) =>
      task({ path: `task.t${i}.md`, due: DUE, reminder: REMINDER }),
    )
    const { event } = sweep([{ remote: 'o/r', tasks }], '2026-07-28T10:00', NONE)
    expect(event!.fires).toHaveLength(4)
    expect(event!.coalesced).toBe(true)
  })

  it('does not coalesce exactly three fires', () => {
    const tasks = Array.from({ length: 3 }, (_, i) =>
      task({ path: `task.t${i}.md`, due: DUE, reminder: REMINDER }),
    )
    const { event } = sweep([{ remote: 'o/r', tasks }], '2026-07-28T10:00', NONE)
    expect(event!.fires).toHaveLength(3)
    expect(event!.coalesced).toBe(false)
  })

  it('aggregates across vaults, tagging each fire with its own remote', () => {
    const vaults = [
      { remote: 'o/a', tasks: [task({ path: 'task.a.md', due: DUE, reminder: REMINDER })] },
      { remote: 'o/b', tasks: [task({ path: 'task.b.md', due: DUE, reminder: REMINDER })] },
    ]
    const { event } = sweep(vaults, '2026-07-28T10:00', NONE)
    expect(event!.fires.map((f) => f.remote).sort()).toEqual(['o/a', 'o/b'])
  })
})
