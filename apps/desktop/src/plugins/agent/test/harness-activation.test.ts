import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { createPluginHost } from '../../../main/plugin-host/host'
import { createBridgeServer } from '../../../main/bridge/server'
import { automationsMain } from '../../automations/main/index'
import type { RunOptions } from '../main/claude/cli'
import { PRESETS } from '../main/harness/record'
import type { AgentExit, StartArgs } from '../main/host/pty'
import { agentMain } from '../main/index'
import type { BridgeRoute } from '../../../main/plugin-api'
import { openTurnLog } from '../main/host/turn-log'

const adapters = vi.hoisted(() => ({
  version: vi.fn(() => 'test'),
  run: vi.fn<(bin: string, args: string[], opts: RunOptions) => Promise<string>>(),
  pty: [] as StartArgs[],
  backup: null as null | { source: string; entered: () => void; wait: Promise<void> },
  heldExit: null as null | { cwd: string; entered: () => void; wait: Promise<void> },
  historyRename: null as null | { source: string; entered: () => void; wait: Promise<void> },
  exitObserved: null as null | { cwd: string; entered: () => void },
  routes: new Map<string, Map<string, BridgeRoute>>(),
  watchStarts: 0,
  watchCloses: 0,
}))

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      const hold = adapters.historyRename
      if (hold !== null && args[1] === hold.source) {
        adapters.historyRename = null
        hold.entered()
        await hold.wait
      }
      return fs.rename(...args)
    },
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

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    watch: (...args: Parameters<typeof fs.watch>) => {
      adapters.watchStarts++
      const watcher = fs.watch(...args)
      const close = watcher.close.bind(watcher)
      watcher.close = () => {
        adapters.watchCloses++
        close()
      }
      return watcher
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
      private exitCallback: ((event: AgentExit) => void) | null = null
      private args: StartArgs | null = null
      override start(args: StartArgs) {
        this.args = args
        adapters.pty.push(args)
      }
      override onExit(callback: (event: AgentExit) => void) {
        this.exitCallback = callback
      }
      override async kill() {
        const hold = adapters.heldExit
        if (hold !== null && this.args?.cwd === hold.cwd) {
          adapters.heldExit = null
          hold.entered()
          await hold.wait
        }
        const observed = adapters.exitObserved
        if (observed !== null && this.args?.cwd === observed.cwd) observed.entered()
        this.exitCallback?.({ exitCode: 0 })
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
  adapters.heldExit = null
  adapters.historyRename = null
  adapters.exitObserved = null
  adapters.routes.clear()
  adapters.watchStarts = 0
  adapters.watchCloses = 0
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
  liveContext = false,
) {
  userData ??= await mkdtemp(join(tmpdir(), 'holi-agent-owner-'))
  dirs.push(userData)
  const roots = { [A]: join(userData, 'vault-a'), [B]: join(userData, 'vault-b') }
  for (const root of Object.values(roots)) {
    await mkdir(join(root, '.holi/settings'), { recursive: true })
    await writeFile(join(root, '.holi/settings/plugins.yaml'), 'plugins:\n  automations: true\n')
    await writeFile(
      join(root, '.fixture-owner'),
      Object.entries(roots).find(([, path]) => path === root)![0],
    )
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Holi test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'holi-test@example.invalid'])
    execFileSync('git', ['-C', root, 'add', '.'])
    execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture'])
  }
  const sent: { remote: string; name: string }[] = []
  const bridge = createBridgeServer({ log: () => {} })
  await bridge.start()
  let activeRemote: typeof A | typeof B | null = null
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
    active: () =>
      liveContext && activeRemote !== null
        ? {
            remote: activeRemote,
            root: roots[activeRemote],
            pause: () => {},
            resume: () => {},
            repo: {
              head: async () =>
                execFileSync('git', ['-C', roots[activeRemote!], 'rev-parse', 'HEAD'], {
                  encoding: 'utf8',
                }).trim(),
            },
            commitNow: async () =>
              execFileSync('git', ['-C', roots[activeRemote!], 'rev-parse', 'HEAD'], {
                encoding: 'utf8',
              }).trim(),
          }
        : null,
    rootFor: async (remote) => roots[remote as keyof typeof roots] ?? null,
    events: {
      send: (_channel, event) => sent.push({ remote: event.remote, name: event.name }),
      listen: () => () => {},
      liveRemote: () => host.displayed(),
    },
    openAppDoor: () => {
      throw new Error('unused')
    },
    route: (path, route, remote) => {
      const forRemote = adapters.routes.get(remote) ?? new Map<string, BridgeRoute>()
      forRemote.set(path, route)
      adapters.routes.set(remote, forRemote)
      const unregister = bridge.route(path, route, remote)
      return () => {
        forRemote.delete(path)
        unregister()
      }
    },
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
  const enter = (remote: typeof A | typeof B) => {
    if (liveContext) activeRemote = remote
    return host.reconcile(
      {
        remote,
        root: roots[remote],
        pause: () => {},
        resume: () => {},
        commitNow: async () =>
          execFileSync('git', ['-C', roots[remote], 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim(),
        repo: {
          head: async () =>
            execFileSync('git', ['-C', roots[remote], 'rev-parse', 'HEAD'], {
              encoding: 'utf8',
            }).trim(),
        },
      },
      'open',
    )
  }
  const setActive = (remote: typeof A | typeof B) => {
    activeRemote = remote
  }
  const call = async (remote: typeof A | typeof B, name: string, params: unknown = {}) =>
    (await capabilities.dispatch({ door: 'ui', remote, name, params })).value
  stops.push(async () => {
    await host.stopAll()
    await bridge.stop()
  })
  return { host, enter, call, capabilities, roots, userData, sent, setActive, bridge, registry }
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

it('serializes overlapping PTY history updates across activations and drains stop A', async () => {
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

  const historyFile = join(userData, 'agent-pty-history.json')
  const aRenameEntered = deferred()
  const releaseARename = deferred()
  adapters.historyRename = {
    source: historyFile,
    entered: aRenameEntered.resolve,
    wait: releaseARename.promise,
  }
  const stopA = call(A, 'agent.stop', { id: aStarted.sessionId })
  await aRenameEntered.promise

  const bExitObserved = deferred()
  const releaseBExit = deferred()
  adapters.heldExit = {
    cwd: roots[B],
    entered: bExitObserved.resolve,
    wait: releaseBExit.promise,
  }
  const bMutationAdmitted = deferred()
  adapters.exitObserved = { cwd: roots[B], entered: bMutationAdmitted.resolve }
  const stopB = call(B, 'agent.stop', { id: bStarted.sessionId })
  await bExitObserved.promise
  releaseBExit.resolve()
  await bMutationAdmitted.promise
  // B reached its real PTY exit callback and queued its real history mutation
  // while A's jsonFileStore rename remains blocked.
  let stoppedA = false
  const teardownA = host.stop(A).then(() => {
    stoppedA = true
  })
  const bRenameEntered = deferred()
  const releaseBRename = deferred()
  adapters.historyRename = {
    source: historyFile,
    entered: bRenameEntered.resolve,
    wait: releaseBRename.promise,
  }
  releaseARename.resolve()
  await stopA
  await bRenameEntered.promise
  await teardownA
  expect(stoppedA).toBe(true)
  let stoppedB = false
  void stopB.then(() => {
    stoppedB = true
  })
  expect(stoppedB).toBe(false)
  releaseBRename.resolve()
  await stopB
  expect(stoppedA).toBe(true)
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

it('binds real hook reports, inbox delivery, and native commands to activation vaults', async () => {
  const { host, enter, call, roots, bridge, userData } = await rig(undefined, undefined, true)
  const received: Record<'A' | 'B' | 'A2', string[]> = { A: [], B: [], A2: [] }
  const inboxServers: ReturnType<typeof createServer>[] = []
  const inboxSockets: string[] = []
  const inbox = async (owner: 'A' | 'B' | 'A2') => {
    const socket = join(tmpdir(), `holi-agent-inbox-${process.pid}-${owner}-${Date.now()}.sock`)
    inboxSockets.push(socket)
    const server = createServer((connection) => {
      let bytes = ''
      connection.on('data', (chunk) => (bytes += chunk.toString()))
      connection.on('end', () => received[owner]!.push(bytes))
    })
    inboxServers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, resolve)
    })
    return { socket, token: `token_${owner}_123` }
  }
  const post = async (remote: string, path: string, query = '', body = '') => {
    const token = bridge.tokenForVault(remote)
    return fetch(
      `http://127.0.0.1:${bridge.port()}${path}?t=${encodeURIComponent(token)}${query}`,
      {
        method: 'POST',
        body,
      },
    )
  }
  try {
    // The same real Claude job id and conversation id deliberately exist in
    // both listings. Only cwd distinguishes the owners.
    const listingEntered = deferred()
    const releaseListing = deferred()
    let gated = false
    let listingStatusB: 'busy' | 'idle' = 'busy'
    adapters.run.mockImplementation(async (_bin, args, opts) => {
      if (args.includes('--bg')) return 'backgrounded · abc12345 · Bound run'
      if (args[0] === 'agents') {
        if (opts.cwd === roots[A] && !gated) {
          gated = true
          listingEntered.resolve()
          await releaseListing.promise
        }
        return JSON.stringify([
          {
            kind: 'background',
            id: 'abc12345',
            name: 'Owner session',
            sessionId: '123e4567-e89b-42d3-a456-426614174000',
            cwd: opts.cwd,
            pid: process.pid,
            status: opts.cwd === roots[B] ? listingStatusB : 'idle',
          },
        ])
      }
      return '[]'
    })
    const enteringA = enter(A)
    await listingEntered.promise
    expect(adapters.routes.has(A)).toBe(false)
    releaseListing.resolve()
    await enteringA
    expect(adapters.routes.has(A)).toBe(true)
    await enter(B)
    expect(await readFile(join(roots[A], '.fixture-owner'), 'utf8')).toBe(A)
    expect(await readFile(join(roots[B], '.fixture-owner'), 'utf8')).toBe(B)
    host.setDisplayed(B)
    const channelA = await inbox('A')
    const channelB = await inbox('B')

    // Genuine HTTP hook routes populate the two activation-local channels.
    for (const [remote, channel] of [
      [A, channelA],
      [B, channelB],
    ] as const) {
      expect(
        (await post(remote, '/session', '&job=abc12345', JSON.stringify(channel))).status,
      ).toBe(204)
      expect(
        (
          await post(
            remote,
            '/statusline',
            '&job=abc12345',
            JSON.stringify({
              context_window: { used_percentage: remote === A ? 17 : 83 },
              model: { display_name: remote === A ? 'Model A' : 'Model B' },
            }),
          )
        ).status,
      ).toBe(204)
      expect(
        (
          await post(
            remote,
            '/turn/start',
            `&job=abc12345&pid=${process.pid}`,
            JSON.stringify(channel),
          )
        ).status,
      ).toBe(204)
    }
    const aSessions = (await call(A, 'agent.sessions')) as {
      id: string
      state: string
      contextPercent?: number
      model?: string
    }[]
    const bSessions = (await call(B, 'agent.sessions')) as {
      id: string
      state: string
      contextPercent?: number
      model?: string
    }[]
    expect(aSessions).toEqual([
      expect.objectContaining({
        id: 'abc12345',
        state: 'working',
        contextPercent: 17,
        model: 'Model A',
      }),
    ])
    expect(bSessions).toEqual([
      expect.objectContaining({
        id: 'abc12345',
        state: 'working',
        contextPercent: 83,
        model: 'Model B',
      }),
    ])
    const settledA = await post(A, '/turn/end', '&job=abc12345&pending=2')
    expect(settledA.status).toBe(200)

    host.setDisplayed(A)
    await expect(
      call(A, 'agent.message', { session: 'abc12345', text: 'message A' }),
    ).resolves.toEqual({ ok: true })
    host.setDisplayed(B)
    await expect(
      call(B, 'agent.message', { session: 'abc12345', text: 'message B' }),
    ).resolves.toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received.A.join('')).toContain('message A')
    expect(received.A.join('')).toContain(channelA.token)
    expect(received.B.join('')).toContain('message B')
    expect(received.B.join('')).toContain(channelB.token)
    expect(received.A.join('')).not.toContain('message B')
    expect(received.B.join('')).not.toContain('message A')

    // A tiny real Pi RPC child gives the actual capability dispatch distinct
    // owner replies without substituting the session host or dispatch table.
    const rpc = join(userData, 'pi-rpc-fixture')
    await writeFile(
      rpc,
      `#!/usr/bin/env node\nconst readline=require('node:readline');\nprocess.on('SIGTERM',()=>process.exit(0));\nconst rl=readline.createInterface({input:process.stdin});\nrl.on('line',line=>{const c=JSON.parse(line); if(c.type==='prompt'){const text=process.cwd().endsWith('vault-a')?'reply-A':'reply-B'; const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n'); emit({type:'agent_start'}); emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}}); emit({type:'message_end',message:{role:'assistant',stopReason:'stop'}}); emit({type:'agent_settled'});} else if(c.type==='get_session_stats'){process.stdout.write(JSON.stringify({type:'response',id:c.id,success:true,data:{}})+'\\n');}});\n`,
    )
    await chmod(rpc, 0o755)
    const pi = { ...PRESETS.find((preset) => preset.id === 'pi')!, command: { bin: rpc, args: [] } }
    await call(A, 'agent.harnessSave', { harness: pi })
    await call(B, 'agent.harnessSave', { harness: pi })
    const launchPi = async (remote: typeof A | typeof B) =>
      call(remote, 'agent.launch', {
        provider: 'pi',
        name: `${remote} reply`,
        prompt: 'answer',
        tools: 'none',
        keep: true,
      }) as Promise<{ ok: boolean; sessionId: string }>
    const piA = await launchPi(A)
    const piB = await launchPi(B)
    expect(piA.ok).toBe(true)
    expect(piB.ok).toBe(true)
    const settledReply = async (remote: typeof A | typeof B, session: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = (await call(remote, 'agent.reply', { session })) as {
          output: string | null
        }
        if (result.output !== null) return result
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`Pi reply did not settle for ${remote}`)
    }
    const replyA = await settledReply(A, piA.sessionId)
    const replyB = await settledReply(B, piB.sessionId)
    expect(replyA.output).toBe('reply-A')
    expect(replyB.output).toBe('reply-B')
    await expect(call(A, 'agent.reply', { session: piB.sessionId })).rejects.toThrow(/Pi run/)
    await expect(call(B, 'agent.reply', { session: piA.sessionId })).rejects.toThrow(/Pi run/)
    expect(
      adapters.run.mock.calls.some(([, args]) => args.includes('--dangerously-skip-permissions')),
    ).toBe(false)

    const settledTurns = async (remote: typeof A | typeof B, sessionId: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const turns = (await call(remote, 'agent.turns')) as { sessionId: string }[]
        if (turns.some((turn) => turn.sessionId === sessionId)) return turns
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`Pi turn log did not settle for ${remote}`)
    }
    const turnsA = await settledTurns(A, piA.sessionId)
    const turnsB = await settledTurns(B, piB.sessionId)
    expect(turnsA.map((turn) => turn.sessionId)).toContain('abc12345')
    expect(turnsB.map((turn) => turn.sessionId)).not.toContain('abc12345')
    await expect(call(A, 'agent.reply', { session: 'abc12345' })).rejects.toThrow(/Pi run/)
    await expect(
      call(B, 'agent.message', { session: 'deadbeef', text: 'wrong owner' }),
    ).rejects.toThrow()

    // Stop is dispatched to each activation's real Claude CLI adapter, not to
    // the displayed vault. Its command cwd and private config target are asserted.
    host.setDisplayed(B)
    expect(await call(A, 'agent.stop', { id: 'abc12345' })).toMatchObject({ ok: true })
    host.setDisplayed(A)
    expect(await call(B, 'agent.stop', { id: 'abc12345' })).toMatchObject({ ok: true })
    const stopCommands = adapters.run.mock.calls.filter(
      ([, args]) => args[0] === 'stop' && args[1] === 'abc12345',
    )
    expect(stopCommands.map(([, , opts]) => opts.cwd)).toEqual([roots[A], roots[B]])
    const stopConfigDirs = stopCommands.map(([, , opts]) => opts.env.CLAUDE_CONFIG_DIR)
    expect(stopConfigDirs[0]).toContain('fixture-a-')
    expect(stopConfigDirs[1]).toContain('fixture-b-')
    expect(stopConfigDirs[0]).not.toBe(stopConfigDirs[1])

    // Leaving A unregisters its HTTP routes and releases its channel. Restart
    // A creates fresh routes; B's activation and channel remain live.
    await host.stop(A)
    expect((await post(A, '/turn/start', '&job=abc12345', JSON.stringify(channelA))).status).toBe(
      404,
    )
    await expect(
      call(B, 'agent.message', { session: 'abc12345', text: 'B still live' }),
    ).resolves.toEqual({ ok: true })
    const channelA2 = await inbox('A2')
    await enter(A)
    expect((await post(A, '/session', '&job=abc12345', JSON.stringify(channelA2))).status).toBe(204)
    expect(
      (
        await post(
          A,
          '/statusline',
          '&job=abc12345',
          JSON.stringify({
            context_window: { used_percentage: 29 },
            model: { display_name: 'Model A2' },
          }),
        )
      ).status,
    ).toBe(204)
    host.setDisplayed(B)
    await expect(
      call(A, 'agent.message', { session: 'abc12345', text: 'message A2' }),
    ).resolves.toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received.A2.join('')).toContain('message A2')
    expect(received.A.join('')).not.toContain('message A2')
    const aLive = (await call(A, 'agent.sessions')) as {
      provider: string
      contextPercent?: number
      model?: string
    }[]
    const bLive = (await call(B, 'agent.sessions')) as {
      provider: string
      contextPercent?: number
      model?: string
    }[]
    expect(aLive.filter((session) => session.provider === 'claude')).toEqual([
      expect.objectContaining({ contextPercent: 29, model: 'Model A2' }),
    ])
    expect(bLive.filter((session) => session.provider === 'claude')).toEqual([
      expect.objectContaining({ contextPercent: 83, model: 'Model B' }),
    ])
    expect(bLive.find((session) => session.provider === 'pi')).toMatchObject({ provider: 'pi' })
    expect(
      adapters.run.mock.calls
        .filter(([, args]) => args[0] === 'agents')
        .map(([, , opts]) => opts.cwd),
    ).toContain(roots[A])

    // Keep B busy through the cross-vault assertions above so the real idle
    // recheck cannot release its turn during teardown. Then explicitly end it
    // and wait for the B-owned record before exercising the actual recheck.
    const baseB = execFileSync('git', ['-C', roots[B], 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const settledB = await post(B, '/turn/end', '&job=abc12345')
    expect(settledB.status).toBe(200)
    const bTurns = async () =>
      (await call(B, 'agent.turns')) as { sessionId: string; base: string }[]
    await vi.waitFor(async () => {
      expect((await bTurns()).find((turn) => turn.sessionId === 'abc12345')).toMatchObject({
        base: baseB,
      })
    })

    // A second turn is intentionally left to the listing's idle confirmation.
    // This crosses the production 1.1s recheck interval and waits on the
    // persisted record rather than sleeping or relying on host.stopAll.
    listingStatusB = 'idle'
    expect(
      (await post(B, '/turn/start', `&job=abc12345&pid=${process.pid}`, JSON.stringify(channelB)))
        .status,
    ).toBe(204)
    await writeFile(join(roots[B], 'idle-recheck.txt'), 'completed turn')
    execFileSync('git', ['-C', roots[B], 'add', 'idle-recheck.txt'])
    execFileSync('git', ['-C', roots[B], 'commit', '-qm', 'fixture turn work'])
    await call(B, 'agent.sessions')
    await vi.waitFor(
      async () => {
        expect((await bTurns()).filter((turn) => turn.sessionId === 'abc12345')).toHaveLength(2)
      },
      { timeout: 5_000, interval: 25 },
    )
  } finally {
    await host.stopAll()
    await Promise.all(
      inboxServers.map(async (server) => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }),
    )
    await Promise.all(inboxSockets.map((socket) => rm(socket, { force: true })))
    await Promise.all(inboxSockets.map((socket) => expect(access(socket)).rejects.toThrow()))
  }
})

it('persists concurrent provider turn reports through each activated vault route', async () => {
  const { host, enter, call, roots, setActive } = await rig(undefined, undefined, true)
  await enter(A)
  await enter(B)
  // Force each real background-session host to finish attaching to its vault
  // before driving the provider's registered hook routes.
  for (const remote of [A, B] as const) {
    setActive(remote)
    await call(remote, 'agent.sessions')
  }
  const jobs = ['a1234567']
  const routesFor = (remote: string) => adapters.routes.get(remote)!
  const report = (remote: string, path: string, job: string) => {
    const query = new URLSearchParams({ job })
    // The fake Claude process is not in a real listing, so identify the active
    // producer with this live test process just as a hook supplies its PID.
    if (path === '/turn/start') query.set('pid', String(process.pid))
    return routesFor(remote).get(path)!.handle(remote, query, '', new AbortController().signal)
  }
  for (const remote of [A, B] as const) {
    setActive(remote)
    await Promise.all(jobs.map((job) => report(remote, '/turn/start', job)))
  }
  const endings = await Promise.all(
    ([A, B] as const).flatMap((remote) => {
      setActive(remote)
      return jobs.map((job) => report(remote, '/turn/end', job))
    }),
  )
  expect(endings).toHaveLength(2)
  expect(endings.every((reply) => reply.status === 200)).toBe(true)

  const expected = expect.arrayContaining(
    jobs.map((job) => expect.objectContaining({ base: expect.any(String), sessionId: job })),
  )
  const aTurns = (await call(A, 'agent.turns')) as { base: string; sessionId: string }[]
  const bTurns = (await call(B, 'agent.turns')) as { base: string; sessionId: string }[]
  expect(aTurns).toHaveLength(1)
  expect(bTurns).toHaveLength(1)
  expect(aTurns).toEqual(expected)
  expect(bTurns).toEqual(expected)
  expect(aTurns.map((turn) => turn.base)).not.toEqual(bTurns.map((turn) => turn.base))
  expect(aTurns.every((turn) => jobs.includes(turn.sessionId))).toBe(true)
  expect(bTurns.every((turn) => jobs.includes(turn.sessionId))).toBe(true)
  await host.stop(A)
  await enter(A)
  expect(await call(A, 'agent.turns')).toEqual(aTurns)
  expect(await call(B, 'agent.turns')).toEqual(bTurns)
  expect(await openTurnLog(roots[A]).list()).toEqual(aTurns)
  expect(await openTurnLog(roots[B]).list()).toEqual(bTurns)
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
  const scheduleFile = join(roots[B], schedule.path)
  const scheduleText = await readFile(scheduleFile, 'utf8')
  await writeFile(scheduleFile, scheduleText.replace('Scheduled B', 'Changed scheduled B'))
  await expect(call(B, 'schedules.run', { schedule: schedule.path })).rejects.toThrow()
  const changedSchedule = (await call(B, 'schedules.list')) as {
    path: string
    fingerprint?: string
  }[]
  const changed = changedSchedule.find((entry) => entry.path === schedule.path)
  expect(changed?.fingerprint).toBeTruthy()
  await call(B, 'schedules.enable', {
    schedule: schedule.path,
    fingerprint: changed!.fingerprint,
  })
  await call(B, 'schedules.run', { schedule: schedule.path })
  const scheduled = adapters.run.mock.calls
    .filter(([, args]) => args.some((arg) => arg.includes('Changed scheduled B')))
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

it('closes the session watcher after activation failure and retries with one watcher', async () => {
  const { host, enter, registry } = await rig()
  vi.spyOn(registry, 'register').mockImplementationOnce(() => {
    throw new Error('registration adapter failed')
  })

  await enter(A)
  expect(host.failures(A).agent).toContain('registration adapter failed')
  expect(adapters.watchStarts).toBe(1)
  expect(adapters.watchCloses).toBe(1)

  await enter(A)
  expect(host.failures(A)).toEqual({})
  expect(adapters.watchStarts).toBe(2)
  expect(adapters.watchCloses).toBe(1)
  await host.stop(A)
  expect(adapters.watchCloses).toBe(2)
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
