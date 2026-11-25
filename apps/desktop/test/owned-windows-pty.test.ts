import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { launchOwnedWindowsPty } from '../src/main/owned-windows-pty'
import type { ManagedOwnedChild, OwnedCompletion } from '../src/main/owned-program-lifetime'

type Receipt = OwnedCompletion
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function child(receipt = deferred<Receipt>()) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const writes: Buffer[] = []
  stdin.on('data', (data: Buffer) => writes.push(Buffer.from(data)))
  const nativeStop = vi.fn(() => true)
  const process = Object.assign(new ChildProcess(), {
    pid: 321,
    stdin,
    stdout,
    stderr,
    ownedCompletion: receipt.promise,
    kill: nativeStop,
  }) as ManagedOwnedChild & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
  }
  return { process, receipt, writes, nativeStop }
}
function runtime(proc: ReturnType<typeof child>['process']) {
  return {
    platform: 'win32' as const,
    prepare: (input: Parameters<typeof launchOwnedWindowsPty>[0]) => input,
    node: () => 'node.exe',
    modulePath: () => 'pty',
    spawn: () => proc,
  }
}
function record(proc: ReturnType<typeof child>['process'], value: unknown) {
  proc.stdout.write(`${JSON.stringify(value)}\n`)
}
const options = { file: 'shell.exe', args: [], cwd: 'C:/vault', env: {}, cols: 80, rows: 24 }

describe('launchOwnedWindowsPty', () => {
  it('exposes the actual PTY PID, replays early Unicode output and sends input and resize frames', async () => {
    const owned = child()
    const launch = launchOwnedWindowsPty(options, runtime(owned.process))
    record(owned.process, { type: 'ready', pid: 987 })
    const pty = await launch.ready
    record(owned.process, { type: 'data', data: Buffer.from('héllo 🪿').toString('base64') })
    const received: string[] = []
    pty.onData((data) => received.push(data))
    pty.write('input 🪿')
    pty.resize(132, 43)
    expect(pty.pid).toBe(987)
    expect(received.join('')).toBe('héllo 🪿')
    const frames = Buffer.concat(owned.writes)
      .toString()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(frames.slice(-2)).toEqual([
      { type: 'input', data: 'input 🪿' },
      { type: 'resize', cols: 132, rows: 43 },
    ])
    record(owned.process, { type: 'exit', exitCode: 0 })
    owned.process.stdout.end()
    owned.process.stderr.end()
    owned.process.emit('exit', 0, null)
    owned.process.emit('close', 0, null)
    owned.receipt.resolve('empty')
    await expect(launch.completion).resolves.toBeUndefined()
  })

  it('waits for native emptiness after root exit and stops only the original child idempotently', async () => {
    const owned = child()
    const launch = launchOwnedWindowsPty(options, runtime(owned.process))
    record(owned.process, { type: 'ready', pid: 987 })
    await launch.ready
    record(owned.process, { type: 'exit', exitCode: 0 })
    owned.process.stdout.end()
    owned.process.stderr.end()
    owned.process.emit('exit', 0, null)
    owned.process.emit('close', 0, null)
    let done = false
    void launch.completion.then(() => {
      done = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(done).toBe(false)
    const first = launch.stop()
    const second = launch.stop()
    expect(second).toBe(first)
    expect(owned.nativeStop).toHaveBeenCalledTimes(1)
    owned.receipt.resolve('empty')
    await expect(first).resolves.toBeUndefined()
  })

  it('preserves native rejection and treats protocol failure as cleanup, not an empty receipt', async () => {
    const owned = child()
    const launch = launchOwnedWindowsPty(options, runtime(owned.process))
    const original = new Error('native witness unavailable')
    owned.receipt.reject(original)
    const observed = await launch.completion.catch((error: unknown) => error)
    expect(observed).toMatchObject({ cause: original })
    await expect(launch.stop()).rejects.toBe(observed)
    expect(owned.nativeStop).toHaveBeenCalledTimes(0)

    const malformed = child()
    const failed = launchOwnedWindowsPty(options, runtime(malformed.process))
    record(malformed.process, { type: 'unexpected' })
    expect(malformed.nativeStop).toHaveBeenCalledTimes(1)
    const failure = new Error('native completion rejected')
    malformed.receipt.reject(failure)
    const observedFailure = await failed.completion.catch((error: unknown) => error)
    expect(observedFailure).toBeInstanceOf(AggregateError)
    expect((observedFailure as AggregateError).errors).toContainEqual(
      expect.objectContaining({ cause: failure }),
    )
    await expect(failed.stop()).rejects.toBe(observedFailure)
  })

  it('cancels before readiness through the original native owner without inventing a PTY', async () => {
    const owned = child()
    const launch = launchOwnedWindowsPty(options, runtime(owned.process))
    const stop = launch.stop()
    expect(launch.stop()).toBe(stop)
    expect(owned.nativeStop).toHaveBeenCalledTimes(1)
    owned.process.stdout.end()
    owned.process.stderr.end()
    owned.process.emit('exit', 0, null)
    owned.process.emit('close', 0, null)
    owned.receipt.resolve('empty')
    await expect(stop).resolves.toBeUndefined()
    await expect(launch.ready).rejects.toBeInstanceOf(Error)
  })

  it('keeps simultaneous launches independent', async () => {
    const left = child()
    const right = child()
    const a = launchOwnedWindowsPty(options, runtime(left.process))
    const b = launchOwnedWindowsPty(options, runtime(right.process))
    record(left.process, { type: 'ready', pid: 11 })
    record(right.process, { type: 'ready', pid: 22 })
    const pty = await b.ready
    const output: string[] = []
    pty.onData((data) => output.push(data))
    record(right.process, { type: 'data', data: Buffer.from('still alive').toString('base64') })
    expect(output.join('')).toBe('still alive')
    a.stop()
    expect(left.nativeStop).toHaveBeenCalledTimes(1)
    expect(right.nativeStop).not.toHaveBeenCalled()
    const error = new Error('left native failure')
    left.receipt.reject(error)
    await expect(a.completion).rejects.toMatchObject({ cause: error })
    record(right.process, { type: 'exit', exitCode: 0 })
    right.process.stdout.end()
    right.process.stderr.end()
    right.process.emit('exit', 0, null)
    right.process.emit('close', 0, null)
    right.receipt.resolve('empty')
    await expect(b.completion).resolves.toBeUndefined()
  })
})
