import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import type { PluginEvent } from '../../../main/plugin-host/events'
import { createPluginHost } from '../../../main/plugin-host/host'
import { defaultProbePid } from '../../../main/process-group'
import type { SpawnPty } from '../main/host/pty'
import { agentScratchRoots } from '../main/host/scratch-roots'
import { agentMain } from '../main/index'
import { PRESETS } from '../main/harness/record'
import type { SessionSummary } from '../main/claude/listing'

const native = vi.hoisted(() => ({
  start: null as
    | null
    | ((
        kind: 'job' | 'fenced',
        bin: string,
        args: readonly string[],
        cwd: string,
        env: NodeJS.ProcessEnv,
      ) => ChildProcess),
  removals: [] as { path: string; done: Promise<void> }[],
  heldExit: null as null | { cwd: string; entered: () => void; wait: Promise<void> },
  heldConfigure: null as null | { root: string; entered: () => void; wait: Promise<void> },
  configured: [] as { root: string; outcome: 'resolved' | 'rejected'; dir?: string }[],
}))

vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  nativeTheme: { shouldUseDarkColors: false },
}))
vi.mock('../main/claude/cli', async (original) => {
  const cli = await original<typeof import('../main/claude/cli')>()
  return {
    ...cli,
    resolveClaudeBin: () => '/synthetic/claude',
    createClaudeCli: (deps: Parameters<typeof cli.createClaudeCli>[0]) =>
      cli.createClaudeCli({ ...deps, run: async () => '[]' }),
  }
})
// Delay only the provider adapter's configure seam, not the host or its
// cancellation checks. Successful releases still invoke Codex's real configure.
vi.mock('../main/codex', async (original) => {
  const codex = await original<typeof import('../main/codex')>()
  return {
    ...codex,
    codexProvider: (deps: Parameters<typeof codex.codexProvider>[0]) => {
      const provider = codex.codexProvider(deps)
      const configure = provider.configure
      return {
        ...provider,
        configure: async (vault: Parameters<typeof configure>[0]) => {
          try {
            const hold = native.heldConfigure
            if (hold !== null && hold.root === vault.root) {
              hold.entered()
              await hold.wait
            }
            const result = await configure(vault)
            native.configured.push({
              root: vault.root,
              outcome: 'resolved',
              ...(result === null ? {} : { dir: result.dir }),
            })
            return result
          } catch (err) {
            native.configured.push({ root: vault.root, outcome: 'rejected' })
            throw err
          }
        },
      }
    },
  }
})
// Deliberately collide job, fence and PTY session ids across activations.
// A random id must never be what protects one vault from another's sweep.
vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>()
  return {
    ...crypto,
    randomBytes: (size: number) => (size === 6 ? Buffer.alloc(6, 0x57) : crypto.randomBytes(size)),
  }
})
// Keep the real filesystem; record completion of asynchronous finalizer deletes
// so the fixture never removes its parent while a host is still writing to it.
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rm: (...args: Parameters<typeof fs.rm>) => {
      const done = fs.rm(...args)
      native.removals.push({ path: String(args[0]), done })
      return done
    },
  }
})
// Only native launch and the configure delay adapters vary. AgentRuntime, all four hosts,
// providers (including command construction/home preparation), dispatcher and
// plugin activation/teardown are production implementations.
vi.mock('../../../main/plugin-api', async (original) => {
  const api = await original<typeof import('../../../main/plugin-api')>()
  const defaultSpawnPty: SpawnPty = (bin, args, opts) => {
    const child = native.start!('fenced', bin, args, opts.cwd, opts.env)
    return {
      pid: child.pid!,
      onData: (cb) => {
        child.stdout!.on('data', (bytes: Buffer) => cb(bytes.toString()))
      },
      onExit: (cb) => {
        child.on('close', async (code) => {
          const hold = native.heldExit
          if (hold !== null && hold.cwd === opts.cwd) {
            native.heldExit = null
            hold.entered()
            await hold.wait
          }
          cb({ exitCode: code ?? -1 })
        })
      },
      write: (data) => {
        child.stdin!.write(data)
      },
      resize: () => {},
      kill: () => {
        child.kill()
      },
    }
  }
  return {
    ...api,
    defaultSpawnPty,
    spawnOwnedProgram: ((bin, args, opts) => {
      if (bin === process.execPath && args.includes('exec') && args.includes('--sandbox'))
        return native.start!('job', bin, args, String(opts.cwd), opts.env ?? {})
      return api.spawnOwnedProgram(bin, args, opts)
    }) as typeof api.spawnOwnedProgram,
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function createScratchFixture() {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'holi-scratch-activation-')))
  const roots = { 'fixture/a': join(userData, 'vault-a'), 'fixture/b': join(userData, 'vault-b') }
  type Remote = keyof typeof roots
  const A: Remote = 'fixture/a'
  const B: Remote = 'fixture/b'
  const children: {
    kind: 'job' | 'fenced'
    bin: string
    args: readonly string[]
    cwd: string
    home: string
    child: ChildProcess
    ready: Promise<void>
    closed: Promise<number | null>
    output: string
    errors: string
  }[] = []
  const fixture = fileURLToPath(new URL('./fixtures/scratch-provider.mjs', import.meta.url))
  native.removals.length = 0
  native.heldExit = null
  native.heldConfigure = null
  native.configured.length = 0
  const releases: (() => void)[] = []
  const holdExit = (cwd: string) => {
    const heldExit = deferred<void>()
    const exitEntered = deferred<void>()
    releases.push(heldExit.resolve)
    native.heldExit = { cwd, entered: exitEntered.resolve, wait: heldExit.promise }
    return { heldExit, exitEntered }
  }
  const holdConfigure = (remote: Remote) => {
    const gate = deferred<void>()
    const entered = deferred<void>()
    releases.push(gate.resolve)
    native.heldConfigure = { root: roots[remote], entered: entered.resolve, wait: gate.promise }
    return { gate, entered: entered.promise }
  }
  native.start = (kind, bin, args, cwd, env) => {
    // Never execute a real provider or inherit keys/config from this machine.
    expect(bin).toBe(process.execPath)
    expect(args).toContain(cwd)
    expect(env.CODEX_HOME).toBeTypeOf('string')
    // Include cwd in the command line, as Codex does, so the real startup
    // PID ownership check can identify this process if shared roots regress.
    const child = spawn(process.execPath, [fixture, kind, cwd], {
      cwd,
      env: { CODEX_HOME: env.CODEX_HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: kind === 'job' && process.platform !== 'win32',
    })
    const ready = deferred<void>()
    const closed = deferred<number | null>()
    const entry = {
      kind,
      bin,
      args,
      cwd,
      home: env.CODEX_HOME!,
      child,
      ready: ready.promise,
      closed: closed.promise,
      output: '',
      errors: '',
    }
    children.push(entry)
    child.stdout!.on('data', (bytes: Buffer) => {
      entry.output += bytes.toString()
      if (entry.output.includes('fixture-ready\n')) ready.resolve()
    })
    child.stderr!.on('data', (bytes: Buffer) => {
      entry.errors += bytes.toString()
    })
    child.once('error', ready.reject)
    child.once('close', (code) => {
      closed.resolve(code)
      if (!entry.output.includes('fixture-ready\n')) ready.reject(new Error(entry.errors))
    })
    return child
  }

  const events: PluginEvent[] = []
  const publications: PluginEvent[] = []
  const pending = new Set<Promise<unknown>>()
  const registry = createCapabilityRegistry()
  const host = createPluginHost({
    plugins: [
      agentMain,
      {
        info: {
          id: 'fixture-observer',
          label: 'Fixture observer',
          description: 'Records agent publication',
          default: true,
          builtIn: true,
          requires: ['agent'],
        },
        activate(ctx) {
          for (const name of ['sessions', 'turn-end'])
            ctx.hear('agent', name, (payload) =>
              publications.push({ remote: ctx.remote, name, payload }),
            )
          return () => {}
        },
      },
    ],
    registry,
    userData,
    coreSeeds: [],
    active: () => null,
    rootFor: async (remote) => roots[remote as Remote] ?? null,
    events: {
      send: (_channel, event) => events.push(event),
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
    rootFor: async (remote) => roots[remote as Remote] ?? null,
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async (plugin, root) => (await host.serving(root)).has(plugin),
    claims: (root) => host.scanClaimsFor(root),
  })
  const call = async (remote: Remote, name: string, params: unknown = {}) => {
    const work = capabilities.dispatch({ door: 'ui', remote, name, params })
    pending.add(work)
    try {
      return (await work).value
    } finally {
      pending.delete(work)
    }
  }
  const enter = (remote: Remote) =>
    host.reconcile(
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
  const rows = async (remote: Remote) => (await call(remote, 'agent.sessions')) as SessionSummary[]
  const removed = async (path: string) => {
    await vi.waitFor(() => expect(native.removals.some((entry) => entry.path === path)).toBe(true))
    await Promise.all(
      native.removals.filter((entry) => entry.path === path).map((entry) => entry.done),
    )
  }
  const finish = async (entry: (typeof children)[number]) => {
    entry.child.stdin!.end('finish\n')
    expect(await entry.closed, entry.errors).toBe(0)
  }
  const start = async (remote: Remote, kind: 'job' | 'fenced') => {
    const result = (await call(remote, kind === 'job' ? 'agent.job' : 'agent.scoped', {
      provider: 'codex',
      name: `${remote}:${kind}`,
      prompt: 'synthetic work',
      scope: { read: ['input.md'], write: [`${kind}.md`] },
    })) as { ok: boolean; sessionId: string; terminalId?: string }
    expect(result).toMatchObject({ ok: true, sessionId: expect.any(String) })
    const entry = children.at(-1)!
    expect(entry.kind).toBe(kind)
    await entry.ready
    if (kind === 'job') {
      await vi.waitFor(async () =>
        expect(await readFile(join(dirname(entry.cwd), `${result.sessionId}.pid`), 'utf8')).toBe(
          `${entry.child.pid}\n${entry.cwd}\n`,
        ),
      )
    } else {
      expect(await call(remote, 'agent.terminals')).toEqual([
        expect.objectContaining({ id: result.terminalId, launchedFor: result.sessionId }),
      ])
    }
    expect(await rows(remote)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: result.sessionId, state: 'working' })]),
    )
    return { ...result, entry }
  }
  const intact = async (remote: Remote, entry: (typeof children)[number]) => {
    expect(defaultProbePid(entry.child.pid!)).not.toBe('gone')
    if (entry.kind === 'job') {
      const pid = join(dirname(entry.cwd), `${basename(entry.cwd)}.pid`)
      expect(await readFile(pid, 'utf8')).toBe(`${entry.child.pid}\n${entry.cwd}\n`)
    }
    expect(await readFile(join(entry.cwd, 'input.md'), 'utf8')).toBe(remote)
    expect(await readFile(join(entry.cwd, `${entry.kind}.md`), 'utf8')).toBe(
      `${remote}:${entry.kind}:started`,
    )
    expect(await readFile(join(entry.home, 'provider-state'), 'utf8')).toBe(
      `${remote}:${entry.kind}:private state`,
    )
  }
  const settle = async (remote: Remote, run: Awaited<ReturnType<typeof start>>) => {
    await finish(run.entry)
    await vi.waitFor(async () =>
      expect(await rows(remote)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: run.sessionId,
            state: 'idle',
            outcome: 'completed',
            ...(run.entry.kind === 'fenced' ? { closed: true } : { usage: { total: 12 } }),
          }),
        ]),
      ),
    )
    expect(await readFile(join(roots[remote], `${run.entry.kind}.md`), 'utf8')).toBe(
      `${remote}:${run.entry.kind}:finished`,
    )
    expect(run.entry.output).toContain(
      `${remote}:${run.entry.kind}:output after other vault stopped`,
    )
    await removed(run.entry.cwd)
    await removed(dirname(run.entry.home))
    await expect(access(run.entry.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(dirname(run.entry.home))).rejects.toMatchObject({ code: 'ENOENT' })
  }

  const dispose = async () => {
    // Release every gate before stopping, and reap children even if a host
    // reports a teardown failure. Only this ledger's processes/roots are touched.
    for (const release of releases) release()
    native.heldExit = null
    native.heldConfigure = null
    const failures: unknown[] = []
    try {
      await host.stopAll()
    } catch (err) {
      failures.push(err)
    } finally {
      // A failed stop must not let the fixture delete a parent while a
      // dispatched start is still releasing its scratch state.
      await Promise.allSettled([...pending])
      for (const entry of children) {
        if (entry.child.exitCode === null && entry.child.signalCode === null)
          entry.child.kill('SIGKILL')
      }
      await Promise.all(children.map((entry) => entry.closed))
      const finalizers = await Promise.allSettled(
        children.flatMap((entry) => [removed(entry.cwd), removed(dirname(entry.home))]),
      )
      for (const result of finalizers)
        if (result.status === 'rejected') failures.push(result.reason)
      const deletions = await Promise.allSettled(native.removals.map((entry) => entry.done))
      for (const result of deletions) if (result.status === 'rejected') failures.push(result.reason)
      try {
        expect(
          children.every(
            (entry) => entry.child.exitCode !== null || entry.child.signalCode !== null,
          ),
        ).toBe(true)
        for (const entry of children) expect(defaultProbePid(entry.child.pid!)).toBe('gone')
      } finally {
        await rm(userData, { recursive: true, force: true })
        native.start = null
      }
      await expect(access(userData)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    if (failures.length > 0) throw new AggregateError(failures, 'scratch fixture cleanup failed')
  }

  const person = join(userData, 'synthetic-codex-home')
  try {
    for (const [remote, root] of Object.entries(roots)) {
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'input.md'), remote)
      execFileSync('git', ['init', '-q', root])
      execFileSync('git', ['-C', root, 'config', 'user.name', 'Holi test'])
      execFileSync('git', ['-C', root, 'config', 'user.email', 'holi-test@example.invalid'])
      execFileSync('git', ['-C', root, 'add', '.'])
      execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture'])
    }
    await mkdir(person)
    await writeFile(join(person, 'auth.json'), '{"fixture":"not a credential"}')
    await enter(A)
    await call(A, 'agent.harnessSave', {
      harness: {
        ...PRESETS.find((preset) => preset.id === 'codex')!,
        command: { bin: process.execPath, args: [] },
        env: { CODEX_HOME: person },
      },
    })
  } catch (err) {
    await dispose()
    throw err
  }
  return {
    userData,
    roots,
    A,
    B,
    children,
    host,
    call,
    enter,
    rows,
    removed,
    start,
    intact,
    settle,
    holdExit,
    holdConfigure,
    events,
    publications,
    person,
    dispose,
  }
}

it('keeps live job and fenced data planes independent through another vault startup and restart', async () => {
  const fixture = await createScratchFixture()
  const {
    userData,
    roots,
    A,
    B,
    children,
    host,
    call,
    enter,
    rows,
    removed,
    start,
    intact,
    settle,
    holdExit,
  } = fixture
  try {
    // Both A processes are doing real scratch work BEFORE B's startup sweep.
    const aJob = await start(A, 'job')
    const aFence = await start(A, 'fenced')
    await enter(B)
    await intact(A, aJob.entry)
    await intact(A, aFence.entry)
    const bJob = await start(B, 'job')
    const bFence = await start(B, 'fenced')
    await intact(A, aJob.entry)
    await intact(A, aFence.entry)
    expect(aJob.sessionId).toBe(bJob.sessionId)
    expect(aFence.sessionId).toBe(bFence.sessionId)
    const a = await agentScratchRoots(userData, { remote: A, root: roots[A] })
    const b = await agentScratchRoots(userData, { remote: B, root: roots[B] })
    expect(aJob.entry.cwd).toBe(join(a.jobs, aJob.sessionId))
    expect(bJob.entry.cwd).toBe(join(b.jobs, bJob.sessionId))
    expect(dirname(aFence.entry.cwd)).toBe(a.fenced)
    expect(dirname(bFence.entry.cwd)).toBe(b.fenced)
    expect(aJob.entry.home).toBe(join(a.jobs, `${aJob.sessionId}.agent`, 'codex-home'))
    expect(bJob.entry.home).toBe(join(b.jobs, `${bJob.sessionId}.agent`, 'codex-home'))
    expect(aFence.entry.home).toBe(join(`${aFence.entry.cwd}.agent`, 'codex-home'))
    expect(bFence.entry.home).toBe(join(`${bFence.entry.cwd}.agent`, 'codex-home'))
    expect(aJob.entry.home).not.toBe(bJob.entry.home)
    expect(aFence.entry.home).not.toBe(bFence.entry.home)
    // Hold A's real PTY exit callback after the operating-system child closes.
    // Teardown must keep waiting for the production finalizer, while B's same-id
    // job and fenced session remain operational.
    const { heldExit, exitEntered } = holdExit(aFence.entry.cwd)
    let stoppedA = false
    const stoppingA = host.stop(A).then(() => {
      stoppedA = true
    })
    await exitEntered.promise
    expect(stoppedA).toBe(false)
    await expect(call(A, 'agent.sessions')).rejects.toThrow('no such method')
    expect(await rows(B)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: bJob.sessionId, state: 'working' })]),
    )
    await intact(B, bJob.entry)
    await intact(B, bFence.entry)
    heldExit.resolve()
    await stoppingA
    await Promise.all([aJob.entry.closed, aFence.entry.closed])
    await removed(aJob.entry.cwd)
    await removed(dirname(aJob.entry.home))
    await removed(aFence.entry.cwd)
    await removed(dirname(aFence.entry.home))
    await expect(access(aJob.entry.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(aFence.entry.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    await intact(B, bJob.entry)
    await intact(B, bFence.entry)

    // A's restart must admit and finish fresh work, not merely recreate a
    // capability surface. The fresh IDs deliberately collide with B's IDs.
    await enter(A)
    const restartedJob = await start(A, 'job')
    expect(restartedJob.sessionId).toBe(bJob.sessionId)
    await intact(B, bJob.entry)
    await intact(B, bFence.entry)
    await settle(A, restartedJob)
    await host.stop(A)
    await intact(B, bJob.entry)
    await intact(B, bFence.entry)
    // B's original sessions finish after both A activations have stopped, and
    // the real providers copy their output into B only.
    await settle(B, bJob)
    await settle(B, bFence)
    expect(await readFile(join(roots[A], 'job.md'), 'utf8')).toBe(`${A}:job:finished`)
    await expect(access(join(roots[A], 'fenced.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await removed(join(b.jobs, `${bJob.sessionId}.pid`))
    expect(children).toHaveLength(5)
  } finally {
    await fixture.dispose()
  }
})

it.each(['success', 'rejection'] as const)(
  'keeps vault b live when provider configure %s arrives after vault a invalidation',
  async (outcome) => {
    const fixture = await createScratchFixture()
    const {
      userData,
      roots,
      A,
      B,
      children,
      host,
      call,
      enter,
      rows,
      start,
      intact,
      settle,
      holdConfigure,
      events,
      publications,
      person,
    } = fixture
    let starting: Promise<unknown> | undefined
    let stopping: Promise<void> | undefined
    try {
      await enter(B)
      const bJob = await start(B, 'job')
      const bFence = await start(B, 'fenced')
      await enter(A)
      const a = await agentScratchRoots(userData, { remote: A, root: roots[A] })
      const b = await agentScratchRoots(userData, { remote: B, root: roots[B] })
      const { gate, entered } = holdConfigure(A)
      let startSettled = false
      starting = call(A, 'agent.scoped', {
        provider: 'codex',
        name: 'delayed configure',
        prompt: 'synthetic work',
        scope: { read: ['input.md'], write: ['fenced.md'] },
      }).finally(() => {
        startSettled = true
      })
      // Observe any failure immediately, while retaining the original promise
      // for assertions and the finally drain.
      void starting.catch(() => {})
      await entered
      expect(startSettled).toBe(false)
      const scratch = await readdir(a.fenced)
      expect(scratch).toEqual(expect.arrayContaining(['575757575757', '575757575757.agent']))
      expect(await readFile(join(a.fenced, '575757575757', 'input.md'), 'utf8')).toBe(A)
      expect(native.configured.filter((entry) => entry.root === roots[A])).toEqual([])
      expect(children).toHaveLength(2)

      // stop revokes A synchronously, before waiting for configure. Its real
      // capability dispatch refuses new work while B keeps both data planes.
      let stopSettled = false
      stopping = host.stop(A).then(() => {
        stopSettled = true
      })
      void stopping.catch(() => {})
      await expect(call(A, 'agent.sessions')).rejects.toThrow('no such method')
      const aEvents = events.filter((event) => event.remote === A)
      const aPublications = publications.filter((event) => event.remote === A)
      expect(await call(B, 'agent.terminals')).toEqual([
        expect.objectContaining({ id: bFence.terminalId, launchedFor: bFence.sessionId }),
      ])
      await intact(B, bJob.entry)
      await intact(B, bFence.entry)
      expect(startSettled).toBe(false)
      expect(stopSettled).toBe(false)

      if (outcome === 'success') gate.resolve()
      else gate.reject(new Error('delayed synthetic configure rejection'))
      await expect(starting).resolves.toEqual({ ok: false, message: 'That vault has been left.' })
      await stopping
      expect(native.configured.filter((entry) => entry.root === roots[A])).toEqual([
        outcome === 'success'
          ? { root: roots[A], outcome: 'resolved', dir: person }
          : { root: roots[A], outcome: 'rejected' },
      ])
      // No late PTY/process, session/terminal publication, history or vault
      // output can be produced by the now-resolved/rejected A start.
      expect(children).toHaveLength(2)
      expect(
        children.every((entry) => entry.cwd.startsWith(b.jobs) || entry.cwd.startsWith(b.fenced)),
      ).toBe(true)
      expect(events.filter((event) => event.remote === A)).toEqual(aEvents)
      expect(publications.filter((event) => event.remote === A)).toEqual(aPublications)
      await expect(call(A, 'agent.sessions')).rejects.toThrow('no such method')
      await expect(call(A, 'agent.terminals')).rejects.toThrow('no such method')
      for (const path of [a.jobs, a.fenced, join(roots[A], 'job.md'), join(roots[A], 'fenced.md')])
        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
      await intact(B, bJob.entry)
      await intact(B, bFence.entry)
      expect(await rows(B)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: bJob.sessionId, state: 'working' }),
          expect.objectContaining({ id: bFence.sessionId, state: 'working' }),
        ]),
      )
      // Real provider completion/copy-back after A's stop proves B was not
      // merely left with a published capability surface or a stale row.
      await settle(B, bJob)
      await settle(B, bFence)
      expect(publications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            remote: B,
            name: 'sessions',
            payload: expect.arrayContaining([
              expect.objectContaining({ id: bJob.sessionId, outcome: 'completed' }),
              expect.objectContaining({ id: bFence.sessionId, outcome: 'completed', closed: true }),
            ]),
          }),
        ]),
      )
      for (const path of [join(roots[A], 'job.md'), join(roots[A], 'fenced.md')])
        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
      const history = JSON.parse(
        await readFile(join(userData, 'agent-pty-history.json'), 'utf8').catch(
          (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') return '{}'
            throw err
          },
        ),
      ) as Record<string, unknown[]>
      expect(history[A] ?? []).toEqual([])
      expect(events.filter((event) => event.remote === A)).toEqual(aEvents)
      expect(publications.filter((event) => event.remote === A)).toEqual(aPublications)
      expect(children).toHaveLength(2)
      await host.stop(B)
      for (const path of [a.jobs, a.fenced, b.jobs, b.fenced])
        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      // dispose releases configuration/exit gates and reaps owned children even
      // when stop fails; always also join the dispatched start and stop.
      try {
        await fixture.dispose()
      } finally {
        await Promise.allSettled([starting, stopping])
      }
    }
  },
)
