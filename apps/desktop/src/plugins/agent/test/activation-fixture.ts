import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { createCoreServices, createUiReports } from '../../../main/capabilities/services'
import { emptyVaultSnapshot } from '@holi/shared'
import { scanVault } from '../../../main/vault/vault-store'
import { createMembersCache } from '../../../main/github/members-cache'
import { createPluginHost } from '../../../main/plugin-host/host'
import { createBridgeServer } from '../../../main/bridge/server'
import { automationsMain } from '../../automations/main/index'
import { holisMain } from '../../holis/main'
import type { RunOptions } from '../main/claude/cli'
import type { AgentRuntimeDeps, PtyProcess, StartArgs } from '../main/host/pty'
import { agentMain } from '../main/index'
import type { BridgeRoute, MainPlugin, PluginCtx } from '../../../main/plugin-api'

const adapters = vi.hoisted(() => ({
  version: vi.fn(() => 'test'),
  run: vi.fn<(bin: string, args: string[], opts: RunOptions) => Promise<string>>(),
  pty: [] as StartArgs[],
  terminals: [] as Array<{
    args: StartArgs
    writes: string[]
    sizes: Array<[number, number]>
    emit(data: string): void
  }>,
  backup: null as null | { source: string; entered: () => void; wait: Promise<void> },
  heldExit: null as null | { cwd: string; entered: () => void; wait: Promise<void> },
  historyRename: null as null | {
    source: string
    entered: () => void
    wait: Promise<void>
    error?: Error
  },
  writeGates: [] as {
    fragment: string
    entered: () => void
    wait: Promise<void>
    error?: Error
  }[],
  readGates: [] as { fragment: string; error: Error }[],
  removeGates: [] as {
    fragment: string
    entered?: () => void
    wait?: Promise<void>
    error?: Error
  }[],
  writeGateReleases: [] as (() => void)[],
  cleanupReleases: [] as (() => void)[],
  commitGates: [] as {
    root: string
    entered: () => void
    wait: Promise<void>
    error?: Error
  }[],
  contextRename: null as null | {
    destination: string
    entered: () => void
    wait: Promise<void>
    error?: Error
  },
  exitObserved: null as null | { cwd: string; entered: () => void },
  routes: new Map<string, Map<string, BridgeRoute>>(),
  watchers: new Set<import('node:fs').FSWatcher>(),
  watchStarts: 0,
  watchCloses: 0,
  watchCloseFailure: null as { error: Error; watch: number } | null,
  headGate: null as null | { root: string; entered: () => void; wait: Promise<void> },
  heldSocket: null as null | {
    path: string
    socket: {
      listeners: Map<string, ((...args: unknown[]) => void)[]>
      sent: string[]
      destroyed: number
      on(event: string, listener: (...args: unknown[]) => void): unknown
      end(data: string): void
      destroy(): void
      emit(event: string, ...args: unknown[]): void
    }
  },
}))
export { adapters }

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const path = String(args[0])
      const index = adapters.readGates.findIndex((gate) => path.includes(gate.fragment))
      if (index >= 0) throw adapters.readGates.splice(index, 1)[0]!.error
      return fs.readFile(...args)
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      const path = String(args[0])
      const index = adapters.removeGates.findIndex((gate) => path.includes(gate.fragment))
      if (index >= 0) {
        const [gate] = adapters.removeGates.splice(index, 1)
        gate!.entered?.()
        await gate!.wait
        if (gate!.error !== undefined) throw gate!.error
      }
      return fs.rm(...args)
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const path = String(args[0])
      const index = adapters.writeGates.findIndex((gate) => path.includes(gate.fragment))
      if (index >= 0) {
        const [gate] = adapters.writeGates.splice(index, 1)
        gate!.entered()
        await gate!.wait
        if (gate!.error !== undefined) throw gate!.error
      }
      return fs.writeFile(...args)
    },
    appendFile: async (...args: Parameters<typeof fs.appendFile>) => {
      const path = String(args[0])
      const index = adapters.writeGates.findIndex((gate) => path.includes(gate.fragment))
      if (index >= 0) {
        const [gate] = adapters.writeGates.splice(index, 1)
        gate!.entered()
        await gate!.wait
        if (gate!.error !== undefined) throw gate!.error
      }
      return fs.appendFile(...args)
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      const contextHold = adapters.contextRename
      if (contextHold !== null && args[1] === contextHold.destination) {
        adapters.contextRename = null
        contextHold.entered()
        await contextHold.wait
        if (contextHold.error !== undefined) throw contextHold.error
      }
      const hold = adapters.historyRename
      if (hold !== null && args[1] === hold.source) {
        adapters.historyRename = null
        hold.entered()
        await hold.wait
        if (hold.error !== undefined) throw hold.error
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

vi.mock('node:net', async (original) => {
  const net = await original<typeof import('node:net')>()
  return {
    ...net,
    createConnection: (...args: Parameters<typeof net.createConnection>) => {
      const held = adapters.heldSocket
      if (held !== null && args[0] === held.path) return held.socket
      return net.createConnection(...args)
    },
  }
})

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    watch: (...args: Parameters<typeof fs.watch>) => {
      const ordinal = ++adapters.watchStarts
      const watcher = fs.watch(...args)
      adapters.watchers.add(watcher)
      const close = watcher.close.bind(watcher)
      watcher.close = () => {
        adapters.watchers.delete(watcher)
        adapters.watchCloses++
        close()
        const failure = adapters.watchCloseFailure
        if (failure?.watch === ordinal) {
          adapters.watchCloseFailure = null
          throw failure.error
        }
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
      constructor(deps: AgentRuntimeDeps = {}) {
        let args: StartArgs
        let output: ((data: string) => void) | undefined
        let exited: ((event: { exitCode: number }) => void) | undefined
        let physical: Promise<void> | undefined
        const writes: string[] = []
        const sizes: Array<[number, number]> = []
        const native: PtyProcess = {
          pid: 424_200 + adapters.pty.length,
          onData: (cb) => {
            output = cb
          },
          onExit: (cb) => {
            exited = cb
          },
          write: (data) => {
            writes.push(data)
          },
          resize: (cols, rows) => {
            sizes.push([cols, rows])
          },
          kill: () => {
            exited?.({ exitCode: 0 })
          },
        }
        super({
          ...deps,
          spawnPty: (bin, argv, options) => {
            args = {
              bin,
              args: argv,
              cwd: options.cwd,
              env: options.env,
              cols: options.cols,
              rows: options.rows,
            }
            adapters.pty.push(args)
            adapters.terminals.push({ args, writes, sizes, emit: (data) => output?.(data) })
            return native
          },
          probePid: () => 'alive',
          superviseGroup: () => ({
            drain: () =>
              (physical ??= Promise.resolve().then(async () => {
                const hold = adapters.heldExit
                if (hold !== null && args.cwd === hold.cwd) {
                  adapters.heldExit = null
                  hold.entered()
                  await hold.wait
                }
                const observed = adapters.exitObserved
                if (observed !== null && args.cwd === observed.cwd) observed.entered()
                exited?.({ exitCode: 0 })
              })),
          }),
        })
      }
    },
  }
})

export const A = 'fixture/a'
export const B = 'fixture/b'
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
  adapters.terminals.length = 0
  adapters.backup = null
  adapters.heldExit = null
  adapters.historyRename = null
  adapters.writeGates.length = 0
  adapters.writeGateReleases.length = 0
  adapters.cleanupReleases.length = 0
  adapters.commitGates.length = 0
  adapters.readGates.length = 0
  adapters.removeGates.length = 0
  adapters.contextRename = null
  adapters.exitObserved = null
  adapters.routes.clear()
  adapters.watchStarts = 0
  adapters.watchCloses = 0
  adapters.watchCloseFailure = null
  adapters.headGate = null
  adapters.heldSocket = null
})
afterEach(async () => {
  for (const release of [...adapters.cleanupReleases, ...adapters.writeGateReleases]) release()
  for (const gate of adapters.commitGates) gate.wait.catch(() => {})
  try {
    await Promise.all(stops.splice(0).map((stop) => stop()))
  } finally {
    for (const watcher of adapters.watchers) watcher.close()
    if (vi.isFakeTimers()) {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
    vi.restoreAllMocks()
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  }
})

export async function tempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), prefix))
}

export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

export function nestedErrors(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(nestedErrors) : [error]
}

export async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error(`Timed out waiting for ${path}`)
}

export async function waitForGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Pi fixture process ${pid} is still alive`)
}

async function commit(root: string): Promise<string> {
  execFileSync('git', ['-C', root, 'add', '-A'])
  const gateIndex = adapters.commitGates.findIndex((gate) => gate.root === root)
  if (gateIndex >= 0) {
    const [gate] = adapters.commitGates.splice(gateIndex, 1)
    gate!.entered()
    await gate!.wait
    if (gate!.error !== undefined) throw gate!.error
  }
  const staged = spawnSync('git', ['-C', root, 'diff', '--cached', '--quiet'], {
    stdio: 'ignore',
  })
  if (staged.error !== undefined) throw staged.error
  if (staged.status === 1)
    execFileSync('git', ['-C', root, 'commit', '-qm', 'agent revert'], { stdio: 'ignore' })
  else if (staged.status !== 0) throw new Error(`git diff failed with status ${staged.status}`)
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

export async function rig(
  userData?: string,
  holdAgentDisposer?: { entered: () => void; wait: Promise<void> },
  liveContext = false,
  lifecycle?: {
    plugins?: MainPlugin[]
    context?: (ctx: PluginCtx) => void
    holdAutomationsDisposer?: { entered: () => void; wait: Promise<void>; turnEnded?: () => void }
    agentDisposerStarted?: () => void
    retainedContexts?: boolean
    realSnapshots?: boolean
  },
) {
  userData ??= await tempDirectory('h674-agent-')
  dirs.push(userData)
  const roots = { [A]: join(userData, 'vault-a'), [B]: join(userData, 'vault-b') }
  for (const root of Object.values(roots)) {
    await mkdir(join(root, '.holi/settings'), { recursive: true })
    await writeFile(
      join(root, '.holi/settings/plugins.yaml'),
      'plugins:\n  automations: true\n  holis: true\n',
    )
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
  const notifications: unknown[] = []
  const navigations: { plugin: string; remote: string; name: string; payload: unknown }[] = []
  const listeners = new Map<string, Set<(message: unknown) => void>>()
  const syncHolds = new Map<string, number>()
  const pause = (remote: string) => syncHolds.set(remote, 1)
  const resume = (remote: string) => syncHolds.set(remote, 0)
  const machineToken = 'holi-573-repair3-machine-token'
  const bridge = createBridgeServer({
    log: () => {},
    cli: {
      dispatch: (call) => capabilities.dispatch(call),
      commands: (remote) => registry.commands(remote),
      rootFor: async (remote) => roots[remote as keyof typeof roots] ?? null,
      machine: {
        token: () => machineToken,
        resolveTarget: async (selector) => {
          const root = roots[selector as keyof typeof roots]
          return root === undefined || selector === null
            ? null
            : { remote: selector, root, live: true }
        },
      },
    },
  })
  await bridge.start()
  let activeRemote: typeof A | typeof B | null = null
  const registry = createCapabilityRegistry()
  const activateAgent = agentMain.activate!
  const agentPlugin = {
    ...agentMain,
    async activate(ctx: PluginCtx) {
      lifecycle?.context?.(ctx)
      const dispose = await activateAgent(ctx)
      if (dispose === undefined) throw new Error('Agent activation did not return a disposer.')
      if (holdAgentDisposer === undefined && lifecycle?.agentDisposerStarted === undefined)
        return dispose
      return async () => {
        lifecycle?.agentDisposerStarted?.()
        await dispose()
        if (holdAgentDisposer !== undefined) {
          holdAgentDisposer.entered()
          await holdAgentDisposer.wait
        }
      }
    },
  }
  const automationsPlugin = {
    ...automationsMain,
    async activate(ctx: PluginCtx) {
      const dispose = await automationsMain.activate?.(ctx)
      const turnEndObserver = lifecycle?.holdAutomationsDisposer?.turnEnded
        ? ctx.hear('agent', 'turn-end', lifecycle.holdAutomationsDisposer.turnEnded)
        : undefined
      if (dispose === undefined) {
        turnEndObserver?.()
        throw new Error('Automations activation did not return a disposer.')
      }
      if (lifecycle?.holdAutomationsDisposer === undefined) return dispose
      return async () => {
        await dispose()
        turnEndObserver?.()
        lifecycle.holdAutomationsDisposer!.entered()
        await lifecycle.holdAutomationsDisposer!.wait
      }
    },
  }
  const host = createPluginHost({
    plugins: [agentPlugin, automationsPlugin, holisMain, ...(lifecycle?.plugins ?? [])],
    registry,
    userData,
    coreSeeds: [],
    active: () => {
      if (!liveContext || activeRemote === null) return null
      const remote = activeRemote
      const root = roots[remote]
      return {
        remote,
        root,
        pause: () => pause(remote),
        resume: () => resume(remote),
        drainSync: async () => {},
        repo: {
          head: async () => {
            const gate = adapters.headGate
            if (gate !== null && gate.root === root) {
              adapters.headGate = null
              gate.entered()
              await gate.wait
            }
            return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
              encoding: 'utf8',
            }).trim()
          },
        },
        commitNow: async () => {
          execFileSync('git', ['-C', root, 'add', '-A'])
          execFileSync('git', ['-C', root, 'commit', '-qm', 'agent revert'], { stdio: 'ignore' })
          return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim()
        },
      }
    },
    rootFor: async (remote) => roots[remote as keyof typeof roots] ?? null,
    events: {
      send: (_channel, event) => sent.push({ remote: event.remote, name: event.name }),
      listen: (channel, handler) => {
        const callbacks = listeners.get(channel) ?? new Set()
        callbacks.add(handler)
        listeners.set(channel, callbacks)
        return () => {
          callbacks.delete(handler)
        }
      },
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
    notify: (notice) => {
      notifications.push(notice)
      return false
    },
    navigate: (plugin, remote, name, payload) => {
      navigations.push({ plugin, remote, name, payload })
    },
    focused: () => false,
    call: async (remote, name, params, beforeInvoke, finalization) =>
      (
        await capabilities.dispatch(
          { door: 'ui', remote, name, params, beforeInvoke },
          finalization,
        )
      ).value,
  })
  const retainedRemotes = new Set<string>()
  const snapshots = { [A]: emptyVaultSnapshot(), [B]: emptyVaultSnapshot() }
  const reports = createUiReports()
  const core = createCoreServices({
    get: (remote) => {
      if (remote !== A && remote !== B) return null
      if (!(lifecycle?.retainedContexts ? retainedRemotes.has(remote) : activeRemote === remote))
        return null
      return {
        remote,
        root: roots[remote],
        syncState: () => ({ kind: 'up-to-date' as const }),
        deliverNow: async () => true,
        heldBack: () => [],
      }
    },
    members: createMembersCache(async () => []),
    reports,
  })
  const capabilities = createCapabilityHost({
    registry,
    rootFor: async (remote) => roots[remote as keyof typeof roots] ?? null,
    get: (remote) => {
      if (remote !== A && remote !== B) return null
      if (!(lifecycle?.retainedContexts ? retainedRemotes.has(remote) : activeRemote === remote))
        return null
      const root = roots[remote]
      return {
        remote,
        root,
        snapshot: () => (lifecycle?.realSnapshots ? snapshots[remote] : emptyVaultSnapshot()),
        refresh: async () => {
          if (!lifecycle?.realSnapshots) return emptyVaultSnapshot()
          snapshots[remote] = await scanVault(root, await host.scanClaimsFor(root))
          return snapshots[remote]
        },
        pause: () => pause(remote),
        resume: () => resume(remote),
        drainSync: async () => {},
        repo: {
          head: async () =>
            execFileSync('git', ['-C', roots[remote], 'rev-parse', 'HEAD'], {
              encoding: 'utf8',
            }).trim(),
        },
        commitNow: async () => commit(root),
      }
    },
    core,
    pluginEnabled: async (plugin, root, allowDrain) =>
      (await host.serving(root, allowDrain)).has(plugin),
    claims: (root) => host.scanClaimsFor(root),
  })
  const openVault = (remote: typeof A | typeof B) => ({
    remote,
    root: roots[remote],
    pause: () => pause(remote),
    resume: () => resume(remote),
    drainSync: async () => {},
    commitNow: async () => commit(roots[remote]),
    repo: {
      head: async () => {
        const gate = adapters.headGate
        if (gate !== null && gate.root === roots[remote]) {
          adapters.headGate = null
          gate.entered()
          await gate.wait
        }
        return execFileSync('git', ['-C', roots[remote], 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim()
      },
    },
  })
  const enter = (remote: typeof A | typeof B) => {
    if (liveContext) {
      activeRemote = remote
      if (lifecycle?.retainedContexts) retainedRemotes.add(remote)
      host.setDisplayed(remote)
    }
    const opened = host.reconcile(openVault(remote), 'open')
    return lifecycle?.realSnapshots
      ? opened.then(async () => {
          snapshots[remote] = await scanVault(
            roots[remote],
            await host.scanClaimsFor(roots[remote]),
          )
        })
      : opened
  }
  const replace = (remote: typeof A | typeof B) => host.reconcile(openVault(remote), 'open')
  const machineCall = (remote: typeof A | typeof B, ...args: string[]) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: bridge.port()!,
          path: '/cli',
          method: 'POST',
          headers: { 'x-holi-cli-token': machineToken },
        },
        (response) => {
          let body = ''
          response.on('data', (chunk) => {
            body += chunk
          })
          response.on('end', () => resolve({ status: response.statusCode!, body }))
        },
      )
      req.on('error', reject)
      req.end(
        new URLSearchParams([...args, '--vault', remote].map((arg) => ['argv', arg])).toString(),
      )
    })
  const setActive = (remote: typeof A | typeof B) => {
    activeRemote = remote
    host.setDisplayed(remote)
  }
  const call = async (remote: typeof A | typeof B, name: string, params: unknown = {}) =>
    (await capabilities.dispatch({ door: 'ui', remote, name, params })).value
  let failedDrainExpected = false
  stops.push(async () => {
    try {
      if (failedDrainExpected) await expect(host.stopAll()).rejects.toThrow('failed to stop')
      else await host.stopAll()
    } finally {
      await bridge.stop()
    }
  })
  const expectFailedDrain = () => {
    failedDrainExpected = true
  }
  return {
    host,
    enter,
    replace,
    reconcileSettings: (remote: typeof A | typeof B) =>
      host.reconcile(openVault(remote), 'settings'),
    call,
    capabilities,
    roots,
    userData,
    sent,
    notifications,
    navigations,
    sendAgent: (remote: string, name: string, payload: unknown) => {
      for (const callback of listeners.get('plugin:agent') ?? [])
        callback({ remote, name, payload })
    },
    syncHolds,
    setActive,
    stopRemote: async (remote: string) => {
      await host.stop(remote)
      retainedRemotes.delete(remote)
    },
    bridge,
    registry,
    expectFailedDrain,
    machineCall,
  }
}

export const harness = {
  id: 'integration-test',
  label: 'Integration test',
  command: { bin: 'integration-test', args: [] },
  prompt: { args: ['--prompt', '{prompt}'] },
  resume: { pick: ['--resume'], byId: ['--id', '{id}'] },
  env: { OWNER_TEST: 'shared' },
}
