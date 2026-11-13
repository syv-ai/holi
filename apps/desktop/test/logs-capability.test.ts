import { describe, expect, it } from 'vitest'
import { createActivityLog, scrubSecrets } from '../src/main/activity/log'
import { resolveArgv } from '../src/main/bridge/cli'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { noCoreServices } from '../src/main/capabilities/services'
import { logsCapabilities } from '../src/main/capabilities/logs-caps'
import { createCapabilityRegistry } from '../src/main/capabilities/registry'

const NOW = Date.parse('2026-01-01T12:00:00.000Z')

describe('holi logs capability', () => {
  it('resolves bare logs with value options and dispatches only owned, filtered activity', async () => {
    let clock = NOW
    const log = createActivityLog({ now: () => new Date(clock).toISOString() })
    log.write({ channel: 'plugins', plugin: 'google', remote: 'a/b', message: 'Google trouble' })
    log.write({ channel: 'plugins', plugin: 'other', remote: 'a/b', message: 'Other trouble' })
    clock = NOW - 16 * 60_000
    log.write({ channel: 'plugins', plugin: 'google', remote: 'a/b', message: 'stale Google' })
    clock = NOW
    log.write({ channel: 'sync', remote: 'c/d', message: 'private', detail: 'private detail' })
    log.write({ channel: 'app', global: true, message: 'Holi started' })
    log.write({
      channel: 'plugins',
      plugin: 'google',
      remote: 'a/b',
      message: 'failure PASSWORD=alpha,fixtureSuffix',
      detail: 'diagnostic PASSWORD=alpha;fixtureSuffix',
    })
    log.write({ channel: 'app', message: 'legacy unowned' })
    log.write({ channel: 'app', global: true, remote: 'c/d', message: 'wrong-vault global' })
    log.write({
      channel: 'plugins',
      plugin: 'google',
      remote: 'a/b',
      message: 'credential',
      detail: 'refresh_token="one\'s secret\\\" value" ya29.SECRET123456789012345678',
    })
    const original = log.entries()
    const registry = createCapabilityRegistry()
    registry.register(
      ['logs'],
      logsCapabilities(log, () => NOW),
    )
    const commands = registry.commands()
    expect(registry.names('cli')).toEqual(['logs.list'])
    expect(registry.names('ui')).toEqual([])
    expect(registry.names('app')).toEqual([])
    const host = createCapabilityHost({
      registry,
      rootFor: async (remote) => `/vaults/${remote}`,
      active: () => ({ remote: 'c/d', snapshot: () => ({}) as never, refresh: async () => {} }),
      core: noCoreServices,
      pluginEnabled: async () => true,
      claims: async () => [],
    })
    const parsed = resolveArgv(['logs', '--channel', 'google', '--since', '15m'], commands, '')
    expect(parsed.kind).toBe('run')
    if (parsed.kind !== 'run') throw new Error('expected CLI run')
    expect(parsed.name).toBe('logs.list')
    expect(parsed.params).toEqual({ channel: 'google', since: '15m' })
    const result = await host.dispatch({
      door: 'cli',
      remote: 'a/b',
      name: parsed.name,
      params: parsed.params,
    })
    expect(result.value).toHaveLength(3)
    expect((result.value as { message: string }[])[0]!.message).toContain('<untrusted')
    expect(JSON.stringify(result.value)).toContain('<untrusted')
    expect(result.text).toContain('<untrusted')
    expect(result.text).not.toContain('SECRET123456789012345678')
    expect(result.text).not.toContain('fixtureSuffix')
    expect(result.text).not.toContain('private')
    expect(result.text).not.toContain('legacy unowned')
    expect(result.text).not.toContain('wrong-vault global')
    const all = await host.dispatch({ door: 'cli', remote: 'a/b', name: 'logs.list', params: {} })
    expect((all.value as { message: string }[]).map((entry) => entry.message)).toEqual([
      expect.stringContaining('Google trouble'),
      expect.stringContaining('Other trouble'),
      expect.stringContaining('stale Google'),
      expect.stringContaining('Holi started'),
      expect.stringContaining('failure PASSWORD=***'),
      expect.stringContaining('credential'),
    ])
    expect(log.entries()).toEqual(original)
    expect(
      (
        await host.dispatch({
          door: 'cli',
          remote: 'a/b',
          name: 'logs.list',
          params: { channel: 'plugins' },
        })
      ).value,
    ).toHaveLength(5)
    expect(
      (
        await host.dispatch({
          door: 'cli',
          remote: 'a/b',
          name: 'logs.list',
          params: { channel: 'git' },
        })
      ).value,
    ).toEqual([])
    const boundary = resolveArgv(
      ['logs', '--since', '2026-01-01T12:00:00.000Z', '--json'],
      commands,
      '',
    )
    expect(boundary.kind).toBe('run')
    if (boundary.kind === 'run') {
      expect(boundary.json).toBe(true)
      expect(
        (
          await host.dispatch({
            door: 'cli',
            remote: 'a/b',
            name: boundary.name,
            params: boundary.params,
          })
        ).value,
      ).toHaveLength(5)
    }
  })

  it('rejects malformed, repeated, unknown and unsafe filters before dispatch', async () => {
    const registry = createCapabilityRegistry()
    registry.register(
      ['logs'],
      logsCapabilities(createActivityLog(), () => NOW),
    )
    const commands = registry.commands()
    expect(resolveArgv(['logs', '--channel', 'google'], commands, '')).toMatchObject({
      kind: 'run',
    })
    for (const args of [
      ['logs', '--channel'],
      ['logs', '--since'],
      ['logs', '--channel', 'google', '--channel', 'git'],
      ['logs', '--wat', 'x'],
    ])
      expect(resolveArgv(args, commands, '').kind).toBe('usage')
    for (const since of [
      '2026-01-01T12:00:00',
      '2026-02-30T12:00:00Z',
      '999999999999999999999d',
      '0m',
      '-1h',
      '9000000000d',
    ]) {
      await expect(
        registry.run(commands[0]!.name, 'cli', { remote: 'a/b' } as never, { since }),
      ).rejects.toThrow()
    }
    expect(resolveArgv(['logs', '--help'], commands, '')).toMatchObject({ kind: 'help' })
    expect(resolveArgv(['logs', 'clear'], commands, '').kind).toBe('usage')
    expect(() => resolveArgv(['logs'], [...commands, commands[0]!], '')).toThrow(
      /multiple standalone/,
    )
  })

  it('removes credentials in quoted strings without leaking around escaped quotes', () => {
    const secrets = [
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
      'https://user:password@example.com/path',
      'Bearer abcdefghijklmnopqrstuvwxyz',
      'ya29.googlecredential123456789012345',
      '1//googlecredential123456789012345',
      `{"access_token":"secret's\\\"tail\\\\more", "refresh_token":"abc\\\"tail"}`,
      `client_secret: 'secret's\\\\tail'`,
      'api_key=lowercase-secret',
      'https://example.test/?client_secret=query-secret&ok=yes',
    ]
    const output = secrets.map(scrubSecrets).join('\n')
    for (const secret of [
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
      'password@example.com',
      'abcdefghijklmnopqrstuvwxyz',
      'googlecredential123456789012345',
      'secret\'s\\"tail',
      'abc\\\"tail',
      'secret\\\\tail',
      'lowercase-secret',
      'query-secret',
    ])
      expect(output).not.toContain(secret)
    expect(scrubSecrets('access_token="secret\'s\\\"tail"')).toBe('access_token=***')
    for (const separator of [',', '&', ';']) {
      expect(scrubSecrets(`PASSWORD=alpha${separator}fixtureSuffix`)).toBe('PASSWORD=***')
      expect(scrubSecrets(`PASSWORD=***${separator}fixtureSuffix`)).toBe('PASSWORD=***')
    }
    expect(scrubSecrets('PASSWORD=***fixtureSuffix')).toBe('PASSWORD=***')
  })
})
