import { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
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
import { basename, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import {
  UnconfirmedOwnedProgramError,
  type ManagedOwnedChild,
  type OwnedCompletion,
} from '../../../main/plugin-api'
import { readJobEvent } from '../main/codex'
import { CopyBackCancelled, createJobs, type Jobs, type JobsDeps } from '../main/host/jobs'
import { createPtySessions } from '../main/host/pty-sessions'
import { createFencedSessions } from '../main/host/fenced'
import { bounded } from '../main/host/bounded'
import { activationOwnership } from '../main/host/ownership'
import type { OpenArgs } from '../main/host/terminals'
import type { SessionSummary } from '../main/claude/listing'
import type { AgentProvider, JobsProvider } from '../main/provider'
import { trackedJobProcesses } from './fixtures/tracked-job-processes'

const native = vi.hoisted(() => ({
  gates: [] as Array<{
    method: string
    matches(args: unknown[]): boolean
    entered(): void
    wait: Promise<void>
    release(): void
    error?: Error
  }>,
  operations: new Set<Promise<unknown>>(),
  previousFailure: null as { method: 'readFile' | 'close'; fail(): never } | null,
}))

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const wrap =
    (method: 'mkdir' | 'readdir' | 'rm' | 'writeFile' | 'link') =>
    (...args: unknown[]) => {
      const work = (async () => {
        const gate = native.gates.find((g) => g.method === method && g.matches(args))
        if (gate) {
          gate.entered()
          await gate.wait
          if (gate.error) throw gate.error
        }
        return (fs[method] as (...args: unknown[]) => Promise<unknown>)(...args)
      })()
      native.operations.add(work)
      void work.then(
        () => native.operations.delete(work),
        () => native.operations.delete(work),
      )
      return work
    }
  return {
    ...fs,
    link: wrap('link'),
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      const path = String(args[0])
      if (path.endsWith('.owned')) {
        for (const operation of ['sync', 'close'] as const) {
          const action = handle[operation].bind(handle)
          handle[operation] = async () => {
            const gate = native.gates.find(
              (g) => g.method === `marker-${operation}` && g.matches([path]),
            )
            if (gate) {
              gate.entered()
              await gate.wait
              if (gate.error && operation === 'sync') throw gate.error
            }
            await action()
            if (gate?.error) throw gate.error
          }
        }
      }
      if (basename(path) === 'previous' && native.previousFailure !== null) {
        const failure = native.previousFailure
        native.previousFailure = null
        if (failure.method === 'readFile') {
          handle.readFile = async () => failure.fail()
        } else {
          const close = handle.close.bind(handle)
          handle.close = async () => {
            await close()
            failure.fail()
          }
        }
      }
      return handle
    },
    mkdir: wrap('mkdir'),
    readdir: wrap('readdir'),
    rm: wrap('rm'),
    writeFile: wrap('writeFile'),
  }
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function hold(method: string, matches: (args: unknown[]) => boolean) {
  const entered = deferred()
  const gate = deferred()
  let calls = 0
  const entry: (typeof native.gates)[number] = {
    method,
    matches,
    entered: () => {
      calls += 1
      entered.resolve()
    },
    wait: gate.promise,
    release: gate.resolve,
  }
  native.gates.push(entry)
  return {
    entered: entered.promise,
    release: gate.resolve,
    calls: () => calls,
    fail: (error: Error) => {
      entry.error = error
      gate.resolve()
    },
  }
}

const roots: string[] = []
const drains: Array<() => Promise<void>> = []
const owners: Jobs[] = []
const processes: Array<ReturnType<typeof trackedJobProcesses>> = []
afterEach(async () => {
  for (const gate of native.gates) gate.release()
  native.gates.length = 0
  native.previousFailure = null
  vi.useRealTimers()
  await Promise.all(processes.splice(0).map((tracked) => tracked.drain()))
  for (const drain of drains.splice(0)) await drain().catch(() => {})
  await Promise.allSettled(owners.splice(0).map((jobs) => jobs.leave()))
  while (native.operations.size > 0) await Promise.allSettled([...native.operations])
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const SCRIPT_EVENTS = [
  '{"type":"thread.started","thread_id":"123e4567-e89b-42d3-a456-426614174000"}',
  '{"type":"turn.completed"}',
].join('\n')
const SCRIPT = `console.log(${JSON.stringify(SCRIPT_EVENTS)})`

async function rig(options: Partial<JobsDeps> = {}, durableOwnership = false) {
  // Copy-back uses canonical paths. Match those even when TMPDIR is a symlink.
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'holi-finalization-'))
  roots.push(dir)
  const root = join(dir, 'vault')
  const scratchRoot = join(dir, 'jobs')
  const tracked = trackedJobProcesses(dir)
  processes.push(tracked)
  await mkdir(root)
  const provider: JobsProvider = {
    id: 'codex',
    label: 'Codex',
    notInstalled: 'missing',
    installed: () => true,
    configure: async () => ({ dir }),
    terminal: () => null,
    capabilities: {
      jobs: {
        command: () => ({ bin: process.execPath, args: ['-e', SCRIPT], env: {} }),
        event: readJobEvent,
      },
    },
  }
  let endedTurns = 0
  const vault = { remote: 'fixture/vault', root }
  const ownership = durableOwnership
    ? activationOwnership(dir, vault, new AbortController().signal)
    : undefined
  const jobs = createJobs({
    vault,
    scratchRoot,
    ...(ownership && { ownership }),
    onChange: () => {},
    log: () => {},
    bracket: (_id, edge) => {
      if (edge === 'end') endedTurns += 1
    },
    keepMs: 600_000,
    killGraceMs: 1,
    spawn: (...args) => tracked.spawn(...args),
    ...options,
  })
  owners.push(jobs)
  const start = async () => {
    const result = await jobs.start({ provider, name: 'fixture', prompt: 'go', allow: [] })
    if (!result.ok) throw new Error(result.message)
    return result.sessionId
  }
  const idle = async (scratch = false) => {
    // The real lease runs its TERM-to-KILL grace before a turn can settle.
    if (!scratch) await vi.waitFor(() => expect(endedTurns).toBeGreaterThan(0), { timeout: 5_000 })
    await vi.waitFor(
      () =>
        expect(jobs.sessions()[0]).toMatchObject({ state: 'idle', outcome: expect.any(String) }),
      { timeout: 5_000 },
    )
    // The row precedes the last settlement microtasks.
    await tick()
  }
  return { jobs, provider, root, scratchRoot, start, idle, dir, tracked }
}

it.each(['scratch', 'vault'] as const)(
  'retains failed %s release ownership through stop, follow-up and repeated leave',
  async (kind) => {
    const t = await rig()
    const release = vi.fn(async () => {
      throw new Error('release refused')
    })
    t.provider.release = release
    const result = await t.jobs.start({
      provider: t.provider,
      name: 'fixture',
      prompt: 'go',
      ...(kind === 'vault' ? { allow: [] } : { scope: { read: [], write: [] } }),
    })
    if (!result.ok) throw new Error(result.message)
    const state = join(t.scratchRoot, `${result.sessionId}.agent`)
    await writeFile(join(state, 'owned'), 'provider resource')
    await t.idle(kind === 'scratch')
    expect(() => t.jobs.message(result.sessionId, 'must not clear the failure')).toThrow()
    for (let i = 0; i < 2; i++) {
      await expect(t.jobs.stop(result.sessionId)).rejects.toThrow('release refused')
      expect(() => t.jobs.message(result.sessionId, 'retry')).toThrow()
      await expect(t.jobs.leave()).rejects.toThrow('did not drain')
      expect(await readFile(join(state, 'owned'), 'utf8')).toBe('provider resource')
      expect(t.jobs.has(result.sessionId)).toBe(true)
    }
    expect(release).toHaveBeenCalledTimes(1)
  },
)

it('keeps the first retirement timeout after late deletion without unindexing or retiring evidence', async () => {
  const t = await rig({}, true)
  const id = await t.start()
  await t.idle()
  const state = join(t.scratchRoot, `${id}.agent`)
  const gate = hold('rm', (args) => args[0] === state)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const first = t.jobs.stop(id).catch((error: unknown) => error)
  await gate.entered
  const concurrent = t.jobs.stop(id).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(5_001)
  const timeout = await first
  expect(timeout).toBeInstanceOf(Error)
  expect(timeout).toHaveProperty('message', expect.stringContaining('timed out'))
  expect(await concurrent).toBe(timeout)
  await expect(t.jobs.stop(id)).rejects.toBe(timeout)
  await access(state)

  // The in-flight removal can finish. It must not proceed to the PID or
  // caller receipts, retire the durable ownership link, or remove the row.
  gate.release()
  await Promise.all([...native.operations])
  await tick()
  await expect(access(state)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(gate.calls()).toBe(1)
  expect(t.jobs.has(id)).toBe(true)
  if (process.platform !== 'win32') {
    await access(join(t.scratchRoot, `${id}.pid`))
    expect(await readFile(join(t.scratchRoot, `${id}.turn`), 'utf8')).toBe(
      `HOLI-JOB-1 ${id}\nSETTLED\n`,
    )
    const owners = join(t.dir, 'agent-ownership')
    const [scope] = await readdir(owners)
    const jobs = join(owners, scope!, 'jobs')
    const [link] = await readdir(jobs)
    expect(link).toMatch(/^[\da-f-]{36}$/)
    expect(await readFile(join(jobs, link!, 'failed'), 'utf8')).toContain('timed out')
  }
  await expect(t.jobs.stop(id)).rejects.toBe(timeout)
  await expect(t.jobs.leave()).rejects.toMatchObject({ errors: [timeout] })
})

it('keeps a delayed startup sweep owned across timeout and repeated leave', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const gate = hold('readdir', (args) => String(args[0]).endsWith('/jobs'))
  const t = await rig()
  await gate.entered
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const first = t.jobs.leave()
  const failed = expect(first).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(5_001)
  await failed
  let left = false
  const retry = t.jobs.leave().then(() => {
    left = true
  })
  await tick()
  expect(left).toBe(false)
  gate.release()
  await retry
  await mkdir(t.scratchRoot)
  await writeFile(join(t.scratchRoot, 'replacement'), 'new activation')
  await t.jobs.leave()
  expect(await readFile(join(t.scratchRoot, 'replacement'), 'utf8')).toBe('new activation')
})

it.each(['new', 'known', 'competing'] as const)(
  'cancels %s copy publication after awaited temporary-file preparation',
  async (kind) => {
    const t = await rig()
    // Join initial sweep before creating any fixture under the scratch namespace.
    const id = await t.start()
    await t.idle()
    await t.jobs.stop(id)
    const source = join(t.dir, 'source')
    await mkdir(source)
    await writeFile(join(source, 'note.md'), 'agent version')
    const target = join(t.root, 'note.md')
    const made = new Map<string, string>()
    if (kind !== 'new') {
      await writeFile(target, 'original')
      made.set('note.md', createHash('sha256').update('original').digest('hex'))
    }
    const gate = hold('writeFile', (args) => basename(String(args[0])).startsWith('.holi-tmp-'))
    const controller = new AbortController()
    const copy = t.jobs.copyBack(source, ['note.md'], made, controller.signal)
    const cancelled = expect(copy).rejects.toThrow('cancelled')
    await gate.entered
    controller.abort()
    if (kind === 'competing') await writeFile(target, 'unrelated newer file')
    gate.release()
    await cancelled
    if (kind === 'new') await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' })
    else
      expect(await readFile(target, 'utf8')).toBe(
        kind === 'known' ? 'original' : 'unrelated newer file',
      )
    expect((await readdir(t.root)).filter((name) => name.startsWith('.holi-'))).toEqual([])
  },
)

it.each(['null', 'throw', 'spawn'] as const)(
  'classifies follow-up refusal from %s before retiring its owner',
  async (mode) => {
    const t = await rig()
    const cleanup = deferred()
    const spawnError = Object.assign(new Error('spawn refused without a launch receipt'), {
      cleanup: cleanup.promise,
    })
    drains.push(async () => cleanup.resolve())
    if (mode === 'spawn') {
      const original = t.tracked.spawn
      // Use the real leased adapter for the first turn only. The follow-up
      // simulates a native spawn refusal (with no started child).
      const refused = vi.spyOn(t.tracked, 'spawn').mockImplementationOnce(original)
      refused.mockImplementation(() => {
        throw spawnError
      })
    }
    const id = await t.start()
    await t.idle()
    if (mode !== 'spawn')
      t.provider.capabilities.jobs.command = () => {
        if (mode === 'throw') throw new Error('command refused')
        return null
      }
    const gate = deferred()
    const entered = deferred()
    const release = vi.fn(async () => {
      entered.resolve()
      await gate.promise
    })
    t.provider.release = release
    drains.push(async () => gate.resolve())
    t.jobs.message(id, 'follow up')
    if (process.platform === 'win32') cleanup.resolve()
    if (mode === 'spawn' && process.platform !== 'win32') {
      // Joining cancellation is necessary, but the synchronous adapter throw
      // never proved nonlaunch. A successful cancellation is not a launch receipt.
      const stopping = t.jobs.stop(id)
      const settled = vi.fn()
      void stopping.then(settled, settled)
      await tick()
      expect(settled).not.toHaveBeenCalled()
      expect(release).not.toHaveBeenCalled()
      cleanup.resolve()
      await expect(stopping).rejects.toBe(spawnError)
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(t.jobs.stop(id)).rejects.toBe(spawnError)
        await expect(t.jobs.leave()).rejects.toMatchObject({ errors: [spawnError] })
      }
      expect(release).not.toHaveBeenCalled()
      expect(t.jobs.has(id)).toBe(true)
      await access(join(t.scratchRoot, `${id}.agent`))
      await expect(access(join(t.scratchRoot, `${id}.pid`))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      return
    }
    await entered.promise
    let stopped = false
    const stop = t.jobs.stop(id).then(() => {
      stopped = true
    })
    await tick()
    expect(stopped).toBe(false)
    gate.resolve()
    await stop
    expect(t.jobs.sessions()[0]).toMatchObject({ state: 'idle', outcome: 'failed' })
    await t.jobs.leave()
    expect(t.jobs.sessions()).toEqual([])
  },
)

it('bounds admitted mkdir startup and retains its pending owner through retry', async () => {
  const t = await rig()
  const gate = hold('mkdir', (args) => String(args[0]).endsWith('.agent'))
  const start = t.start().catch((err: unknown) => err)
  await gate.entered
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const leave = t.jobs.leave()
  const failed = expect(leave).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(5_001)
  await failed
  let done = false
  const retry = t.jobs.leave().then(() => {
    done = true
  })
  await tick()
  expect(done).toBe(false)
  expect(t.tracked.count).toBe(0)
  gate.release()
  expect(await start).toBeInstanceOf(Error)
  await retry
  await expect(access(t.scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(t.tracked.count).toBe(0)
})

function windowsChild() {
  let prove!: (value: OwnedCompletion) => void
  let reject!: (reason: Error) => void
  const ownedCompletion = new Promise<OwnedCompletion>((res, rej) => {
    prove = res
    reject = rej
  })
  const kill = vi.fn(() => true)
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    kill,
    ownedCompletion,
  })
  const finish = (proof: OwnedCompletion = 'empty') => {
    child.stdout.end(`${SCRIPT_EVENTS}\n`)
    child.stderr.end()
    child.emit('close', 0, null)
    prove(proof)
  }
  drains.push(async () => finish())
  return {
    child: child as unknown as ManagedOwnedChild,
    stdout: child.stdout,
    kill,
    finish,
    reject,
  }
}

it('joins every admitted input copy after a known Stop failure without blocking another vault', async () => {
  const a = windowsChild()
  const spawn = vi.fn(() => a.child)
  const t = await rig({ platform: 'win32', spawn })
  const release = vi.fn()
  t.provider.release = release
  const start = (name: string, read: string[], write: string[] = []) =>
    t.jobs.start({ provider: t.provider, name, prompt: 'go', scope: { read, write } })
  const started = await start('uncertain', [], ['result.md'])
  if (!started.ok) throw new Error(started.message)
  const { sessionId: id } = started
  const state = join(t.scratchRoot, `${id}.agent`, 'provider-resource')
  const scratch = join(t.scratchRoot, id, 'result.md')
  await writeFile(state, 'owned provider state')
  await writeFile(scratch, 'unconfirmed output')
  a.stdout.write(`${SCRIPT_EVENTS}\n`)
  const owned = (await readdir(t.scratchRoot)).sort()

  const input = 'input.md'
  const competing = 'competing.md'
  for (const name of [input, competing]) await writeFile(join(t.root, name), 'input copy')
  const gate = hold('writeFile', ([path]) => basename(String(path)) === input)
  const secondary = hold('writeFile', ([path]) => basename(String(path)) === competing)
  const b = start('copying', [input])
  const b2 = start('copying with error', [competing]).catch((err: unknown) => err)
  await Promise.all([gate.entered, secondary.entered])

  const lease = { revoke: vi.fn(async () => {}) }
  const failure = new UnconfirmedOwnedProgramError(new Error('native query rejected'), lease)
  let pendingAtRejection: number | undefined
  const leave = t.jobs.leave().catch((err: unknown) => {
    pendingAtRejection = native.operations.size
    return err
  })
  await expect(start('closed', [input])).resolves.toMatchObject({ ok: false })
  const stop = expect(t.jobs.stop(id)).rejects.toBe(failure)
  a.reject(failure)
  await stop
  expect(a.kill).toHaveBeenCalledTimes(1)
  await tick()
  expect(pendingAtRejection).toBeUndefined()

  const prepFailure = new Error('input scratch write rejected')
  secondary.fail(prepFailure)
  expect(await b2).toBe(prepFailure)
  await tick()
  expect(pendingAtRejection).toBeUndefined()

  const c = windowsChild()
  const third = await rig({ platform: 'win32', spawn: () => c.child })
  await third.start()
  c.finish()
  await third.idle()
  await third.jobs.leave()
  expect(pendingAtRejection).toBeUndefined()

  gate.release()
  await expect(b).resolves.toMatchObject({ ok: false })
  expect(await leave).toBe(failure)
  expect(pendingAtRejection).toBe(0)
  await tick()
  expect(native.operations.size).toBe(0)
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(release).not.toHaveBeenCalled()
  expect(lease.revoke).not.toHaveBeenCalled()
  expect(a.child.pid).toBeUndefined()
  expect(t.jobs.sessions()).toEqual([expect.objectContaining({ id, outcome: 'failed' })])
  expect((await readdir(t.scratchRoot)).sort()).toEqual(owned)
  expect(await readFile(state, 'utf8')).toBe('owned provider state')
  expect(await readFile(scratch, 'utf8')).toBe('unconfirmed output')
  await expect(access(join(t.root, 'result.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(t.jobs.stop(id)).rejects.toBe(failure)
  await expect(t.jobs.leave()).rejects.toBe(failure)
})

it('cancels starts queued before recovery admits them without touching scratch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'holi-queued-jobs-'))
  roots.push(dir)
  const scratchRoot = join(dir, 'queued-jobs')
  await mkdir(scratchRoot)
  const recovery = hold('readdir', ([path]) => path === scratchRoot)
  const mkdirState = hold('mkdir', ([path]) => String(path).endsWith('.agent'))
  const spawn = vi.fn(() => {
    throw new Error('queued start spawned')
  })
  const t = await rig({ scratchRoot, platform: 'win32', spawn })
  await recovery.entered
  const starts = Array.from({ length: 10 }, () =>
    t.jobs.start({
      provider: t.provider,
      name: 'queued',
      prompt: 'go',
      scope: { read: [], write: [] },
    }),
  )
  const leave = t.jobs.leave()
  void leave.catch(() => {})
  for (const result of await Promise.all(starts)) expect(result).toMatchObject({ ok: false })
  expect(mkdirState.calls()).toBe(0)
  expect(spawn).not.toHaveBeenCalled()
  recovery.release()
  await leave
  await expect(access(scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('joins an admitted JSONL turn finalizer despite a sibling Stop rejection', async () => {
  const a = windowsChild()
  const b = windowsChild()
  const finalizer = deferred()
  const entered = deferred()
  drains.push(async () => finalizer.resolve())
  const spawn = vi.fn().mockReturnValueOnce(a.child).mockReturnValueOnce(b.child)
  const t = await rig({
    platform: 'win32',
    spawn,
    bracket: async (_id, edge) => {
      if (edge !== 'end') return
      entered.resolve()
      await finalizer.promise
      await writeFile(join(t.root, 'turn.log'), 'settled output')
    },
  })
  const aId = await t.start()
  const bId = await t.start()
  b.finish()
  await entered.promise
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let left = false
  const leave = t.jobs.leave().catch((err: unknown) => {
    left = true
    return err
  })
  const failure = new UnconfirmedOwnedProgramError(new Error('proof failed'))
  const stop = expect(t.jobs.stop(aId)).rejects.toBe(failure)
  a.reject(failure)
  await stop
  await vi.advanceTimersByTimeAsync(5_002)
  expect(left).toBe(false)
  finalizer.resolve()
  expect(await leave).toBe(failure)
  expect(await readFile(join(t.root, 'turn.log'), 'utf8')).toBe('settled output')
  expect(await readdir(t.scratchRoot)).toContainEqual(
    expect.stringMatching(`^${aId}\\..*\\.owned$`),
  )
  expect(
    (await readdir(t.scratchRoot)).some(
      (name) => name.startsWith(`${bId}.`) && name.endsWith('.owned'),
    ),
  ).toBe(false)
})

it('joins host work but not an unresponsive Windows child after the Stop deadline', async () => {
  const a = windowsChild()
  const gate = deferred()
  const entered = deferred()
  drains.push(async () => gate.resolve())
  const bracket = vi.fn(async (_id, edge) => {
    if (edge !== 'begin') return
    entered.resolve()
    await gate.promise
  })
  const t = await rig({ platform: 'win32', spawn: () => a.child, bracket })
  const release = vi.fn()
  t.provider.release = release
  const id = await t.start()
  await entered.promise
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let left = false
  const leave = t.jobs.leave().catch((err: unknown) => {
    left = true
    return err
  })
  const stop = t.jobs.stop(id).catch((err: unknown) => err)
  await vi.advanceTimersByTimeAsync(5_002)
  const failure = await stop
  expect(failure).toMatchObject({ message: expect.stringContaining('timed out') })
  expect(left).toBe(false)
  gate.resolve()
  expect(await leave).toBe(failure)
  // Actual proof and EOF may come later, but this retired host must not write.
  a.finish()
  await tick()
  expect(a.kill).toHaveBeenCalledTimes(1)
  expect(bracket.mock.calls.map(([, edge]) => edge)).toEqual(['begin'])
  expect(release).not.toHaveBeenCalled()
  expect(t.jobs.has(id)).toBe(true)
  expect(await readdir(t.scratchRoot)).toContainEqual(expect.stringMatching(/\.owned$/))
  await expect(t.jobs.stop(id)).rejects.toBe(failure)
})

it.each(['stop', 'activation', 'leave'] as const)(
  'revokes Windows spawn on %s during marker close, and bounds the same Stop for all waiters',
  async (kind) => {
    const activation = new AbortController()
    const spawn = vi.fn(() => {
      throw new Error('spawn after revocation')
    })
    const t = await rig({ platform: 'win32', spawn, activationSignal: activation.signal })
    const sync = hold('marker-sync', () => true)
    const close = hold('marker-close', () => true)
    const started = t.jobs.start({
      provider: t.provider,
      name: 'marker',
      prompt: 'go',
      scope: { read: [], write: [] },
    })
    await sync.entered
    expect(spawn).not.toHaveBeenCalled()
    const id = t.jobs.sessions()[0]!.id
    const marker = (await readdir(t.scratchRoot)).find((name) => name.endsWith('.owned'))!
    expect(await readFile(join(t.scratchRoot, marker), 'utf8')).toBe(
      'pending Windows job ownership\n',
    )
    sync.release()
    await close.entered
    expect(spawn).not.toHaveBeenCalled()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let left = false
    const leaving =
      kind === 'leave'
        ? t.jobs.leave().catch((err: unknown) => {
            left = true
            return err
          })
        : undefined
    if (kind === 'activation') activation.abort()
    const results = Promise.allSettled(Array.from({ length: 20 }, () => t.jobs.stop(id)))
    await tick()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5_002)
    const [first, ...others] = await results
    expect(first).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('timed out') }),
    })
    if (first?.status !== 'rejected') throw new Error('Stop unexpectedly settled')
    for (const result of others) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(result.reason).toBe(first.reason)
    }
    expect(left).toBe(false)
    await expect(t.jobs.stop(id)).rejects.toBe(first.reason)
    expect(vi.getTimerCount()).toBe(0)
    expect(await readdir(t.scratchRoot)).toContain(marker)
    close.release()
    await expect(started).resolves.toMatchObject({ ok: false })
    if (leaving !== undefined) expect(await leaving).toBe(first.reason)
    expect(spawn).not.toHaveBeenCalled()
    expect(t.jobs.sessions()).toEqual([])
    await t.jobs.leave()
    await expect(access(t.scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it('publishes a fresh Windows marker for a follow-up and refuses to spawn when syncing it fails', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 9001,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    kill: vi.fn(),
    ownedCompletion: Promise.resolve('empty' as const),
  })
  const spawn = vi.fn(() => child as unknown as ChildProcess)
  const t = await rig({ platform: 'win32', spawn })
  let firstPath: unknown
  const first = hold('marker-sync', ([path]) => {
    firstPath ??= path
    return path === firstPath
  })
  const launching = t.start()
  try {
    await first.entered
    expect(spawn).not.toHaveBeenCalled()
    const previous = (await readdir(t.scratchRoot)).find((name) => name.endsWith('.owned'))
    first.release()
    const id = await launching
    child.stdout.end(`${SCRIPT_EVENTS}\n`)
    child.stderr.end()
    child.emit('close', 0, null)
    await t.idle()

    const next = hold('marker-sync', ([path]) => basename(String(path)) !== previous)
    // The idle outcome is published before marker removal. A follow-up can
    // be admitted only after that finalization has actually completed.
    await vi.waitFor(() => t.jobs.message(id, 'follow up'))
    await next.entered
    const names = await readdir(t.scratchRoot)
    expect(names).not.toContain(previous)
    expect(names.filter((name) => name.endsWith('.owned'))).toHaveLength(1)
    next.fail(new Error('could not flush marker'))
    await vi.waitFor(async () => {
      expect(t.jobs.sessions()[0]).toMatchObject({
        state: 'idle',
        outcome: 'failed',
        error: expect.stringContaining('could not flush marker'),
      })
      expect((await readdir(t.scratchRoot)).filter((name) => name.endsWith('.owned'))).toEqual([])
    })
    expect(spawn).toHaveBeenCalledTimes(1)
    await t.jobs.leave()
  } finally {
    first.release()
    // Settle fake output and control even if a preceding assertion failed.
    await launching.catch(() => {})
    child.stdout.end()
    child.stderr.end()
    child.emit('close', 0, null)
  }
})

it('refuses an unreadable Windows scratch namespace without deleting its contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'holi-unreadable-jobs-'))
  roots.push(dir)
  const scratchRoot = join(dir, 'jobs')
  await mkdir(scratchRoot)
  const path = join(scratchRoot, 'retained')
  await writeFile(path, 'not safe to sweep')
  const listing = hold('readdir', ([path]) => path === scratchRoot)
  const spawn = vi.fn(() => {
    throw new Error('spawned against unverified scratch')
  })
  const t = await rig({ scratchRoot, spawn, platform: 'win32' })
  await listing.entered
  const denied = new Error('cannot list jobs')
  listing.fail(denied)
  await expect(t.start()).rejects.toThrow('cannot list jobs')
  await expect(t.jobs.leave()).rejects.toBe(denied)
  expect(spawn).not.toHaveBeenCalled()
  expect(await readFile(path, 'utf8')).toBe('not safe to sweep')
})

it('bounds final root deletion and joins the underlying operation on retry', async () => {
  const t = await rig()
  const id = await t.start()
  await t.idle()
  const gate = hold('rm', (args) => args[0] === t.scratchRoot)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const leave = t.jobs.leave()
  const failed = expect(leave).rejects.toThrow('timed out')
  await gate.entered
  await vi.advanceTimersByTimeAsync(5_001)
  await failed
  expect(t.jobs.has(id)).toBe(false)
  let done = false
  const retry = t.jobs.leave().then(() => {
    done = true
  })
  await tick()
  expect(done).toBe(false)
  expect(gate.calls()).toBe(1)
  gate.release()
  await retry
  await mkdir(t.scratchRoot)
  await writeFile(join(t.scratchRoot, 'replacement'), 'safe')
  await t.jobs.leave()
  expect(await readFile(join(t.scratchRoot, 'replacement'), 'utf8')).toBe('safe')
})

function finishExit(args: OpenArgs | undefined, title?: string) {
  if (!args) return
  return Promise.resolve(args.onExit?.(title)).then(() => args.onRetired?.())
}

async function ptyRig() {
  const dir = await mkdtemp(join(tmpdir(), 'holi-history-race-'))
  roots.push(dir)
  const history = join(dir, 'history.json')
  await writeFile(history, '[]')
  let failWrites = 0
  const historyFailure = new Error('history unavailable')
  const provider: AgentProvider = {
    id: 'codex',
    label: 'Codex',
    notInstalled: 'missing',
    installed: () => true,
    configure: async () => ({ dir }),
    terminal: () => ({ bin: 'fixture', args: [], env: {} }),
    capabilities: {},
  }
  const opened: OpenArgs[] = []
  let closeError: Error | undefined
  let closeWait: Promise<void> | undefined
  let closeCalls = 0
  const sessions = createPtySessions({
    vault: { remote: 'fixture/vault', root: dir },
    providers: () => [provider],
    binDir: () => null,
    bracket: () => {},
    onChange: () => {},
    log: () => {},
    past: {
      read: async () => JSON.parse(await readFile(history, 'utf8')) as SessionSummary[],
      write: async (rows) => {
        if (failWrites > 0) {
          failWrites -= 1
          throw historyFailure
        }
        await writeFile(history, JSON.stringify(rows))
      },
    },
    terminals: {
      open: (args) => {
        opened.push(args)
        return { ok: true, id: `terminal-${opened.length}` }
      },
      close: async (id) => {
        closeCalls += 1
        if (closeError) throw closeError
        await closeWait
        await finishExit(opened[Number(id.split('-')[1]) - 1])
      },
      paste: () => true,
      list: () => [],
    },
  })
  return {
    sessions,
    opened,
    provider,
    history,
    historyFailure,
    fail: (count: number) => {
      failWrites = count
    },
    holdClose: (wait: Promise<void>) => {
      closeWait = wait
    },
    closeCalls: () => closeCalls,
    closeFails: (err?: Error) => {
      closeError = err
    },
  }
}

it('never replays a failed reopen removal after the newer close append', async () => {
  const t = await ptyRig()
  const old: SessionSummary = {
    id: 'p0123456789ab',
    provider: 'codex',
    name: 'old',
    state: 'idle',
    startedAt: 1,
    conversationId: '123e4567-e89b-42d3-a456-426614174000',
  }
  await writeFile(t.history, JSON.stringify([old]))
  t.fail(1)
  await expect(t.sessions.reopen(old.id, {})).rejects.toThrow('history unavailable')
  t.sessions.noteConversation(old.id, { conversationId: '123e4567-e89b-42d3-a456-426614174001' })
  finishExit(t.opened[0])
  await t.sessions.leave()
  expect(JSON.parse(await readFile(t.history, 'utf8'))).toEqual([
    expect.objectContaining({ id: old.id, conversationId: '123e4567-e89b-42d3-a456-426614174001' }),
  ])
})

it('preserves an older failed append when an unrelated conversation saves successfully', async () => {
  const t = await ptyRig()
  const first = await t.sessions.start('codex', {})
  const second = await t.sessions.start('codex', {})
  if (!first.ok || !second.ok) throw new Error('fixture start refused')
  for (const [i, started] of [first, second].entries()) {
    t.sessions.noteConversation(started.sessionId, {
      conversationId: `123e4567-e89b-42d3-a456-42661417400${i}`,
    })
  }
  t.fail(1)
  await expect(finishExit(t.opened[0])).rejects.toBe(t.historyFailure)
  await t.sessions.past()
  expect(JSON.parse(await readFile(t.history, 'utf8'))).toEqual([])
  await finishExit(t.opened[1])
  await t.sessions.past()
  const rows = JSON.parse(await readFile(t.history, 'utf8')) as SessionSummary[]
  expect(rows.map((row) => row.id)).toEqual([second.sessionId, first.sessionId])
  await expect(t.sessions.stop(first.sessionId)).rejects.toBe(t.historyFailure)
  await expect(t.sessions.leave()).rejects.toMatchObject({ errors: [t.historyFailure] })
})

it.each(['session', 'sign-in'] as const)(
  'observes immediate close rejection while another %s configure is stalled',
  async (kind) => {
    const t = await ptyRig()
    const started = await t.sessions.start('codex', {})
    if (!started.ok) throw new Error(started.message)
    // A second provider bypasses the first provider\'s already configured cache.
    t.provider.id = 'fixture-other'
    const gate = deferred()
    const entered = deferred()
    t.provider.configure = async () => {
      entered.resolve()
      await gate.promise
      return { dir: '/fixture' }
    }
    if (kind === 'sign-in')
      t.provider.capabilities.background = {} as NonNullable<
        AgentProvider['capabilities']['background']
      >
    const starting = t.sessions.start('fixture-other', kind === 'sign-in' ? { login: true } : {})
    await entered.promise
    const cause = new Error('close refused')
    t.closeFails(cause)
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => {
      unhandled.push(err)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const leaving = t.sessions.leave()
      const failed = expect(leaving).rejects.toThrow('did not drain')
      await tick()
      await tick()
      expect(unhandled).toEqual([])
      expect(t.sessions.has(started.sessionId)).toBe(true)
      gate.resolve()
      await starting
      await failed
      expect(unhandled).toEqual([])
      expect(t.sessions.has(started.sessionId)).toBe(true)
      t.closeFails()
      await expect(t.sessions.stop(started.sessionId)).rejects.toBe(cause)
      await expect(t.sessions.leave()).rejects.toMatchObject({ errors: [cause] })
      expect(t.closeCalls()).toBe(1)
    } finally {
      gate.resolve()
      process.off('unhandledRejection', onUnhandled)
    }
  },
)

it('joins an owned PTY close beyond the old session deadline', async () => {
  const t = await ptyRig()
  const started = await t.sessions.start('codex', {})
  if (!started.ok) throw new Error(started.message)
  const gate = deferred()
  t.holdClose(gate.promise)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const leaving = t.sessions.leave()
    const settled = vi.fn()
    void leaving.then(settled, settled)
    await tick()
    expect(t.sessions.has(started.sessionId)).toBe(true)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(settled).not.toHaveBeenCalled()
    let left = false
    const retry = t.sessions.leave().then(() => {
      left = true
    })
    await tick()
    expect(left).toBe(false)
    expect(t.closeCalls()).toBe(1)
    gate.resolve()
    await Promise.all([leaving, retry])
  } finally {
    gate.resolve()
  }
})

it('does not acknowledge or retry a terminal close rejected before public exit', async () => {
  const t = await ptyRig()
  const started = await t.sessions.start('codex', {})
  if (!started.ok) throw new Error(started.message)
  const cause = new Error('close failed before public exit')
  t.holdClose(Promise.reject(cause))
  await expect(t.sessions.stop(started.sessionId)).rejects.toBe(cause)
  expect(t.sessions.has(started.sessionId)).toBe(true)
  t.holdClose(Promise.resolve())
  await expect(t.sessions.stop(started.sessionId)).rejects.toBe(cause)
  await expect(t.sessions.leave()).rejects.toMatchObject({ errors: [cause] })
  expect(t.closeCalls()).toBe(1)
})

async function fencedRig(options: Pick<JobsDeps, 'beforePublish'> = {}) {
  const t = await rig(options)
  // Use the real copy-back rules, without leaving a job process alive.
  await t.jobs.leave()
  const scratchRoot = join(t.dir, 'fenced')
  const provider: AgentProvider = {
    ...t.provider,
    terminal: () => ({ bin: 'fixture', args: [], env: {} }),
    capabilities: { fenced: 'sandbox' },
  }
  const opened: OpenArgs[] = []
  const activation = new AbortController()
  const sessions = createPtySessions({
    vault: { root: t.root, remote: 'fixture/vault' },
    providers: () => [provider],
    binDir: () => null,
    bracket: () => {},
    onChange: () => {},
    log: () => {},
    terminals: {
      open: (args) => {
        opened.push(args)
        return { ok: true, id: `terminal-${opened.length}` }
      },
      close: async (id) => {
        await finishExit(opened[Number(id.split('-')[1]) - 1])
      },
      paste: () => true,
      list: () => [],
    },
  })
  const fenced = createFencedSessions({
    vault: { root: t.root, remote: 'fixture/vault' },
    scratchRoot,
    own: sessions,
    copyBack: t.jobs.copyBack,
    activationSignal: activation.signal,
    log: () => {},
  })
  drains.push(
    () => sessions.leave(),
    () => fenced.leave(),
  )
  const start = async (read: string[] = [], write: string[] = []) => {
    const result = await fenced.start({
      provider,
      name: 'fenced',
      prompt: 'go',
      scope: { read, write },
    })
    if (!result.ok) throw new Error(result.message)
    const entry = opened.at(-1)!
    return { ...result, entry, state: `${entry.cwd}.agent` }
  }
  return { ...t, scratchRoot, provider, sessions, fenced, activation, start }
}

it('bounds fenced root removal, joins retries and never removes a replacement namespace', async () => {
  const t = await fencedRig()
  const run = await t.start()
  await t.sessions.stop(run.sessionId)
  const gate = hold('rm', (args) => args[0] === t.scratchRoot)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const first = t.fenced.leave()
  const failed = expect(first).rejects.toThrow('timed out')
  await gate.entered
  await vi.advanceTimersByTimeAsync(5_001)
  await failed
  const second = t.fenced.leave()
  const failedAgain = expect(second).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(5_001)
  await failedAgain
  expect(gate.calls()).toBe(1)
  let retired = false
  const retry = t.fenced.leave().then(() => {
    retired = true
  })
  await tick()
  expect(retired).toBe(false)
  gate.release()
  await retry
  expect(gate.calls()).toBe(1)
  await mkdir(t.scratchRoot)
  await writeFile(join(t.scratchRoot, 'replacement'), 'new activation')
  await t.fenced.leave()
  expect(await readFile(join(t.scratchRoot, 'replacement'), 'utf8')).toBe('new activation')
  expect(gate.calls()).toBe(1)
})

it('rejects stop and leave on fenced provider release failure without losing its state owner', async () => {
  const t = await fencedRig()
  const cause = new Error('release refused')
  const release = vi.fn(async () => {
    throw cause
  })
  t.provider.release = release
  const run = await t.start()
  await writeFile(join(run.state, 'owned'), 'provider resource')
  await expect(t.sessions.stop(run.sessionId)).rejects.toBe(cause)
  expect(t.sessions.sessions()).toEqual([
    expect.objectContaining({
      id: run.sessionId,
      closed: true,
      outcome: 'failed',
      error: expect.stringContaining('release refused'),
    }),
  ])
  for (let i = 0; i < 2; i++) {
    await expect(t.sessions.stop(run.sessionId)).rejects.toBe(cause)
    await expect(t.sessions.leave()).rejects.toMatchObject({ errors: [cause] })
    await expect(t.fenced.leave()).rejects.toMatchObject({ errors: [cause] })
    expect(await readFile(join(run.state, 'owned'), 'utf8')).toBe('provider resource')
  }
  expect(release).toHaveBeenCalledTimes(1)
})

it.each(['new', 'known'] as const)(
  'drains safe fenced %s publication cancellation after confirmed cleanup',
  async (kind) => {
    const t = await fencedRig()
    const target = join(t.root, 'note.md')
    if (kind === 'known') await writeFile(target, 'original')
    const run = await t.start(kind === 'known' ? ['note.md'] : [], ['note.md'])
    await writeFile(join(run.entry.cwd, 'note.md'), 'agent version')
    const gate = hold('writeFile', (args) => basename(String(args[0])).startsWith('.holi-tmp-'))
    t.sessions.noteTurn(run.sessionId, false)
    await gate.entered
    t.activation.abort()
    await t.fenced.closing()
    gate.release()
    await t.sessions.stop(run.sessionId)
    await t.sessions.leave()
    await t.fenced.leave()
    if (kind === 'known') expect(await readFile(target, 'utf8')).toBe('original')
    else await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(t.root)).filter((name) => name.startsWith('.holi-'))).toEqual([])
    await expect(access(t.scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

const stagedCopy = ([path]: unknown[]) => basename(String(path)).startsWith('.holi-tmp-')

function holdCopyBack(afterMove: boolean) {
  const staged = afterMove ? undefined : hold('writeFile', stagedCopy)
  const moved = deferred()
  const beforePublish = vi.fn((_rel: string) => moved.promise)
  return {
    beforePublish,
    async wait() {
      // Fail at the missing seam instead of awaiting an unreachable gate indefinitely.
      await vi.waitFor(
        () => {
          if (staged) expect(staged.calls()).toBe(1)
          else expect(beforePublish).toHaveBeenCalledExactlyOnceWith('note.md')
        },
        { timeout: 5_000 },
      )
    },
    release() {
      staged?.release()
      moved.resolve()
    },
  }
}

function failCopyBack(kind: 'rollback' | 'temporary cleanup', target: string) {
  const fault =
    kind === 'rollback'
      ? hold('link', ([from, to]) => basename(String(from)) === 'previous' && to === target)
      : hold('rm', stagedCopy)
  fault.fail(new Error(`${kind} refused`))
  return fault
}

it.each(['rollback', 'temporary cleanup'] as const)(
  'retains real fenced %s failure even when cancellation was requested',
  async (kind) => {
    const prep = holdCopyBack(kind === 'rollback')
    const t = await fencedRig({ beforePublish: prep.beforePublish })
    const target = join(t.root, 'note.md')
    await writeFile(target, 'original')
    const run = await t.start(['note.md'], ['note.md'])
    await writeFile(join(run.entry.cwd, 'note.md'), 'agent version')
    const fault = failCopyBack(kind, target)
    try {
      t.sessions.noteTurn(run.sessionId, false)
      await prep.wait()
      t.activation.abort()
    } finally {
      prep.release()
    }
    const cause = await t.sessions.stop(run.sessionId).catch((error: unknown) => error)
    expect(fault.calls()).toBe(1)
    expect(cause).toMatchObject({ message: expect.stringContaining(`${kind} refused`) })
    await expect(t.sessions.stop(run.sessionId)).rejects.toBe(cause)
    await expect(t.sessions.leave()).rejects.toMatchObject({ errors: [cause] })
    for (let i = 0; i < 2; i++)
      await expect(t.fenced.leave()).rejects.toMatchObject({
        message: expect.stringContaining('cleanup did not complete'),
        errors: [cause],
      })
    expect(await readFile(join(run.entry.cwd, 'note.md'), 'utf8')).toBe('agent version')
    await expect(access(run.state)).resolves.toBeUndefined()
    const leftovers = (await readdir(t.root)).filter((name) => name.startsWith('.holi-'))
    if (kind === 'rollback') {
      expect(cause).toMatchObject({ cause: expect.any(CopyBackCancelled) })
      const preserved = leftovers.find((name) => name.startsWith('.holi-copy-'))!
      expect(await readFile(join(t.root, preserved, 'previous'), 'utf8')).toBe('original')
      await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect(leftovers.some((name) => name.startsWith('.holi-tmp-'))).toBe(true)
      expect(await readFile(target, 'utf8')).toBe('original')
    }
  },
)

it.each(['safe cancellation', 'rollback', 'temporary cleanup'] as const)(
  'retains job copy-back ownership after %s without hiding restoration failures',
  async (kind) => {
    const prep = holdCopyBack(kind === 'rollback')
    const t = await rig({ beforePublish: prep.beforePublish })
    const target = join(t.root, 'note.md')
    await writeFile(target, 'original')
    t.provider.capabilities.jobs.command = () => ({
      bin: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync('note.md', 'agent version');${SCRIPT}`],
      env: {},
    })
    const fault = kind === 'safe cancellation' ? undefined : failCopyBack(kind, target)
    let id: string
    let stop: ReturnType<Jobs['stop']>
    try {
      const result = await t.jobs.start({
        provider: t.provider,
        name: 'fixture',
        prompt: 'go',
        scope: { read: ['note.md'], write: ['note.md'] },
      })
      if (!result.ok) throw new Error(result.message)
      id = result.sessionId
      await prep.wait()
      stop = t.jobs.stop(id)
    } finally {
      prep.release()
    }
    if (kind === 'safe cancellation') {
      await expect(stop).resolves.toEqual({ ok: true })
      expect(await readFile(target, 'utf8')).toBe('original')
      await t.jobs.leave()
      expect((await readdir(t.root)).filter((name) => name.startsWith('.holi-'))).toEqual([])
      await expect(access(t.scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      return
    }
    const cause = await stop.catch((error: unknown) => error)
    expect(fault?.calls()).toBe(1)
    expect(cause).toMatchObject({ message: expect.stringContaining(`${kind} refused`) })
    expect(t.jobs.sessions()[0]).toMatchObject({
      state: 'idle',
      outcome: 'failed',
      error: expect.stringContaining(`${kind} refused`),
    })
    for (let i = 0; i < 2; i++) {
      await expect(t.jobs.stop(id)).rejects.toBe(cause)
      await expect(t.jobs.leave()).rejects.toMatchObject({
        message: expect.stringContaining('did not drain'),
        errors: [cause],
      })
      expect(t.jobs.has(id)).toBe(true)
      await expect(access(join(t.scratchRoot, `${id}.agent`))).resolves.toBeUndefined()
    }
    const leftovers = (await readdir(t.root)).filter((name) => name.startsWith('.holi-'))
    if (kind === 'rollback') {
      expect(cause).toMatchObject({ cause: expect.any(CopyBackCancelled) })
      const preserved = leftovers.find((name) => name.startsWith('.holi-copy-'))!
      expect(await readFile(join(t.root, preserved, 'previous'), 'utf8')).toBe('original')
      await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect(leftovers.some((name) => name.startsWith('.holi-tmp-'))).toBe(true)
      expect(await readFile(target, 'utf8')).toBe('original')
    }
  },
)

it.each(['readFile', 'close'] as const)(
  'preserves the original when its pre-publication %s fails beside a competing file',
  async (method) => {
    const refused = new Error(`pre-publication ${method} refused`)
    const fail = vi.fn((): never => {
      throw refused
    })
    const t = await rig({
      beforePublish: async (rel) => {
        // The original was moved aside. A competing writer takes the now-free name.
        await writeFile(join(t.root, rel), 'competing version', { flag: 'wx' })
        native.previousFailure = { method, fail }
      },
    })
    const target = join(t.root, 'note.md')
    await writeFile(target, 'original')
    t.provider.capabilities.jobs.command = () => ({
      bin: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync('note.md', 'agent version');${SCRIPT}`],
      env: {},
    })
    const run = await t.jobs.start({
      provider: t.provider,
      name: 'fixture',
      prompt: 'go',
      scope: { read: ['note.md'], write: ['note.md'] },
    })
    if (!run.ok) throw new Error(run.message)
    await t.idle(true)
    expect(fail).toHaveBeenCalledOnce()
    expect(t.jobs.sessions()[0]).toMatchObject({ outcome: 'failed' })
    const cause = await t.jobs.stop(run.sessionId).catch((error: unknown) => error)
    const holdDir = (await readdir(t.root)).find((name) => name.startsWith('.holi-copy-'))!
    expect(cause).toMatchObject({
      message: `${String(refused)} The previous file is preserved at ${join(holdDir, 'previous')}.`,
    })
    expect((cause as Error).cause).toBe(refused)
    expect(await readFile(join(t.root, holdDir, 'previous'), 'utf8')).toBe('original')
    expect(await readFile(target, 'utf8')).toBe('competing version')
    await expect(t.jobs.stop(run.sessionId)).rejects.toBe(cause)
    await expect(t.jobs.leave()).rejects.toMatchObject({
      message: expect.stringContaining('did not drain'),
      errors: [cause],
    })
    expect(t.jobs.has(run.sessionId)).toBe(true)
  },
)

it.each(['pending', 'failed'] as const)(
  "stops a healthy session independently of another fenced session's %s finalization",
  async (kind) => {
    const t = await fencedRig()
    const entered = deferred()
    const gate = deferred()
    drains.unshift(async () => {
      gate.resolve()
    })
    t.provider.release = async () => {
      entered.resolve()
      await gate.promise
      if (kind === 'failed') throw new Error('unrelated release refused')
    }
    const a = await t.start()
    const b = await t.sessions.start('codex', {})
    if (!b.ok) throw new Error(b.message)
    void finishExit(a.entry)?.catch(() => {})
    await entered.promise
    if (kind === 'failed') {
      gate.resolve()
      await vi.waitFor(() =>
        expect(t.sessions.sessions()).toContainEqual(
          expect.objectContaining({ id: a.sessionId, closed: true, outcome: 'failed' }),
        ),
      )
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let stopped = false
    const stopB = t.sessions.stop(b.sessionId).then((result) => {
      stopped = true
      return result
    })
    await tick()
    await tick()
    // Settle normal promise work without advancing any teardown deadline.
    expect(stopped).toBe(true)
    expect(await stopB).toEqual({ ok: true })
    expect(t.sessions.has(b.sessionId)).toBe(false)
    const leaving = t.sessions.leave()
    if (kind === 'pending') {
      const settled = vi.fn()
      void leaving.then(settled, settled)
      await vi.advanceTimersByTimeAsync(5_001)
      // This terminal adapter models the authoritative close settlement.
      expect(settled).not.toHaveBeenCalled()
      gate.resolve()
      await leaving
      await t.fenced.leave()
    } else {
      await expect(leaving).rejects.toThrow('did not drain')
      await expect(t.fenced.leave()).rejects.toThrow()
    }
  },
)

it('bounds only the wait and rejoins the same operation after a custom deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const gate = deferred()
  const wait = bounded(gate.promise, 'fixture', 17)
  const failed = expect(wait).rejects.toThrow('fixture did not finish before teardown timed out.')
  await vi.advanceTimersByTimeAsync(17)
  await failed
  expect(vi.getTimerCount()).toBe(0)
  const retry = bounded(gate.promise, 'fixture', 17)
  gate.resolve()
  await retry
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['fulfilled', 'rejected'] as const)(
  'clears the bounded deadline when work is %s',
  async (kind) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const error = new Error('native operation failed')
    const work = kind === 'fulfilled' ? Promise.resolve(42) : Promise.reject(error)
    if (kind === 'fulfilled') await expect(bounded(work, 'fixture')).resolves.toBe(42)
    else await expect(bounded(work, 'fixture')).rejects.toBe(error)
    expect(vi.getTimerCount()).toBe(0)
  },
)
