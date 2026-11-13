import { completeTask } from '@holi/shared'
import type { Task } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import { sweep } from '../main/reminders/sweep'
import type { Delivered, VaultTasks } from '../main/reminders/sweep'

const task = (over: Partial<Task> = {}): Task => ({
  path: 'task.t.md',
  title: 'a task',
  status: 'todo',
  tags: [],
  assignees: [],
  description: '',
  ...over,
})

const NONE = (): Delivered => ({})

// A reminder is the moment itself now, so the fire time IS the stored
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

describe('sweep with assignees', () => {
  const assigned = task({ reminder: REMINDER, assignees: ['mads'] })
  const vaults = [{ remote: 'o/r', tasks: [assigned] }]

  it('reminds an assignee', () => {
    expect(sweep(vaults, '2026-07-28T10:00', NONE, 'Mads').event).not.toBeNull()
  })

  it('reminds no one else, and leaves the reminder unmarked for them', () => {
    const { event, marks } = sweep(vaults, '2026-07-28T10:00', NONE, 'someone')
    expect(event).toBeNull()
    expect(marks).toEqual([])
    expect(sweep(vaults, '2026-07-28T10:00', NONE, null).event).toBeNull()
  })

  it('still reminds everyone of a task with no assignees', () => {
    const open = [{ remote: 'o/r', tasks: [task({ reminder: REMINDER })] }]
    expect(sweep(open, '2026-07-28T10:00', NONE, 'someone').event).not.toBeNull()
  })
})

describe('fallback overdue delivery', () => {
  const overdue = (due: string, extra: Partial<Task> = {}) => task({ due, ...extra })
  const vault = (tasks: Task[], statuses?: VaultTasks['statuses']): VaultTasks => ({
    remote: 'o/r',
    tasks,
    ...(statuses === undefined ? {} : { statuses }),
  })
  it('fires strictly after a timed minute and after a date-only day', () => {
    const timed = vault([overdue('2026-07-28T09:00')])
    expect(sweep([timed], '2026-07-28T09:00', NONE).event).toBeNull()
    expect(sweep([timed], '2026-07-28T09:01', NONE).event?.fires[0]).toMatchObject({
      overdue: true,
      due: '2026-07-28T09:00',
    })
    const allDay = vault([overdue('2026-07-28')])
    expect(sweep([allDay], '2026-07-29T00:00', NONE).event?.fires[0]?.due).toBe('2026-07-28')
    expect(sweep([allDay], '2026-07-28T23:59', NONE).event).toBeNull()
  })

  it('ignores absent or invalid due stamps and every explicitly reminded task', () => {
    const tasks = [
      overdue('not-a-date'),
      task(),
      overdue(DUE, { reminder: 'not-a-reminder' }),
      overdue(DUE, { reminder: '2026-08-01T09:00' }),
      overdue(DUE, { reminder: REMINDER }),
    ]
    const result = sweep([vault(tasks)], '2026-07-30T10:00', NONE)
    expect(result.event?.fires).toEqual([
      { remote: 'o/r', path: 'task.t.md', title: 'a task', fireAt: REMINDER },
    ])
    expect(result.fallbackMarks).toEqual([])
  })

  it('excludes default and vault-defined completed statuses, but allows open statuses', () => {
    const statuses = [
      { id: 'queued', name: 'Queued', category: 'unstarted' as const },
      { id: 'shipped', name: 'Shipped', category: 'completed' as const },
    ]
    expect(
      sweep(
        [vault([overdue(DUE, { status: 'done' }), overdue(DUE, { status: 'shipped' })], statuses)],
        '2026-07-30T10:00',
        NONE,
      ).event,
    ).toBeNull()
    expect(
      sweep([vault([overdue(DUE, { status: 'queued' })], statuses)], '2026-07-30T10:00', NONE)
        .event,
    ).not.toBeNull()
    expect(sweep([vault([overdue(DUE)], null)], '2026-07-30T10:00', NONE).event).toBeNull()
  })

  it('applies the assignee policy and coalesces mixed fires together', () => {
    const dueTask = overdue(DUE, { path: 'task.due.md', assignees: ['Mads'] })
    const otherDueTask = overdue(DUE, { path: 'task.due2.md', assignees: ['Mads'] })
    const explicitTasks = Array.from({ length: 2 }, (_, index) =>
      task({ path: `task.reminder${index}.md`, reminder: REMINDER }),
    )
    const tasks = [dueTask, otherDueTask, ...explicitTasks]
    expect(sweep([vault(tasks)], '2026-07-30T10:00', NONE, 'mAdS').event?.coalesced).toBe(true)
    expect(sweep([vault(tasks)], '2026-07-30T10:00', NONE, 'someone').event?.fires).toHaveLength(2)
    expect(sweep([vault([dueTask])], '2026-07-30T10:00', NONE, null).event).toBeNull()
    expect(sweep([vault([overdue(DUE)])], '2026-07-30T10:00', NONE, 'someone').event).not.toBeNull()
  })

  it('allows the next occurrence produced by shared recurrence completion', () => {
    const receipts = { has: (_remote: string, _path: string, due: string) => due === DUE }
    const rolled = completeTask(
      overdue(DUE, { recurrence: { frequency: 'daily', interval: 1 } }),
      '2026-07-30',
    )
    expect(rolled.due).toBe('2026-07-30')
    const next = task({ ...rolled, path: 'task.t.md' })
    const result = sweep([vault([next])], '2026-07-31T10:00', NONE, null, receipts)
    expect(result.event?.fires[0]?.due).toBe('2026-07-30')
  })

  it('deduplicates each remote, path and exact due occurrence without chronological watermarks', () => {
    const receipts = new Set<string>()
    const seen = {
      has: (remote: string, path: string, due: string) =>
        receipts.has(JSON.stringify([remote, path, due])),
    }
    const mark = (remote: string, path: string, due: string) =>
      receipts.add(JSON.stringify([remote, path, due]))
    const taskA = overdue(DUE)
    const a = vault([taskA])
    const first = sweep([a], '2026-07-30T10:00', NONE, null, seen)
    expect(first.event).not.toBeNull()
    for (const receipt of first.fallbackMarks) mark(receipt.remote, receipt.path, receipt.fireAt)
    expect(sweep([a], '2026-07-31T10:00', NONE, null, seen).event).toBeNull()
    mark('o/r', 'task.t.md', `${DUE}T09:00`)
    expect(
      sweep([vault([overdue(`${DUE}T09:00:30`)])], '2026-07-31T10:00', NONE, null, seen).event,
    ).toBeNull()
    const earlier = vault([overdue('2026-07-27')])
    expect(sweep([earlier], '2026-07-31T10:00', NONE, null, seen).event).not.toBeNull()
    expect(sweep([vault([overdue(DUE)])], '2026-07-31T10:00', NONE, null, seen).event).toBeNull()
    expect(
      sweep([vault([overdue('2026-07-30')])], '2026-07-31T10:00', NONE, null, seen).event,
    ).not.toBeNull()
    expect(
      sweep(
        [vault([overdue(DUE, { path: 'task.other.md' })])],
        '2026-07-31T10:00',
        NONE,
        null,
        seen,
      ).event,
    ).not.toBeNull()
    expect(
      sweep([{ remote: 'o/other', tasks: [taskA] }], '2026-07-31T10:00', NONE, null, seen).event,
    ).not.toBeNull()
  })
})
