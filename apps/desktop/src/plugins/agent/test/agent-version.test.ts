/**
 * `holi agent version`: Holi's version and the Claude Code one, which is
 * `unknown` whenever Claude Code cannot say.
 */
import { describe, expect, it } from 'vitest'
import type { CapabilityContext } from '../../../main/capabilities/registry'
import { versionCapabilities } from '../main/version'

async function versionText(deps: Parameters<typeof versionCapabilities>[0]): Promise<string> {
  const entry = versionCapabilities(deps)['agent.version']
  const result = await entry.run({} as CapabilityContext, entry.params({}))
  return entry.text?.(result) ?? ''
}

describe('agent.version', () => {
  it('prints both versions, asking claude --version', async () => {
    const asked: string[][] = []
    const text = await versionText({
      holi: '0.5.0',
      claudeBin: () => '/bin/claude',
      run: async (bin, args) => {
        asked.push([bin, ...args])
        return '2.1.312 (Claude Code)\n'
      },
    })
    expect(asked).toEqual([['/bin/claude', '--version']])
    expect(text).toBe('Holi 0.5.0\nClaude Code 2.1.312')
  })

  it('says unknown when claude is not on this machine', async () => {
    const text = await versionText({ holi: '0.5.0', claudeBin: () => null })
    expect(text).toBe('Holi 0.5.0\nClaude Code unknown')
  })

  it('says unknown when claude fails or times out', async () => {
    const text = await versionText({
      holi: '0.5.0',
      claudeBin: () => '/bin/claude',
      run: () => Promise.reject(new Error('timed out')),
    })
    expect(text).toBe('Holi 0.5.0\nClaude Code unknown')
  })
})
