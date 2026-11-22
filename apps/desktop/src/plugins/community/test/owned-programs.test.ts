import { ChildProcess } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer, Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  emptyVaultSnapshot,
  pluginPinPath,
  PLUGIN_COMMANDS_DIR,
  PLUGINS_FILE,
  PLUGINS_LOCAL_FILE,
} from '@holi/shared'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  readVaultSettings,
  spawnOwnedProgram,
  UnconfirmedOwnedProgramError,
  type CapabilityContext,
  type CapabilityTable,
  type OwnedCompletion,
  type PluginCtx,
} from '../../../main/plugin-api'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { createPluginHost, type OpenVault } from '../../../main/plugin-host/host'
import * as community from '../main/capabilities'
import { createChecks } from '../main/checks'
import * as fetch from '../main/fetch'
import { communityMain } from '../main/index'
import { communityOwner, reserveInstall } from '../main/owner'
import { runCheck, runSetup } from '../main/setup'
import type { Install } from '../main/store'
import { createSupervisor } from '../main/supervisor'

vi.mock('../../../main/plugin-api', async (actual) => ({
  ...(await actual<typeof import('../../../main/plugin-api')>()),
  spawnOwnedProgram: vi.fn(),
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const listeners = new Set<Server>()
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-ordinary-owned-'))
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
})
afterEach(async () => {
  await Promise.all([...listeners].map(closeListener))
  listeners.clear()
  Object.defineProperty(process, 'platform', platform)
  vi.mocked(spawnOwnedProgram).mockReset()
  vi.restoreAllMocks()
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function childFor({
  pipes = true,
  receipt = true,
  onSpawn,
}: {
  pipes?: boolean
  receipt?: boolean
  onSpawn?: (...args: Parameters<typeof spawnOwnedProgram>) => void
} = {}) {
  const proof = deferred<OwnedCompletion>()
  const spawned = deferred<void>()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const kill = vi.fn(() => true)
  const child = Object.assign(new ChildProcess(), {
    ...(pipes ? { stdout, stderr } : {}),
    ...(receipt ? { ownedCompletion: proof.promise } : {}),
    kill,
  })
  vi.mocked(spawnOwnedProgram).mockImplementationOnce((...args) => {
    onSpawn?.(...args)
    spawned.resolve()
    return child
  })
  const exit = (code: number | null) => {
    Object.defineProperty(child, 'exitCode', { value: code, configurable: true })
    child.emit('exit', code, null)
  }
  const eof = () => {
    stdout.end()
    stderr.end()
  }
  const close = (code: number | null) => {
    exit(code)
    eof()
    child.emit('close', code, null)
  }
  return { child, stdout, stderr, kill, proof, spawned: spawned.promise, exit, eof, close }
}

function pending<T>(promise: Promise<T>) {
  const settled = vi.fn()
  void promise.then(settled, settled)
  return async () => {
    for (let step = 0; step < 10; step++) await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
  }
}

const proofFailure = () =>
  new UnconfirmedOwnedProgramError(new Error('lost receipt'), { revoke: vi.fn() })

function setup() {
  const log = join(dir, 'setup.log')
  return {
    log,
    result: runSetup({ argv: ['install'], cwd: dir, logPath: log, onLine: vi.fn() }),
  }
}

test.each(['output', 'proof'] as const)(
  'setup joins %s first, then closes the log',
  async (first) => {
    const f = childFor()
    const { log, result } = setup()
    const stillPending = pending(result)
    await f.spawned
    f.stdout.write('partial')
    f.exit(0)
    if (first === 'output') f.close(0)
    else f.proof.resolve('empty')
    await stillPending()
    if (first === 'output') f.proof.resolve('empty')
    else f.eof()
    await expect(result).resolves.toBe(true)
    expect(await readFile(log, 'utf8')).toBe('partial')
  },
)

test('setup preserves native cause and lease plus first error without waiting for held output', async () => {
  const f = childFor()
  const { log, result } = setup()
  const stillPending = pending(result)
  await f.spawned
  const first = new Error('first error')
  f.child.emit('error', first)
  f.child.emit('error', new Error('late error'))
  await stillPending()
  const failure = proofFailure()
  f.proof.reject(failure)
  await expect(result).rejects.toMatchObject({
    cause: failure.cause,
    lease: failure.lease,
    commandError: first,
  })
  expect(await readFile(log, 'utf8')).toContain('Could not confirm')
  f.close(0)
})

test.each(['nonzero', 'not-started', 'destroyed'] as const)(
  'setup treats %s as a known failure',
  async (kind) => {
    const f = childFor()
    const { result } = setup()
    await f.spawned
    if (kind === 'not-started') {
      f.proof.resolve('not-started')
      f.child.emit('error', new Error('no such command'))
      f.close(null)
    } else {
      f.proof.resolve('empty')
      if (kind === 'destroyed') f.stdout.destroy()
      f.close(kind === 'nonzero' ? 2 : 0)
    }
    await expect(result).resolves.toBe(false)
  },
)

test.each(['timeout', 'abort'] as const)(
  'check %s waits for EMPTY even after close',
  async (stop) => {
    vi.useFakeTimers()
    const f = childFor({ pipes: false })
    const abort = new AbortController()
    const result = runCheck({ argv: ['check'], cwd: dir, timeoutMs: 10, signal: abort.signal })
    const stillPending = pending(result)
    await f.spawned
    if (stop === 'timeout') await vi.advanceTimersByTimeAsync(10)
    else abort.abort()
    expect(f.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    f.close(0)
    await stillPending()
    f.proof.resolve('empty')
    await expect(result).resolves.toBe(false)
  },
)

test.each(['missing', 'rejected'] as const)(
  'check %s proof survives forget and stop',
  async (kind) => {
    const f = childFor({ pipes: false, receipt: kind !== 'missing' })
    const checks = createChecks()
    const check = { run: ['check'], hint: 'not ready' }
    const run = () => checks.run(dir, 'sample', check, dir)
    const answer = run()
    void answer.catch(() => {})
    const forgetting = checks.forget(dir, 'sample')
    void forgetting.catch(() => {})
    expect(run()).toBe(answer)
    f.close(0)
    const failure = proofFailure()
    if (kind === 'rejected') f.proof.reject(failure)
    const error = await answer.catch((err: unknown) => err)
    expect(error).toBeInstanceOf(UnconfirmedOwnedProgramError)
    if (kind === 'rejected') expect(error).toBe(failure)
    await expect(forgetting).rejects.toBe(error)
    await expect(checks.forget(dir, 'sample')).rejects.toBe(error)
    await expect(run()).rejects.toBe(error)
    const stopped = checks.stop()
    expect(checks.stop()).toBe(stopped)
    await expect(stopped).rejects.toBe(error)
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(1)
  },
)

async function listen(server: Server, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}
const closeListener = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()))

async function freePort() {
  const server = createServer()
  await listen(server, 0)
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no test port')
  await closeListener(server)
  return addr.port
}

/** Hold the real selector's listen probe after it closes the candidate socket. */
function holdNextPortPick() {
  const picked = deferred<number>()
  const release = deferred<void>()
  const close = Server.prototype.close
  vi.spyOn(Server.prototype, 'close').mockImplementationOnce(function (this: Server, callback) {
    const address = this.address()
    if (!address || typeof address === 'string') throw new Error('no probe port')
    return close.call(this, (err) => {
      picked.resolve(address.port)
      void release.promise.then(() => callback?.(err))
    })
  })
  return { picked: picked.promise, release: release.resolve }
}

test('check and serve observe the real Windows no-helper planning failure', async () => {
  const actual = await vi.importActual<typeof import('../../../main/plugin-api')>(
    '../../../main/plugin-api',
  )
  // The shared planner rejects NUL before it can create a helper, even on Windows.
  vi.mocked(spawnOwnedProgram).mockImplementation(actual.spawnOwnedProgram)
  await expect(runCheck({ argv: ['check', '\0'], cwd: dir })).resolves.toBe(false)
  const supervisor = createSupervisor({
    firstPort: await freePort(),
    onState() {},
    frameOrigin: () => () => {},
  })
  await expect(
    supervisor.acquire('key', { cwd: dir, argv: () => ['serve', '\0'], env: () => ({}) }),
  ).rejects.toThrow(/cannot contain NUL/)
  expect(supervisor.state('key')).toBeNull()
  await expect(supervisor.dispose()).resolves.toBeUndefined()
})

test('serve immediately unframes, retains failed key and port, and leaves another Vault independent', async () => {
  const firstPort = await freePort()
  const frames = new Set<string>()
  const a = childFor()
  const supervisor = createSupervisor({
    firstPort,
    onState() {},
    frameOrigin(origin) {
      frames.add(origin)
      return () => void frames.delete(origin)
    },
  })
  const sockets: Server[] = []
  const spec = {
    cwd: dir,
    argv(port: number) {
      const server = createServer((socket) => socket.end())
      sockets.push(server)
      server.listen(port, '127.0.0.1')
      return ['serve']
    },
    env: () => ({}),
  }
  try {
    const lease = await supervisor.acquire('a\0sample\0page', spec)
    expect(frames.size).toBe(1)
    await closeListener(sockets[0]!)
    a.exit(0)
    expect(frames.size).toBe(0)
    const release = lease.release()
    const stillPending = pending(release)
    await stillPending()
    const failure = proofFailure()
    a.proof.reject(failure) // Both streams still held open.
    await expect(release).rejects.toBe(failure)
    await expect(lease.release()).rejects.toBe(failure)
    await expect(supervisor.acquire('a\0sample\0page', spec)).rejects.toBe(failure)

    const b = childFor()
    const other = await supervisor.acquire('b\0sample\0page', spec)
    expect(other.port).not.toBe(lease.port)
    const closingB = other.release()
    b.close(0)
    await pending(closingB)()
    b.proof.resolve('empty')
    await closingB
    await expect(supervisor.stopAll()).rejects.toBe(failure)
    const disposed = supervisor.dispose()
    expect(supervisor.dispose()).toBe(disposed)
    await expect(disposed).rejects.toBe(failure)
    expect(supervisor.state('a\0sample\0page')).toMatchObject({ state: 'failed' })
  } finally {
    await Promise.all(sockets.map(closeListener))
    a.close(0)
  }
})

test.each(['known', 'unknown'] as const)('startup timeout joins %s teardown', async (kind) => {
  const f = childFor()
  const supervisor = createSupervisor({
    firstPort: await freePort(),
    readyTimeoutMs: 0,
    onState() {},
    frameOrigin: () => () => {},
  })
  const spec = { cwd: dir, argv: () => ['serve'], env: () => ({}) }
  const start = supervisor.acquire('key', spec)
  const stillPending = pending(start)
  await f.spawned
  expect(f.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  f.close(1)
  await stillPending()
  if (kind === 'known') {
    f.proof.resolve('empty')
    await expect(start).rejects.toThrow(/did not answer/)
    await expect(supervisor.dispose()).resolves.toBeUndefined()
    expect(supervisor.state('key')).toBeNull()
  } else {
    const failure = proofFailure()
    f.proof.reject(failure)
    await expect(start).rejects.toBe(failure)
    await expect(supervisor.dispose()).rejects.toBe(failure)
  }
})

async function installation(command: 'setup' | 'check') {
  const userData = join(dir, 'data')
  const owner = communityOwner({ userData })
  const root = join(dir, 'vault')
  const plugin = join(dir, 'folder')
  const commit = 'a'.repeat(40)
  const manifest = {
    id: 'sample',
    name: 'Sample',
    version: '1.0.0',
    // Setup/check ownership tests still need a valid installable plugin manifest.
    opens: ['*.md'],
    serve: ['serve', '{port}'],
    ...(command === 'check'
      ? { check: { run: ['check'], hint: 'not ready' } }
      : { setup: ['install'] }),
  }
  await mkdir(join(root, '.holi/settings'), { recursive: true })
  await mkdir(plugin)
  await writeFile(join(plugin, 'holi-plugin.json'), JSON.stringify(manifest))
  await writeFile(
    join(root, '.holi/settings/plugins.yaml'),
    'plugins:\n  community: true\n  sample: true\n',
  )
  const install = {
    id: manifest.id,
    manifest,
    source: { kind: 'release', repo: 'owner/release', path: '', tag: 'v1.0.0', commit } as const,
    setup: command === 'check' ? ('ok' as const) : ('none' as const),
  }
  await owner.store.put(install)
  const activate = () => {
    const checks = createChecks()
    const attachment = owner.attach(root, 'owner/vault', {
      emit() {},
      frameOrigin: () => () => {},
      forgetCheck: (id) => checks.forget(root, id),
    })
    attachment.signal.addEventListener('abort', () => void checks.stop(), { once: true })
    const caps = community.communityCapabilities({
      ...owner,
      checks,
      scratch: dir,
      context: { root, remote: 'owner/vault' },
      signal: attachment.signal,
      live: attachment.isLive,
      run: (work) => attachment.run(work),
      git: { url: () => '', token: () => null },
      token: () => null,
      firstPartyIds: () => [],
      bridgeScript: () => null,
      emit() {},
      searchPath: () => '',
    })
    const ctx = { root, remote: 'owner/vault' } as CapabilityContext
    return {
      ctx,
      caps,
      checks,
      check: () => caps['community.check'].run(ctx, { id: 'sample' }),
      refresh: () =>
        community.runChecks(
          root,
          { ...owner, checks, signal: attachment.signal },
          { passive: true },
        ),
      close: () => attachment.close(() => checks.stop()),
    }
  }
  return { owner, install, commit, plugin, activate }
}

test.each(['setup', 'check'] as const)(
  'unconfirmed %s fences replacement and removal after attachment close',
  async (command) => {
    const h = await installation(command)
    const a = h.activate()
    if (command === 'setup') {
      await expect(a.caps['community.setup'].run(a.ctx, { id: 'sample' })).rejects.toThrow(/agreed/)
      expect(spawnOwnedProgram).not.toHaveBeenCalled()
    }
    await a.caps['community.consent'].run(a.ctx, { id: 'sample', commit: h.commit })
    const f = childFor({ pipes: command === 'setup' })
    const running = a.caps[`community.${command}`].run(a.ctx, { id: 'sample' })
    void running.catch(() => {})
    await f.spawned
    const closing = a.close()
    void closing.catch(() => {})
    expect(a.close()).toBe(closing)
    f.close(0)
    const failure = proofFailure()
    f.proof.reject(failure)
    await expect(running).rejects.toBe(failure)
    await expect(closing).rejects.toBe(failure)

    const b = h.activate()
    await expect(b.caps['community.installFolder'].run(b.ctx, { folder: h.plugin })).rejects.toBe(
      failure,
    )
    await expect(b.caps['community.remove'].run(b.ctx, { id: 'sample' })).rejects.toBe(failure)
    expect(await h.owner.store.get('sample')).toMatchObject({
      source: h.install.source,
      setup: command === 'setup' ? 'failed' : 'ok',
    })
    expect(await h.owner.consent.has('sample', h.commit)).toBe(true)
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(1)
    await b.close()
  },
)

test('attachment close drains sibling servers and runs cleanup after a proof failure', async () => {
  const owner = communityOwner({ userData: join(dir, 'data') })
  const emit = vi.fn()
  const adapters = { emit, frameOrigin: () => () => {} }
  const a = owner.attach(dir, 'owner/vault', adapters)
  const first = childFor()
  const second = childFor()
  const spec = { cwd: dir, argv: () => ['serve'], env: () => ({}) }
  const starts = Promise.allSettled([
    owner.supervisor.acquire(`${dir}\0sample\0first`, spec),
    owner.supervisor.acquire(`${dir}\0sample\0second`, spec),
  ])
  await Promise.all([first.spawned, second.spawned])
  const cleanup = vi.fn(async () => {})
  const closing = a.close(cleanup)
  const stillClosing = pending(closing)
  const failure = proofFailure()
  const events = emit.mock.calls.length
  first.proof.reject(failure)
  await stillClosing()
  expect(() => owner.attach(dir, 'owner/vault', adapters)).toThrow(/already active/)
  expect(cleanup).not.toHaveBeenCalled()
  second.close(0)
  second.proof.resolve('empty')
  await expect(closing).rejects.toBe(failure)
  expect(cleanup).toHaveBeenCalledOnce()
  await starts

  const replacement = owner.attach(dir, 'owner/vault', adapters)
  await expect(replacement.close(async () => {})).rejects.toBe(failure)
  expect(emit).toHaveBeenCalledTimes(events)
  first.close(0)
})

function servingChild(readiness?: Promise<void>, onSpawn?: () => void) {
  const socket = createServer((client) => client.end())
  listeners.add(socket)
  const f = childFor({
    onSpawn: (_bin, _args, options) => {
      onSpawn?.()
      const start = () => socket.listen(Number(options.env?.HOLI_PORT), '127.0.0.1')
      if (readiness) void readiness.then(start)
      else start()
    },
  })
  return {
    ...f,
    async end() {
      await closeListener(socket)
      listeners.delete(socket)
      f.close(0)
    },
  }
}

test('supervisor disposal fences queued readmission until the old Windows row joins', async () => {
  const supervisor = createSupervisor({
    firstPort: await freePort(),
    onState() {},
    frameOrigin: () => () => {},
  })
  const spec = {
    cwd: dir,
    argv: () => ['serve'],
    env: (port: number) => ({ HOLI_PORT: String(port) }),
  }
  const old = servingChild()
  await supervisor.acquire('key', spec)
  await old.end()
  const readmit = vi.fn(async (resume) => resume(spec).ready)
  const queued = supervisor.acquire('key', spec, readmit)
  const stopping = supervisor.dispose()
  const stillStopping = pending(stopping)
  await expect(queued).rejects.toThrow(/closed/)
  await stillStopping()
  old.proof.resolve('empty')
  await stopping
  expect(readmit).not.toHaveBeenCalled()
  expect(spawnOwnedProgram).toHaveBeenCalledTimes(1)
  await supervisor.dispose()
})

async function ownedVault(userData: string, name: string, ids: string[]) {
  const root = join(dir, name)
  const remote = `owner/${name}`
  await mkdir(join(root, '.holi/settings'), { recursive: true })
  await writeFile(
    join(root, PLUGINS_FILE),
    `plugins:\n  community: true\n${ids.map((id) => `  ${id}: true\n`).join('')}`,
  )
  const registry = createCapabilityRegistry()
  let unregister!: () => void
  const host = createCapabilityHost({
    registry,
    rootFor: async (target) => (target === remote ? root : null),
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async (id, target) =>
      (await readVaultSettings(target)).plugins.vault[id] === true,
    claims: async () => [],
  })
  let onSnapshot!: (snapshot: unknown) => void
  const emit = vi.fn()
  const dispose = await communityMain.activate!({
    userData,
    root,
    remote,
    githubToken: () => null,
    register: (namespaces: readonly string[], caps: CapabilityTable) => {
      unregister = registry.register(namespaces, caps, 'community', remote)
      return unregister
    },
    emit,
    frameOrigin: () => () => {},
    onSnapshot: (callback: typeof onSnapshot) => {
      onSnapshot = callback
      return () => {}
    },
  } as unknown as PluginCtx)
  type Caps = ReturnType<typeof community.communityCapabilities>
  const call = async <K extends keyof Caps>(name: K, params: Parameters<Caps[K]['run']>[1]) => {
    const { value } = await host.dispatch({ door: 'ui', name, remote, params })
    return value as Awaited<ReturnType<Caps[K]['run']>>
  }
  return {
    root,
    emit,
    snapshot: (updatedAt: number) => onSnapshot({ files: [{ path: PLUGINS_FILE, updatedAt }] }),
    acquire: (id: string) => call('community.acquire', { path: `${id}.md` }),
    release: async (lease: string) => await call('community.release', { lease }),
    remove: async (id: string) => await call('community.remove', { id }),
    installFolder: (folder: string) => call('community.installFolder', { folder }),
    check: (id: string) => call('community.check', { id }),
    verb: (id: string) =>
      host.dispatch({ door: 'cli', remote, name: 'plugin.run', params: { argv: [id, 'run'] } }),
    consent: (id: string, commit: string) => call('community.consent', { id, commit }),
    setup: (id: string) => call('community.setup', { id }),
    list: () => call('community.list', {}),
    dispose: async () => {
      try {
        await dispose?.()
      } finally {
        unregister()
      }
    },
  }
}

function serveInstall(id: string): Install {
  return {
    id,
    manifest: { id, name: id, version: '1.0.0', opens: [`${id}.md`], serve: [id, '{port}'] },
    source: { kind: 'dev', folder: dir },
    setup: 'none',
  }
}

// Observe admission onto an already-ending Windows row, rather than assuming
// the capability reached it after an arbitrary number of event-loop turns.
async function queuedAcquire(
  owner: ReturnType<typeof communityOwner>,
  vault: Awaited<ReturnType<typeof ownedVault>>,
) {
  const admitted = deferred<void>()
  const retrying = deferred<void>()
  const acquire = owner.supervisor.acquire.bind(owner.supervisor)
  const spy = vi.spyOn(owner.supervisor, 'acquire').mockImplementationOnce((key, spec, readmit) => {
    const result = acquire(key, spec, (resume, signal) => {
      retrying.resolve()
      return readmit!(resume, signal)
    })
    admitted.resolve()
    return result
  })
  const queued = vault.acquire('sample')
  void queued.catch(() => {})
  await admitted.promise
  spy.mockRestore()
  return { queued, retrying: retrying.promise }
}

test.each(['held EMPTY', 'readmission queued'] as const)(
  'community.release cancels the exact old lease retry with %s',
  async (phase) => {
    const userData = join(dir, 'data')
    const owner = communityOwner({ userData })
    const { install, commit } = await releaseInstall(owner, 'sample')
    const a = await ownedVault(userData, 'a', ['sample'])
    await expect(a.acquire('sample')).rejects.toThrow(/needs-consent/)
    await a.consent(install.id, commit)
    const old = servingChild()
    const lease = await a.acquire('sample')
    await old.end()
    const { queued, retrying } = await queuedAcquire(owner, a)
    await pending(queued)()

    const gate = deferred<void>()
    try {
      if (phase === 'readmission queued') {
        const entered = deferred<void>()
        void owner.admit(async () => {
          entered.resolve()
          await gate.promise
        })
        await entered.promise
        old.proof.resolve('empty')
        await retrying
      }
      const releasing = a.release(lease.lease)
      await expect(queued).rejects.toThrow(/released/)
      if (phase === 'held EMPTY') await pending(releasing)()
      old.proof.resolve('empty')
      await releasing
    } finally {
      gate.resolve()
    }
    await owner.admit(async () => {})
    await a.dispose()
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(1)
  },
)

test('a stale community lease cannot cancel a replacement instance or another vault', async () => {
  const userData = join(dir, 'data')
  const owner = communityOwner({ userData })
  await owner.store.put(serveInstall('sample'))
  await owner.store.put(serveInstall('other'))
  const a = await ownedVault(userData, 'a', ['sample'])
  const b = await ownedVault(userData, 'b', ['sample', 'other'])
  const old = servingChild()
  const lease = await a.acquire('sample')
  await old.end()
  old.proof.resolve('empty')

  const replacement = servingChild()
  const live = await a.acquire('sample')
  const beside = servingChild()
  const sibling = await b.acquire('sample')
  const unrelated = servingChild()
  const other = await b.acquire('other')
  await replacement.end()
  const { queued } = await queuedAcquire(owner, a)
  await a.release(lease.lease)
  await pending(queued)()
  expect(beside.kill).not.toHaveBeenCalled()
  expect(unrelated.kill).not.toHaveBeenCalled()

  const next = servingChild()
  replacement.proof.resolve('empty')
  const retry = await queued
  for (const [child, vault, lease] of [
    [next, a, retry],
    [beside, b, sibling],
    [unrelated, b, other],
  ] as const) {
    await child.end()
    child.proof.resolve('empty')
    await vault.release(lease.lease)
  }
  await a.release(live.lease)
  await a.dispose()
  await b.dispose()
  expect(spawnOwnedProgram).toHaveBeenCalledTimes(5)
})

async function releaseInstall(
  owner: ReturnType<typeof communityOwner>,
  id: string,
  commit = 'a'.repeat(40),
) {
  const install: Install = {
    ...serveInstall(id),
    source: { kind: 'release', repo: `owner/${id}`, path: '', tag: 'v1.0.0', commit },
    setup: 'ok',
  }
  const checkout = owner.store.releaseDir(id, commit)
  await mkdir(checkout, { recursive: true })
  const marker = join(checkout, 'code.txt')
  await writeFile(marker, commit)
  await owner.store.put(install)
  return { install, commit, marker }
}

test.each([
  { change: 'vault off', denial: /no plugin opens/ },
  { change: 'local off', denial: /no plugin opens/ },
  { change: 'pin', denial: /pin-differs/ },
  { change: 'compatible pin edit', denial: /changed while starting/ },
  { change: 'served file', denial: /changed while starting/ },
  { change: 'consent', denial: /needs-consent/ },
] as const)(
  'community.acquire does not spawn after a port wait ($change)',
  async ({ change, denial }) => {
    const userData = join(dir, 'data')
    const owner = communityOwner({ userData })
    const { install, commit } = await releaseInstall(owner, 'sample')
    await owner.consent.grant(install.id, commit)
    await owner.store.put(serveInstall('healthy'))
    // Observe where the actual spawn runs, not just where authorization returns.
    const admit = owner.admit.bind(owner)
    let admitted = false
    vi.spyOn(owner, 'admit').mockImplementation((work) =>
      admit(async () => {
        admitted = true
        try {
          return await work()
        } finally {
          admitted = false
        }
      }),
    )
    const a = await ownedVault(userData, 'a', ['sample'])
    const b = await ownedVault(userData, 'b', ['healthy'])
    const pin = { ...install.manifest, repo: 'owner/sample', path: '', commit }
    const pinPath = join(a.root, pluginPinPath('sample'))
    await mkdir(dirname(pinPath), { recursive: true })
    await writeFile(pinPath, JSON.stringify(pin))
    const first = join(a.root, 'first.md')
    const served = join(a.root, 'sample.md')
    await writeFile(first, 'first')
    await symlink(first, served, 'file')
    await owner.notifyMutation()

    const gate = holdNextPortPick()
    const stale = a.acquire('sample')
    void stale.catch(() => {})
    const picked = await gate.picked
    const spawnAdmissions: boolean[] = []
    const child = servingChild(undefined, () => spawnAdmissions.push(admitted))
    const spawn = vi.mocked(spawnOwnedProgram).mockImplementation((bin) => {
      throw new Error(`unexpected spawn: ${bin}`)
    })
    try {
      const key = `${a.root}\0sample\0sample.md`
      expect(owner.supervisor.state(key)?.state).toBe('starting')
      await owner.admit(async () => {
        switch (change) {
          case 'vault off':
            await writeFile(
              join(a.root, PLUGINS_FILE),
              'plugins:\n  community: true\n  sample: false\n',
            )
            break
          case 'local off':
            await writeFile(join(a.root, PLUGINS_LOCAL_FILE), 'plugins:\n  sample: false\n')
            break
          case 'pin':
            await writeFile(pinPath, JSON.stringify({ ...pin, commit: 'b'.repeat(40) }))
            break
          case 'compatible pin edit':
            await writeFile(pinPath, JSON.stringify({ ...pin, description: 'new pin text' }))
            break
          case 'served file': {
            const second = join(a.root, 'second.md')
            await writeFile(second, 'second')
            await rm(served)
            await symlink(second, served, 'file')
            break
          }
          case 'consent':
            await owner.consent.forget('sample')
        }
      })
      const acquiringHealthy = b.acquire('healthy')
      void acquiringHealthy.catch(() => {})
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
      const healthy = await acquiringHealthy
      expect(healthy.port).not.toBe(picked)
      expect(owner.supervisor.state(key)?.state).toBe('starting')
      expect(spawn.mock.calls.map(([bin]) => bin)).toEqual(['healthy'])
      expect(spawnAdmissions).toEqual([true])
      gate.release()
      await expect(stale).rejects.toThrow(denial)
      expect(owner.supervisor.state(key)).toBeNull()
      expect(spawn.mock.calls.map(([bin]) => bin)).toEqual(['healthy'])
      await child.end()
      child.proof.resolve('empty')
      await b.release(healthy.lease)
    } finally {
      gate.release()
      if (child.child.exitCode === null) await child.end()
      child.proof.resolve('empty')
      await Promise.all([a.dispose(), b.dispose()])
    }
  },
)

test.each([
  { change: 'off', denial: /no plugin opens/ },
  { change: 'pin', denial: /pin-differs/ },
  { change: 'compatible pin edit', denial: /changed while starting/ },
  { change: 'served file', denial: /changed while starting/ },
] as const)(
  'community.acquire reauthorizes after readiness ($change)',
  async ({ change, denial }) => {
    const userData = join(dir, 'data')
    const owner = communityOwner({ userData })
    const { install, commit } = await releaseInstall(owner, 'sample')
    await owner.consent.grant(install.id, commit)
    const a = await ownedVault(userData, 'a', ['sample'])
    const b = await ownedVault(userData, 'b', ['sample'])
    const key = `${a.root}\0sample\0sample.md`
    const before = await owner.store.get('sample')
    const pin = { ...install.manifest, repo: 'owner/sample', path: '', commit }
    const pinPath = join(a.root, pluginPinPath('sample'))
    await mkdir(dirname(pinPath), { recursive: true })
    await writeFile(pinPath, JSON.stringify(pin))
    const first = join(a.root, 'first.md')
    const served = join(a.root, 'sample.md')
    await writeFile(first, 'first')
    await symlink(first, served, 'file')
    await owner.notifyMutation()

    const ready = deferred<void>()
    const child = servingChild(ready.promise)
    const acquire = owner.supervisor.acquire.bind(owner.supervisor)
    const release = vi.fn()
    vi.spyOn(owner.supervisor, 'acquire').mockImplementationOnce(async (...args) => {
      const lease = await acquire(...args)
      return {
        ...lease,
        release: () => {
          release()
          return lease.release()
        },
      }
    })
    const stale = a.acquire('sample')
    const stillAcquiring = pending(stale)
    await child.spawned
    const [, , launch] = vi.mocked(spawnOwnedProgram).mock.lastCall!
    expect(launch.env?.HOLI_FILE).toBe(await realpath(first))
    const port = Number(launch.env?.HOLI_PORT)
    expect(owner.supervisor.state(key)?.state).toBe('starting')
    if (change === 'off') {
      await writeFile(join(a.root, PLUGINS_FILE), 'plugins:\n  community: true\n  sample: false\n')
      await expect(a.acquire('sample')).rejects.toThrow(denial)
    } else if (change === 'pin') {
      await writeFile(pinPath, JSON.stringify({ ...pin, commit: 'b'.repeat(40) }))
      await expect(a.acquire('sample')).rejects.toThrow(denial)
    } else if (change === 'compatible pin edit') {
      await writeFile(pinPath, JSON.stringify({ ...pin, description: 'new pin text' }))
    } else {
      const second = join(a.root, 'second.md')
      await writeFile(second, 'second')
      await rm(served)
      await symlink(second, served, 'file')
      // A new dispatch cannot attach its changed grant to the original row.
      await expect(a.acquire('sample')).rejects.toThrow(/server authorization changed/)
    }
    expect(await owner.store.get('sample')).toEqual(before)
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(1)
    ready.resolve()
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM'))
    expect(release).toHaveBeenCalledTimes(1)
    await child.end()
    await stillAcquiring()

    // A's native receipt is held, but not its owner admission queue or B's port.
    const sibling = servingChild()
    const healthy = await b.acquire('sample')
    expect(healthy.port).not.toBe(port)
    expect(sibling.kill).not.toHaveBeenCalled()
    await stillAcquiring()
    if (change === 'served file') {
      const failure = proofFailure()
      child.proof.reject(failure)
      await expect(stale).rejects.toMatchObject({
        name: failure.name,
        cause: failure.cause,
        lease: failure.lease,
        commandError: { message: expect.stringMatching(denial) },
      })
      expect(owner.supervisor.state(key)).toMatchObject({
        state: 'failed',
        message: String(failure),
      })
      await expect(a.acquire('sample')).rejects.toBe(failure)
      await expect(a.dispose()).rejects.toBe(failure)
    } else {
      child.proof.resolve('empty')
      await expect(stale).rejects.toThrow(denial)
      expect(owner.supervisor.state(key)).toBeNull()
      await a.dispose()
    }
    expect(release).toHaveBeenCalledTimes(1)
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(2)
    await sibling.end()
    sibling.proof.resolve('empty')
    await b.release(healthy.lease)
    await b.dispose()
  },
)

test.each(['empty', 'unknown', 'replaced', 'closed'] as const)(
  'remove fences only its install during a held receipt (%s)',
  async (end) => {
    const userData = join(dir, 'data')
    const owner = communityOwner({ userData })
    const oldInstall = await releaseInstall(owner, 'sample')
    const otherInstall = await releaseInstall(owner, 'other')
    const a = await ownedVault(userData, 'a', ['sample'])
    const b = await ownedVault(userData, 'b', ['sample', 'other'])
    await a.consent('sample', oldInstall.commit)
    await b.consent('other', otherInstall.commit)
    const old = servingChild()
    const oldLease = await a.acquire('sample')
    await old.end()
    const { queued } = await queuedAcquire(owner, a)
    const removing = a.remove('sample')
    const stillRemoving = pending(removing)
    await expect(queued).rejects.toThrow(/installation changed/)
    await expect(b.acquire('sample')).rejects.toThrow(/installation is changing/)

    const healthy = servingChild()
    const healthyLease = await b.acquire('other')
    await stillRemoving()
    expect(await readFile(oldInstall.marker, 'utf8')).toBe(oldInstall.commit)
    expect(await owner.store.get('sample')).toEqual(oldInstall.install)
    expect(healthy.kill).not.toHaveBeenCalled()
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(2)

    const failure = proofFailure()
    const replacement =
      end === 'replaced'
        ? await owner.admit(() => releaseInstall(owner, 'sample', 'b'.repeat(40)))
        : null
    const closing = end === 'closed' ? a.dispose() : null
    if (end === 'unknown') old.proof.reject(failure)
    else old.proof.resolve('empty')
    if (end === 'empty') {
      await removing
      expect(await owner.store.get('sample')).toBeNull()
      await expect(readFile(oldInstall.marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } else if (end === 'unknown') {
      await expect(removing).rejects.toBe(failure)
      await expect(a.release(oldLease.lease)).rejects.toBe(failure)
      await expect(a.release(oldLease.lease)).rejects.toBe(failure)
      await expect(b.acquire('sample')).rejects.toBe(failure)
      await expect(b.remove('sample')).rejects.toBe(failure)
    } else {
      await expect(removing).rejects.toThrow(end === 'closed' ? /closed/ : /changed during cleanup/)
      expect(await readFile(oldInstall.marker, 'utf8')).toBe(oldInstall.commit)
      expect(await owner.consent.has('sample', oldInstall.commit)).toBe(true)
      if (replacement) {
        expect(await owner.store.get('sample')).toEqual(replacement.install)
        expect(await readFile(replacement.marker, 'utf8')).toBe(replacement.commit)
        await expect(b.acquire('sample')).rejects.toThrow(/needs-consent/)
      } else {
        // An aborted removal must not leave a transient reservation behind.
        await b.consent('sample', oldInstall.commit)
      }
    }
    const healthyAgain = await b.acquire('other')
    expect(healthyAgain.port).toBe(healthyLease.port)
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(2)
    await b.release(healthyAgain.lease)
    await healthy.end()
    healthy.proof.resolve('empty')
    await b.release(healthyLease.lease)
    if (end === 'unknown') await expect(a.dispose()).rejects.toBe(failure)
    else await (closing ?? a.dispose())
    await b.dispose()
  },
)

test('setup checks release consent again after the server drain', async () => {
  const userData = join(dir, 'data')
  const owner = communityOwner({ userData })
  const { install, commit } = await releaseInstall(owner, 'sample')
  await owner.store.put({ ...install, manifest: { ...install.manifest, setup: ['setup'] } })
  const a = await ownedVault(userData, 'a', ['sample'])
  await a.consent('sample', commit)
  const old = servingChild()
  const lease = await a.acquire('sample')
  await old.end()
  const { queued } = await queuedAcquire(owner, a)

  const setup = a.setup('sample')
  const stillSettingUp = pending(setup)
  await expect(queued).rejects.toThrow(/installation changed/)
  await owner.admit(() => owner.consent.forget('sample'))
  await stillSettingUp()
  old.proof.resolve('empty')
  await expect(setup).rejects.toThrow(/nobody here has agreed/)
  expect(spawnOwnedProgram).toHaveBeenCalledTimes(1)
  expect(await owner.store.get('sample')).toMatchObject({ setup: 'ok' })
  // A failed revalidation also releases its transient reservation.
  await a.consent('sample', commit)
  await a.release(lease.lease)
  await a.dispose()
})

test.each(['close', 'remove'] as const)(
  '%s revokes a queued acquire before its old Windows row proves EMPTY',
  async (action) => {
    const userData = join(dir, 'data')
    const owner = communityOwner({ userData })
    await owner.store.put(serveInstall('sample'))
    await owner.store.put(serveInstall('other'))
    const a = await ownedVault(userData, 'a', ['sample'])
    const b = await ownedVault(userData, 'b', ['sample', 'other'])
    const old = servingChild()
    const oldLease = await a.acquire('sample')
    await old.end()
    const release = a.release(oldLease.lease)
    const { queued } = await queuedAcquire(owner, a)
    await pending(queued)()

    // This other Vault can serve the same install while the first row drains.
    const sibling = servingChild()
    const siblingLease = await b.acquire('sample')
    expect(siblingLease.port).not.toBe(oldLease.port)
    const closing = action === 'close' ? a.dispose() : a.remove('sample')
    const stillClosing = pending(closing)
    await expect(queued).rejects.toThrow(action === 'close' ? /closed/ : /installation changed/)
    await stillClosing()
    expect(await owner.store.get('sample')).not.toBeNull()
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(2)

    old.proof.resolve('empty')
    await release
    if (action === 'remove') {
      // Removal cannot change the install until *both* admitted rows join.
      await stillClosing()
      expect(await owner.store.get('sample')).not.toBeNull()
      await sibling.end()
      sibling.proof.resolve('empty')
    }
    await closing
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(2)
    if (action === 'remove') {
      expect(await owner.store.get('sample')).toBeNull()
      await a.dispose()
    } else {
      expect(owner.supervisor.state(`${b.root}\0sample\0sample.md`)).toMatchObject({
        state: 'running',
      })
      await sibling.end()
      sibling.proof.resolve('empty')
    }
    await b.release(siblingLease.lease)

    const other = servingChild()
    const lease = await b.acquire('other')
    await other.end()
    other.proof.resolve('empty')
    await b.release(lease.lease)
    await b.dispose()
  },
)

test.each(['changed command', 'revoked consent', 'unchanged'] as const)(
  'EMPTY readmits under the owner and rechecks %s before spawn',
  async (change) => {
    const userData = join(dir, 'data')
    const owner = communityOwner({ userData })
    const commit = 'a'.repeat(40)
    const install: Install = {
      ...serveInstall('sample'),
      source: { kind: 'release', repo: 'owner/sample', path: '', tag: 'v1.0.0', commit },
      setup: 'ok',
    }
    await owner.store.put(install)
    const a = await ownedVault(userData, 'a', ['sample'])
    await a.consent(install.id, commit)
    const old = servingChild()
    const lease = await a.acquire('sample')
    await old.end()
    const { queued } = await queuedAcquire(owner, a)
    const gate = deferred<void>()
    const entered = deferred<void>()
    const busy = owner.admit(async () => {
      entered.resolve()
      await gate.promise
      if (change === 'changed command')
        await owner.store.put({
          ...install,
          manifest: { ...install.manifest, serve: ['replacement', '{port}'] },
        })
      if (change === 'revoked consent') await owner.consent.forget(install.id)
    })
    await entered.promise
    old.proof.resolve('empty')
    await pending(queued)()
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(1)
    const fresh = change === 'unchanged' ? servingChild() : null
    gate.resolve()
    await busy
    if (fresh) {
      const replacement = await queued
      expect(spawnOwnedProgram).toHaveBeenCalledTimes(2)
      await fresh.end()
      fresh.proof.resolve('empty')
      await a.release(replacement.lease)
    } else {
      await expect(queued).rejects.toThrow(
        change === 'revoked consent' ? /needs-consent/ : /changed while starting/,
      )
      expect(spawnOwnedProgram).toHaveBeenCalledTimes(1)
    }
    await a.release(lease.lease)
    await a.dispose()
  },
)

function checkInstall(id: string, version: number): Install {
  const base = serveInstall(id)
  return {
    ...base,
    manifest: {
      ...base.manifest,
      version: `${version}.0.0`,
      check: { run: [`${id}-check-${version}`], hint: `${id} hint ${version}` },
    },
  }
}

test.each(['empty', 'unknown'] as const)(
  'verbs and explicit checks honor the install fence during removal (%s)',
  async (receipt) => {
    const userData = join(dir, 'data')
    const owner = communityOwner({ userData })
    const { install, commit, marker } = await releaseInstall(owner, 'sample')
    const manifest = (id: string, version: number) => ({
      ...checkInstall(id, version).manifest,
      cli: { run: [`${id}-cli-${version}`], verbs: { run: 'Run' } },
    })
    await owner.store.put({ ...install, manifest: manifest('sample', 1) })
    await owner.consent.grant('sample', commit)
    await owner.store.put({ ...checkInstall('healthy', 1), manifest: manifest('healthy', 1) })
    const original = childFor({ pipes: false })
    const a = await ownedVault(userData, 'a', ['sample'])
    const checks = [original]
    const vaults = [a]
    try {
      await original.spawned
      await expect(a.verb('sample')).resolves.toMatchObject({
        run: { cwd: dirname(marker), argv: ['sample-cli-1', 'run'] },
      })
      const removing = a.remove('sample')
      const stillRemoving = pending(removing)
      await vi.waitFor(() => expect(original.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL'))
      original.close(0)

      const codeDir = vi.spyOn(owner.store, 'codeDir')
      const conflict = { code: 'CONFLICT', message: 'sample installation is changing' }
      await expect(a.verb('sample')).rejects.toMatchObject(conflict)
      await expect(a.check('sample')).rejects.toMatchObject(conflict)
      expect(codeDir).not.toHaveBeenCalled()
      expect(spawnOwnedProgram).toHaveBeenCalledTimes(1)
      expect(await readFile(marker, 'utf8')).toBe(commit)

      // Setup's targeted refresh is not an explicit request, even with a fresh check.
      await expect(
        community.runChecks(
          a.root,
          { ...owner, checks: createChecks() },
          { intent: 'refresh', ids: ['sample'], fresh: true },
        ),
      ).resolves.toBe(false)

      const healthy = childFor({ pipes: false })
      checks.push(healthy)
      const b = await ownedVault(userData, 'b', ['sample', 'healthy'])
      vaults.push(b)
      await healthy.spawned
      expect(vi.mocked(spawnOwnedProgram).mock.lastCall?.[0]).toBe('healthy-check-1')
      healthy.close(0)
      healthy.proof.resolve('empty')
      await vi.waitFor(() => expect(b.emit).toHaveBeenCalledWith('owner/b', 'check', null))
      expect(await b.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'sample', check: null }),
          expect.objectContaining({ id: 'healthy', check: { ok: true } }),
        ]),
      )
      await expect(b.verb('healthy')).resolves.toMatchObject({
        run: { cwd: dir, argv: ['healthy-cli-1', 'run'] },
      })
      expect(codeDir.mock.calls.map(([item]) => item.id)).toEqual(['healthy', 'healthy'])
      expect(spawnOwnedProgram).toHaveBeenCalledTimes(2)
      await stillRemoving()
      await b.dispose()

      if (receipt === 'unknown') {
        const failure = proofFailure()
        original.proof.reject(failure)
        await expect(removing).rejects.toBe(failure)
        // A fresh attachment must see the install's original failure, not a
        // leftover CONFLICT or a normal row from its empty readiness cache.
        const sibling = await ownedVault(userData, 'sibling', ['sample'])
        vaults.push(sibling)
        await expect(sibling.verb('sample')).rejects.toBe(failure)
        await expect(sibling.check('sample')).rejects.toBe(failure)
        expect(await readFile(marker, 'utf8')).toBe(commit)
        expect(spawnOwnedProgram).toHaveBeenCalledTimes(2)
      } else {
        original.proof.resolve('empty')
        await removing
        await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        codeDir.mockClear()
        await expect(a.verb('sample')).rejects.toMatchObject({ code: 'NOT_FOUND' })
        await expect(a.check('sample')).rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(codeDir).not.toHaveBeenCalled()

        const folder = join(dir, 'replacement')
        await mkdir(folder)
        await writeFile(join(folder, 'holi-plugin.json'), JSON.stringify(manifest('sample', 2)))
        const localSettings = join(a.root, PLUGINS_LOCAL_FILE)
        await writeFile(localSettings, 'plugins:\n  sample: false\n')
        await a.installFolder(folder)
        await rm(localSettings)
        await expect(a.verb('sample')).resolves.toMatchObject({
          run: { cwd: folder, argv: ['sample-cli-2', 'run'] },
        })
        const fresh = childFor({ pipes: false })
        checks.push(fresh)
        const asking = a.check('sample')
        void asking.catch(() => {})
        await fresh.spawned
        expect(spawnOwnedProgram).toHaveBeenLastCalledWith(
          'sample-check-2',
          [],
          expect.objectContaining({ cwd: folder }),
        )
        fresh.close(0)
        fresh.proof.resolve('empty')
        await expect(asking).resolves.toMatchObject({
          install: { kind: 'dev', version: '2.0.0' },
          check: { ok: true },
        })
        expect(spawnOwnedProgram).toHaveBeenCalledTimes(3)
      }
    } finally {
      for (const check of checks) {
        if (check.child.exitCode === null) check.close(0)
        check.proof.resolve('empty')
      }
      await Promise.allSettled(vaults.map((vault) => vault.dispose()))
    }
  },
)

async function coreHostedCommunity(userData: string) {
  const roots = new Map<string, string>()
  const contexts = new Map<string, PluginCtx>()
  const registry = createCapabilityRegistry()
  const blockerEntered = deferred<void>()
  const releaseBlocker = deferred<void>()
  const disposeCommunity = vi.fn()
  const rootFor = async (remote: string) => roots.get(remote) ?? null
  const idle = () => () => {}
  const host = createPluginHost({
    plugins: [
      {
        ...communityMain,
        async activate(ctx) {
          contexts.set(ctx.remote, ctx)
          const dispose = await communityMain.activate!(ctx)
          return async () => {
            disposeCommunity(ctx)
            await dispose?.()
          }
        },
      },
      {
        // Core stops dependents first. Hold this real host's disposal order
        // without substituting a signal or calling the community disposer.
        info: { id: 'hold-stop', label: 'Hold stop', default: true, requires: ['community'] },
        activate: (ctx) => async () => {
          if (ctx.remote !== 'owner/a') return
          blockerEntered.resolve()
          await releaseBlocker.promise
        },
      },
    ],
    registry,
    userData,
    coreSeeds: [],
    active: () => null,
    rootFor,
    events: { send() {}, listen: idle, liveRemote: () => null },
    openAppDoor: () => {
      throw new Error('unexpected app door')
    },
    route: idle,
    binDir: () => '',
    githubToken: () => null,
    frameOrigin: idle,
    notify: () => false,
    focused: () => false,
  })
  const caps = createCapabilityHost({
    registry,
    rootFor,
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async (id, root, allowDrain) => (await host.serving(root, allowDrain)).has(id),
    claims: async () => [],
  })
  const open = async (name: string, ids: string[]) => {
    const root = join(dir, name)
    const remote = `owner/${name}`
    roots.set(remote, root)
    await mkdir(join(root, '.holi/settings'), { recursive: true })
    await writeFile(
      join(root, PLUGINS_FILE),
      `plugins:\n  community: true\n${ids.map((id) => `  ${id}: true\n`).join('')}`,
    )
    const vault: OpenVault = {
      root,
      remote,
      pause() {},
      resume() {},
      drainSync: async () => {},
      commitNow: async () => null,
      repo: { head: async () => null },
    }
    const reopen = () => host.reconcile(vault, 'open')
    await reopen()
    return {
      root,
      remote,
      reopen,
      context: () => contexts.get(remote)!,
      acquire: async (id: string) =>
        (
          await caps.dispatch({
            door: 'ui',
            remote,
            name: 'community.acquire',
            params: { path: `${id}.md` },
          })
        ).value as { port: number; lease: string },
      snapshot(updatedAt: string) {
        host.snapshot(remote, {
          ...emptyVaultSnapshot(),
          files: [{ path: PLUGINS_FILE, updatedAt }],
        })
      },
    }
  }
  return { host, open, blockerEntered, releaseBlocker, disposeCommunity }
}

test.each(['empty', 'unknown'] as const)(
  'real host revocation fences queued checks and port picks before disposal (%s)',
  async (receipt) => {
    const userData = join(dir, 'data')
    const owner = communityOwner({ userData })
    await owner.store.put(serveInstall('sample'))
    await owner.store.put(serveInstall('prior'))
    const h = await coreHostedCommunity(userData)
    let gate: ReturnType<typeof holdNextPortPick> | undefined
    const releaseQueue = deferred<void>()
    const children: ReturnType<typeof servingChild>[] = []
    const checks: ReturnType<typeof childFor>[] = []
    const check = () => {
      const child = childFor({ pipes: false })
      checks.push(child)
      return child
    }
    const serve = () => {
      const child = servingChild()
      children.push(child)
      return child
    }
    vi.mocked(spawnOwnedProgram).mockImplementation(() => {
      throw new Error('unexpected launch')
    })
    try {
      const a = await h.open('a', ['sample', 'prior', 'readiness'])
      const b = await h.open('b', ['sample', 'readiness'])
      await owner.notifyMutation()
      const oldCtx = a.context()
      a.snapshot('before')
      const prior = serve()
      await a.acquire('prior')
      const sibling = serve()
      const beside = await b.acquire('sample')
      const siblingCtx = b.context()

      gate = holdNextPortPick()
      const stale = a.acquire('sample')
      void stale.catch(() => {})
      await gate.picked
      // Queue checks in both vaults without changing the grant for either server.
      const readiness = checkInstall('readiness', 1)
      await owner.admit(() =>
        owner.store.put({
          ...readiness,
          manifest: {
            ...readiness.manifest,
            check: { run: ['readiness-check-1', '{vault}'], hint: 'not ready' },
          },
        }),
      )
      const queueEntered = deferred<void>()
      void owner.admit(async () => {
        queueEntered.resolve()
        await releaseQueue.promise
      })
      await queueEntered.promise
      const refreshQueued = deferred<void>()
      const admit = owner.admit.bind(owner)
      const observeAdmission = vi.spyOn(owner, 'admit').mockImplementationOnce((work) => {
        refreshQueued.resolve()
        return admit(work)
      })
      a.snapshot('after')
      // Coalesces with A's snapshot refresh; gives the test a completion
      // barrier for it (and also refreshes the still-live B).
      const refreshing = owner.notifyMutation()
      await refreshQueued.promise
      observeAdmission.mockRestore()

      const stopping = h.host.stop(a.remote)
      void stopping.catch(() => {})
      await h.blockerEntered.promise
      expect(oldCtx.activationSignal.aborted).toBe(true)
      expect(siblingCtx.activationSignal.aborted).toBe(false)
      expect(h.disposeCommunity).not.toHaveBeenCalled()
      expect(prior.kill).not.toHaveBeenCalled()

      gate.release()
      await expect(stale).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'community attachment is closed',
      })
      // A denied launch retires without a helper or a synthetic receipt.
      expect(owner.supervisor.state(`${a.root}\0sample\0sample.md`)).toBeNull()
      expect(spawnOwnedProgram).toHaveBeenCalledTimes(2)
      const bCheck = check()
      releaseQueue.resolve()
      await bCheck.spawned
      bCheck.close(0)
      bCheck.proof.resolve('empty')
      await refreshing
      expect(vi.mocked(spawnOwnedProgram).mock.calls.map(([bin]) => bin)).toEqual([
        'prior',
        'sample',
        'readiness-check-1',
      ])
      expect(vi.mocked(spawnOwnedProgram).mock.lastCall?.[1]).toEqual([b.root])
      expect(h.disposeCommunity).not.toHaveBeenCalled()
      await expect(b.acquire('sample')).resolves.toMatchObject({ port: beside.port })
      expect(sibling.kill).not.toHaveBeenCalled()

      const stillStopping = pending(stopping)
      h.releaseBlocker.resolve()
      await vi.waitFor(() => expect(prior.kill).toHaveBeenCalledWith('SIGTERM'))
      await prior.end()
      await expect(b.acquire('sample')).resolves.toMatchObject({ port: beside.port })
      await stillStopping()
      if (receipt === 'unknown') {
        const failure = proofFailure()
        prior.proof.reject(failure)
        const result = await stopping.catch((error: unknown) => error)
        expect((result as AggregateError).errors[0].errors[0]).toBe(failure)
        await expect(a.reopen()).rejects.toBeInstanceOf(AggregateError)
        expect(a.context()).toBe(oldCtx)
      } else {
        prior.proof.resolve('empty')
        await stopping
        const aCheck = check()
        await a.reopen()
        expect(a.context()).not.toBe(oldCtx)
        expect(oldCtx.activationSignal.aborted).toBe(true)
        expect(a.context().activationSignal.aborted).toBe(false)
        await aCheck.spawned
        expect(vi.mocked(spawnOwnedProgram).mock.lastCall?.[1]).toEqual([a.root])
        aCheck.close(0)
        aCheck.proof.resolve('empty')
        const fresh = serve()
        const lease = await a.acquire('sample')
        expect(lease.port).not.toBe(beside.port)
        expect(vi.mocked(spawnOwnedProgram).mock.lastCall?.[2].env?.HOLI_VAULT_ROOT).toBe(a.root)
        await fresh.end()
        fresh.proof.resolve('empty')
      }
      expect(sibling.kill).not.toHaveBeenCalled()
      await expect(b.acquire('sample')).resolves.toMatchObject({ port: beside.port })
    } finally {
      gate?.release()
      releaseQueue.resolve()
      h.releaseBlocker.resolve()
      for (const child of checks) {
        if (child.child.exitCode === null) child.close(0)
        child.proof.resolve('empty')
      }
      for (const child of children) {
        if (child.child.exitCode === null) await child.end()
        child.proof.resolve('empty')
      }
      await h.host.stopAll().catch(() => {})
    }
  },
)

async function drainingReadiness() {
  const h = await installation('check')
  await h.owner.consent.grant('sample', h.commit)
  const a = h.activate()
  const original = childFor()
  // The injected owned child can hold output independently of its receipt.
  original.stdout.resume()
  original.stderr.resume()
  const initial = a.refresh()
  await original.spawned
  const refreshing = a.refresh()
  await vi.waitFor(() => expect(original.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL'))
  const run = vi.spyOn(a.checks, 'run')
  return { ...h, a, original, initial, refreshing, run }
}

test('explicit readiness drains stale work, then shares the current authorized check', async () => {
  const { a, owner, install, original, initial, refreshing, run } = await drainingReadiness()
  const first = a.check()
  const second = a.check()
  const stillAsking = [pending(first), pending(second)]
  const children = [original]
  const vaults: Awaited<ReturnType<typeof ownedVault>>[] = []
  try {
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    original.exit(0)
    for (const wait of stillAsking) await wait()
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(1)

    await owner.store.put(checkInstall('healthy', 1))
    const healthy = childFor({ pipes: false })
    children.push(healthy)
    const b = await ownedVault(join(dir, 'data'), 'b', ['healthy'])
    vaults.push(b)
    await healthy.spawned
    healthy.close(0)
    healthy.proof.resolve('empty')
    await vi.waitFor(() => expect(b.emit).toHaveBeenCalledWith('owner/b', 'check', null))
    for (const wait of stillAsking) await wait()

    // A changed release is authorized against the new pin and commit, not the
    // snapshot held when the explicit calls joined the first launch.
    const commit = 'b'.repeat(40)
    const { manifest } = checkInstall('sample', 2)
    const source = { ...install.source, tag: 'v2.0.0', commit }
    const pin = join(a.ctx.root, pluginPinPath('sample'))
    await owner.admit(async () => {
      await mkdir(dirname(pin), { recursive: true })
      await writeFile(pin, JSON.stringify({ ...manifest, repo: source.repo, path: '', commit }))
      await owner.store.put({ ...install, manifest, source })
      await owner.consent.grant('sample', commit)
    })
    original.proof.resolve('empty')
    for (const wait of stillAsking) await wait()
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(2)

    const retry = childFor({ pipes: false })
    children.push(retry)
    original.eof()
    await retry.spawned
    const command = [
      'sample-check-2',
      [],
      expect.objectContaining({ cwd: owner.store.releaseDir('sample', commit) }),
    ] as const
    expect(spawnOwnedProgram).toHaveBeenLastCalledWith(...command)
    // Both explicit calls and the refresh joined the same replacement. Invalidate
    // it again while its receipt is held; neither waiter may publish its answer.
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(5))
    const invalidatingAgain = a.refresh()
    await vi.waitFor(() => expect(retry.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL'))
    retry.close(0)
    for (const wait of stillAsking) await wait()
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(3)

    const current = childFor({ pipes: false })
    children.push(current)
    retry.proof.resolve('empty')
    await current.spawned
    expect(spawnOwnedProgram).toHaveBeenLastCalledWith(...command)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(8))
    for (const wait of stillAsking) await wait()
    current.close(0)
    current.proof.resolve('empty')
    const rows = await Promise.all([first, second])
    for (const row of rows)
      expect(row).toMatchObject({ pin: { commit }, install: { commit }, check: { ok: true } })
    await Promise.all([initial, refreshing, invalidatingAgain])
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(4)
  } finally {
    for (const child of children) {
      child.close(0)
      child.proof.resolve('empty')
    }
    await Promise.allSettled([a.close(), ...vaults.map((vault) => vault.dispose())])
  }
})

test.each([
  'vault off',
  'local off',
  'community off',
  'revoked consent',
  'activation closed',
  'reserved install',
  'unknown',
] as const)('explicit readiness reauthorizes after stale drain (%s)', async (change) => {
  const { a, owner, commit, original, initial, refreshing, run } = await drainingReadiness()
  const asking = a.check()
  const stillAsking = pending(asking)
  let reservation: ReturnType<typeof reserveInstall> | undefined
  try {
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    if (change === 'vault off' || change === 'community off')
      await writeFile(
        join(a.ctx.root, PLUGINS_FILE),
        `plugins:\n  community: ${change !== 'community off'}\n  sample: ${change !== 'vault off'}\n`,
      )
    if (change === 'local off')
      await writeFile(join(a.ctx.root, PLUGINS_LOCAL_FILE), 'plugins:\n  sample: false\n')
    if (change === 'revoked consent') await owner.consent.forget('sample')
    if (change === 'activation closed') void a.close().catch(() => {})
    if (change === 'reserved install')
      reservation = await owner.admit(async () => reserveInstall(owner.store, 'sample'))
    original.close(0)
    await stillAsking()

    if (change === 'unknown') {
      const failure = proofFailure()
      original.proof.reject(failure)
      await expect(asking).rejects.toBe(failure)
      await expect(a.check()).rejects.toBe(failure)
      await expect(a.close()).rejects.toBe(failure)
    } else {
      original.proof.resolve('empty')
      if (change === 'activation closed')
        await expect(asking).rejects.toMatchObject({ code: 'FORBIDDEN' })
      else if (change === 'reserved install')
        await expect(asking).rejects.toMatchObject({ code: 'CONFLICT' })
      else
        await expect(asking).resolves.toMatchObject({
          running: false,
          on: change !== 'vault off',
          status: change === 'revoked consent' ? 'needs-consent' : 'ready',
          install: { commit },
          check: null,
        })
    }
    await Promise.all([initial, refreshing])
    expect(a.checks.get(a.ctx.root, 'sample')).toBeNull()
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(1)
  } finally {
    reservation?.release()
    original.close(0)
    original.proof.resolve('empty')
    await a.close().catch(() => {})
  }
})

test('targeted readiness only inspects its pin and install, and forgets results when disabled', async () => {
  const owner = communityOwner({ userData: join(dir, 'data') })
  const root = join(dir, 'vault')
  const settings = join(root, PLUGINS_FILE)
  const target = 'sample'
  const ids = [target, ...Array.from({ length: 12 }, (_, i) => `plugin-${i}`)]
  const writeSettings = async (communityOn: boolean) => {
    await mkdir(dirname(settings), { recursive: true })
    await writeFile(settings, `plugins:\n  community: ${communityOn}\n  sample: true\n`)
  }
  await writeSettings(true)
  for (const id of ids) {
    const { install, commit } = await releaseInstall(owner, id)
    const { manifest } = checkInstall(id, 1)
    await owner.store.put({ ...install, manifest })
    await owner.consent.grant(id, commit)
    const pin = join(root, pluginPinPath(id))
    await mkdir(dirname(pin), { recursive: true })
    await writeFile(pin, JSON.stringify({ ...manifest, repo: `owner/${id}`, path: '', commit }))
  }
  const readPin = vi.spyOn(fetch, 'readBoundedRegularText')
  const listInstalls = vi.spyOn(owner.store, 'list')
  const getInstall = vi.spyOn(owner.store, 'get')
  const checks = createChecks()
  const deps = { ...owner, checks }
  const ask = (passive = false) =>
    community.runChecks(root, deps, { ids: [target], passive, fresh: true })
  const result = async () => {
    const child = childFor({ pipes: false })
    const asked = ask()
    await child.spawned
    child.close(0)
    child.proof.resolve('empty')
    await expect(asked).resolves.toBe(true)
    expect(checks.get(root, target)).toEqual({ ok: true })
  }
  await result()
  expect(listInstalls).not.toHaveBeenCalled()
  expect(getInstall.mock.calls).toEqual([[target]])
  expect(readPin.mock.calls.map(([path]) => path)).toEqual([join(root, pluginPinPath(target))])

  const localSettings = join(root, PLUGINS_LOCAL_FILE)
  await writeFile(localSettings, 'plugins:\n  sample: false\n')
  await expect(ask(true)).resolves.toBe(false)
  expect(checks.get(root, target)).toBeNull()
  expect(spawnOwnedProgram).toHaveBeenCalledTimes(1)
  await rm(localSettings)
  await result()

  await writeSettings(false)
  await expect(ask(true)).resolves.toBe(false)
  expect(checks.get(root, target)).toBeNull()
  expect(spawnOwnedProgram).toHaveBeenCalledTimes(2)
})

test('a disabled check drains outside admission while a healthy check starts', async () => {
  const owner = communityOwner({ userData: join(dir, 'data') })
  const root = join(dir, 'vault')
  const settings = join(root, PLUGINS_FILE)
  await mkdir(dirname(settings), { recursive: true })
  await writeFile(settings, 'plugins:\n  community: true\n  sample: true\n  healthy: true\n')
  await owner.store.put(checkInstall('sample', 1))
  await owner.store.put(checkInstall('healthy', 1))
  const checks = createChecks()
  const deps = { ...owner, checks }
  const original = childFor({ pipes: false })
  const prior = community.runChecks(root, deps, { ids: ['sample'] })
  void prior.catch(() => {})
  await original.spawned
  await writeFile(join(root, PLUGINS_LOCAL_FILE), 'plugins:\n  sample: false\n')
  const refreshed = community.runChecks(root, deps, { passive: true })
  const stillRefreshing = pending(refreshed)
  const healthy = childFor({ pipes: false })
  try {
    await vi.waitFor(() =>
      expect(spawnOwnedProgram).toHaveBeenLastCalledWith('healthy-check-1', [], expect.anything()),
    )
    expect(original.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    healthy.close(0)
    healthy.proof.resolve('empty')
    await stillRefreshing()
    original.close(0)
    const failure = proofFailure()
    original.proof.reject(failure)
    await expect(prior).rejects.toBe(failure)
    await expect(refreshed).resolves.toBe(true)
    expect(checks.get(root, 'sample')).toBeNull()
    expect(checks.get(root, 'healthy')).toEqual({ ok: true })
    expect(
      (await community.listPlugins(root, deps)).find(({ id }) => id === 'sample')?.check,
    ).toEqual({
      ok: false,
      hint: failure.message,
    })
    expect(spawnOwnedProgram).toHaveBeenCalledTimes(2)
  } finally {
    for (const child of [original, healthy]) {
      if (child.child.exitCode === null) child.close(0)
      child.proof.resolve('empty')
    }
    await checks.stop().catch(() => {})
  }
})

test.each(['unlink succeeds', 'unlink rejects'] as const)(
  'turning community off preserves the check proof while revoking commands (%s)',
  async (unlink) => {
    const userData = join(dir, 'data')
    const owner = communityOwner({ userData })
    const command = `holi-community-test-${process.pid}`
    const executable = join(dir, 'sample')
    await writeFile(executable, '#!/bin/sh\necho sample\n', { mode: 0o755 })
    const base = checkInstall('broken', 1)
    const broken = { ...base, manifest: { ...base.manifest, bin: { [command]: 'sample' } } }
    await owner.store.put(broken)
    await owner.store.put(checkInstall('healthy', 1))

    const original = childFor({ pipes: false })
    const a = await ownedVault(userData, 'a', ['broken'])
    await original.spawned
    const link = join(a.root, PLUGIN_COMMANDS_DIR, command)
    expect(await readlink(link)).toBe(await realpath(executable))
    await writeFile(join(a.root, PLUGINS_FILE), 'plugins:\n  community: false\n  broken: true\n')
    const unlinking = vi.spyOn(community, 'unlinkWhenOff')
    const secondary = new Error('unlink failed')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    if (unlink === 'unlink rejects') unlinking.mockRejectedValueOnce(secondary)

    const closing = a.dispose()
    const stillClosing = pending(closing)
    expect(original.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    original.close(0)
    await stillClosing()

    // The other vault can refresh even while A cannot prove its check drained.
    const healthy = childFor({ pipes: false })
    const b = await ownedVault(userData, 'b', ['healthy'])
    await healthy.spawned
    expect(vi.mocked(spawnOwnedProgram).mock.lastCall?.[0]).toBe('healthy-check-1')
    healthy.close(0)
    healthy.proof.resolve('empty')
    await vi.waitFor(() => expect(b.emit).toHaveBeenCalledWith('owner/b', 'check', null))
    await stillClosing()

    const failure = proofFailure()
    original.proof.reject(failure)
    await expect(closing).rejects.toBe(failure)
    expect(unlinking).toHaveBeenCalledExactlyOnceWith(a.root, expect.any(Array))
    if (unlink === 'unlink succeeds') {
      await expect(readlink(link)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect(log).toHaveBeenCalledWith('[community] commands:', secondary)
    }

    const refreshed = childFor({ pipes: false })
    const remove = b.remove('broken')
    void remove.catch(() => {})
    await refreshed.spawned
    expect(vi.mocked(spawnOwnedProgram).mock.lastCall?.[0]).toBe('healthy-check-1')
    refreshed.close(0)
    refreshed.proof.resolve('empty')
    await expect(remove).rejects.toBe(failure)
    expect(await owner.store.get('broken')).toEqual(broken)
    await b.dispose()
  },
)

test('passive snapshots refresh healthy checks while retaining another plugin’s proof failure', async () => {
  const userData = join(dir, 'data')
  const owner = communityOwner({ userData })
  await owner.store.put(checkInstall('broken', 1))
  await owner.store.put(checkInstall('healthy', 1))
  // Select fixtures by command: readiness checks of distinct plugins can start in either order.
  const broken = childFor({ pipes: false })
  const healthy = childFor({ pipes: false })
  const a = await ownedVault(userData, 'a', ['broken', 'healthy'])
  a.snapshot(1)
  await Promise.all([broken.spawned, healthy.spawned])
  const commands = vi.mocked(spawnOwnedProgram).mock.calls.map(([bin]) => bin)
  const [failed, passed] = commands[0] === 'broken-check-1' ? [broken, healthy] : [healthy, broken]
  const failure = proofFailure()
  failed.close(0)
  failed.proof.reject(failure)
  passed.close(0)
  passed.proof.resolve('empty')
  await owner.admit(async () => {})
  expect((await a.list()).find(({ id }) => id === 'healthy')?.check).toEqual({ ok: true })

  for (const version of [2, 3]) {
    await owner.admit(async () => {
      await owner.store.put(checkInstall('broken', version))
      await owner.store.put(checkInstall('healthy', version))
    })
    const check = childFor({ pipes: false })
    a.snapshot(version)
    await check.spawned
    expect(vi.mocked(spawnOwnedProgram).mock.lastCall?.[0]).toBe(`healthy-check-${version}`)
    check.close(version === 2 ? 1 : 0)
    check.proof.resolve('empty')
    await owner.admit(async () => {})
    const rows = await a.list()
    expect(rows.find(({ id }) => id === 'healthy')).toMatchObject({
      install: { version: `${version}.0.0` },
      check: version === 2 ? { ok: false, hint: 'healthy hint 2' } : { ok: true },
    })
    expect(rows.find(({ id }) => id === 'broken')?.check).toEqual({
      ok: false,
      hint: failure.message,
    })
    expect(a.emit.mock.calls.filter(([, name]) => name === 'check')).toHaveLength(version)
  }

  const elsewhere = childFor({ pipes: false })
  const b = await ownedVault(userData, 'b', ['healthy'])
  await elsewhere.spawned
  expect(vi.mocked(spawnOwnedProgram).mock.lastCall?.[0]).toBe('healthy-check-3')
  elsewhere.close(0)
  elsewhere.proof.resolve('empty')
  await owner.admit(async () => {})
  expect((await b.list()).find(({ id }) => id === 'healthy')?.check).toEqual({ ok: true })
  await b.dispose()

  const afterDeniedRemove = childFor({ pipes: false })
  const remove = a.remove('broken')
  void remove.catch(() => {})
  await afterDeniedRemove.spawned
  expect(vi.mocked(spawnOwnedProgram).mock.lastCall?.[0]).toBe('healthy-check-3')
  afterDeniedRemove.close(0)
  afterDeniedRemove.proof.resolve('empty')
  await expect(remove).rejects.toBe(failure)
  expect(await owner.store.get('broken')).toMatchObject({ manifest: { version: '3.0.0' } })
  await expect(a.dispose()).rejects.toBe(failure)
  expect(spawnOwnedProgram).toHaveBeenCalledTimes(6)
})
