import { describe, expect, it } from 'vitest'
import { NOT_INSTALLED, piProvider } from '../main/pi'

const TARGET = { root: '/vault', configDir: '/home/ada/.pi', binDir: '/holi/bin' }

describe('the Pi provider', () => {
  it("launches stock Pi with the user's environment and no prompt by default", () => {
    const pi = piProvider({ resolveBin: () => '/usr/local/bin/pi' })
    const cmd = pi.terminal(TARGET)
    expect(cmd).toEqual({ bin: '/usr/local/bin/pi', args: [], env: process.env })
  })

  it('uses Pi’s interactive resume picker and accepts a first prompt', () => {
    const pi = piProvider({ resolveBin: () => '/usr/local/bin/pi' })
    expect(pi.terminal(TARGET, { resume: 'pick' })?.args).toEqual(['--resume'])
    expect(pi.terminal(TARGET, { resume: 'session-123' })?.args).toEqual([
      '--resume',
      'session-123',
    ])
    expect(pi.terminal(TARGET, { prompt: 'Review this vault' })?.args).toEqual([
      'Review this vault',
    ])
  })

  it('reports when the stock CLI is unavailable', () => {
    const pi = piProvider({ resolveBin: () => null })
    expect(pi.installed()).toBe(false)
    expect(pi.terminal(TARGET)).toBeNull()
    expect(NOT_INSTALLED).toContain('Pi is not installed')
  })
})
