/**
 * The chat's three reads of a conversation as capabilities: params checked
 * before anything is read, and the answers passed through.
 */
import { describe, expect, it } from 'vitest'
import { agentCapabilities } from '../main/host/capabilities'
import type { CapabilityContext } from '../../../main/capabilities/registry'

const REMOTE = 'syv-ai/chat'

function rig() {
  const calls: unknown[][] = []
  const table = agentCapabilities({
    sessions: {
      transcript: async (...args: unknown[]) => {
        calls.push(['transcript', ...args])
        return { sessionId: 's', entries: [], offset: 7, start: 0 }
      },
      transcriptEarlier: async (...args: unknown[]) => {
        calls.push(['earlier', ...args])
        return { entries: [], start: 0 }
      },
      subagent: async (...args: unknown[]) => {
        calls.push(['subagent', ...args])
        return { sessionId: 's', entries: [], offset: 3 }
      },
    } as never,
    terminals: {} as never,
    liveRemote: () => REMOTE,
    commitNow: async () => null,
  })
  const ctx = { remote: REMOTE } as unknown as CapabilityContext
  const run = async (name: keyof typeof table, params: unknown) => {
    const entry = table[name] as {
      params(raw: unknown): unknown
      run(ctx: CapabilityContext, p: unknown): Promise<unknown>
    }
    return entry.run(ctx, entry.params(params))
  }
  const params = (name: keyof typeof table, raw: unknown) =>
    (table[name] as { params(raw: unknown): unknown }).params(raw)
  return { run, params, calls }
}

describe('agent.transcriptEarlier', () => {
  it('reads before a line start, and refuses anything else', async () => {
    const { run, params, calls } = rig()
    expect(await run('agent.transcriptEarlier', { id: 'j1', before: 4096 })).toEqual({
      entries: [],
      start: 0,
    })
    expect(calls).toEqual([['earlier', 'j1', 4096]])
    for (const before of [-1, 1.5, '10', undefined, null, NaN]) {
      expect(() => params('agent.transcriptEarlier', { id: 'j1', before })).toThrow()
    }
    expect(() => params('agent.transcriptEarlier', { before: 1 })).toThrow()
  })
})

describe('agent.subagent', () => {
  it('reads a sub-agent by a checked id, with or without an offset', async () => {
    const { run, params, calls } = rig()
    await run('agent.subagent', { id: 'j1', agentId: 'abc123' })
    await run('agent.subagent', { id: 'j1', agentId: 'abc_123-X', offset: 40 })
    expect(calls).toEqual([
      ['subagent', 'j1', 'abc123', undefined, undefined],
      ['subagent', 'j1', 'abc_123-X', 40, undefined],
    ])
    for (const agentId of ['../x', 'ab', 'a b c d', 'x'.repeat(65), 5, undefined]) {
      expect(() => params('agent.subagent', { id: 'j1', agentId })).toThrow()
    }
    expect(() => params('agent.subagent', { id: 'j1', agentId: 'abc123', offset: -1 })).toThrow()
  })
})

describe('agent.transcript', () => {
  it('passes the chunk through whole, start included', async () => {
    const { run } = rig()
    expect(await run('agent.transcript', { id: 'j1' })).toEqual({
      sessionId: 's',
      entries: [],
      offset: 7,
      start: 0,
    })
  })
})

describe('offsets and fingerprints', () => {
  const bad = [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY, 2 ** 60, '10', null]

  it('agent.transcript takes only a non-negative whole offset', () => {
    const { params } = rig()
    for (const offset of bad) {
      expect(() => params('agent.transcript', { id: 'j1', offset }), String(offset)).toThrow(
        /offset/,
      )
    }
    expect(() => params('agent.transcript', { id: 'j1', offset: 0 })).not.toThrow()
    expect(() => params('agent.transcript', { id: 'j1', offset: 4096 })).not.toThrow()
  })

  it('agent.subagent takes only a non-negative whole offset', () => {
    const { params } = rig()
    for (const offset of bad) {
      expect(
        () => params('agent.subagent', { id: 'j1', agentId: 'abc123', offset }),
        String(offset),
      ).toThrow(/offset/)
    }
  })

  it('passes a fingerprint string along, and refuses anything else', async () => {
    const { run, params, calls } = rig()
    await run('agent.transcript', { id: 'j1', offset: 5, fingerprint: 'ab12.cd34' })
    await run('agent.subagent', {
      id: 'j1',
      agentId: 'abc123',
      offset: 5,
      fingerprint: 'ab12.cd34',
    })
    expect(calls).toEqual([
      ['transcript', 'j1', 5, 'ab12.cd34'],
      ['subagent', 'j1', 'abc123', 5, 'ab12.cd34'],
    ])
    for (const fingerprint of [5, null, {}, 'x'.repeat(200)]) {
      expect(() => params('agent.transcript', { id: 'j1', offset: 5, fingerprint })).toThrow(
        /fingerprint/,
      )
    }
  })
})
