/**
 * The count that turns the board badge red: open tasks the board would label
 * `overdue`, by the same rule, at the store's current minute.
 */
import { createStore } from 'jotai'
import { expect, test } from 'vitest'
import type { Task, VaultSnapshot } from '@holi/shared'
import { nowAtom, overdueTaskCountAtom } from '../src/renderer/src/state/tasks'
import { snapshotAtom } from '../src/renderer/src/state/vaults'

const task = (path: string, over: Partial<Task> = {}): Task => ({
  path,
  title: path,
  status: 'todo',
  tags: [],
  description: '',
  ...over,
})

function storeWith(tasks: Task[], now: string) {
  const snapshot: VaultSnapshot = { docs: [], tasks, broken: [], files: [] }
  const store = createStore()
  store.set(snapshotAtom, snapshot)
  store.set(nowAtom, now)
  return store
}

test('counts open tasks past due, and not done or undated ones', () => {
  const store = storeWith(
    [
      task('task.late.md', { due: '2026-09-20' }),
      task('task.done-late.md', { due: '2026-09-20', status: 'done' }),
      task('task.today.md', { due: '2026-09-27' }),
      task('task.undated.md'),
      task('task.hour-passed.md', { due: '2026-09-27T09:00' }),
    ],
    '2026-09-27T10:00',
  )
  expect(store.get(overdueTaskCountAtom)).toBe(2)
})

test('follows the clock: a task turns overdue when its minute passes', () => {
  const store = storeWith(
    [task('task.meeting.md', { due: '2026-09-27T14:00' })],
    '2026-09-27T14:00',
  )
  expect(store.get(overdueTaskCountAtom)).toBe(0)
  store.set(nowAtom, '2026-09-27T14:01')
  expect(store.get(overdueTaskCountAtom)).toBe(1)
})
