import { ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export class FixtureDeadlineError extends Error {
  constructor(readonly stage: string) {
    super(`${stage} deadline exceeded`)
  }
}

type Settled<T> = { value: T } | { error: unknown }
type Listener<T> = (result: Settled<T>) => void

// A persistent observation with removable waiters. A timed-out waiter never stays
// attached to the event source (or to a promise that might never settle).
export function fixtureResult<T>() {
  let settled: Settled<T> | undefined
  const listeners = new Set<Listener<T>>()
  return {
    get current() {
      return settled
    },
    settle(result: Settled<T>) {
      if (settled) return
      settled = result
      for (const listener of listeners) listener(result)
      listeners.clear()
    },
    wait(ms: number, stage: string): Promise<T> {
      if (settled) {
        return 'error' in settled ? Promise.reject(settled.error) : Promise.resolve(settled.value)
      }
      return new Promise((resolve, reject) => {
        const listener: Listener<T> = (result) => {
          clearTimeout(timer)
          if ('error' in result) reject(result.error)
          else resolve(result.value)
        }
        const timer = setTimeout(() => {
          listeners.delete(listener)
          reject(new FixtureDeadlineError(stage))
        }, ms)
        listeners.add(listener)
      })
    },
  }
}

const observed = new WeakMap<Promise<unknown>, ReturnType<typeof fixtureResult<unknown>>>()

export function within<T>(work: Promise<T>, ms: number, stage: string): Promise<T> {
  let result = observed.get(work)
  if (!result) {
    const observation = fixtureResult<T>()
    observed.set(work, observation)
    void work.then(
      (value) => observation.settle({ value }),
      (error: unknown) => observation.settle({ error }),
    )
    result = observation
  }
  return result.wait(ms, stage) as Promise<T>
}

export async function pollFixture<T>(
  read: () => T | undefined | Promise<T | undefined>,
  deadline: number,
  stage: string,
  intervalMs: number,
): Promise<T> {
  for (;;) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new FixtureDeadlineError(stage)
    const probe = read()
    const value = probe instanceof Promise ? await within(probe, remaining, stage) : probe
    if (value !== undefined) return value
    await delay(Math.min(intervalMs, Math.max(0, deadline - performance.now())))
  }
}

const children = new WeakMap<ChildProcess, ReturnType<typeof observeChild>>()

// Register at spawn, before any awaits. Node has no public flag for child `close`.
export function fixtureChild(child: ChildProcess) {
  let observation = children.get(child)
  if (!observation) {
    observation = observeChild(child)
    children.set(child, observation)
  }
  return observation
}

export function fixtureChildAlive(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null
}

/** Terminate the actual fixture child, bypassing any overridden managed stop. */
export async function stopFixtureChild(child: ChildProcess, ms: number, label: string) {
  const observed = fixtureChild(child)
  if (fixtureChildAlive(child)) ChildProcess.prototype.kill.call(child, 'SIGKILL')
  await observed.join(ms, label)
}

function observeChild(child: ChildProcess) {
  const exit = fixtureResult<void>()
  const close = fixtureResult<number | null>()
  const completion = fixtureResult<number | null>()
  child.on('error', (error) => completion.settle({ error }))
  child.once('exit', () => exit.settle({ value: undefined }))
  child.once('close', (code) => {
    close.settle({ value: code })
    completion.settle({ value: code })
  })
  return {
    completion,
    async join(ms: number, label: string) {
      const code = await close.wait(ms, `${label} close`)
      const result = completion.current
      // A spawn failure has no OS process and won't emit `exit`.
      if (!exit.current && !(child.pid === undefined && result && 'error' in result))
        throw new Error(`${label} closed without an observed exit (pid=${child.pid ?? 'none'})`)
      return code
    },
  }
}

/** Cleanup starts with its own budget and cannot replace an earlier failure. */
export async function withFixtureCleanup<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<unknown>,
): Promise<T> {
  let result: Settled<T>
  try {
    result = { value: await work() }
  } catch (error) {
    result = { error }
  }
  try {
    await cleanup()
  } catch (error) {
    if ('error' in result && result.error !== error)
      throw new AggregateError([result.error, error], 'fixture operation and cleanup failed')
    throw error
  }
  if ('error' in result) throw result.error
  return result.value
}
