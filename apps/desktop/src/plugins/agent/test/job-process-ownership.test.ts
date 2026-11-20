import { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { ownedProcessDrain, type ProcessGroupSupervision } from '../../../main/plugin-api'
import { readJobEvent } from '../main/codex'
import { createJobs, type JobsDeps } from '../main/host/jobs'
import { activationOwnership } from '../main/host/ownership'
import { createManagedTurnBrackets, createTurnCoordinator } from '../main/host/turn-coordinator'
import { openTurnLog, type TurnLog } from '../main/host/turn-log'

import type { JobsProvider } from '../main/provider'

const pid = 678_909
const oldId = 'j0123456789ab'
const roots: string[] = []
const posix = it.skipIf(process.platform === 'win32')

afterEach(async () => {
  vi.restoreAllMocks()
  // These roots contain only fake process evidence; this fixture starts no OS child.
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function gate() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeChild(drain?: ProcessGroupSupervision['drain'], launched = true) {
  const child: ChildProcess & { [ownedProcessDrain]?: ProcessGroupSupervision } = new ChildProcess()
  if (launched) Object.assign(child, { pid })
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => false)
  if (drain !== undefined) child[ownedProcessDrain] = { drain }
  return child
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'holi-job-fake-ownership-'))
  roots.push(dir)
  const root = join(dir, 'vault')
  const scratchRoot = join(dir, 'jobs')
  await mkdir(root)
  const release = vi.fn(async () => {})
  const provider: JobsProvider = {
    id: 'codex',
    label: 'Codex',
    notInstalled: 'missing',
    installed: () => true,
    configure: async () => ({ dir }),
    terminal: () => null,
    release,
    capabilities: {
      jobs: { command: () => ({ bin: 'fake-codex', args: [], env: {} }), event: readJobEvent },
    },
  }
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('fake process must not reach the kernel')
  })
  const create = (options: Partial<JobsDeps>) =>
    createJobs({
      vault: { remote: 'fixture/vault', root },
      scratchRoot,
      onChange: () => {},
      log: () => {},
      killGraceMs: 1,
      ...options,
    })
  const spec = { provider, name: 'fixture', prompt: 'go' }
  const registry = () =>
    activationOwnership(dir, { remote: 'fixture/vault', root }, new AbortController().signal)!
  return { dir, root, scratchRoot, create, spec, release, kill, registry }
}

posix('refuses a recycled startup PID without signals or state deletion', async () => {
  const t = await fixture()
  await mkdir(join(t.scratchRoot, `${oldId}.agent`), { recursive: true })
  const evidence = join(t.scratchRoot, `${oldId}.agent`, 'evidence')
  await writeFile(evidence, 'retain me')
  await writeFile(join(t.scratchRoot, `${oldId}.pid`), `${pid}\n${t.root}\n`)
  const spawn = vi.fn(() => fakeChild(async () => {}))
  const jobs = t.create({ spawn, ownership: t.registry() })
  const result = await jobs.start({ ...t.spec, allow: [] })
  expect(t.kill).not.toHaveBeenCalled()
  expect(result).toMatchObject({ ok: false, message: expect.stringContaining(oldId) })
  expect(spawn).not.toHaveBeenCalled()
  await expect(jobs.leave()).rejects.toThrow(oldId)
  expect(await readFile(evidence, 'utf8')).toBe('retain me')
})

posix('fails closed for an injected child without a lease even after close', async () => {
  const t = await fixture()
  const child = fakeChild()
  const jobs = t.create({ spawn: () => child })
  const result = await jobs.start({ ...t.spec, allow: [] })
  const id = jobs.sessions()[0]!.id
  child.emit('spawn')
  const stopping = jobs.stop(id)
  const observed = stopping.catch((error: unknown) => error)
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
  expect(await observed).toMatchObject({ message: expect.stringMatching(/lease/i) })
  expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/lease/i) })
  expect(t.kill).not.toHaveBeenCalled()
  expect(child.kill).not.toHaveBeenCalled()
  expect(t.release).not.toHaveBeenCalled()
  expect(jobs.has(id)).toBe(true)
  await expect(jobs.leave()).rejects.toThrow('did not drain')
  await expect(access(join(t.scratchRoot, `${id}.agent`))).resolves.toBeUndefined()
})

it('joins started error, output close and physical confirmation before release or cleanup', async () => {
  const t = await fixture()
  const proof = gate()
  const drain = vi.fn(() => proof.promise)
  const child = fakeChild(drain)
  const jobs = t.create({ spawn: () => child })
  const result = await jobs.start({ ...t.spec, scope: { read: [], write: ['result.txt'] } })
  if (!result.ok) throw new Error(result.message)
  const id = result.sessionId
  child.emit('spawn')
  const scratchFile = join(t.scratchRoot, id, 'result.txt')
  await writeFile(scratchFile, 'do not publish')
  child.emit('error', new Error('started I/O failure'))
  proof.resolve()
  await tick()
  expect(t.release).not.toHaveBeenCalled()
  expect(await readFile(scratchFile, 'utf8')).toBe('do not publish')
  child.stdout!.push('{"type":"turn.completed"}\n')
  child.stdout!.push(null)
  child.stderr!.push(null)
  child.emit('close', 0, null)
  await vi.waitFor(() =>
    expect(jobs.sessions()[0]).toMatchObject({
      outcome: 'failed',
      error: expect.stringContaining('started I/O failure'),
    }),
  )
  await jobs.leave()
  expect(t.release).toHaveBeenCalledTimes(1)
  expect(drain).toHaveBeenCalledTimes(1)
  await expect(access(join(t.root, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(scratchFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

posix(
  'retains the original physical error after abort and a late bracket begin failure',
  async () => {
    const t = await fixture()
    const activation = new AbortController()
    const bracket = gate()
    const original = new Error('lease proof failed')
    const drain = vi.fn(async () => {
      throw original
    })
    const child = fakeChild(drain)
    const jobs = t.create({
      spawn: () => child,
      activationSignal: activation.signal,
      bracket: () => bracket.promise,
    })
    const result = await jobs.start({ ...t.spec, allow: [] })
    if (!result.ok) throw new Error(result.message)
    const id = result.sessionId
    child.emit('spawn')
    child.emit('exit', 0, null) // Output is still open.
    await expect(jobs.stop(id)).rejects.toBe(original)
    activation.abort()
    await tick()
    bracket.reject(new Error('late bracket failure'))
    await tick()
    for (let i = 0; i < 2; i++) {
      await expect(jobs.leave()).rejects.toMatchObject({ errors: [original] })
      await expect(jobs.stop(id)).rejects.toBe(original)
    }
    expect(jobs.sessions()[0]).toMatchObject({ id, outcome: 'failed', error: original.message })
    expect(t.release).not.toHaveBeenCalled()
    expect(drain).toHaveBeenCalledTimes(1)
    await expect(access(join(t.scratchRoot, `${id}.agent`))).resolves.toBeUndefined()
  },
)

posix('observes and retains a synchronous supervisor throw from a child event', async () => {
  const t = await fixture()
  const original = new Error('synchronous drain failure')
  const drain = vi.fn(() => {
    throw original
  })
  const child = fakeChild(drain)
  const jobs = t.create({ spawn: () => child })
  const result = await jobs.start({ ...t.spec, allow: [] })
  if (!result.ok) throw new Error(result.message)
  child.emit('spawn')
  expect(() => child.emit('exit', 0, null)).not.toThrow()
  await expect(jobs.stop(result.sessionId)).rejects.toBe(original)
  await expect(jobs.leave()).rejects.toMatchObject({ errors: [original] })
  expect(drain).toHaveBeenCalledTimes(1)
  expect(t.release).not.toHaveBeenCalled()
})

it('joins explicit drainage and output close after a no-PID fake error', async () => {
  const t = await fixture()
  const cleanup = gate()
  const drain = vi.fn(() => cleanup.promise)
  const child = fakeChild(drain, false)
  const jobs = t.create({ spawn: () => child })
  const result = await jobs.start({ ...t.spec, allow: [] })
  if (!result.ok) throw new Error(result.message)
  child.emit('error', new Error('exec refused'))
  await tick()
  expect(t.release).not.toHaveBeenCalled()
  cleanup.resolve()
  child.stdout!.push(null)
  child.emit('close', null, null)
  await vi.waitFor(() =>
    expect(jobs.sessions()[0]).toMatchObject({
      outcome: 'failed',
      error: expect.stringContaining('exec refused'),
    }),
  )
  await jobs.leave()
  expect(drain).toHaveBeenCalledTimes(1)
  expect(t.release).toHaveBeenCalledTimes(1)
})

posix(
  'retains native synchronous spawn cleanup errors through start refusal and later leave',
  async () => {
    const t = await fixture()
    const cleanup = gate()
    const invoked = gate()
    const original = new Error('native launch cancellation failed')
    const jobs = t.create({
      spawn: () => {
        invoked.resolve()
        throw Object.assign(new Error('spawn refused'), { cleanup: cleanup.promise })
      },
    })
    const starting = jobs.start({ ...t.spec, scope: { read: [], write: [] } })
    await invoked.promise
    const id = jobs.sessions()[0]!.id
    await tick()
    expect(t.release).not.toHaveBeenCalled()
    cleanup.reject(original)
    await expect(starting).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining(original.message),
    })
    await expect(jobs.stop(id)).rejects.toBe(original)
    await expect(jobs.leave()).rejects.toMatchObject({ errors: [original] })
    await expect(access(join(t.scratchRoot, id))).resolves.toBeUndefined()
    await expect(access(join(t.scratchRoot, `${id}.agent`))).resolves.toBeUndefined()
    expect(t.release).not.toHaveBeenCalled()
  },
)

posix(
  'keeps a vault receipt while idle and clears stale proof before a follow-up spawn',
  async () => {
    const t = await fixture()
    const first = fakeChild(async () => {})
    const second = fakeChild(async () => {})
    const spawn = vi.fn().mockReturnValueOnce(first)
    const jobs = t.create({ spawn })
    const result = await jobs.start({ ...t.spec, allow: [] })
    if (!result.ok) throw new Error(result.message)
    const receipt = join(t.scratchRoot, `${result.sessionId}.pid`)
    first.stdout!.push(
      '{"type":"thread.started","thread_id":"123e4567-e89b-42d3-a456-426614174000"}\n',
    )
    first.stdout!.push('{"type":"turn.completed"}\n')
    first.stdout!.push(null)
    await tick()
    first.emit('close', 0, null)
    await vi.waitFor(() => expect(jobs.sessions()[0]).toMatchObject({ outcome: 'completed' }))
    expect(await readFile(receipt, 'utf8')).toBe(`${pid}\n${t.root}\n`)
    spawn.mockImplementationOnce(() => {
      expect(existsSync(receipt)).toBe(false)
      return second
    })
    jobs.message(result.sessionId, 'second turn')
    expect(spawn).toHaveBeenCalledTimes(2)
    second.stdout!.push(null)
    second.emit('close', 0, null)
    await jobs.leave()
    await expect(access(receipt)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

posix(
  'retains an ambiguous follow-up and refuses recovery even after its cleanup settles',
  async () => {
    const t = await fixture()
    const first = fakeChild(async () => {})
    const cleanup = gate()
    const original = Object.assign(new Error('ambiguous native spawn'), {
      code: 'ENOENT',
      cleanupPromise: cleanup.promise,
    })
    const spawn = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementationOnce(() => {
        throw original
      })
    const jobs = t.create({ spawn, ownership: t.registry() })
    const result = await jobs.start({ ...t.spec, allow: [] })
    if (!result.ok) throw new Error(result.message)
    const id = result.sessionId
    const receipt = join(t.scratchRoot, `${id}.pid`)
    const state = join(t.scratchRoot, `${id}.agent`, 'history')
    await writeFile(state, 'original context')
    first.stdout!.push(
      '{"type":"thread.started","thread_id":"123e4567-e89b-42d3-a456-426614174000"}\n',
    )
    first.stdout!.push('{"type":"turn.completed"}\n')
    first.stdout!.push(null)
    await tick()
    first.emit('close', 0, null)
    await vi.waitFor(() => expect(jobs.sessions()[0]).toMatchObject({ outcome: 'completed' }))
    jobs.message(id, 'ambiguous follow-up')
    const stopping = jobs.stop(id)
    const settled = vi.fn()
    void stopping.then(settled, settled)
    await tick()
    expect(settled).not.toHaveBeenCalled()
    expect(t.release).toHaveBeenCalledTimes(1)
    cleanup.resolve()
    await expect(stopping).rejects.toBe(original)
    await expect(jobs.stop(id)).rejects.toBe(original)
    await expect(jobs.leave()).rejects.toMatchObject({ errors: [original] })
    expect(jobs.has(id)).toBe(true)
    await expect(access(receipt)).rejects.toMatchObject({ code: 'ENOENT' })
    const recovered = t.create({ spawn, ownership: t.registry() })
    expect(await recovered.start({ ...t.spec, allow: [] })).toMatchObject({
      ok: false,
      message: expect.stringContaining('Retaining'),
    })
    await expect(recovered.leave()).rejects.toThrow('Retaining')
    const base = join(t.dir, 'agent-ownership')
    const [key] = await readdir(base)
    const scope = join(base, key!, 'jobs')
    const entries = await readdir(scope)
    expect(entries).toHaveLength(2)
    const links = await Promise.all(
      entries.map((entry) => readFile(join(scope, entry, 'link'), 'utf8')),
    )
    expect(links.every((link) => link.includes(`explicit ${id}\n`))).toBe(true)
    const failures = await Promise.allSettled(
      entries.map((entry) => readFile(join(scope, entry, 'failed'), 'utf8')),
    )
    expect(failures).toEqual(
      expect.arrayContaining([
        { status: 'fulfilled', value: expect.stringContaining('ambiguous native spawn') },
      ]),
    )
    expect(await readFile(state, 'utf8')).toBe('original context')
    expect(t.release).toHaveBeenCalledTimes(1)
    expect(t.kill).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(2)
  },
)

it('keeps the first provider cleanup failure when bracket end and abort follow it', async () => {
  const t = await fixture()
  const activation = new AbortController()
  const original = new Error('provider cleanup failed first')
  t.release.mockRejectedValueOnce(original)
  const child = fakeChild(async () => {})
  const ended = gate()
  const persist = gate()
  const jobs = t.create({
    spawn: () => child,
    activationSignal: activation.signal,
    bracket: (_id, edge) => {
      if (edge === 'end') {
        ended.resolve()
        return persist.promise
      }
    },
  })
  const result = await jobs.start({ ...t.spec, allow: [] })
  if (!result.ok) throw new Error(result.message)
  child.stdout!.push(null)
  child.emit('close', 0, null)
  await ended.promise
  activation.abort()
  persist.reject(new Error('late persist failed'))
  await expect(jobs.stop(result.sessionId)).rejects.toBe(original)
  await expect(jobs.leave()).rejects.toMatchObject({ errors: [original] })
  expect(jobs.sessions()[0]).toMatchObject({ error: original.message })
  await expect(access(join(t.scratchRoot, `${result.sessionId}.agent`))).resolves.toBeUndefined()
})

posix(
  'starts the output deadline only after physical proof and retains its first failure on late close',
  async () => {
    const t = await fixture()
    const proof = gate()
    const child = fakeChild(() => proof.promise)
    const jobs = t.create({ spawn: () => child, ownership: t.registry() })
    const result = await jobs.start({ ...t.spec, allow: [] })
    if (!result.ok) throw new Error(result.message)
    const id = result.sessionId
    child.emit('spawn')
    const history = join(t.scratchRoot, `${id}.agent`, 'history')
    await writeFile(history, 'retain this thread')
    vi.useFakeTimers()
    try {
      const wait = jobs.stop(id)
      const settled = vi.fn()
      void wait.then(settled, settled)
      await vi.advanceTimersByTimeAsync(5500)
      expect(settled).not.toHaveBeenCalled()
      proof.resolve()
      await vi.advanceTimersByTimeAsync(5000)
      const first = await wait.catch((error: unknown) => error)
      expect(first).toMatchObject({ message: expect.stringContaining('Output of job') })
      child.emit('close', 0, null)
      await vi.advanceTimersByTimeAsync(0)
      await expect(jobs.stop(id)).rejects.toBe(first)
      await expect(jobs.leave()).rejects.toMatchObject({ errors: [first] })
      expect(t.release).not.toHaveBeenCalled()
      expect(t.kill).not.toHaveBeenCalled()
      expect(await readFile(history, 'utf8')).toBe('retain this thread')
    } finally {
      vi.useRealTimers()
    }
  },
)

function managedHistory(t: Awaited<ReturnType<typeof fixture>>, append: TurnLog['append']) {
  const resume = vi.fn()
  const managed = createManagedTurnBrackets()
  const coordinator = createTurnCoordinator({
    vault: () => ({
      root: t.root,
      head: async () => 'base',
      commitNow: async () => 'settled',
      pauseSync: () => resume,
      claimManagedTurn: managed.claimManagedTurn,
    }),
    turnSafetyMs: 10,
    snapshot: async () => 'snapshot',
    turnLogFor: () => ({ list: async () => [], append }),
    log: () => {},
  })
  return {
    coordinator,
    resume,
    beginManagedTurn: (id: string) => managed.begin(id, (job, edge) => coordinator[edge](job)),
  }
}

it.each(['success', 'failure'] as const)(
  'joins the managed bracket history write under an overlapping turn: %s',
  async (mode) => {
    const t = await fixture()
    const entered = gate()
    const write = gate()
    const original = new Error('turn history write failed')
    const history = openTurnLog(t.root)
    const append: TurnLog['append'] = async (record) => {
      entered.resolve()
      await write.promise
      await history.append(record)
    }
    const { coordinator, resume, beginManagedTurn } = managedHistory(t, append)
    const other = beginManagedTurn('other')
    const child = fakeChild(async () => {})
    const onChange = vi.fn<JobsDeps['onChange']>()
    const jobs = t.create({
      beginManagedTurn,
      onChange,
      spawn: () => child,
      ownership: t.registry(),
    })
    const result = await jobs.start({ ...t.spec, allow: [] })
    if (!result.ok) throw new Error(result.message)
    const id = result.sessionId
    child.stdout!.push('{"type":"turn.completed"}\n')
    child.stdout!.push(null)
    child.emit('close', 0, null)
    await entered.promise
    try {
      await tick()
      expect(resume).not.toHaveBeenCalled()
      expect(await history.list()).toEqual([])
      for (const [rows] of onChange.mock.calls) expect(rows[0]).not.toHaveProperty('outcome')
      expect(jobs.sessions()[0]).toMatchObject({ state: 'working' })
    } finally {
      if (mode === 'failure') write.reject(original)
      else write.resolve()
      other.forget()
    }
    await vi.waitFor(() =>
      expect(jobs.sessions()[0]).toMatchObject({
        state: 'idle',
        outcome: mode === 'success' ? 'completed' : 'failed',
      }),
    )
    if (mode === 'success') {
      expect(await history.list()).toMatchObject([{ sessionId: id, end: 'snapshot' }])
      await jobs.leave()
      await coordinator.drain()
    } else {
      await expect(jobs.stop(id)).rejects.toBe(original)
      await expect(jobs.leave()).rejects.toMatchObject({ errors: [original] })
      await expect(coordinator.drain()).rejects.toMatchObject({ errors: [original] })
      expect(await history.list()).toEqual([])
      expect(jobs.has(id)).toBe(true)
      await expect(access(join(t.scratchRoot, `${id}.agent`))).resolves.toBeUndefined()
      if (process.platform !== 'win32') {
        const owners = join(t.dir, 'agent-ownership')
        const [vault] = await readdir(owners)
        const scope = join(owners, vault!, 'jobs')
        const [owner] = await readdir(scope)
        expect(await readFile(join(scope, owner!, 'failed'), 'utf8')).toContain(original.message)
      }
    }
  },
)

posix.each(['positive', 'unknown'] as const)(
  'only forgets a managed bracket on stdout loss with positive physical proof: %s',
  async (mode) => {
    const t = await fixture()
    const proof = gate()
    const append = vi.fn(async () => {})
    const { coordinator, resume, beginManagedTurn } = managedHistory(t, append)
    const child = fakeChild(() => proof.promise)
    const jobs = t.create({ beginManagedTurn, spawn: () => child, ownership: t.registry() })
    const result = await jobs.start({ ...t.spec, allow: [] })
    if (!result.ok) throw new Error(result.message)
    const id = result.sessionId
    const stdout = new Error('stdout lost after spawn')
    const physical = new Error('no physical proof')
    child.emit('spawn')
    child.stdout!.emit('error', stdout)
    const stop = jobs.stop(id)
    await tick()
    expect(coordinator.working.has(id)).toBe(true)
    if (mode === 'positive') proof.resolve()
    else proof.reject(physical)
    await expect(stop).rejects.toBe(stdout)
    // Passing the native safety cap or tearing down the session host must
    // not certify that an unresolved managed writer has gone.
    coordinator.forget(id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(coordinator.working.has(id)).toBe(mode === 'unknown')
    expect(resume).toHaveBeenCalledTimes(mode === 'unknown' ? 0 : 1)
    expect(append).not.toHaveBeenCalled()
    expect(t.release).not.toHaveBeenCalled()
    expect(jobs.sessions()[0]?.outcome).toBe('failed')
    await expect(jobs.leave()).rejects.toMatchObject({
      errors: mode === 'unknown' ? [stdout, physical] : [stdout],
    })
  },
)
