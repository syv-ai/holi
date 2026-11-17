import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
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
// Only the two native launch adapters vary. AgentRuntime, all four hosts,
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
        child.on('close', (code) => cb({ exitCode: code ?? -1 }))
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

it('keeps live job and fenced data planes independent through another vault startup and restart', async () => {
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

  const registry = createCapabilityRegistry()
  const host = createPluginHost({
    plugins: [agentMain],
    registry,
    userData,
    coreSeeds: [],
    active: () => null,
    rootFor: async (remote) => roots[remote as Remote] ?? null,
    events: { send: () => {}, listen: () => () => {}, liveRemote: () => host.displayed() },
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
  const call = async (remote: Remote, name: string, params: unknown = {}) =>
    (await capabilities.dispatch({ door: 'ui', remote, name, params })).value
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
    const person = join(userData, 'synthetic-codex-home')
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
    // Stop A with both finalizers still owning live work. Its admission closes
    // immediately, while teardown must reap the children and remove only A's
    // scratch; B's same-id owners remain operational.
    await host.stop(A)
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
    // Explicit ownership ledger: close activations, reap every synthetic child,
    // join provider/host finalizer deletions, then (and only then) remove roots.
    await host.stopAll()
    for (const entry of children) {
      if (entry.child.exitCode === null && entry.child.signalCode === null)
        entry.child.kill('SIGKILL')
      await entry.closed
      await removed(entry.cwd)
      await removed(dirname(entry.home))
    }
    await Promise.all(native.removals.map((entry) => entry.done))
    expect(
      children.every((entry) => entry.child.exitCode !== null || entry.child.signalCode !== null),
    ).toBe(true)
    for (const entry of children) expect(defaultProbePid(entry.child.pid!)).toBe('gone')
    await rm(userData, { recursive: true, force: true })
    await expect(access(userData)).rejects.toMatchObject({ code: 'ENOENT' })
    native.start = null
  }
})
