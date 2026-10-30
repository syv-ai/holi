import { describe, expect, it } from 'vitest'
import { NOT_INSTALLED, piProvider } from '../main/pi'
import { buildPiEnv } from '../main/pi/env'

const TARGET = { root: '/vault', configDir: '/home/ada/.pi', binDir: '/holi/bin' }

describe('the Pi provider', () => {
  it("launches stock Pi with the user's environment and no prompt by default", () => {
    const pi = piProvider({ resolveBin: () => '/usr/local/bin/pi' })
    const cmd = pi.terminal(TARGET)
    expect(cmd).toMatchObject({ bin: '/usr/local/bin/pi', args: [] })
    expect(cmd?.env.PATH).toContain('/holi/bin/fallback')
  })

  it('uses Pi’s interactive resume picker and accepts a first prompt', () => {
    const pi = piProvider({ resolveBin: () => '/usr/local/bin/pi' })
    expect(pi.terminal(TARGET, { resume: 'pick' })?.args).toEqual(['--resume'])
    const id = '018f1234-5678-7abc-8def-0123456789ab'
    expect(pi.terminal(TARGET, { resume: id })?.args).toEqual(['--session-id', id])
    expect(pi.terminal(TARGET, { conversation: id })?.args).toEqual(['--session-id', id])
    expect(pi.terminal(TARGET, { fork: id, conversation: '018f1234-5678-7abc-8def-0123456789ac' })?.args).toEqual([
      '--fork', id, '--session-id', '018f1234-5678-7abc-8def-0123456789ac',
    ])
    expect(pi.terminal(TARGET, { resume: 'not-a-session' })?.args).toEqual([])
    expect(pi.terminal(TARGET, { prompt: 'Review this vault' })?.args).toEqual([
      '--',
      'Review this vault',
    ])
    expect(pi.terminal(TARGET, { prompt: '--help' })?.args).toEqual(['--', '--help'])
  })

  it('strips inherited Pi session state but preserves user config and Holi PATH', () => {
    const env = buildPiEnv(
      {
        PATH: '/usr/bin',
        PI_CODING_AGENT_DIR: '/home/ada/.pi-custom',
        PI_SESSION_ID: 'parent-session',
        PI_SESSION_FILE: '/tmp/parent.jsonl',
        PI_PROVIDER: 'parent-provider',
        PI_MODEL: 'parent-model',
        PI_REASONING_LEVEL: 'high',
        PI_WORKTREE_SESSION_MANIFEST: '/tmp/parent-manifest.json',
        PI_WORKTREE_BRANCH_CONTINUATION: '1',
        PI_WORKTREE_CLEANUP_CONTINUATION: '1',
        USER_MODEL_CONFIG: 'keep-me',
      },
      { binDir: '/holi/bin' },
    )
    expect(env).toMatchObject({
      PI_CODING_AGENT_DIR: '/home/ada/.pi-custom',
      USER_MODEL_CONFIG: 'keep-me',
    })
    expect(env.PATH).toContain('/holi/bin/fallback')
    for (const key of [
      'PI_SESSION_ID',
      'PI_SESSION_FILE',
      'PI_PROVIDER',
      'PI_MODEL',
      'PI_REASONING_LEVEL',
      'PI_WORKTREE_SESSION_MANIFEST',
      'PI_WORKTREE_BRANCH_CONTINUATION',
      'PI_WORKTREE_CLEANUP_CONTINUATION',
    ])
      expect(env[key]).toBeUndefined()
  })

  it('uses the sanitized environment for interactive Pi', () => {
    const previous = process.env.PI_WORKTREE_SESSION_MANIFEST
    process.env.PI_WORKTREE_SESSION_MANIFEST = '/tmp/parent-manifest.json'
    try {
      expect(
        piProvider({ resolveBin: () => '/usr/local/bin/pi' }).terminal(TARGET)?.env,
      ).not.toHaveProperty('PI_WORKTREE_SESSION_MANIFEST')
    } finally {
      if (previous === undefined) delete process.env.PI_WORKTREE_SESSION_MANIFEST
      else process.env.PI_WORKTREE_SESSION_MANIFEST = previous
    }
  })

  it('reports when the stock CLI is unavailable', () => {
    const pi = piProvider({ resolveBin: () => null })
    expect(pi.installed()).toBe(false)
    expect(pi.terminal(TARGET)).toBeNull()
    expect(NOT_INSTALLED).toContain('Pi is not installed')
  })
})
