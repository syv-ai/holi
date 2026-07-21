import { describe, expect, it } from 'vitest'
import { taskArea, type DocMeta, type Task, type VaultEntry } from '../src/index'

describe('shared domain types', () => {
  it('type-checks a VaultEntry, a DocMeta and a Task literal', () => {
    const vault: VaultEntry = {
      remote: 'syv-ai/1brain',
      path: '/Users/nic/Holi/syv-ai/1brain',
      name: '1brain',
      lastOpenedAt: '2026-07-21T00:00:00Z',
    }
    const doc: DocMeta = {
      path: 'projects/q2/roadmap.md',
      kind: 'note',
      updatedAt: '2026-07-21T00:00:00Z',
    }
    const task: Task = {
      path: 'projects/q2/task.prove-the-slice.md',
      title: 'Prove the slice',
      status: 'doing',
      tags: ['spike'],
      description: 'Links to [[projects/q2/roadmap.md]].',
    }
    expect(task.status).toBe('doing')
    expect(vault.remote).toBe('syv-ai/1brain')
    expect(doc.kind).toBe('note')
  })
})

describe('taskArea', () => {
  it('is the containing folder — the lane', () => {
    expect(taskArea({ path: 'projects/q2/task.a.md' })).toBe('projects/q2')
  })

  it('is the empty root lane for a task at the vault root', () => {
    expect(taskArea({ path: 'task.a.md' })).toBe('')
  })
})
