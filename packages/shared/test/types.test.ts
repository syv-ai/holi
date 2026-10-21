import { describe, expect, it } from 'vitest'
import type { DocMeta, VaultEntry } from '../src/index'

describe('shared domain types', () => {
  it('type-checks a VaultEntry and a DocMeta literal', () => {
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
    expect(vault.remote).toBe('syv-ai/1brain')
    expect(doc.kind).toBe('note')
  })
})
