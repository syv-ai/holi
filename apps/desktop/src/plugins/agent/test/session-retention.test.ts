import { describe, expect, it } from 'vitest'
import { agentsViewOf } from '../renderer/state/agents-view'

describe('agent session retention policy', () => {
  const retains = (selection: { owner: string; id: string }) =>
    agentsViewOf(selection).kind === 'session'

  it('retains only session selections, not other agent or plugin views', () => {
    expect(retains({ owner: 'agent', id: 'session:job-1' })).toBe(true)
    expect(retains({ owner: 'agent', id: 'inbox' })).toBe(false)
    expect(retains({ owner: 'agent', id: 'history' })).toBe(false)
    expect(retains({ owner: 'agent', id: 'memory' })).toBe(false)
    expect(retains({ owner: 'plugin', id: 'session:job-1' })).toBe(false)
  })
})
