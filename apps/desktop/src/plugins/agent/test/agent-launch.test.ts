/**
 * `agent.launch`'s params: what a plugin built on the agent may start a
 * session with, and the door it is reached through.
 */
import { describe, expect, it, vi } from 'vitest'
import { agentCapabilities } from '../main/host/capabilities'
import {
  createCapabilityRegistry,
  type CapabilityContext,
} from '../../../main/capabilities/registry'

function rig() {
  const launch = vi.fn(async () => ({ ok: true as const, sessionId: 'abcd1234' }))
  const registry = createCapabilityRegistry()
  registry.register(
    ['agent'],
    agentCapabilities({
      sessions: { launch } as never,
      own: {} as never,
      jobs: {} as never,
      fenced: {} as never,
      providers: () => [],
      terminals: {} as never,
      liveRemote: () => 'syv/vault',
      commitNow: async () => null,
      defaultProvider: async () => 'claude' as const,
    }),
  )
  const ctx = { remote: 'syv/vault', root: '/tmp/vault', bundle: null } as CapabilityContext
  return {
    launch,
    run: (door: 'ui' | 'cli', params: unknown) => registry.run('agent.launch', door, ctx, params),
  }
}

describe('agent.launch', () => {
  it('passes an MCP config through to the session', async () => {
    const { launch, run } = rig()
    await run('ui', { name: 'Meeting', prompt: 'go', mcpConfig: '/Users/me/mcp.json' })
    expect(launch).toHaveBeenCalledWith({
      name: 'Meeting',
      prompt: 'go',
      mcpConfig: '/Users/me/mcp.json',
    })
  })

  it('refuses an MCP config that is not an absolute path to a .json file', async () => {
    const { launch, run } = rig()
    await expect(run('ui', { name: 'M', prompt: 'go', mcpConfig: 'mcp.json' })).rejects.toThrow(
      /absolute/,
    )
    await expect(run('ui', { name: 'M', prompt: 'go', mcpConfig: '/etc/passwd' })).rejects.toThrow(
      /\.json/,
    )
    expect(launch).not.toHaveBeenCalled()
  })

  it('passes allow and deny rules through to the session', async () => {
    const { launch, run } = rig()
    await run('ui', {
      name: 'Meeting',
      prompt: 'go',
      allow: ['Bash(holi meeting:*)'],
      deny: ['Read', 'WebFetch'],
    })
    expect(launch).toHaveBeenCalledWith({
      name: 'Meeting',
      prompt: 'go',
      allow: ['Bash(holi meeting:*)'],
      deny: ['Read', 'WebFetch'],
    })
  })

  it('refuses deny rules that are not a list of text', async () => {
    const { launch, run } = rig()
    await expect(run('ui', { name: 'M', prompt: 'go', deny: 'Read' })).rejects.toThrow(/deny/)
    await expect(run('ui', { name: 'M', prompt: 'go', deny: [1] })).rejects.toThrow(/deny/)
    expect(launch).not.toHaveBeenCalled()
  })

  it('stays the UI door alone', async () => {
    const { run } = rig()
    await expect(run('cli', { name: 'M', prompt: 'go' })).rejects.toThrow(/no such method/)
  })
})
