import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { createPluginHost } from '../../../main/plugin-host/host'
import { automationsMain } from '../../automations/main/index'
import type { RunOptions } from '../main/claude/cli'
import { PRESETS } from '../main/harness/record'
import type { AgentExit, StartArgs } from '../main/host/pty'
import { agentMain } from '../main/index'
import { openTurnLog } from '../main/host/turn-log'

const adapters = vi.hoisted(() => ({
  version: vi.fn(() => 'test'),
  run: vi.fn<(bin: string, args: string[], opts: RunOptions) => Promise<string>>(),
  pty: [] as StartArgs[],
  backup: null as null | { source: string; entered: () => void; wait: Promise<void> },
}))

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      const pause = adapters.backup
      if (pause !== null && args[0] === pause.source) {
        pause.entered()
        await pause.wait
      }
      return fs.copyFile(...args)
    },
  }
})

vi.mock('electron', () => ({
  app: { getVersion: adapters.version },
  nativeTheme: { shouldUseDarkColors: false },
}))

vi.mock('../main/claude/cli', async (original) => {
  const cli = await original<typeof import('../main/claude/cli')>()
  return {
    ...cli,
    resolveClaudeBin: () => '/synthetic/claude',
    createClaudeCli: (deps: Parameters<typeof cli.createClaudeCli>[0]) =>
      cli.createClaudeCli({ ...deps, run: adapters.run }),
  }
})

vi.mock('../main/host/pty', async (original) => {
  const pty = await original<typeof import('../main/host/pty')>()
  return {
    ...pty,
    AgentRuntime: class extends pty.AgentRuntime {
      private exitCallbacks: Array<(event: AgentExit) => void> = []
      override start(args: StartArgs) {
        adapters.pty.push(args)
      }
      override onExit(callback: (event: AgentExit) => void) {
        this.exitCallbacks.push(callback)
      }
      override async kill() {
        for (const callback of this.exitCallbacks.splice(0)) callback({ exitCode: 0 })
      }
    },
  }
})

const A = 'fixture/a'
const B = 'fixture/b'
const dirs: string[] = []
const stops: (() => Promise<void>)[] = []
beforeEach(() => {
  adapters.version.mockReset().mockReturnValue('test')
  adapters.run
    .mockReset()
    .mockImplementation(async (_bin, args) =>
      args.includes('--bg') ? 'backgrounded · abc12345 · Bound run' : '[]',
    )
  adapters.pty.length = 0
  adapters.backup = null
})
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()))
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

async function rig(
  userData?: string,
  holdAgentDisposer?: { entered: () => void; wait: Promise<void> },
) {
  userData ??= await mkdtemp(join(tmpdir(), 'holi-agent-owner-'))
  dirs.push(userData)
  const roots = { [A]: join(userData, 'vault-a'), [B]: join(userData, 'vault-b') }
  for (const root of Object.values(roots)) {
    await mkdir(join(root, '.holi/settings'), { recursive: true })
    await writeFile(join(root, '.holi/settings/plugins.yaml'), 'plugins:\n  automations: true\n')
  }
  const sent: { remote: string; name: string }[] = []
  const registry = createCapabilityRegistry()
  const activateAgent = agentMain.activate!
  const agentPlugin =
    holdAgentDisposer === undefined
      ? agentMain
      : {
          ...agentMain,
          async activate(ctx: Parameters<typeof activateAgent>[0]) {
            const dispose = await activateAgent(ctx)
            if (dispose === undefined)
              throw new Error('Agent activation did not return a disposer.')
            return async () => {
              await dispose()
              holdAgentDisposer.entered()
              await holdAgentDisposer.wait
            }
          },
        }
  const host = createPluginHost({
    plugins: [agentPlugin, automationsMain],
    registry,
    userData,
    coreSeeds: [],
    active: () => null,
    rootFor: async (remote) => roots[remote as keyof typeof roots] ?? null,
    events: {
      send: (_channel, event) => sent.push({ remote: event.remote, name: event.name }),
      listen: () => () => {},
      liveRemote: () => host.displayed(),
    },
    openAppDoor: () => {
      throw new Error('unused')
    },
    route: () => () => {},
    binDir: () => userData,
    githubToken: () => null,
    frameOrigin: () => () => {},
    notify: () => false,
    focused: () => false,
    call: async (remote, name, params, beforeInvoke) =>
      (await capabilities.dispatch({ door: 'ui', remote, name, params, beforeInvoke })).value,
  })
  const capabilities = createCapabilityHost({
    registry,
    rootFor: async (remote) => roots[remote as keyof typeof roots] ?? null,
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async (plugin, root) => (await host.serving(root)).has(plugin),
    claims: (root) => host.scanClaimsFor(root),
  })
  const enter = (remote: typeof A | typeof B) =>
    host.reconcile(
      {
        remote,
        root: roots[remote],
        pause: () => {},
        resume: () => {},
        commitNow: async () => null,
        repo: { head: async () => null },
      },
      'open',
    )
  const call = async (remote: typeof A | typeof B, name: string, params: unknown = {}) =>
    (await capabilities.dispatch({ door: 'ui', remote, name, params })).value
  stops.push(() => host.stopAll())
  return { host, enter, call, capabilities, roots, userData, sent }
}

const harness = {
  id: 'integration-test',
  label: 'Integration test',
  command: { bin: 'integration-test', args: [] },
  prompt: { args: ['--prompt', '{prompt}'] },
  resume: { pick: ['--resume'], byId: ['--id', '{id}'] },
  env: { OWNER_TEST: 'shared' },
}
const customRow = {
  agents: expect.arrayContaining([
    expect.objectContaining({ harness: expect.objectContaining({ id: harness.id }) }),
  ]),
}

it('updates real PTY history per activated vault and retains the other partition on stop', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'holi-agent-history-'))
  const sharedId = 'p0123456789ab'
  const prior = {
    id: sharedId,
    provider: 'pi',
    name: 'Prior session',
    state: 'idle',
    startedAt: 1,
    conversationId: '123e4567-e89b-42d3-a456-426614174000',
  }
  await writeFile(
    join(userData, 'agent-pty-history.json'),
    JSON.stringify({ [A]: [prior], [B]: [prior] }),
  )
  const { host, enter, call, roots } = await rig(userData)
  await enter(A)
  await enter(B)
  const pi = {
    ...PRESETS.find((preset) => preset.id === 'pi')!,
    command: { bin: process.execPath, args: [] },
  }
  await call(A, 'agent.harnessSave', { harness: pi })
  const aStarted = (await call(A, 'agent.start', { provider: 'pi', prompt: 'A work' })) as {
    ok: boolean
    sessionId: string
  }
  const bStarted = (await call(B, 'agent.start', { provider: 'pi', prompt: 'B work' })) as {
    ok: boolean
    sessionId: string
  }
  expect(aStarted.ok).toBe(true)
  expect(bStarted.ok).toBe(true)
  expect(adapters.pty.slice(-2).map((session) => session.cwd)).toEqual([roots[A], roots[B]])

  await call(A, 'agent.stop', { id: aStarted.sessionId })
  const historyFile = join(userData, 'agent-pty-history.json')
  const afterAStops = JSON.parse(await readFile(historyFile, 'utf8')) as Record<string, unknown[]>
  expect(afterAStops[A]).toHaveLength(2)
  expect(afterAStops[B]).toEqual([prior])
  expect(await call(B, 'agent.history')).toEqual([prior])

  await call(B, 'agent.stop', { id: bStarted.sessionId })
  const afterBothStop = JSON.parse(await readFile(historyFile, 'utf8')) as Record<string, unknown[]>
  expect(afterBothStop[A]).toHaveLength(2)
  expect(afterBothStop[B]).toHaveLength(2)
  expect(afterBothStop[A]?.[1]).toMatchObject({ id: sharedId })
  expect(afterBothStop[B]?.[1]).toMatchObject({ id: sharedId })
  await host.stop(A)
  await host.stop(B)
  await enter(A)
  await enter(B)
  expect(await call(A, 'agent.history')).toEqual(
    expect.arrayContaining([prior, expect.objectContaining({ id: aStarted.sessionId })]),
  )
  expect(await call(B, 'agent.history')).toEqual(
    expect.arrayContaining([prior, expect.objectContaining({ id: bStarted.sessionId })]),
  )
})

it('routes concurrent turn reports through each activated vault and reloads them from disk', async () => {
  const { host, enter, call, roots } = await rig()
  await enter(A)
  await enter(B)
  const sameSession = 'same-session'
  const logs = { [A]: openTurnLog(roots[A]), [B]: openTurnLog(roots[B]) }
  await Promise.all(
    Array.from({ length: 12 }, (_, n) =>
      Promise.all(
        ([A, B] as const).map((remote) =>
          logs[remote].append({
            base: `${remote}-base-${n}`,
            end: `${remote}-end-${n}`,
            at: `2026-09-09T10:${String(n).padStart(2, '0')}:00Z`,
            sessionId: sameSession,
          }),
        ),
      ),
    ),
  )

  const aTurns = (await call(A, 'agent.turns')) as { base: string; sessionId: string }[]
  const bTurns = (await call(B, 'agent.turns')) as { base: string; sessionId: string }[]
  expect(aTurns.map((turn) => turn.base)).toEqual(
    Array.from({ length: 12 }, (_, n) => `${A}-base-${n}`).reverse(),
  )
  expect(bTurns.map((turn) => turn.base)).toEqual(
    Array.from({ length: 12 }, (_, n) => `${B}-base-${n}`).reverse(),
  )
  expect(aTurns.every((turn) => turn.sessionId === sameSession)).toBe(true)
  expect(bTurns.every((turn) => turn.sessionId === sameSession)).toBe(true)
  await host.stop(A)
  await enter(A)
  expect(await call(A, 'agent.turns')).toEqual(aTurns)
  expect(await call(B, 'agent.turns')).toEqual(bTurns)
})

it('activates real agents and shares save/remove/reset/reload and remote notifications', async () => {
  const { host, enter, call, sent, userData } = await rig()
  await enter(A)
  await enter(B)
  expect(host.failures(A)).toEqual({})
  expect(host.failures(B)).toEqual({})
  expect(await call(A, 'agent.harnesses')).toEqual(await call(B, 'agent.harnesses'))
  await call(A, 'agent.harnessSave', { harness, create: true })
  expect(await call(B, 'agent.harnesses')).toMatchObject(customRow)
  expect(sent).toContainEqual({ remote: A, name: 'providers' })
  expect(sent).toContainEqual({ remote: B, name: 'providers' })
  await call(B, 'agent.harnessRemove', { id: harness.id })
  expect(await call(A, 'agent.harnesses')).not.toMatchObject(customRow)
  await call(A, 'agent.harnessSave', { harness, create: true })
  await host.stop(A)
  await enter(A)
  expect(host.failures(A)).toEqual({})
  expect(await call(B, 'agent.harnesses')).toMatchObject(customRow)
  await call(B, 'agent.harnessReset')
  expect(await call(A, 'agent.harnesses')).not.toMatchObject(customRow)
  await writeFile(
    join(userData, 'agent-harnesses.json'),
    JSON.stringify({ version: 1, harnesses: [harness] }),
  )
  await call(A, 'agent.harnesses')
  expect(await call(B, 'agent.harnesses')).toMatchObject(customRow)
  const other = await rig()
  await other.enter(A)
  expect(await other.call(A, 'agent.harnesses')).not.toMatchObject(customRow)
})

it('keeps real native provider commands and vault configuration local after a shared edit', async () => {
  const { host, enter, call, capabilities, roots, userData } = await rig()
  await enter(A)
  await enter(B)
  const codex = {
    ...PRESETS[1]!,
    command: { bin: process.execPath, args: ['--first-preset'] },
    env: { OWNER_TEST: 'first', CODEX_HOME: join(userData, 'synthetic-codex') },
  }
  await call(A, 'agent.harnessSave', { harness: codex })
  expect(await call(B, 'agent.start', { provider: 'codex', prompt: 'B first' })).toMatchObject({
    ok: true,
  })
  const first = adapters.pty.at(-1)!
  expect(first.cwd).toBe(roots[B])
  expect(first.bin).toBe(process.execPath)
  expect(first.args).toEqual(expect.arrayContaining(['--first-preset', '--', 'B first']))
  expect(first.env).toMatchObject({ OWNER_TEST: 'first', CODEX_HOME: codex.env.CODEX_HOME })
  await call(A, 'agent.harnessSave', {
    harness: {
      ...codex,
      command: { ...codex.command, args: ['--second-preset'] },
      env: { ...codex.env, OWNER_TEST: 'second' },
    },
  })
  expect(adapters.pty).toHaveLength(1)
  expect(await call(B, 'agent.start', { provider: 'codex', prompt: 'B next' })).toMatchObject({
    ok: true,
  })
  expect(adapters.pty.at(-1)).toMatchObject({
    cwd: roots[B],
    args: expect.arrayContaining(['--second-preset', 'B next']),
    env: { OWNER_TEST: 'second' },
  })
  expect(first.env.OWNER_TEST).toBe('first')
  expect(await call(A, 'agent.start', { provider: 'codex', prompt: 'A next' })).toMatchObject({
    ok: true,
  })
  expect(adapters.pty.at(-1)?.cwd).toBe(roots[A])
  await call(A, 'agent.harnessSave', {
    harness: { ...PRESETS[0]!, command: { bin: process.execPath, args: [] } },
  })
  for (const remote of [A, B] as const) {
    expect(
      await call(remote, 'agent.launch', { name: `${remote} bound`, prompt: `${remote} prompt` }),
    ).toMatchObject({ ok: true })
  }
  const launches = adapters.run.mock.calls.filter(([, args]) => args.includes('--bg'))
  expect(launches).toHaveLength(2)
  expect(launches.map(([, , opts]) => opts.cwd)).toEqual([roots[A], roots[B]])
  expect(launches[0]![2].env.CLAUDE_CONFIG_DIR).not.toBe(launches[1]![2].env.CLAUDE_CONFIG_DIR)
  for (const [bin, args, opts] of launches) {
    expect(bin).toBe(process.execPath)
    expect(args).toContain('--')
    expect(opts.env.CLAUDE_CONFIG_DIR).toContain(join(userData, 'agent-config'))
    expect(args).not.toContain('--dangerously-skip-permissions')
  }
  await expect(
    capabilities.dispatch({ door: 'cli', remote: A, name: 'agent.harnessReset', params: {} }),
  ).rejects.toThrow()
  const schedule = (await call(B, 'schedules.save', {
    draft: { name: 'Bound automation', crons: ['0 0 1 1 *'], prompt: 'Scheduled B', allow: [] },
  })) as { path: string; fingerprint: string }
  await expect(call(B, 'schedules.run', { schedule: schedule.path })).rejects.toThrow()
  await call(B, 'schedules.enable', {
    schedule: schedule.path,
    fingerprint: schedule.fingerprint,
  })
  await call(B, 'schedules.run', { schedule: schedule.path })
  const scheduled = adapters.run.mock.calls
    .filter(([, args]) => args.some((arg) => arg.includes('Scheduled B')))
    .at(-1)!
  expect(scheduled[2].cwd).toBe(roots[B])
  expect(scheduled[2].env.CLAUDE_CONFIG_DIR).toBe(launches[1]![2].env.CLAUDE_CONFIG_DIR)
  await host.stop(A)
  expect(await call(B, 'agent.start', { provider: 'codex', prompt: 'B survives' })).toMatchObject({
    ok: true,
  })
  expect(adapters.pty.at(-1)?.cwd).toBe(roots[B])
})

it('rejects late UI config dispatch after A releases ownership but before unregistering', async () => {
  const enteredDispose = deferred()
  const releaseDispose = deferred()
  const { host, enter, call, sent, userData } = await rig(undefined, {
    entered: enteredDispose.resolve,
    wait: releaseDispose.promise,
  })
  let stopping: Promise<void> | undefined
  try {
    await enter(A)
    stopping = host.stop(A)
    await enteredDispose.promise

    // A's real disposer has released its sole owner handle, but the host still
    // serves its capabilities until this wrapper lets stopOne finish.
    await enter(B)
    const codex = {
      ...PRESETS[1]!,
      command: { bin: process.execPath, args: ['--live-owner'] },
    }
    await call(B, 'agent.harnessSave', { harness: codex })
    const disk = await readFile(join(userData, 'agent-harnesses.json'), 'utf8')
    const bListing = await call(B, 'agent.harnesses')
    const bNotices = sent.filter((event) => event.name === 'providers').length
    for (const [name, params] of [
      ['agent.harnessSave', { harness: { ...harness, id: 'late-save' }, create: true }],
      ['agent.harnessRemove', { id: 'codex' }],
      ['agent.harnessReset', {}],
      ['agent.harnesses', {}],
    ] as const) {
      await expect(call(A, name, params)).rejects.toThrow(/disposed/)
    }
    expect(await readFile(join(userData, 'agent-harnesses.json'), 'utf8')).toBe(disk)
    expect(sent.filter((event) => event.name === 'providers')).toHaveLength(bNotices)
    expect(await call(B, 'agent.harnesses')).toEqual(bListing)

    expect(
      await call(B, 'agent.start', { provider: 'codex', prompt: 'B remains live' }),
    ).toMatchObject({ ok: true })
    expect(adapters.pty.at(-1)).toMatchObject({
      cwd: join(userData, 'vault-b'),
      bin: process.execPath,
      args: expect.arrayContaining(['--live-owner', 'B remains live']),
    })
  } finally {
    releaseDispose.resolve()
    await stopping
    await host.stopAll()
  }
})

it('releases failed activation ownership so a fresh activation reads current disk state', async () => {
  const { host, enter, call, userData } = await rig()
  adapters.version.mockImplementationOnce(() => {
    throw new Error('native activation failed')
  })
  await enter(A)
  expect(host.failures(A).agent).toContain('native activation failed')
  await enter(B)
  await call(B, 'agent.harnessSave', { harness, create: true })
  await host.stop(B)
  await writeFile(
    join(userData, 'agent-harnesses.json'),
    JSON.stringify({ version: 1, harnesses: [] }),
  )
  await enter(A)
  expect(host.failures(A)).toEqual({})
  expect(await call(A, 'agent.providers')).not.toContainEqual(
    expect.objectContaining({ id: harness.id }),
  )
})

it('drains an admitted real activation write while the other activation stays usable', async () => {
  const { host, enter, call, sent, userData } = await rig()
  await enter(A)
  await enter(B)
  await call(A, 'agent.harnessSave', { harness, create: true })
  const entered = deferred()
  const release = deferred()
  adapters.backup = {
    source: join(userData, 'agent-harnesses.json'),
    entered: entered.resolve,
    wait: release.promise,
  }
  const write = call(A, 'agent.harnessReset')
  await entered.promise
  let stopped = false
  const stop = host.stop(A).then(() => {
    stopped = true
  })
  try {
    expect(await call(B, 'agent.providers')).toContainEqual(
      expect.objectContaining({ id: harness.id }),
    )
    expect(stopped).toBe(false)
  } finally {
    release.resolve()
    await Promise.all([write, stop])
  }
  expect(stopped).toBe(true)
  expect(await call(B, 'agent.harnesses')).not.toMatchObject(customRow)
  const before = sent.filter((event) => event.remote === A && event.name === 'providers').length
  await call(B, 'agent.harnessSave', { harness, create: true })
  expect(sent.filter((event) => event.remote === A && event.name === 'providers')).toHaveLength(
    before,
  )
})
