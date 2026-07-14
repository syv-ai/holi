import { describe, expect, it } from 'vitest'
import type { Task, Vault } from '../src/index'

describe('shared domain types', () => {
  it('type-checks a Task and a Vault literal', () => {
    const vault: Vault = {
      id: 'v1',
      name: 'Syv',
      kind: 'shared',
      ownerId: 'u1',
      createdAt: '2026-07-10T00:00:00Z',
      updatedAt: '2026-07-10T00:00:00Z',
    }
    const task: Task = {
      id: 't1',
      vaultId: vault.id,
      title: 'Prove the bridge',
      status: 'doing',
      tags: ['spike'],
      related: [{ kind: 'note', id: 'd1' }],
      version: 1,
      createdAt: '2026-07-10T00:00:00Z',
      updatedAt: '2026-07-10T00:00:00Z',
    }
    expect(task.status).toBe('doing')
    expect(vault.kind).toBe('shared')
  })
})
