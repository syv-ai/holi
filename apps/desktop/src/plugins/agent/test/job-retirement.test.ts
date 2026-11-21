import { ChildProcess } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { ownedProcessDrain } from '../../../main/plugin-api'
import { readJobEvent } from '../main/codex'
import { createJobs } from '../main/host/jobs'
import { activationOwnership } from '../main/host/ownership'
import type { JobsProvider } from '../main/provider'

const filesystem = vi.hoisted(() => ({
  remove: undefined as ((path: string, remove: () => Promise<void>) => Promise<void>) | undefined,
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rm: (...args: Parameters<typeof fs.rm>) =>
      filesystem.remove?.(String(args[0]), () => fs.rm(...args)) ?? fs.rm(...args),
  }
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

it.skipIf(process.platform === 'win32').each([
  ['agent', 'Stop', 'timeout'],
  ['pid', 'Stop', 'timeout'],
  ['turn', 'TTL', 'timeout'],
  ['agent', 'Stop', 'rejection'],
] as const)('retains retirement of %s after %s sees %s', async (stage, initiator, mode) => {
  const data = await mkdtemp(join(tmpdir(), 'holi-job-retirement-'))
  const root = join(data, 'vault')
  await mkdir(root)
  const vault = { remote: 'fixture/vault', root }
  const scratchRoot = join(data, 'jobs')
  const provider: JobsProvider = {
    id: 'codex',
    label: 'Codex',
    notInstalled: 'missing',
    installed: () => true,
    configure: async () => ({ dir: root }),
    terminal: () => null,
    capabilities: {
      jobs: { command: () => ({ bin: 'fixture', args: [], env: {} }), event: readJobEvent },
    },
  }
  const stdout = new PassThrough()
  const drain = vi.fn(async () => {})
  const child = Object.assign(new ChildProcess(), { stdout, [ownedProcessDrain]: { drain } })
  const idle = deferred()
  const jobs = createJobs({
    vault,
    scratchRoot,
    ownership: activationOwnership(data, vault, new AbortController().signal)!,
    keepMs: 1000,
    onChange: (rows) => {
      if (rows.some((row) => row.outcome === 'completed')) idle.resolve()
    },
    log: () => {},
    spawn: () => child,
  })
  const entered = deferred()
  const release = deferred()
  const unlocked = deferred()
  const fsError = new Error('fixture removal failed')
  let stopping: Promise<unknown> | undefined
  const removals: string[] = []
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try {
    const result = await jobs.start({ provider, name: 'fixture', prompt: 'go', allow: [] })
    if (!result.ok) throw new Error(result.message)
    const id = result.sessionId
    stdout.end('{"type":"turn.completed"}\n')
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    await idle.promise
    expect(drain).toHaveBeenCalledOnce()
    const state = join(scratchRoot, `${id}.agent`)
    const pid = join(scratchRoot, `${id}.pid`)
    const caller = join(scratchRoot, `${id}.turn`)
    const target = join(scratchRoot, `${id}.${stage}`)
    expect(await readFile(caller, 'utf8')).toMatch(/SETTLED\n$/)
    const scopes = join(data, 'agent-ownership')
    const records = join(scopes, (await readdir(scopes))[0]!, 'jobs')
    const record = join(records, (await readdir(records))[0]!)
    filesystem.remove = async (path, remove) => {
      removals.push(path)
      if (path !== target) return remove()
      entered.resolve()
      await release.promise
      try {
        if (mode === 'rejection') throw fsError
        await remove()
      } finally {
        unlocked.resolve()
      }
    }
    if (initiator === 'TTL') await vi.advanceTimersByTimeAsync(1000)
    else stopping = jobs.stop(id).catch((error: unknown) => error)
    await entered.promise
    if (mode === 'rejection') release.resolve()
    else await vi.advanceTimersByTimeAsync(5000)
    if (initiator === 'TTL') expect(jobs.sessions()[0]).toMatchObject({ outcome: 'failed' })
    const failure = await (stopping ?? jobs.stop(id).catch((error: unknown) => error))
    if (mode === 'rejection') expect(failure).toBe(fsError)
    else
      expect(failure).toMatchObject({ message: expect.stringMatching(/Cleanup of job.*timed out/) })
    release.resolve()
    await unlocked.promise
    await vi.advanceTimersByTimeAsync(0)
    expect(jobs.has(id)).toBe(true)
    expect(jobs.sessions()[0]).toMatchObject({
      outcome: 'failed',
      error: (failure as Error).message,
    })
    await expect(jobs.stop(id)).rejects.toBe(failure)
    await expect(jobs.leave()).rejects.toMatchObject({ errors: [failure] })
    const stages = [state, pid, caller]
    expect(removals).toEqual(stages.slice(0, stages.indexOf(target) + 1))
    expect(await readFile(join(record, 'failed'), 'utf8')).toContain((failure as Error).message)
    await access(join(record, 'link'))
    await expect(access(join(record, 'settled'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (stage !== 'turn') expect(await readFile(caller, 'utf8')).toMatch(/SETTLED\n$/)
  } finally {
    filesystem.remove = undefined
    release.resolve()
    await stopping
    await jobs.leave().catch(() => {})
    vi.useRealTimers()
    stdout.destroy()
    await rm(data, { recursive: true, force: true })
  }
})
