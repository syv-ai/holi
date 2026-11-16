import { describe, expect, it } from 'vitest'
import { notificationsFor } from '../main/reminders/notifications'
import { createNotifier } from '../main/reminders/notify'
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

  it('labels a fallback notice overdue with its due stamp and vault', () => {
    expect(
      notificationsFor({
        fires: [{ ...fire(1), fireAt: '2026-07-30T10:00', due: '2026-07-28T09:30', overdue: true }],
        coalesced: false,
        firedAt: '2026-07-30T10:00',
      })[0],
    ).toEqual({
      title: 'Overdue: task 1',
      body: 'r · Overdue · 2026-07-28 09:30',
      task: { remote: 'o/r', path: 'task.t1.md' },
    })
  })

  it('summarizes all-overdue and mixed batches accurately per vault', () => {
    const overdueFire = { ...fire(1), due: '2026-07-28', overdue: true as const }
    expect(
      notificationsFor({
        fires: [overdueFire, { ...fire(2), due: '2026-07-29', overdue: true }],
        coalesced: true,
        firedAt: '2026-07-30T10:00',
      })[0],
    ).toMatchObject({
      title: '2 overdue tasks in r',
      body: 'Overdue: task 1 (2026-07-28), Overdue: task 2 (2026-07-29)',
    })
    expect(
      notificationsFor({
        fires: [overdueFire, fire(2), fire(3), fire(4)],
        coalesced: true,
        firedAt: '2026-07-30T10:00',
      })[0],
    ).toMatchObject({
      title: '4 task reminders in r',
      body: 'Overdue: task 1 (2026-07-28), task 2, task 3 +1 more',
    })
  })

  it('opens the exact vault and task path on a singleton click', () => {
    const notices: Array<{ title: string; body: string; onClick?: () => void }> = []
    const opened: Array<[string, string]> = []
    createNotifier({
      notify: (notice) => {
        notices.push(notice)
      },
      open: (remote, path) => opened.push([remote, path]),
    }).fire({ fires: [fire(1, 'o/second')], coalesced: false, firedAt: '2026-07-16T07:00' })
    notices[0]!.onClick!()
    expect(opened).toEqual([['o/second', 'task.t1.md']])
  })

  it('raises nothing for an empty batch', () => {
    expect(notificationsFor(event(0))).toEqual([])
  })
})
