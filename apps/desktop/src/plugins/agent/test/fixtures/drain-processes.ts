import { spawn, type ChildProcess } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, vi } from 'vitest'
import { NOTIFICATIONS_OVERRIDE, SESSION_ENV } from '../../main/codex'
import type { PosixLaunch } from '../../../../main/posix-launch-lease'
import {
  groupMembers,
  kernelGroupAbsent,
  type posixFixtureLedger,
} from '../../../../../test/fixtures/posix-fixture-ledger'
import { leasedPty } from './leased-pty'

export type Kind = 'pi' | 'pty' | 'fenced' | 'job'
export type Plan = { kind: Kind; stdio: 'ignore' | 'inherit'; code: number; launchError?: Error }
const native = vi.hoisted(() => ({ fixture: null as FixtureNative | null }))

export type FixtureNative = ReturnType<typeof drainProcesses>

vi.mock('electron', () => ({ app: { getVersion: () => 'test' }, nativeTheme: {} }))
vi.mock('../../main/claude/cli', async (original) => {
  const cli = await original<typeof import('../../main/claude/cli')>()
  return {
    ...cli,
    resolveClaudeBin: () => '/synthetic/claude',
    createClaudeCli: (deps: Parameters<typeof cli.createClaudeCli>[0]) =>
      cli.createClaudeCli({ ...deps, run: async () => '[]' }),
  }
})
vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>()
  return {
    ...crypto,
    randomUUID: () => 'abcdef01-0000-4000-8000-000000000001',
    randomBytes: (size: number) => (size === 6 ? Buffer.alloc(6, 0x67) : crypto.randomBytes(size)),
  }
})
vi.mock('../../main/codex', async (original) => {
  const codex = await original<typeof import('../../main/codex')>()
  return {
    ...codex,
    codexProvider: (deps: Parameters<typeof codex.codexProvider>[0]) => {
      const provider = codex.codexProvider(deps)
      return {
        ...provider,
        release: async (state: string) => {
          const run = native.fixture!.runs.find((run) => dirname(run.home) === state)
          if (run) await run.release.enter()
          await provider.release!(state)
        },
      }
    },
  }
})
// Let real finalizers mutate disk, but join their in-flight filesystem work
// before removing a private fixture on assertion failure.
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const track = <T>(path: unknown, work: Promise<T>): Promise<T> => {
    native.fixture?.track(path, work)
    return work
  }
  return {
    ...fs,
    mkdir: (...args: Parameters<typeof fs.mkdir>) => track(args[0], fs.mkdir(...args)),
    rm: (...args: Parameters<typeof fs.rm>) => track(args[0], fs.rm(...args)),
    writeFile: (...args: Parameters<typeof fs.writeFile>) => track(args[0], fs.writeFile(...args)),
    copyFile: (...args: Parameters<typeof fs.copyFile>) => track(args[1], fs.copyFile(...args)),
    readdir: ((...args: Parameters<typeof fs.readdir>) => {
      const work = (async () => {
        await native.fixture?.beforeReadDir(String(args[0]))
        return fs.readdir(...args)
      })()
      return track(args[0], work)
    }) as typeof fs.readdir,
    rename: (...args: Parameters<typeof fs.rename>) => track(args[1], fs.rename(...args)),
    link: (...args: Parameters<typeof fs.link>) => track(args[1], fs.link(...args)),
  }
})
vi.mock('../../../../main/posix-launch-lease', async (original) => {
  const lease = await original<typeof import('../../../../main/posix-launch-lease')>()
  return {
    ...lease,
    preparePosixSpawn: (
      bin: string,
      args: string[],
      options: Parameters<typeof lease.preparePosixSpawn>[2],
      stdio: Parameters<typeof lease.preparePosixSpawn>[3],
    ) => {
      const scoped = { ...options, directory: native.fixture!.directory }
      return lease.preparePosixSpawn(bin, args, scoped, stdio)
    },
    preparePosixLaunch: (
      bin: string,
      args: string[],
      options: Parameters<typeof lease.preparePosixLaunch>[2],
    ) => {
      const run = native.fixture!.prepare(bin, args, String(options.cwd), options.env ?? {})
      const prepared = lease.preparePosixLaunch(process.execPath, run.args, {
        ...options,
        directory: run.directory,
        env: { PATH: '/usr/bin:/bin', CODEX_HOME: run.home || undefined },
        stdio: 'pipe',
        graceMs: 250,
      })
      run.nativeDrain = prepared.drain
      prepared.drain = run.consumerDrain
      if (run.launchError) {
        const cancel = prepared.cancel
        run.nativeDrain = () => cancel('possibly-launched')
        prepared.cancel = async (state) => {
          await run.drain.enter()
          await cancel(state)
          run.proven.resolve()
        }
        run.drain.hold()
      }
      run.prepared = prepared
      return prepared
    },
  }
})
vi.mock('../../../../main/plugin-api', async (original) => {
  const api = await original<typeof import('../../../../main/plugin-api')>()
  return {
    ...api,
    spawnOwnedProgram: ((...args: Parameters<typeof api.spawnOwnedProgram>) => {
      const [bin, argv, options] = args
      const run = native.fixture!.prepare(bin, argv, String(options.cwd), options.env ?? {})
      expect(options.posixGroupLease).toBe(true)
      const child = api.spawnOwnedProgram(process.execPath, run.args, {
        ...options,
        env: { PATH: '/usr/bin:/bin', CODEX_HOME: run.home || undefined },
        stdio: 'pipe',
        posixGroupLease: true,
      })
      const proof = child[api.ownedProcessDrain]!
      run.nativeDrain = proof.drain
      proof.drain = run.consumerDrain
      native.fixture!.record(run, child, 'owned-process descriptor', true)
      return child
    }) as typeof api.spawnOwnedProgram,
    defaultSpawnPty: (bin: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const run = native.fixture!.runs.at(-1)!
      const prepared = run.prepared!
      expect(options.env).toBe(prepared.options.env)
      const child = spawn(bin, args, prepared.options)
      native.fixture!.record(run, child, prepared.args[1]!, false)
      const output = leasedPty(child, () => run.close.enter())
      run.ptyOutput = output
      void output.outputSettled.then(run.emittedClose.resolve)
      if (run.launchError) {
        // The helper was actually spawned, but callback installation fails
        // before the runtime can bind the native process.
        output.pty.onExit = () => {
          throw run.launchError
        }
      }
      return output.pty
    },
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function gate() {
  const entered = deferred<void>()
  const permit = deferred<void>()
  void permit.promise.catch(() => {})
  let held = false
  return {
    entered: entered.promise,
    hit: false,
    hold() {
      held = true
    },
    open: permit.resolve,
    reject: permit.reject,
    async enter() {
      this.hit = true
      entered.resolve()
      if (held) await permit.promise
    },
  }
}

function newRun(plan: Plan, directory: string, i: number, cwd: string, home: string) {
  const receipt = join(directory, `descendant-${i}.receipt`)
  let consumerProof: Promise<void> | undefined
  let ancestry: { anchor: number; reaper: number } | undefined
  let descendant: number | undefined
  const run = {
    ...plan,
    cwd,
    home,
    directory,
    receipt,
    args: [
      fileURLToPath(new URL('./drain-provider.mjs', import.meta.url)),
      plan.kind,
      receipt,
      plan.stdio,
      String(plan.code),
    ],
    prepared: undefined as PosixLaunch | undefined,
    nativeDrain: undefined as (() => Promise<void>) | undefined,
    child: undefined as ChildProcess | undefined,
    ptyOutput: undefined as ReturnType<typeof leasedPty> | undefined,
    ancestry: undefined as (() => void) | undefined,
    consumerDrain() {
      run.drainCalls++
      return (consumerProof ??= (async () => {
        await run.drain.enter()
        await run.nativeDrain!()
        run.proven.resolve()
      })())
    },
    async waitReady() {
      await bounded(run.ready.promise, `provider readiness: ${run.errors}`)
      run.ancestry!()
      ancestry = JSON.parse(await readFile(join(directory, `lease-${run.pid}.json`), 'utf8'))
      descendant = Number(await readFile(receipt, 'utf8'))
      expect(groupMembers(run.pid)).toContain(descendant)
    },
    aliveAfterExit() {
      expect(descendant).toBeGreaterThan(1)
      expect(() => process.kill(descendant!, 0)).not.toThrow()
      expect(() => process.kill(-run.pid, 0)).not.toThrow()
    },
    absent() {
      kernelGroupAbsent(run.pid)
      if (ancestry) kernelGroupAbsent(ancestry.reaper)
      for (const pid of [run.pid, descendant, ancestry?.anchor, ancestry?.reaper]) {
        if (pid === undefined) continue
        expect(() => process.kill(pid, 0), `fixture PID ${pid}`).toThrow(
          expect.objectContaining({ code: 'ESRCH' }),
        )
      }
    },
    exit() {
      run.child!.stdin!.end('exit\n')
    },
    ping() {
      run.child!.stdin!.write('ping\n')
    },
    tail: () => writeFile(`${receipt}.tail`, ''),
    pid: 0,
    output: '',
    errors: '',
    drainCalls: 0,
    ready: deferred<void>(),
    exited: deferred<number | null>(),
    nativeClosed: deferred<void>(),
    proven: deferred<void>(),
    drain: gate(),
    close: gate(),
    eof: gate(),
    emittedEOF: deferred<void>(),
    release: gate(),
    emittedClose: deferred<void>(),
  }
  return run
}

export function drainProcesses(ledger: Awaited<ReturnType<typeof posixFixtureLedger>>) {
  const runs: ReturnType<typeof newRun>[] = []
  let next: Plan | undefined
  const filesystem = new Set<Promise<unknown>>()
  const readDirs = new Map<string, ReturnType<typeof gate>>()
  const fixture = {
    directory: ledger.root,
    runs,
    holdReadDir(path: string) {
      const hold = gate()
      hold.hold()
      readDirs.set(path, hold)
      return hold
    },
    beforeReadDir(path: string) {
      return readDirs.get(path)?.enter()
    },
    track(path: unknown, work: Promise<unknown>) {
      if (!String(path).startsWith(`${ledger.root}/`)) return
      filesystem.add(work)
      void work.then(
        () => filesystem.delete(work),
        () => filesystem.delete(work),
      )
    },
    plan(plan: Plan) {
      next = plan
    },
    prepare(bin: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
      const plan = next!
      next = undefined
      expect(bin).toBe(process.execPath)
      if (plan.kind === 'pi') {
        expect(args.slice(0, 2)).toEqual(['--mode', 'rpc'])
        expect(args).toEqual(
          expect.arrayContaining([
            '--no-tools',
            '--no-extensions',
            '--no-skills',
            '--no-prompt-templates',
            '--no-context-files',
            '--no-mcp',
            '--no-approve',
            '--append-system-prompt',
            'fixture instruction',
          ]),
        )
        expect(env.FIXTURE_PERMISSION).toBe('unchanged')
        expect(env.PATH).toContain(ledger.root)
      } else {
        expect(env.FIXTURE_PERMISSION).toBe('unchanged')
        if (plan.kind !== 'job') {
          expect(args).toContain(NOTIFICATIONS_OVERRIDE)
          expect(env[SESSION_ENV]).toBe('p676767676767')
        }
        if (plan.kind === 'pty') {
          expect(args).not.toContain('--sandbox')
          expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
          expect(env.PATH).toContain(ledger.root)
        } else {
          expect(args).toContain(cwd)
          expect(env.CODEX_HOME).toBe(`${cwd}.agent/codex-home`)
        }
      }
      if (plan.kind === 'job' || plan.kind === 'fenced') {
        expect(args).toContain('workspace-write')
        expect(args).toContain('sandbox_workspace_write.network_access=false')
        expect(args).toContain(
          plan.kind === 'job' ? 'approval_policy="never"' : 'approval_policy="on-request"',
        )
      }
      const run = newRun(plan, ledger.root, runs.length, cwd, env.CODEX_HOME ?? '')
      runs.push(run)
      return run
    },
    record(
      run: ReturnType<typeof newRun>,
      child: ChildProcess,
      control: string,
      gateClose: boolean,
    ) {
      run.child = child
      run.pid = ledger.record(child)
      run.ancestry = ledger.retain(run.pid, run.nativeDrain!, run.nativeClosed.promise, control)
      child.on('error', (error) => {
        run.errors += String(error)
      })
      child.once('close', () => run.nativeClosed.resolve())
      child.stdin!.on('error', () => {})
      child.stdout!.on('data', (bytes: Buffer) => {
        run.output += bytes.toString()
        if (run.output.includes('fixture-ready\n')) run.ready.resolve()
      })
      child.stderr!.on('data', (bytes: Buffer) => {
        run.errors += bytes.toString()
      })
      child.once('exit', run.exited.resolve)
      if (!gateClose) return
      if (run.kind === 'pi') {
        // Gate stdout EOF independently of child close; data flows normally.
        const stdout = child.stdout!
        const emitOutput = stdout.emit.bind(stdout)
        let delivery: Promise<void> | undefined
        stdout.emit = (event: string | symbol, ...args: unknown[]) => {
          if (event !== 'end' && event !== 'close') return emitOutput(event, ...args)
          delivery = (delivery ?? run.eof.enter()).then(() => {
            emitOutput(event, ...args)
            run.emittedEOF.resolve()
          })
          return true
        }
      }
      const emit = child.emit.bind(child)
      child.emit = (event: string | symbol, ...args: unknown[]) => {
        if (event !== 'close') return emit(event, ...args)
        run.nativeClosed.resolve()
        void run.close.enter().then(() => {
          emit(event, ...args)
          run.emittedClose.resolve()
        })
        return true
      }
    },
    openGates() {
      for (const hold of readDirs.values()) hold.open()
      for (const run of runs) {
        run.drain.open()
        run.close.open()
        run.eof.open()
        run.release.open()
      }
    },
    async joinOutput() {
      for (const run of runs) {
        if (!run.child) continue
        await bounded(run.emittedClose.promise, `close ${run.pid}`)
        expect(run.ptyOutput?.timerPending() ?? false).toBe(false)
        run.absent()
      }
      while (filesystem.size) await Promise.allSettled([...filesystem])
      expect(
        (await readdir(ledger.root)).filter((name) => name.startsWith('holi-launch-')),
      ).toEqual([])
    },
    reset() {
      native.fixture = null
    },
  }
  native.fixture = fixture
  return fixture
}

export async function bounded<T>(work: Promise<T>, label: string, timeout = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export const physical = (proof: Promise<void>, label: string) => bounded(proof, label, 15_000)
