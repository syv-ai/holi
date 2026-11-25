import { createRequire } from 'node:module'
import { StringDecoder } from 'node:string_decoder'
import { commandLine, launchPlan } from './launch'
import { spawnOwnedProgram } from './owned-process'
import { ownedPtyHostPlan, type PtyHostLaunch } from './owned-process-pty-host'
import { joinOwnedProgram, type ManagedOwnedChild } from './owned-program-lifetime'
import { resolveBundledWindowsNode } from './windows-node-runtime'

export type OwnedWindowsPtyOptions = {
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  cols: number
  rows: number
}
export type OwnedPtyProcess = {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void
}
export type OwnedPtyLaunch = {
  ready: Promise<OwnedPtyProcess>
  /** Joins native Job zero and output settlement; failures retain their original cause. */
  completion: Promise<void>
  stop(): Promise<void>
}
type Startup = Omit<OwnedWindowsPtyOptions, 'args'> & { args: string | string[] }
type Runtime = {
  prepare(options: OwnedWindowsPtyOptions): Startup
  spawn(plan: PtyHostLaunch, env: NodeJS.ProcessEnv): ManagedOwnedChild
  node(): string | null
  modulePath(): string
  platform: NodeJS.Platform
}
const production: Runtime = {
  prepare: (options) => {
    const plan = launchPlan(options.file, options.args, {
      env: options.env,
      cwd: options.cwd,
      platform: 'win32',
    })
    return {
      ...options,
      file: plan.file,
      args: commandLine(plan),
      env: { ...options.env, ...plan.env },
    }
  },
  spawn: (plan, env) =>
    spawnOwnedProgram(plan.file, plan.args, { cwd: plan.cwd, env, stdio: 'pipe' }),
  node: resolveBundledWindowsNode,
  modulePath: () => {
    const req = typeof require === 'function' ? require : createRequire(import.meta.url)
    return req.resolve('node-pty').replace(/([\\/])app\.asar([\\/])/i, '$1app.asar.unpacked$2')
  },
  platform: process.platform,
}
const MAX_FRAME = 1024 * 1024

type Exit = { exitCode: number; signal?: number }

/** Node-pty inherits the helper's native Job; no post-creation PID attachment occurs. */
export function launchOwnedWindowsPty(
  options: OwnedWindowsPtyOptions,
  runtime: Runtime = production,
): OwnedPtyLaunch {
  let resolveReady!: (pty: OwnedPtyProcess) => void
  let rejectReady!: (reason: unknown) => void
  let resolveDone!: () => void
  let rejectDone!: (reason: unknown) => void
  const ready = new Promise<OwnedPtyProcess>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const completion = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  void ready.catch(() => {})
  void completion.catch(() => {})
  let child: ManagedOwnedChild | undefined
  let failed = false
  let failure: unknown
  let stopped = false
  let settled = false
  let admitted = false
  let pending = ''
  let exit: Exit | undefined
  let outputBytes = 0
  let bufferedOutput: string[] = []
  const lines = new StringDecoder('utf8')
  const terminalText = new StringDecoder('utf8')
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: Exit) => void>()
  let deadline: NodeJS.Timeout | undefined

  const recordFailure = (cause: unknown) => {
    if (failed) return
    failed = true
    failure = cause
    rejectReady(cause)
  }
  const requestStop = () => {
    if (stopped || settled) return
    stopped = true
    try {
      child?.kill()
    } catch (cause) {
      recordFailure(cause)
    }
  }
  const fail = (cause: unknown) => {
    recordFailure(cause)
    requestStop()
  }
  const emitData = (data: string) => {
    if (!data) return
    if (dataListeners.size) for (const listener of dataListeners) listener(data)
    else {
      outputBytes += Buffer.byteLength(data)
      if (outputBytes > MAX_FRAME)
        throw new Error('PTY output awaiting a consumer exceeded its bound')
      bufferedOutput.push(data)
    }
  }
  const emitExit = (event: Exit) => {
    if (exit) throw new Error('Duplicate PTY exit')
    emitData(terminalText.end())
    exit = event
    for (const listener of exitListeners) listener(event)
  }
  const send = (record: object) => {
    if (failed) throw failure
    if (stopped || exit || !child?.stdin) throw new Error('PTY is not accepting input')
    const frame = Buffer.from(`${JSON.stringify(record)}\n`)
    if (frame.length > MAX_FRAME || child.stdin.writableLength + frame.length > MAX_FRAME) {
      const error = new Error('PTY input transport exceeded its bound')
      fail(error)
      throw error
    }
    try {
      child.stdin.write(frame, (error) => {
        if (error && !settled) fail(error)
      })
    } catch (cause) {
      fail(cause)
      throw cause
    }
  }
  const handle = (record: unknown) => {
    if (!record || typeof record !== 'object' || !('type' in record))
      throw new Error('Invalid PTY protocol record')
    if (exit) throw new Error('PTY record after exit')
    if (record.type === 'error') throw new Error('Windows PTY helper failed')
    if (record.type === 'ready') {
      if (
        admitted ||
        !('pid' in record) ||
        !Number.isSafeInteger(record.pid) ||
        Number(record.pid) <= 0
      )
        throw new Error('Invalid PTY readiness')
      admitted = true
      clearTimeout(deadline)
      const pty: OwnedPtyProcess = {
        pid: Number(record.pid),
        write: (data) => send({ type: 'input', data }),
        resize: (cols, rows) => send({ type: 'resize', cols, rows }),
        onData: (listener) => {
          dataListeners.add(listener)
          const queued = bufferedOutput
          bufferedOutput = []
          outputBytes = 0
          for (const data of queued) listener(data)
        },
        onExit: (listener) => {
          exitListeners.add(listener)
          if (exit) listener(exit)
        },
      }
      resolveReady(pty)
      return
    }
    if (!admitted) throw new Error('PTY output preceded readiness')
    if (record.type === 'data' && 'data' in record && typeof record.data === 'string') {
      const bytes = Buffer.from(record.data, 'base64')
      if (bytes.toString('base64') !== record.data) throw new Error('Invalid PTY terminal encoding')
      emitData(terminalText.write(bytes))
    } else if (
      record.type === 'exit' &&
      'exitCode' in record &&
      Number.isSafeInteger(record.exitCode) &&
      (!('signal' in record) || record.signal === undefined || Number.isSafeInteger(record.signal))
    ) {
      emitExit({
        exitCode: Number(record.exitCode),
        ...('signal' in record && typeof record.signal === 'number'
          ? { signal: record.signal }
          : {}),
      })
    } else throw new Error('Invalid PTY protocol record')
  }

  try {
    if (runtime.platform !== 'win32') throw new Error('Owned Windows PTYs require Windows')
    const node = runtime.node()
    if (!node) throw new Error('Bundled Windows Node runtime unavailable')
    const plan = ownedPtyHostPlan(node, runtime.modulePath(), options)
    child = runtime.spawn(plan, process.env)
    // Observe the original native lease before reading any protocol events.
    const native = joinOwnedProgram(child, 'win32')
    void native
      .then(
        (result) => {
          settled = true
          clearTimeout(deadline)
          try {
            pending += lines.end()
            if (pending) throw new Error('Truncated PTY protocol frame')
            if (result.error) throw result.error
            if (result.ownership !== 'empty' && result.ownership !== 'not-started')
              throw new Error('Windows PTY has no native empty receipt')
            if (!admitted) rejectReady(failed ? failure : new Error('Windows PTY did not start'))
            if (!stopped && (!exit || result.code !== 0))
              throw new Error('Windows PTY helper ended without complete terminal output')
            if (admitted && !exit && stopped) {
              // Job cancellation can end the helper before a root status record.
              // -1 denotes unavailable status, never the helper's exit code.
              emitExit({ exitCode: -1 })
            }
          } catch (cause) {
            recordFailure(cause)
          }
          if (failed) rejectDone(failure)
          else resolveDone()
        },
        (cause) => {
          settled = true
          clearTimeout(deadline)
          if (failed && !Object.is(failure, cause)) {
            failure = new AggregateError(
              [failure, cause],
              'PTY transport and native cleanup failed',
              { cause: failure },
            )
          } else recordFailure(cause)
          rejectDone(failure)
        },
      )
      .catch((cause: unknown) => {
        recordFailure(cause)
        rejectDone(failure)
      })
    if (!child.stdout || !child.stdin || !child.stderr)
      throw new Error('Missing PTY transport pipes')
    child.stderr.resume()
    child.stdin.on('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      if (failed) return
      try {
        pending += lines.write(chunk)
        let at: number
        while ((at = pending.indexOf('\n')) >= 0) {
          if (at > MAX_FRAME) throw new Error('PTY protocol frame exceeded its bound')
          const line = pending.slice(0, at)
          pending = pending.slice(at + 1)
          handle(JSON.parse(line) as unknown)
        }
        if (Buffer.byteLength(pending) > MAX_FRAME)
          throw new Error('PTY protocol frame exceeded its bound')
      } catch (cause) {
        fail(cause)
      }
    })
    deadline = setTimeout(() => fail(new Error('Windows PTY readiness timed out')), 60_000)
    deadline.unref()
    send(runtime.prepare(options))
  } catch (cause) {
    fail(cause)
    if (!child) rejectDone(failure)
  }

  return {
    ready,
    completion,
    stop: () => {
      requestStop()
      return completion
    },
  }
}
