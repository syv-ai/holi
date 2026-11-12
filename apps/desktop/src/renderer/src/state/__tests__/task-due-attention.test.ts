import { createStore } from 'jotai'
import { describe, expect, it } from 'vitest'
import type { Task } from '@holi/shared'
import { emptyVaultSnapshot } from '@holi/shared'
import { nowAtom } from '@/state/clock'
import { taskDueAttentionAtom } from '@/state/tasks'
import { activeRemoteAtom, openedRemoteAtom, snapshotAtom } from '@/state/vaults'

let nextTask = 0
const makeTask = (due: string | undefined, status = 'todo') =>
  ({ path: `tasks/task-${nextTask++}.md`, title: 'Task', status, due }) as Task

function readyStore(tasks: Task[]) {
  const store = createStore()
  store.set(activeRemoteAtom, 'owner/vault')
  store.set(openedRemoteAtom, 'owner/vault')
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    claimed: { tasks: { items: tasks, broken: [] } },
  })
  store.set(nowAtom, '2026-11-12T10:30')
  return store
}

describe('taskDueAttentionAtom', () => {
  it('counts overdue and today once, with private tasks and open total', () => {
    const store = readyStore([
      makeTask('2026-11-11'),
      makeTask('2026-11-12T09:30'),
      makeTask('2026-11-12'),
      makeTask('not-a-date'),
      makeTask(undefined),
      makeTask('2026-11-12', 'done'),
    ])
    expect(store.get(taskDueAttentionAtom)).toEqual({ open: 5, overdue: 2, dueToday: 1, due: 3 })
  })

  it('updates from the shared clock and snapshot without mounting Board', () => {
    const store = readyStore([makeTask('2026-11-12T10:31')])
    expect(store.get(taskDueAttentionAtom)?.due).toBe(1)
    store.set(nowAtom, '2026-11-12T10:32')
    expect(store.get(taskDueAttentionAtom)?.overdue).toBe(1)
    store.set(nowAtom, '2026-11-13T00:00')
    expect(store.get(taskDueAttentionAtom)?.overdue).toBe(1)
  })

  it('suppresses a previous vault snapshot until the displayed vault opens', () => {
    const store = readyStore([makeTask('2026-11-11')])
    expect(store.get(taskDueAttentionAtom)?.due).toBe(1)
    store.set(activeRemoteAtom, 'owner/next')
    expect(store.get(taskDueAttentionAtom)).toBeNull()
    store.set(snapshotAtom, emptyVaultSnapshot())
    store.set(openedRemoteAtom, 'owner/next')
    expect(store.get(taskDueAttentionAtom)?.due).toBe(0)
  })
})
