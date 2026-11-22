import { createStore } from 'jotai'
import { describe, expect, it } from 'vitest'
import type { Task } from '@holi/shared'
import { DEFAULT_STATUSES, emptyVaultSnapshot, type StatusDef } from '@holi/shared'
import { nowAtom } from '@/state/clock'
import { recordStatusesReadAtom, statusesFileAtom } from '@/state/planning'
import { taskDueAttentionAtom } from '@/state/tasks'
import {
  activeRemoteAtom,
  activeRemoteRevisionValueAtom,
  openedRemoteAtom,
  snapshotAtom,
} from '@/state/vaults'

const makeTask = (path: string, due: string | undefined, status = 'todo') =>
  ({ path, title: 'Task', status, due }) as Task

function readyStore(tasks: Task[]) {
  const store = createStore()
  store.set(activeRemoteAtom, 'owner/vault')
  store.set(openedRemoteAtom, 'owner/vault')
  store.set(recordStatusesReadAtom, {
    remote: 'owner/vault',
    revision: store.get(activeRemoteRevisionValueAtom),
    stamp: null,
    retry: 0,
    file: { state: 'ready', value: [...DEFAULT_STATUSES], warnings: [] },
  })
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    claimed: { tasks: { items: tasks, broken: [] } },
  })
  store.set(nowAtom, '2026-11-12T10:30')
  return store
}

describe('taskDueAttentionAtom', () => {
  it('counts due dates, private tasks, missing and invalid dates, and closed work', () => {
    const store = readyStore([
      makeTask('projects/task.overdue.md', '2026-11-11'),
      makeTask('projects/task.private.local.md', '2026-11-12T09:30'),
      makeTask('projects/task.today.md', '2026-11-12'),
      makeTask('projects/task.invalid.md', 'not-a-date'),
      makeTask('projects/task.missing.md', undefined),
      makeTask('projects/task.closed.md', '2026-11-12', 'done'),
    ])
    expect(store.get(taskDueAttentionAtom)).toEqual({ open: 5, overdue: 2, dueToday: 1, due: 3 })
  })

  it('uses the vault-defined completion category and treats unknown statuses as open', () => {
    const store = readyStore([
      makeTask('projects/task.finished.md', undefined, 'shipped'),
      makeTask('projects/task.unknown.md', undefined, 'typo'),
    ])
    const file = {
      state: 'ready' as const,
      value: [
        { id: 'shipped', name: 'Shipped', category: 'completed' },
        { id: 'todo', name: 'To do', category: 'unstarted' },
      ] satisfies StatusDef[],
      warnings: [],
    }
    store.set(statusesFileAtom, file)
    store.set(recordStatusesReadAtom, {
      remote: 'owner/vault',
      revision: store.get(activeRemoteRevisionValueAtom),
      stamp: null,
      retry: 0,
      file,
    })
    expect(store.get(taskDueAttentionAtom)?.open).toBe(1)
  })

  it('updates with snapshot completion, deletion, due edits and a clock-only midnight change', () => {
    const store = readyStore([
      makeTask('projects/task.due-now.md', '2026-11-12T10:30'),
      makeTask('projects/task.tomorrow.md', '2026-11-13'),
    ])
    expect(store.get(taskDueAttentionAtom)).toEqual({ open: 2, overdue: 0, dueToday: 1, due: 1 })

    store.set(nowAtom, '2026-11-12T10:31')
    expect(store.get(taskDueAttentionAtom)?.overdue).toBe(1)

    store.set(nowAtom, '2026-11-13T00:00')
    expect(store.get(taskDueAttentionAtom)).toEqual({ open: 2, overdue: 1, dueToday: 1, due: 2 })

    store.set(snapshotAtom, {
      ...emptyVaultSnapshot(),
      claimed: {
        tasks: {
          items: [makeTask('projects/task.tomorrow.md', '2026-11-14', 'done')],
          broken: [],
        },
      },
    })
    expect(store.get(taskDueAttentionAtom)).toEqual({ open: 0, overdue: 0, dueToday: 0, due: 0 })
  })

  it('suppresses the badge until the initial vault statuses settle', () => {
    const store = createStore()
    store.set(activeRemoteAtom, 'owner/vault')
    store.set(openedRemoteAtom, 'owner/vault')
    store.set(snapshotAtom, {
      ...emptyVaultSnapshot(),
      claimed: {
        tasks: { items: [makeTask('projects/task.shipped.md', undefined, 'shipped')], broken: [] },
      },
    })
    store.set(nowAtom, '2026-11-12T10:30')

    expect(store.get(taskDueAttentionAtom)).toBeNull()
    store.set(recordStatusesReadAtom, {
      remote: 'owner/vault',
      revision: store.get(activeRemoteRevisionValueAtom),
      stamp: null,
      retry: 0,
      file: {
        state: 'ready',
        value: [{ id: 'shipped', name: 'Shipped', category: 'completed' }],
        warnings: [],
      },
    })
    expect(store.get(taskDueAttentionAtom)?.open).toBe(0)
  })

  it('uses the default completion statuses after a status read error', () => {
    const store = readyStore([makeTask('projects/task.done.md', undefined, 'done')])
    store.set(recordStatusesReadAtom, {
      remote: 'owner/vault',
      revision: store.get(activeRemoteRevisionValueAtom),
      stamp: null,
      retry: 0,
      file: { state: 'error', message: 'read failed' },
    })
    expect(store.get(taskDueAttentionAtom)?.open).toBe(0)
  })

  it('waits for each vault status read and rejects late results across rapid switches', () => {
    const store = readyStore([makeTask('projects/task.shipped.md', undefined, 'shipped')])
    const aRevision = store.get(activeRemoteRevisionValueAtom)
    const aFile = {
      state: 'ready' as const,
      value: [{ id: 'shipped', name: 'Shipped', category: 'completed' } as StatusDef],
      warnings: [],
    }
    store.set(recordStatusesReadAtom, {
      remote: 'owner/vault',
      revision: aRevision,
      stamp: null,
      retry: 0,
      file: aFile,
    })
    expect(store.get(taskDueAttentionAtom)?.open).toBe(0)

    store.set(activeRemoteAtom, 'owner/next')
    const bRevision = store.get(activeRemoteRevisionValueAtom)
    store.set(openedRemoteAtom, 'owner/next')
    store.set(snapshotAtom, {
      ...emptyVaultSnapshot(),
      claimed: {
        tasks: { items: [makeTask('projects/task.shipped.md', undefined, 'shipped')], broken: [] },
      },
    })
    expect(store.get(taskDueAttentionAtom)).toBeNull()
    store.set(recordStatusesReadAtom, {
      remote: 'owner/next',
      revision: bRevision,
      stamp: null,
      retry: 0,
      file: {
        state: 'ready',
        value: [{ id: 'shipped', name: 'Shipped', category: 'unstarted' }] as StatusDef[],
        warnings: [],
      },
    })
    expect(store.get(taskDueAttentionAtom)?.open).toBe(1)

    store.set(activeRemoteAtom, 'owner/vault')
    const secondARevision = store.get(activeRemoteRevisionValueAtom)
    store.set(openedRemoteAtom, 'owner/vault')
    store.set(recordStatusesReadAtom, {
      remote: 'owner/vault',
      revision: aRevision,
      stamp: null,
      retry: 0,
      file: aFile,
    })
    expect(store.get(taskDueAttentionAtom)).toBeNull()

    store.set(recordStatusesReadAtom, {
      remote: 'owner/vault',
      revision: secondARevision,
      stamp: null,
      retry: 0,
      file: {
        state: 'ready',
        value: [{ id: 'shipped', name: 'Shipped', category: 'unstarted' }] as StatusDef[],
        warnings: [],
      },
    })
    expect(store.get(taskDueAttentionAtom)?.open).toBe(1)
  })

  it('suppresses a previous vault snapshot until the displayed vault opens', () => {
    const store = readyStore([makeTask('projects/task.old.md', '2026-11-11')])
    expect(store.get(taskDueAttentionAtom)?.due).toBe(1)
    store.set(activeRemoteAtom, 'owner/next')
    expect(store.get(taskDueAttentionAtom)).toBeNull()
    store.set(snapshotAtom, emptyVaultSnapshot())
    store.set(openedRemoteAtom, 'owner/next')
    store.set(recordStatusesReadAtom, {
      remote: 'owner/next',
      revision: store.get(activeRemoteRevisionValueAtom),
      stamp: null,
      retry: 0,
      file: { state: 'ready', value: [...DEFAULT_STATUSES], warnings: [] },
    })
    expect(store.get(taskDueAttentionAtom)?.due).toBe(0)
  })
})
