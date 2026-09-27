import { expect, test } from 'vitest'
import { completeTask } from '../src/completion'

const TODAY = '2026-09-27'

test('a task with no rule is simply done', () => {
  expect(completeTask({ due: '2026-09-20' }, TODAY)).toEqual({ status: 'done' })
  expect(completeTask({}, TODAY)).toEqual({ status: 'done' })
})

test('a rule with no due has nothing to advance from, so it ends', () => {
  expect(completeTask({ recurrence: { frequency: 'daily', interval: 1 } }, TODAY)).toEqual({
    status: 'done',
  })
})

test('a recurring task rolls to its next occurrence on or after today, keeping its time', () => {
  expect(
    completeTask(
      { due: '2026-09-01T09:30', recurrence: { frequency: 'weekly', interval: 1 } },
      TODAY,
    ),
  ).toEqual({ status: 'todo', due: '2026-09-29T09:30' })
})

test('the reminder moves by the same days, keeping its own time', () => {
  expect(
    completeTask(
      {
        due: '2026-09-26',
        reminder: '2026-09-25T18:00',
        recurrence: { frequency: 'daily', interval: 1 },
      },
      TODAY,
    ),
  ).toEqual({ status: 'todo', due: '2026-09-27', reminder: '2026-09-26T18:00' })
})

test('an inert reminder is carried as it is', () => {
  expect(
    completeTask(
      { due: '2026-09-26', reminder: '1d', recurrence: { frequency: 'daily', interval: 1 } },
      TODAY,
    ).reminder,
  ).toBe('1d')
})
