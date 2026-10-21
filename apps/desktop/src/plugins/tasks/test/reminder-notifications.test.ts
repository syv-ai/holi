import { describe, expect, it } from 'vitest'
import { notificationsFor } from '../main/reminders/notifications'
import type { RemindersEvent } from '../main/reminders/types'

const fire = (n: number, remote = 'o/r') => ({
  remote,
  path: `task.t${n}.md`,
  title: `task ${n}`,
  fireAt: '2026-07-16T09:00',
})
const event = (count: number, coalesced = false): RemindersEvent => ({
  fires: Array.from({ length: count }, (_, i) => fire(i + 1)),
  coalesced,
  firedAt: '2026-07-16T07:00:00.000Z',
})

describe('notificationsFor', () => {
  it('raises one notification per fire, titled by the task', () => {
    const specs = notificationsFor(event(2))
    expect(specs).toHaveLength(2)
    expect(specs[0]).toEqual({
      title: 'task 1',
      body: 'r · Reminder · 2026-07-16 09:00',
      task: { remote: 'o/r', path: 'task.t1.md' },
    })
  })

  it('carries the task path so a click can open the task', () => {
    expect(notificationsFor(event(1))[0]!.task).toEqual({ remote: 'o/r', path: 'task.t1.md' })
  })

  // Six toasts is not six times the information — it's a wall you dismiss unread,
  // which loses all six.
  it('collapses a coalesced batch into a single summary', () => {
    const specs = notificationsFor(event(6, true))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.title).toBe('6 reminders in r')
  })

  it('names the first few and counts the rest', () => {
    expect(notificationsFor(event(6, true))[0]!.body).toBe('task 1, task 2, task 3 +3 more')
  })

  it('does not say "+0 more" when the summary names them all', () => {
    const specs = notificationsFor({ ...event(3), coalesced: true })
    expect(specs[0]!.body).toBe('task 1, task 2, task 3')
  })

  // A summary speaks for several tasks — there is no single one to open.
  it('gives a summary no task', () => {
    expect(notificationsFor(event(6, true))[0]!.task).toBeUndefined()
  })

  // Reminders come from every registered vault; one summary over two would
  // read as one vault's list.
  it('gives each vault its own summary, and a lone fire its own task', () => {
    const specs = notificationsFor({
      fires: [fire(1, 'o/notes'), fire(2, 'o/notes'), fire(3, 'o/work'), fire(4, 'o/notes')],
      coalesced: true,
      firedAt: '2026-07-16T07:00:00.000Z',
    })
    expect(specs).toEqual([
      { title: '3 reminders in notes', body: 'task 1, task 2, task 4' },
      {
        title: 'task 3',
        body: 'work · Reminder · 2026-07-16 09:00',
        task: { remote: 'o/work', path: 'task.t3.md' },
      },
    ])
  })

  it('raises nothing for an empty batch', () => {
    expect(notificationsFor(event(0))).toEqual([])
  })
})
