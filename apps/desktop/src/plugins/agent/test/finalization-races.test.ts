import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { readJobEvent } from '../main/codex'
import { createJobs, type Jobs, type JobsDeps } from '../main/host/jobs'
import { createPtySessions } from '../main/host/pty-sessions'
import type { OpenArgs } from '../main/host/terminals'
import type { SessionSummary } from '../main/claude/listing'
import type { AgentProvider, JobsProvider } from '../main/provider'

const native = vi.hoisted(() => ({
  gates: [] as Array<{
    method: string
    matches(args: unknown[]): boolean
    entered(): void
    wait: Promise<void>
    release(): void
  }>,
  operations: new Set<Promise<unknown>>(),
}))

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const wrap =
    (method: 'mkdir' | 'readdir' | 'rm' | 'writeFile') =>
    (...args: unknown[]) => {
      const work = (async () => {
        const gate = native.gates.find((g) => g.method === method && g.matches(args))
        if (gate) {
          gate.entered()
          await gate.wait
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
  native.gates.push({
    method,
    matches,
    entered: () => {
      calls += 1
      entered.resolve()
    },
    wait: gate.promise,
    release: gate.resolve,
  })
  return { entered: entered.promise, release: gate.resolve, calls: () => calls }
}

const roots: string[] = []
const owners: Jobs[] = []
const children: Array<{ child: ChildProcess; closed: Promise<void> }> = []
afterEach(async () => {
  for (const gate of native.gates) gate.release()
  native.gates.length = 0
  vi.useRealTimers()
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(children.splice(0).map(({ closed }) => closed))
  await Promise.allSettled(owners.splice(0).map((jobs) => jobs.leave()))
  while (native.operations.size > 0) await Promise.allSettled([...native.operations])
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const SCRIPT = [
  'console.log(JSON.stringify({type:"thread.started",thread_id:"123e4567-e89b-42d3-a456-426614174000"}))',
  'console.log(JSON.stringify({type:"turn.completed"}))',
].join(';')

async function rig(options: Partial<JobsDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'holi-finalization-'))
  roots.push(dir)
  const root = join(dir, 'vault')
  const scratchRoot = join(dir, 'jobs')
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
  const jobs = createJobs({
    vault: { remote: 'fixture/vault', root },
    scratchRoot,
    onChange: () => {},
    log: () => {},
    bracket: (_id, edge) => {
      if (edge === 'end') endedTurns += 1
    },
    keepMs: 600_000,
    killGraceMs: 1,
    spawn: (bin, args, opts) => {
      const child = spawn(bin, args, {
        ...opts,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      children.push({ child, closed })
      return child
    },
    ...options,
  })
  owners.push(jobs)
  const start = async () => {
    const result = await jobs.start({ provider, name: 'fixture', prompt: 'go', allow: [] })
    if (!result.ok) throw new Error(result.message)
    return result.sessionId
  }
  const idle = async (scratch = false) => {
    if (!scratch) await vi.waitFor(() => expect(endedTurns).toBeGreaterThan(0))
    await vi.waitFor(() =>
      expect(jobs.sessions()[0]).toMatchObject({ state: 'idle', outcome: expect.any(String) }),
    )
    // The row precedes the last settlement microtasks.
    await tick()
  }
  return { jobs, provider, root, scratchRoot, start, idle, dir }
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

it('joins the same underlying retirement after each timeout without overlapping deletion', async () => {
  const t = await rig()
  const id = await t.start()
  await t.idle()
  const state = join(t.scratchRoot, `${id}.agent`)
  const gate = hold('rm', (args) => args[0] === state)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const first = t.jobs.stop(id)
  const failedFirst = expect(first).rejects.toThrow('timed out')
  await gate.entered
  await vi.advanceTimersByTimeAsync(5_001)
  await failedFirst
  const second = t.jobs.stop(id)
  const failedSecond = expect(second).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(5_001)
  await failedSecond
  expect(gate.calls()).toBe(1)
  expect(t.jobs.has(id)).toBe(true)
  const third = t.jobs.stop(id)
  gate.release()
  await third
  expect(gate.calls()).toBe(1)
  expect(t.jobs.has(id)).toBe(false)
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
  'settles refused follow-up %s through its own awaited finalizer',
  async (mode) => {
    let spawns = 0
    const t = await rig(
      mode === 'spawn'
        ? {
            spawn: () => {
              spawns += 1
              if (spawns > 1) throw new Error('spawn refused')
              const child = spawn(process.execPath, ['-e', SCRIPT], {
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
              })
              children.push({
                child,
                closed: new Promise<void>((resolve) => child.once('close', () => resolve())),
              })
              return child
            },
          }
        : {},
    )
    const id = await t.start()
    await t.idle()
    if (mode !== 'spawn')
      t.provider.capabilities.jobs.command = () => {
        if (mode === 'throw') throw new Error('command refused')
        return null
      }
    const gate = deferred()
    const entered = deferred()
    t.provider.release = async () => {
      entered.resolve()
      await gate.promise
    }
    t.jobs.message(id, 'follow up')
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
  expect(children).toHaveLength(0)
  gate.release()
  expect(await start).toBeInstanceOf(Error)
  await retry
  await expect(access(t.scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(children).toHaveLength(0)
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

async function ptyRig() {
  const dir = await mkdtemp(join(tmpdir(), 'holi-history-race-'))
  roots.push(dir)
  const history = join(dir, 'history.json')
  await writeFile(history, '[]')
  let failWrites = 0
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
          throw new Error('history unavailable')
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
        opened[Number(id.split('-')[1]) - 1]?.onExit?.()
        await closeWait
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
  t.opened[0]!.onExit?.()
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
  t.opened[0]!.onExit?.()
  await t.sessions.past()
  expect(JSON.parse(await readFile(t.history, 'utf8'))).toEqual([])
  t.opened[1]!.onExit?.()
  await t.sessions.past()
  const rows = JSON.parse(await readFile(t.history, 'utf8')) as SessionSummary[]
  expect(rows.map((row) => row.id)).toEqual([second.sessionId, first.sessionId])
  await t.sessions.leave()
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
    t.closeFails(new Error('close refused'))
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
      await t.sessions.leave()
    } finally {
      gate.resolve()
      process.off('unhandledRejection', onUnhandled)
    }
  },
)

it('retains a pending PTY close across timeout even after its exit removed the session', async () => {
  const t = await ptyRig()
  const started = await t.sessions.start('codex', {})
  if (!started.ok) throw new Error(started.message)
  const gate = deferred()
  t.holdClose(gate.promise)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const leaving = t.sessions.leave()
    const failed = expect(leaving).rejects.toThrow('did not drain')
    await tick()
    expect(t.sessions.has(started.sessionId)).toBe(false)
    await vi.advanceTimersByTimeAsync(5_001)
    await failed
    let left = false
    const retry = t.sessions.leave().then(() => {
      left = true
    })
    await tick()
    expect(left).toBe(false)
    expect(t.closeCalls()).toBe(1)
    gate.resolve()
    await retry
  } finally {
    gate.resolve()
  }
})

it('retains the close owner when its exit callback precedes a close rejection', async () => {
  const t = await ptyRig()
  const started = await t.sessions.start('codex', {})
  if (!started.ok) throw new Error(started.message)
  t.holdClose(Promise.reject(new Error('close failed after exit')))
  await expect(t.sessions.leave()).rejects.toThrow('did not drain')
  expect(t.sessions.has(started.sessionId)).toBe(false)
  expect(t.closeCalls()).toBe(1)
  t.holdClose(Promise.resolve())
  await t.sessions.leave()
  expect(t.closeCalls()).toBe(2)
})
