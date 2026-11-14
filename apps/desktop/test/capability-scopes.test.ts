import { describe, expect, it, vi } from 'vitest'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import {
  createCapabilityRegistry,
  cap,
  type CapabilityContext,
} from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'

const context = (remote: string): CapabilityContext => ({
  remote,
  root: `/${remote}`,
  bundle: null,
  snapshot: async () =>
    ({}) as CapabilityContext['snapshot'] extends () => Promise<infer T> ? T : never,
  claims: async () => [],
  core: {} as CapabilityContext['core'],
})
const entry = (value: string, run = vi.fn(async () => value)) =>
  cap({
    doors: ['ui', 'cli', 'app'] as const,
    cli: { args: [], summary: value },
    params: () => ({}),
    run,
  })

describe('remote-scoped capability registrations', () => {
  it('routes same-namespace handlers by remote without fallback and disposes exact leases', async () => {
    const registry = createCapabilityRegistry()
    const shared = entry('same')
    const removeA = registry.register(['sample'], { 'sample.ping': shared }, 'sample', 'A')
    const removeB = registry.register(['sample'], { 'sample.ping': entry('B') }, 'sample', 'B')
    expect((await registry.run('sample.ping', 'ui', context('A'), {})).value).toBe('same')
    expect((await registry.run('sample.ping', 'ui', context('B'), {})).value).toBe('B')
    await expect(registry.run('sample.ping', 'ui', context('missing'), {})).rejects.toThrow(
      /no such method/,
    )
    removeA()
    const replacement = registry.register(['sample'], { 'sample.ping': shared }, 'sample', 'A')
    removeA()
    expect((await registry.run('sample.ping', 'ui', context('A'), {})).value).toBe('same')
    expect((await registry.run('sample.ping', 'ui', context('B'), {})).value).toBe('B')
    replacement()
    removeB()
  })

  it('does not hand off an executable after its scoped registration is disposed', async () => {
    const registry = createCapabilityRegistry()
    let finish!: (value: string) => void
    const pending = new Promise<string>((resolve) => {
      finish = resolve
    })
    const command = cap({
      doors: ['cli'] as const,
      cli: { args: [], summary: 'pending handoff' },
      params: () => ({}),
      run: () => pending,
      cliRun: () => ({ cwd: '/plugin', argv: ['/plugin/run'], env: {} }),
    })
    const remove = registry.register(['sample'], { 'sample.run': command }, 'sample', 'A')
    const call = registry.run('sample.run', 'cli', context('A'), {})
    await Promise.resolve()
    remove()
    finish('done')
    await expect(call).rejects.toThrow(/no such method/)
  })

  it('fences a scoped handoff revoked while post-run enablement is pending', async () => {
    const registry = createCapabilityRegistry()
    let finish!: (enabled: boolean) => void
    const enabled = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    const remove = registry.register(
      ['sample'],
      {
        'sample.run': cap({
          doors: ['cli'] as const,
          cli: { args: [], summary: 'run' },
          params: () => ({}),
          run: async () => 'done',
          cliRun: () => ({ cwd: '/plugin', argv: ['/plugin/run'], env: {} }),
        }),
      },
      'sample',
      'A',
    )
    const pluginEnabled = vi.fn().mockResolvedValueOnce(true).mockReturnValueOnce(enabled)
    const host = createCapabilityHost({
      registry,
      rootFor: async () => '/A',
      active: () => null,
      core: noCoreServices,
      pluginEnabled,
      claims: async () => [],
    })
    const call = host.dispatch({ door: 'cli', remote: 'A', name: 'sample.run', params: {} })
    await vi.waitFor(() => expect(pluginEnabled).toHaveBeenCalledTimes(2))
    remove()
    registry.register(
      ['sample'],
      {
        'sample.run': cap({
          doors: ['cli'] as const,
          cli: { args: [], summary: 'replacement' },
          params: () => ({}),
          run: async () => 'replacement',
          cliRun: () => ({ cwd: '/plugin', argv: ['/plugin/run'], env: {} }),
        }),
      },
      'sample',
      'A',
    )
    finish(true)
    await expect(call).rejects.toThrow(/no such method/)
  })

  it('rechecks plugin enablement before returning an awaited executable handoff', async () => {
    const registry = createCapabilityRegistry()
    let finish!: (value: string) => void
    const pending = new Promise<string>((resolve) => {
      finish = resolve
    })
    registry.register(
      ['sample'],
      {
        'sample.run': cap({
          doors: ['cli'] as const,
          cli: { args: [], summary: 'run' },
          params: () => ({}),
          run: () => pending,
          cliRun: () => ({ cwd: '/plugin', argv: ['/plugin/run'], env: {} }),
        }),
      },
      'sample',
      'A',
    )
    const pluginEnabled = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const host = createCapabilityHost({
      registry,
      rootFor: async () => '/A',
      active: () => null,
      core: noCoreServices,
      pluginEnabled,
      claims: async () => [],
    })
    const call = host.dispatch({ door: 'cli', remote: 'A', name: 'sample.run', params: {} })
    await Promise.resolve()
    finish('done')
    await expect(call).rejects.toThrow(/no such method/)
    expect(pluginEnabled).toHaveBeenCalledTimes(2)
  })

  it('tracks empty namespace claims and rejects core/plugin/global collisions in either order', () => {
    const registry = createCapabilityRegistry()
    const release = registry.register(['empty'], {}, 'sample', 'A')
    expect(() => registry.register(['empty'], {}, 'sample', 'A')).toThrow(/already registered/)
    expect(() => registry.register(['empty'], {}, 'other', 'B')).toThrow(/already registered/)
    expect(() => registry.register(['empty'], {}, undefined)).toThrow(/already registered/)
    release()
    registry.register(['empty'], {}, 'sample', 'A')()
    const global = registry.register(['core'], {})
    expect(() => registry.register(['core'], {}, 'sample', 'A')).toThrow(/already registered/)
    global()
    const scoped = registry.register(['another'], {}, 'sample', 'A')
    expect(() => registry.register(['another'], {}, undefined)).toThrow(/already registered/)
    scoped()
  })

  it('binds command metadata to each remote and rejects unscoped plugin registrations', () => {
    const registry = createCapabilityRegistry()
    const a = entry('A')
    registry.register(['sample'], { 'sample.ping': a }, 'sample', 'A')
    registry.register(['sample'], { 'sample.ping': entry('B') }, 'sample', 'B')
    expect(registry.commands('A')[0]).toMatchObject({ name: 'sample.ping', cli: { summary: 'A' } })
    expect(registry.commands('B')[0]).toMatchObject({ name: 'sample.ping', cli: { summary: 'B' } })
    expect(registry.commands('missing')).toEqual([])
    expect(() => registry.register(['sample'], { 'sample.ping': a }, 'sample')).toThrow(/scoped/)
  })

  it('refuses a capability replaced while consent is pending', async () => {
    const registry = createCapabilityRegistry()
    const old = cap({
      doors: ['app'] as const,
      appGrant: 'grant',
      params: () => ({}),
      run: vi.fn(async () => 'old'),
    })
    const remove = registry.register(['sample'], { 'sample.ping': old }, 'sample', 'A')
    let allow!: () => void
    const waiting = new Promise<void>((resolve) => {
      allow = resolve
    })
    const call = registry.run('sample.ping', 'app', context('A'), {}, async () => waiting)
    await Promise.resolve()
    remove()
    registry.register(['sample'], { 'sample.ping': old }, 'sample', 'A')
    allow()
    await expect(call).rejects.toThrow(/no such method/)
    expect(old.run).not.toHaveBeenCalled()
  })

  it('binds each app door to its remote and fences closed doors across root and consent waits', async () => {
    const registry = createCapabilityRegistry()
    const runA = vi.fn(async () => 'A')
    registry.register(['core'], {
      'core.open': cap({ doors: ['app'], params: () => ({}), run: runA }),
      'core.grant': cap({ doors: ['app'], appGrant: 'grant', params: () => ({}), run: runA }),
    })
    let resolveRoot!: (root: string) => void
    let firstA = true
    const host = createCapabilityHost({
      registry,
      rootFor: (remote) =>
        remote === 'A' && firstA
          ? ((firstA = false),
            new Promise((resolve) => {
              resolveRoot = resolve
            }))
          : Promise.resolve(remote === 'A' ? '/A' : '/B'),
      active: () => null,
      core: noCoreServices,
      pluginEnabled: async () => true,
      claims: async () => [],
    })
    const doorA = host.openAppDoor({ admit: async () => {} }, 'A')
    const doorB = host.openAppDoor({ admit: async () => {} }, 'B')
    await expect(doorA.call('B', 'T.app', 'core.open', {})).rejects.toThrow(/belongs to A/)
    const waitingRoot = doorA.call('A', 'T.app', 'core.open', {})
    doorA.close()
    const replacementA = host.openAppDoor({ admit: async () => {} }, 'A')
    resolveRoot('/A')
    await expect(waitingRoot).rejects.toThrow(/closed/)
    expect(runA).not.toHaveBeenCalled()
    expect((await doorB.call('B', 'T.app', 'core.open', {})).value).toBe('A')
    await expect(replacementA.call('A', 'T.app', 'core.open', {})).resolves.toMatchObject({
      value: 'A',
    })
    doorA.close()
    await expect(replacementA.call('A', 'T.app', 'core.open', {})).resolves.toMatchObject({
      value: 'A',
    })
    doorB.close()
  })

  it('fences a consent-delayed app call when its door closes', async () => {
    const registry = createCapabilityRegistry()
    const run = vi.fn(async () => 'ran')
    registry.register(['core'], {
      'core.grant': cap({ doors: ['app'], appGrant: 'grant', params: () => ({}), run }),
    })
    let allow!: () => void
    const waiting = new Promise<void>((resolve) => {
      allow = resolve
    })
    const host = createCapabilityHost({
      registry,
      rootFor: async () => '/vault',
      active: () => null,
      core: noCoreServices,
      pluginEnabled: async () => true,
      claims: async () => [],
    })
    let entered!: () => void
    const consenting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const door = host.openAppDoor(
      {
        admit: async () => {
          entered()
          await waiting
        },
      },
      'A',
    )
    const call = door.call('A', 'T.app', 'core.grant', {})
    await consenting
    door.close()
    allow()
    await expect(call).rejects.toThrow(/no such method/)
    expect(run).not.toHaveBeenCalled()
  })
})
