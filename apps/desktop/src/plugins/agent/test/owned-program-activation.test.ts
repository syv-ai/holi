import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import {
  UnconfirmedOwnedProgramError,
  type ManagedOwnedChild,
  type OwnedCompletion,
} from '../../../main/plugin-api'
import { readJobEvent } from '../main/codex'
import { createJobs, type Jobs, type JobsDeps } from '../main/host/jobs'
import { agentScratchRoots } from '../main/host/scratch-roots'
import type { JobsProvider } from '../main/provider'

function controlledChild(pid: number | undefined) {
  let prove!: (value: OwnedCompletion) => void
  let reject!: (failure: Error) => void
  const ownedCompletion = new Promise<OwnedCompletion>((res, rej) => {
    prove = res
    reject = rej
  })
  const child = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const kill = vi.fn(() => true)
  Object.assign(child, { pid, stdout, stderr, stdin: null, ownedCompletion, kill })
  return {
    child: child as unknown as ManagedOwnedChild,
    kill,
    stdout,
    stderr,
    prove,
    reject,
    complete() {
      stdout.write('{"type":"thread.started","thread_id":"123e4567-e89b-42d3-a456-426614174000"}\n')
      stdout.write('{"type":"turn.completed","usage":{"input_tokens":18,"output_tokens":2}}\n')
    },
    close(code: number | null = 0) {
      child.emit('close', code, null)
    },
    endOutput() {
      stdout.end()
      stderr.end()
    },
  }
}

const temps: string[] = []
const owners: Jobs[] = []
const children: ReturnType<typeof controlledChild>[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const adapter of children.splice(0)) {
    adapter.endOutput()
    adapter.close()
    adapter.prove('empty')
  }
  await Promise.allSettled(owners.splice(0).map((jobs) => jobs.leave()))
  await Promise.all(temps.splice(0).map((temp) => rm(temp, { recursive: true, force: true })))
})

async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'holi-owned-activation-'))
  temps.push(dir)
  return dir
}

async function fixture(dir: string, name: string, options: Partial<JobsDeps> = {}) {
  const root = join(dir, name)
  const vault = { root, remote: `owner/${name}` }
  await mkdir(root, { recursive: true })
  const { jobs: scratchRoot } = await agentScratchRoots(join(dir, 'user-data'), vault)
  const release = vi.fn()
  const event = vi.fn(readJobEvent)
  const provider: JobsProvider = {
    id: 'codex',
    label: 'Codex',
    notInstalled: 'not installed',
    installed: () => true,
    configure: async () => ({ dir }),
    terminal: () => null,
    capabilities: { jobs: { command: () => ({ bin: 'fake-codex', args: [], env: {} }), event } },
    release,
  }
  const adapter = controlledChild(9001)
  children.push(adapter)
  const spawn = vi.fn((_bin, _args, _opts: { cwd: string }) => adapter.child)
  const probePid = vi.fn(() => {
    throw new Error('Windows must not probe a pid')
  })
  const commandOf = vi.fn(() => {
    throw new Error('Windows must not inspect a pid')
  })
  const bracket = vi.fn()
  const makeJobs = (overrides: Partial<JobsDeps> = {}) => {
    const jobs = createJobs({
      vault,
      scratchRoot,
      platform: 'win32',
      onChange: () => {},
      log: () => {},
      bracket,
      spawn,
      ...options,
      ...overrides,
    })
    owners.push(jobs)
    return jobs
  }
  const jobs = makeJobs()
  const spec = { provider, name, prompt: 'write result', scope: { read: [], write: ['result.md'] } }
  const start = async (owner = jobs) => {
    const result = await owner.start(spec)
    if (!result.ok) throw new Error(result.message)
    return result.sessionId
  }
  return {
    jobs,
    makeJobs,
    adapter,
    release,
    event,
    spawn,
    bracket,
    probePid,
    commandOf,
    root,
    scratchRoot,
    spec,
    start,
  }
}

it('joins the real provider output and isolates two vaults until their own EMPTY receipts', async () => {
  const dir = await temp()
  const a = await fixture(dir, 'vault-a')
  const b = await fixture(dir, 'vault-b')
  for (const [index, f] of [a, b].entries()) {
    const id = await f.start()
    // The scratch write completes before either close or the receipt is delivered.
    await writeFile(join(f.scratchRoot, id, 'result.md'), `vault-${index}`)
    f.adapter.complete()
    f.adapter.endOutput()
    f.adapter.close()
    expect(f.event).toHaveReturnedWith({ kind: 'turn-completed', tokens: 20 })
    expect(f.jobs.sessions()[0]).toMatchObject({ id, usage: { total: 20 } })
  }
  await tick()
  for (const f of [a, b]) {
    await expect(readFile(join(f.root, 'result.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.release).not.toHaveBeenCalled()
  }
  b.adapter.prove('empty')
  await vi.waitFor(async () => {
    expect(b.jobs.sessions()[0]).toMatchObject({ state: 'idle', outcome: 'completed' })
    expect(await readFile(join(b.root, 'result.md'), 'utf8')).toBe('vault-1')
  })
  await b.jobs.leave()
  await expect(readFile(join(a.root, 'result.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(a.release).not.toHaveBeenCalled()
  expect(await readdir(a.scratchRoot)).toContainEqual(expect.stringMatching(/\.owned$/))
  a.adapter.prove('empty')
  await vi.waitFor(async () => {
    expect(a.jobs.sessions()[0]).toMatchObject({ state: 'idle', outcome: 'completed' })
    expect(await readFile(join(a.root, 'result.md'), 'utf8')).toBe('vault-0')
  })
  for (const f of [a, b]) {
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.probePid).not.toHaveBeenCalled()
    expect(f.commandOf).not.toHaveBeenCalled()
  }
})

it('observes a no-pid planning error and cleans up only on explicit not-started', async () => {
  const adapter = controlledChild(undefined)
  children.push(adapter)
  const launchError = new Error('planning refused')
  const f = await fixture(await temp(), 'plan', {
    spawn: () => {
      process.nextTick(() => {
        adapter.child.emit('error', launchError)
        adapter.endOutput()
        adapter.close(null)
      })
      return adapter.child
    },
  })
  await f.start()
  await tick()
  expect(adapter.child.pid).toBeUndefined()
  expect(f.release).not.toHaveBeenCalled()
  adapter.prove('not-started')
  await vi.waitFor(async () => {
    expect(f.jobs.sessions()[0]).toMatchObject({
      outcome: 'failed',
      error: 'Codex did not start: planning refused',
    })
    expect(await readdir(f.scratchRoot)).toEqual([])
  })
  expect(f.release).toHaveBeenCalledTimes(1)
  await f.jobs.leave()
})

it.each(['child error', 'broken output'] as const)(
  'joins actual output after EMPTY and reports %s as a settled command failure',
  async (mode) => {
    const f = await fixture(await temp(), 'output')
    const id = await f.start()
    await writeFile(join(f.scratchRoot, id, 'result.md'), 'must not be copied')
    f.adapter.complete()
    if (mode === 'child error') f.adapter.child.emit('error', new Error('command stream failed'))
    f.adapter.close()
    f.adapter.prove('empty')
    await tick()
    expect(f.jobs.sessions()[0]).toMatchObject({ state: 'working', usage: { total: 20 } })
    expect(f.release).not.toHaveBeenCalled()
    expect(await readFile(join(f.scratchRoot, id, 'result.md'), 'utf8')).toBe('must not be copied')
    if (mode === 'broken output') f.adapter.stdout.destroy()
    else f.adapter.stdout.end()
    f.adapter.stderr.end()
    await vi.waitFor(async () => {
      expect(f.jobs.sessions()[0]).toMatchObject({
        outcome: 'failed',
        error:
          mode === 'child error'
            ? 'command stream failed'
            : 'Owned program stdout closed before end',
      })
      expect(await readdir(f.scratchRoot)).toEqual([])
    })
    await expect(readFile(join(f.root, 'result.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.release).toHaveBeenCalledTimes(1)
    await f.jobs.leave()
  },
)

it.each(['scratch', 'vault'] as const)(
  'retains the exact rejected receipt and lease for every %s Stop and leave',
  async (kind) => {
    const dir = await temp()
    const f = await fixture(dir, 'failed', { keepMs: 1 })
    const started = await f.jobs.start(
      kind === 'vault'
        ? { provider: f.spec.provider, name: f.spec.name, prompt: f.spec.prompt, allow: [] }
        : f.spec,
    )
    if (!started.ok) throw new Error(started.message)
    const { sessionId: id } = started
    const state = join(f.scratchRoot, `${id}.agent`, 'owned')
    await writeFile(state, 'provider state')
    if (kind === 'scratch') await writeFile(join(f.scratchRoot, id, 'result.md'), 'scratch result')
    f.adapter.complete()
    if (kind === 'vault') f.jobs.message(id, 'never launch this follow-up')
    const marker = (await readdir(f.scratchRoot)).find((name) => name.endsWith('.owned'))!
    const markerPath = join(f.scratchRoot, marker)
    const recovery = await readFile(markerPath, 'utf8')
    const before = f.adapter.child.listenerCount('close')
    const lease = { revoke: vi.fn(async () => undefined) }
    const failure = new UnconfirmedOwnedProgramError(new Error('native query denied'), lease)
    const stopped = Promise.allSettled(Array.from({ length: 20 }, () => f.jobs.stop(id)))
    const left = expect(f.jobs.leave()).rejects.toBe(failure)
    await tick()
    expect(f.adapter.child.listenerCount('close')).toBe(before)
    expect(f.adapter.kill).toHaveBeenCalledTimes(1)
    f.adapter.reject(failure)
    // Neither child close nor EOF has occurred, and no timer is advanced.
    await left
    for (const stop of await stopped) {
      expect(stop.status).toBe('rejected')
      if (stop.status === 'rejected') expect(stop.reason).toBe(failure)
    }
    await expect(f.jobs.stop(id)).rejects.toBe(failure)
    expect(failure.lease).toBe(lease)
    expect(lease.revoke).not.toHaveBeenCalled()
    expect(f.jobs.has(id)).toBe(true)
    expect(f.release).not.toHaveBeenCalled()
    expect(f.bracket.mock.calls.map(([, edge]) => edge)).toEqual(kind === 'vault' ? ['begin'] : [])
    expect(f.adapter.child.listenerCount('close')).toBe(0)
    expect(f.adapter.child.listenerCount('error')).toBe(1)
    f.adapter.child.emit('error', new Error('late error'))
    f.adapter.close()
    f.adapter.endOutput()
    await expect(f.jobs.leave()).rejects.toBe(failure)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(await readFile(state, 'utf8')).toBe('provider state')
    expect(await readFile(markerPath, 'utf8')).toBe(recovery)
    if (kind === 'scratch')
      expect(await readFile(join(f.scratchRoot, id, 'result.md'), 'utf8')).toBe('scratch result')
    await expect(readFile(join(f.root, 'result.md'))).rejects.toMatchObject({ code: 'ENOENT' })

    const restarted = f.makeJobs()
    await expect(restarted.start(f.spec)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('ownership is unproven'),
    })
    await expect(restarted.leave()).rejects.toThrow('ownership is unproven')
    const other = await fixture(dir, 'other-vault')
    await other.start()
    other.adapter.complete()
    other.adapter.endOutput()
    other.adapter.close()
    other.adapter.prove('empty')
    await vi.waitFor(() => expect(other.jobs.sessions()[0]?.outcome).toBe('completed'))
    await other.jobs.leave()
    expect(await readFile(markerPath, 'utf8')).toBe(recovery)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(f.probePid).not.toHaveBeenCalled()
    expect(f.commandOf).not.toHaveBeenCalled()
  },
)

it.each(['j000000000001.pid', 'j000000000001.000000000001.owned', 'unknown.agent'])(
  'fails closed on unexplained Windows remnants (%s), even without a receipt to read',
  async (name) => {
    const f = await fixture(await temp(), 'indeterminate')
    // Let the first verified-empty activation retire before simulating leftovers.
    await f.jobs.leave()
    await mkdir(f.scratchRoot)
    const path = join(f.scratchRoot, name)
    await writeFile(path, 'untrustworthy')
    const restarted = f.makeJobs()
    await expect(restarted.start(f.spec)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('sweep'),
    })
    await expect(restarted.leave()).rejects.toThrow('ownership is unproven')
    expect(await readFile(path, 'utf8')).toBe('untrustworthy')
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.probePid).not.toHaveBeenCalled()
    expect(f.commandOf).not.toHaveBeenCalled()
  },
)

it('persists a Windows managed turn before publishing its outcome or removing its marker', async () => {
  let releaseHistory!: () => void
  let enteredHistory!: () => void
  const history = new Promise<void>((resolve) => {
    releaseHistory = resolve
  })
  const entered = new Promise<void>((resolve) => {
    enteredHistory = resolve
  })
  const end = vi.fn(async () => {
    enteredHistory()
    await history
    return { base: 'before', end: 'after', at: '2026-01-01T00:00:00.000Z' }
  })
  const forget = vi.fn()
  const f = await fixture(await temp(), 'managed', {
    beginManagedTurn: () => ({ end, forget }),
  })
  try {
    const started = await f.jobs.start({
      provider: f.spec.provider,
      name: 'managed',
      prompt: 'go',
      allow: [],
    })
    if (!started.ok) throw new Error(started.message)
    f.adapter.complete()
    f.adapter.endOutput()
    f.adapter.close()
    f.adapter.prove('empty')
    await entered
    expect(f.jobs.sessions()[0]?.outcome).toBeUndefined()
    expect((await readdir(f.scratchRoot)).some((name) => name.endsWith('.owned'))).toBe(true)
    releaseHistory()
    await vi.waitFor(() => expect(f.jobs.sessions()[0]?.outcome).toBe('completed'))
    expect(end).toHaveBeenCalledOnce()
    expect(forget).not.toHaveBeenCalled()
    await f.jobs.leave()
  } finally {
    releaseHistory()
  }
})
