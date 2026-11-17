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
  heldRelease: null as null | { state: string; entered: () => void; wait: Promise<void> },
  released: [] as { state: string; outcome: 'resolved' | 'rejected' }[],
  heldFs: [] as {
    method: 'link' | 'rename' | 'writeFile'
    matches: (args: string[]) => boolean
    entered: () => void
    wait: Promise<void>
  }[],
  operations: new Set<Promise<unknown>>(),
  start: null as
    | null
    | ((
        kind: 'job' | 'fenced' | 'pty',
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
// Gate only provider configure/release adapters, never host lifecycle checks.
// Successful gates always continue through the original Codex implementation.
vi.mock('../main/codex', async (original) => {
  const codex = await original<typeof import('../main/codex')>()
  return {
    ...codex,
    codexProvider: (deps: Parameters<typeof codex.codexProvider>[0]) => {
      const provider = codex.codexProvider(deps)
      const configure = provider.configure
      const release = provider.release!
      return {
        ...provider,
        release: async (state: string) => {
          const work = (async () => {
            try {
              const hold = native.heldRelease
              if (hold !== null && hold.state === state) {
                hold.entered()
                await hold.wait
              }
              await release(state)
              native.released.push({ state, outcome: 'resolved' })
            } catch (err) {
              native.released.push({ state, outcome: 'rejected' })
              throw err
            }
          })()
          native.operations.add(work)
          try {
            await work
          } finally {
            native.operations.delete(work)
          }
        },
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
  const gated = async <T>(
    method: 'link' | 'rename' | 'writeFile',
    args: unknown[],
    run: () => Promise<T>,
  ): Promise<T> => {
    const hold = native.heldFs.find(
      (gate) => gate.method === method && gate.matches(args.map(String)),
    )
    const work = (async () => {
      if (hold !== undefined) {
        native.heldFs.splice(native.heldFs.indexOf(hold), 1)
        hold.entered()
        await hold.wait
      }
      return run()
    })()
    native.operations.add(work)
    try {
      return await work
    } finally {
      native.operations.delete(work)
    }
  }
  return {
    ...fs,
    link: (...args: Parameters<typeof fs.link>) => gated('link', args, () => fs.link(...args)),
    rename: (...args: Parameters<typeof fs.rename>) =>
      gated('rename', args, () => fs.rename(...args)),
    writeFile: (...args: Parameters<typeof fs.writeFile>) =>
      gated('writeFile', args, () => fs.writeFile(...args)),
    rm: (...args: Parameters<typeof fs.rm>) => {
      const done = fs.rm(...args)
      native.removals.push({ path: String(args[0]), done })
      return done
    },
  }
})
// Only native process/filesystem and provider delay adapters vary. AgentRuntime, all four hosts,
// providers (including command construction/home preparation), dispatcher and
// plugin activation/teardown are production implementations.
vi.mock('../../../main/plugin-api', async (original) => {
  const api = await original<typeof import('../../../main/plugin-api')>()
  const defaultSpawnPty: SpawnPty = (bin, args, opts) => {
    const child = native.start!(
      opts.env.CODEX_HOME === undefined ? 'pty' : 'fenced',
      bin,
      args,
      opts.cwd,
      opts.env,
    )
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

function within<T>(work: Promise<T>): Promise<T> {
  const done = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Fixture operation did not settle')), 3_000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  })()
  // A preceding assertion can fail before its gate is awaited. Still observe
  // the bounded admission promise while finally releases/drains the fixture.
  void done.catch(() => {})
  return done
}

async function createScratchFixture() {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'holi-scratch-activation-')))
  const roots = { 'fixture/a': join(userData, 'vault-a'), 'fixture/b': join(userData, 'vault-b') }
  type Remote = keyof typeof roots
  const A: Remote = 'fixture/a'
  const B: Remote = 'fixture/b'
  const children: {
    kind: 'job' | 'fenced' | 'pty'
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
  native.released.length = 0
  native.heldRelease = null
  native.heldFs.length = 0
  expect(native.operations.size).toBe(0)
  const releases: (() => void)[] = []
  const holdExit = (cwd: string) => {
    const heldExit = deferred<void>()
    const exitEntered = deferred<void>()
    releases.push(heldExit.resolve)
    native.heldExit = { cwd, entered: exitEntered.resolve, wait: heldExit.promise }
    return { heldExit, exitEntered: { ...exitEntered, promise: within(exitEntered.promise) } }
  }
  const holdConfigure = (remote: Remote) => {
    const gate = deferred<void>()
    const entered = deferred<void>()
    releases.push(gate.resolve)
    native.heldConfigure = { root: roots[remote], entered: entered.resolve, wait: gate.promise }
    return { gate, entered: within(entered.promise) }
  }
  const holdRelease = (state: string) => {
    const gate = deferred<void>()
    const entered = deferred<void>()
    releases.push(gate.resolve)
    native.heldRelease = { state, entered: entered.resolve, wait: gate.promise }
    return { gate, entered: within(entered.promise) }
  }
  const holdFs = (
    method: 'link' | 'rename' | 'writeFile',
    matches: (args: string[]) => boolean,
  ) => {
    const gate = deferred<void>()
    const entered = deferred<void>()
    releases.push(gate.resolve)
    native.heldFs.push({ method, matches, entered: entered.resolve, wait: gate.promise })
    return { gate, entered: within(entered.promise) }
  }
  native.start = (kind, bin, args, cwd, env) => {
    // Never execute a real provider or inherit keys/config from this machine.
    expect(bin).toBe(process.execPath)
    if (kind !== 'pty') {
      expect(args).toContain(cwd)
      expect(env.CODEX_HOME).toBeTypeOf('string')
    }
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
      home: env.CODEX_HOME ?? '',
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
  const stop = (remote: Remote) => {
    const work = host.stop(remote)
    pending.add(work)
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    )
    return work
  }
  const quiet = (remote: Remote) => {
    const sent = events.filter((event) => event.remote === remote)
    const published = publications.filter((event) => event.remote === remote)
    return () => {
      expect(events.filter((event) => event.remote === remote)).toEqual(sent)
      expect(publications.filter((event) => event.remote === remote)).toEqual(published)
    }
  }
  const enter = (remote: Remote) =>
    host.reconcile(
      {
        remote,
        root: roots[remote],
        pause: () => {},
        resume: () => {},
        drainSync: async () => {},
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
    expect(await within(entry.closed), entry.errors).toBe(0)
  }
  const start = async (
    remote: Remote,
    kind: 'job' | 'fenced',
    scope = { read: ['input.md'], write: [`${kind}.md`] },
  ) => {
    const result = (await call(remote, kind === 'job' ? 'agent.job' : 'agent.scoped', {
      provider: 'codex',
      name: `${remote}:${kind}`,
      prompt: 'synthetic work',
      scope,
    })) as { ok: boolean; sessionId: string; terminalId?: string }
    expect(result).toMatchObject({ ok: true, sessionId: expect.any(String) })
    const entry = children.at(-1)!
    expect(entry.kind).toBe(kind)
    await within(entry.ready)
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

  const dispose = async (failedRemote?: Remote) => {
    // Release every gate before stopping, and reap children even if a host
    // reports a teardown failure. Only this ledger's processes/roots are touched.
    for (const release of releases) release()
    native.heldExit = null
    native.heldConfigure = null
    native.heldRelease = null
    native.heldFs.length = 0
    const failures: unknown[] = []
    if (failedRemote !== undefined) {
      // The expected A failure cannot hide an unrelated B teardown failure.
      for (const remote of [A, B]) {
        if (remote === failedRemote) continue
        try {
          await host.stop(remote)
        } catch (err) {
          failures.push(err)
        }
      }
    }
    try {
      await host.stopAll()
      if (failedRemote !== undefined) failures.push(new Error('Expected teardown to remain failed'))
    } catch (err) {
      if (failedRemote === undefined) failures.push(err)
      else expect(err).toBeInstanceOf(AggregateError)
    } finally {
      // A failed stop must not let the fixture delete a parent while a
      // dispatched start is still releasing its scratch state.
      await Promise.allSettled([...pending])
      for (const entry of children) {
        if (entry.child.exitCode === null && entry.child.signalCode === null)
          entry.child.kill('SIGKILL')
      }
      await Promise.all(children.map((entry) => entry.closed))
      while (native.operations.size > 0) await Promise.allSettled([...native.operations])
      const failedRoots =
        failedRemote === undefined
          ? null
          : await agentScratchRoots(userData, { remote: failedRemote, root: roots[failedRemote] })
      const finalizers = await Promise.allSettled(
        children
          .filter(
            (entry) =>
              entry.kind !== 'pty' &&
              (failedRoots === null ||
                (!entry.cwd.startsWith(failedRoots.jobs) &&
                  !entry.cwd.startsWith(failedRoots.fenced))),
          )
          .flatMap((entry) => [removed(entry.cwd), removed(dirname(entry.home))]),
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
    await call(A, 'agent.harnessSave', {
      harness: {
        ...PRESETS.find((preset) => preset.id === 'pi')!,
        command: { bin: process.execPath, args: [] },
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
    stop,
    quiet,
    call,
    enter,
    rows,
    removed,
    start,
    intact,
    settle,
    holdExit,
    holdConfigure,
    holdRelease,
    holdFs,
    finish,
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

for (const kind of ['job', 'fenced'] as const) {
  it.each(['success', 'rejection'] as const)(
    `drains ${kind} provider release %s before replacing vault a while vault b stays live`,
    async (outcome) => {
      const f = await createScratchFixture()
      let failed = false
      try {
        const a = await f.start(f.A, kind)
        await f.enter(f.B)
        const bJob = await f.start(f.B, 'job')
        const bFence = await f.start(f.B, 'fenced')
        const state = dirname(a.entry.home)
        const hold = f.holdRelease(state)
        await f.finish(a.entry)
        await hold.entered
        expect(defaultProbePid(a.entry.child.pid!)).toBe('gone')
        expect(await readFile(join(a.entry.home, 'provider-state'), 'utf8')).toContain(
          'private state',
        )
        let stopped = false
        const stopping = f.stop(f.A).then(() => {
          stopped = true
        })
        void stopping.catch(() => {})
        await expect(f.call(f.A, 'agent.sessions')).rejects.toThrow('no such method')
        const quiet = f.quiet(f.A)
        await f.intact(f.B, bJob.entry)
        await f.intact(f.B, bFence.entry)
        expect(stopped).toBe(false)
        expect(native.released.filter((entry) => entry.state === state)).toEqual([])
        // Opening the same remote queues behind teardown, never over its state.
        const replacement = f.enter(f.A)
        void replacement.catch(() => {})
        let replaced = false
        void replacement.then(
          () => {
            replaced = true
          },
          () => {},
        )
        expect(replaced).toBe(false)
        if (outcome === 'success') {
          hold.gate.resolve()
          await stopping
          expect(native.released.filter((entry) => entry.state === state)).toEqual([
            { state, outcome: 'resolved' },
          ])
          await f.removed(state)
          await expect(access(state)).rejects.toMatchObject({ code: 'ENOENT' })
          await replacement
          native.heldRelease = null
          await rm(join(f.roots[f.A], `${kind}.md`), { force: true })
          const fresh = await f.start(f.A, kind)
          expect(fresh.sessionId).toBe(a.sessionId)
          await f.settle(f.A, fresh)
          await f.stop(f.A)
        } else {
          hold.gate.reject(new Error('synthetic release rejected'))
          await expect(stopping).rejects.toThrow(`plugins in ${f.A} failed to stop`)
          failed = true
          quiet()
          await expect(replacement).rejects.toThrow()
          await expect(f.stop(f.A)).rejects.toThrow()
          await expect(f.enter(f.A)).rejects.toThrow()
          await expect(f.call(f.A, 'agent.sessions')).rejects.toThrow('no such method')
          // Failed ownership remains captured, not swept or replaced by a retry.
          expect(await readFile(join(a.entry.home, 'provider-state'), 'utf8')).toContain(
            'private state',
          )
          expect(await readFile(join(a.entry.cwd, 'input.md'), 'utf8')).toBe(f.A)
          expect(f.children).toHaveLength(3)
          expect(native.released.filter((entry) => entry.state === state)).toEqual([
            { state, outcome: 'rejected' },
          ])
        }
        await f.intact(f.B, bJob.entry)
        await f.intact(f.B, bFence.entry)
        await f.settle(f.B, bJob)
        await f.settle(f.B, bFence)
        if (failed) quiet()
      } finally {
        await f.dispose(failed ? f.A : undefined)
      }
    },
  )

  it.each(['link', 'rename'] as const)(
    `joins admitted ${kind} copy-back %s before vault a stop and cancels future publications`,
    async (method) => {
      const f = await createScratchFixture()
      let failed = false
      try {
        const target = join(f.roots[f.A], `${kind}.md`)
        if (method === 'rename') await writeFile(target, 'original file')
        const a = await f.start(f.A, kind, {
          read: ['input.md', ...(method === 'rename' ? [`${kind}.md`] : [])],
          write: [`${kind}.md`, 'z-cancelled.md'],
        })
        await writeFile(join(a.entry.cwd, 'z-cancelled.md'), 'must never publish')
        await f.enter(f.B)
        const bJob = await f.start(f.B, 'job')
        const bFence = await f.start(f.B, 'fenced')
        const hold = f.holdFs(method, (args) =>
          method === 'link'
            ? args[1] === target
            : args[0] === target && basename(args[1]!) === 'previous',
        )
        await f.finish(a.entry)
        await hold.entered
        // Simulate a newer sync write after production's last hash check but
        // before the admitted native rename actually moves the file aside.
        if (method === 'rename') await writeFile(target, 'newer sync file')
        let stopped = false
        const stopping = f.stop(f.A).then(() => {
          stopped = true
        })
        void stopping.catch(() => {})
        await expect(f.call(f.A, 'agent.sessions')).rejects.toThrow('no such method')
        const quiet = f.quiet(f.A)
        await f.intact(f.B, bJob.entry)
        await f.intact(f.B, bFence.entry)
        expect(stopped).toBe(false)
        hold.gate.resolve()
        if (kind === 'fenced' && method === 'rename') {
          // A fenced copy error is sticky and must be an explicit drain failure.
          await expect(stopping).rejects.toThrow(`plugins in ${f.A} failed to stop`)
          failed = true
          await expect(f.enter(f.A)).rejects.toThrow()
        } else await stopping
        quiet()
        expect(await readFile(target, 'utf8')).toBe(
          method === 'rename' ? 'newer sync file' : `${f.A}:${kind}:finished`,
        )
        await expect(access(join(f.roots[f.A], 'z-cancelled.md'))).rejects.toMatchObject({
          code: 'ENOENT',
        })
        expect((await readdir(f.roots[f.A])).filter((name) => name.startsWith('.holi-'))).toEqual(
          [],
        )
        await f.removed(a.entry.cwd)
        await f.removed(dirname(a.entry.home))
        await f.settle(f.B, bJob)
        await f.settle(f.B, bFence)
        quiet()
        // The held original native operation completed; no old mutation can
        // arrive in a subsequent generation of the same vault.
        if (!failed) {
          await f.enter(f.A)
          const fresh = await f.start(f.A, 'job', {
            read: ['input.md', ...(kind === 'job' ? ['job.md'] : [])],
            write: ['job.md'],
          })
          await f.settle(f.A, fresh)
          await f.stop(f.A)
        }
      } finally {
        await f.dispose(failed ? f.A : undefined)
      }
    },
  )
}

it('drains retained pty conversation history publication before restarting vault a without losing vault b', async () => {
  const f = await createScratchFixture()
  const historyPath = join(f.userData, 'agent-pty-history.json')
  const history = async () =>
    JSON.parse(await readFile(historyPath, 'utf8')) as Record<string, SessionSummary[]>
  const startPi = async (remote: typeof f.A | typeof f.B, name: string) => {
    const result = (await f.call(remote, 'agent.start', { provider: 'pi', name })) as {
      ok: boolean
      sessionId: string
      terminalId: string
    }
    expect(result.ok).toBe(true)
    const entry = f.children.at(-1)!
    expect(entry.kind).toBe('pty')
    await within(entry.ready)
    return { ...result, entry }
  }
  try {
    await f.enter(f.B)
    const oldB = await startPi(f.B, 'retained b')
    await f.finish(oldB.entry)
    expect(await f.call(f.B, 'agent.stop', { id: oldB.sessionId })).toEqual({ ok: true })
    const before = await history()
    expect(before[f.B]).toEqual([
      expect.objectContaining({ name: 'retained b', conversationId: expect.any(String) }),
    ])
    const bJob = await f.start(f.B, 'job')
    const bFence = await f.start(f.B, 'fenced')
    const a = await startPi(f.A, 'retained a')
    await f.finish(a.entry)
    // Pi's exited terminal/conversation stays retained until deliberate close.
    expect(await f.call(f.A, 'agent.terminals')).toEqual([
      expect.objectContaining({ id: a.terminalId }),
    ])
    expect(await history()).toEqual(before)
    const hold = f.holdFs(
      'writeFile',
      (args) => args[0] === `${historyPath}.tmp` && args[1]!.includes('retained a'),
    )
    let stopped = false
    const stopping = f.stop(f.A).then(() => {
      stopped = true
    })
    void stopping.catch(() => {})
    await hold.entered
    const quiet = f.quiet(f.A)
    await expect(f.call(f.A, 'agent.sessions')).rejects.toThrow('no such method')
    expect(await history()).toEqual(before)
    await f.intact(f.B, bJob.entry)
    await f.intact(f.B, bFence.entry)
    expect(stopped).toBe(false)
    let replaced = false
    const replacement = f.enter(f.A).then(() => {
      replaced = true
    })
    void replacement.catch(() => {})
    expect(replaced).toBe(false)
    hold.gate.resolve()
    await stopping
    quiet()
    const saved = await history()
    expect(saved[f.B]).toEqual(before[f.B])
    expect(saved[f.A]).toEqual([
      expect.objectContaining({
        id: a.sessionId,
        name: 'retained a',
        provider: 'pi',
        conversationId: expect.any(String),
      }),
    ])
    await replacement
    const fresh = await startPi(f.A, 'new generation a')
    expect(fresh.sessionId).toBe(a.sessionId)
    await f.finish(fresh.entry)
    await f.stop(f.A)
    const after = await history()
    expect(after[f.B]).toEqual(before[f.B])
    expect(after[f.A]).toEqual([expect.objectContaining({ name: 'new generation a' })])
    expect(after[f.A]![0]!.conversationId).not.toBe(saved[f.A]![0]!.conversationId)
    await f.settle(f.B, bJob)
    await f.settle(f.B, bFence)
    expect(await history()).toEqual(after)
    expect(native.operations.size).toBe(0)
    await expect(access(`${historyPath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await f.dispose()
  }
})
