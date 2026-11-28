import { describe, expect, it } from 'vitest'
import { AgentRuntime } from '../main/host/pty'
import type { OwnedPtyLaunch } from '../../../main/owned-windows-pty'
type OwnedPtyProcess = Awaited<OwnedPtyLaunch['ready']>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture() {
  const ready = deferred<OwnedPtyProcess>()
  const completion = deferred<void>()
  const stopped = completion
  const writes: string[] = []
  const sizes: Array<[number, number]> = []
  let exit!: (event: { exitCode: number; signal?: number }) => void
  let data!: (value: string) => void
  const pty: OwnedPtyProcess = {
    pid: 731,
    write: (value) => writes.push(value),
    resize: (cols, rows) => sizes.push([cols, rows]),
    onExit: (cb) => (exit = cb),
    onData: (cb) => (data = cb),
  }
  const launch: OwnedPtyLaunch = {
    ready: ready.promise,
    completion: completion.promise,
    stop: () => stopped.promise,
  }
  const runtime = new AgentRuntime({ platform: 'win32', launchWindowsPty: () => launch })
  runtime.start({ bin: 'agent.exe', args: [], cwd: 'C:\\vault', env: {}, cols: 80, rows: 24 })
  return {
    runtime,
    ready,
    completion,
    stopped,
    pty,
    writes,
    sizes,
    exit: (code = 0) => exit({ exitCode: code }),
    output: (s: string) => data(s),
  }
}

const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('AgentRuntime owned Windows launch', () => {
  it('queues input and latest resize until actual readiness, and waits for native completion after root exit', async () => {
    const f = fixture()
    const exits: number[] = []
    let closed = 0
    f.runtime.onExit(({ exitCode }) => {
      exits.push(exitCode)
    })
    f.runtime.onClosed(() => closed++)
    expect(f.runtime.isRunning).toBe(true)
    expect(f.runtime.pid).toBeNull()
    f.runtime.write('queued')
    f.runtime.resize(20, 10)
    f.runtime.resize(90, 30)
    f.ready.resolve(f.pty)
    await turn()
    expect(f.runtime.pid).toBe(731)
    expect(f.writes).toEqual(['queued'])
    expect(f.sizes).toEqual([[90, 30]])
    f.exit(7)
    await turn()
    expect(exits).toEqual([])
    expect(closed).toBe(0)
    f.completion.resolve()
    await turn()
    expect(exits).toEqual([7])
    expect(closed).toBe(1)
    expect(f.runtime.isRunning).toBe(false)
  })

  it('cancels before readiness, discards queued input and joins late native readiness and completion', async () => {
    const f = fixture()
    let closed = 0
    f.runtime.onClosed(() => closed++)
    f.runtime.write('must not arrive')
    const killing = f.runtime.kill()
    f.ready.resolve(f.pty)
    await turn()
    expect(f.writes).toEqual([])
    expect(f.runtime.pid).toBe(731)
    f.completion.resolve()
    f.stopped.resolve()
    await killing
    expect(closed).toBe(1)
    expect(f.runtime.isRunning).toBe(false)
  })

  it('retains native cleanup rejection as the cause for repeated kill and refuses replacement', async () => {
    const f = fixture()
    const cause = new Error('native cleanup failed')
    const first = f.runtime.kill()
    f.ready.resolve(f.pty)
    await turn()
    f.stopped.reject(cause)
    f.completion.reject(cause)
    await expect(first).rejects.toBe(cause)
    await expect(f.runtime.kill()).rejects.toBe(cause)
    expect(() =>
      f.runtime.start({
        bin: 'other.exe',
        args: [],
        cwd: 'C:\\vault',
        env: {},
        cols: 80,
        rows: 24,
      }),
    ).toThrow()
  })

  it('keeps runtimes with matching process identifiers independent', async () => {
    const a = fixture()
    const b = fixture()
    a.ready.resolve(a.pty)
    b.ready.resolve(b.pty)
    await turn()
    const stopping = a.runtime.kill()
    a.completion.resolve()
    a.stopped.resolve()
    await stopping
    expect(b.runtime.isRunning).toBe(true)
    expect(b.runtime.pid).toBe(731)
    b.runtime.write('still live')
    b.output('output')
    expect(b.writes).toEqual(['still live'])
    const seen: string[] = []
    b.runtime.onData((value) => seen.push(value))
    b.output('continued')
    expect(seen).toEqual(['continued'])
    let closed = 0
    b.runtime.onClosed(() => closed++)
    b.exit()
    b.completion.resolve()
    await turn()
    expect(closed).toBe(1)
    expect(b.runtime.isRunning).toBe(false)
  })
})

it('drops queued display work across A → B → A without dropping native input or finalization', async () => {
  const f = fixture()
  let epoch = 0
  const capture = () => {
    const at = epoch
    return () => epoch === at
  }
  const old = capture()
  const delivered: string[] = []
  f.runtime.write('stale keystroke', old, () => delivered.push('stale'))
  f.runtime.resize(100, 40, old)
  epoch++
  epoch++
  f.runtime.write('native protocol reply')
  f.runtime.write('fresh keystroke', capture(), () => delivered.push('fresh'))
  f.ready.resolve(f.pty)
  await turn()
  expect(f.writes).toEqual(['native protocol reply', 'fresh keystroke'])
  expect(f.sizes).toEqual([])
  expect(delivered).toEqual(['fresh'])
  f.runtime.resize(120, 50, capture())
  expect(f.sizes).toEqual([[120, 50]])
  let finalized = false
  f.runtime.onExit(() => {
    finalized = true
  })
  const stopping = f.runtime.kill()
  f.completion.resolve()
  f.exit()
  await stopping
  expect(finalized).toBe(true)
  expect(f.runtime.isRunning).toBe(false)
})
