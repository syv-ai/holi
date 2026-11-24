import { createRequire } from 'node:module'
import { spawnOwnedProgram } from './owned-process'
import { ownedPtyHostPlan } from './owned-process-pty-host'
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
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void
}
export type OwnedPtyLaunch = {
  ready: Promise<OwnedPtyProcess>
  completion: Promise<void>
  stop(): Promise<void>
}
type Runtime = {
  spawn(
    plan: { file: string; args: string[]; cwd: string },
    env: NodeJS.ProcessEnv,
  ): ManagedOwnedChild
  node(): string | null
  modulePath(): string
  platform: NodeJS.Platform
}
const production: Runtime = {
  spawn: (plan, env) =>
    spawnOwnedProgram(plan.file, plan.args, { cwd: plan.cwd, env, stdio: 'pipe' }),
  node: resolveBundledWindowsNode,
  modulePath: () => {
    const req = createRequire(import.meta.url)
    return req.resolve('node-pty').replace(/([\\/])app\.asar([\\/])/i, '$1app.asar.unpacked$2')
  },
  platform: process.platform,
}
const MAX_LINE = 1024 * 1024

/** Start node-pty beneath the native Job root; all native completion stays with that root. */
export function launchOwnedWindowsPty(
  options: OwnedWindowsPtyOptions,
  runtime: Runtime = production,
): OwnedPtyLaunch {
  let resolveReady!: (pty: OwnedPtyProcess) => void
  let rejectReady!: (reason: Error) => void
  let resolveDone!: () => void
  let rejectDone!: (reason: Error) => void
  const ready = new Promise<OwnedPtyProcess>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })
  const completion = new Promise<void>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })
  void ready.catch(() => undefined)
  void completion.catch(() => undefined)
  let child: ManagedOwnedChild | undefined
  let failure: Error | undefined
  let ended = false
  let buffer = ''
  let pty: OwnedPtyProcess | undefined
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()
  let pendingData = ''
  let pendingExit: { exitCode: number; signal?: number } | undefined
  const fail = (message: string) => {
    if (failure) return
    failure = new Error(message)
    rejectReady(failure)
    rejectDone(failure)
  }
  const send = (command: object) => {
    if (!child || ended || failure) throw failure ?? new Error('PTY is not running')
    child.stdin?.write(`${JSON.stringify(command)}\n`)
  }
  const launch = runtime.node()
  if (runtime.platform !== 'win32' || !launch) fail('Bundled Windows Node runtime unavailable')
  else {
    const plan = ownedPtyHostPlan(launch, runtime.modulePath(), options)
    child = runtime.spawn(plan, process.env)
    const native = joinOwnedProgram(child, runtime.platform)
    void native.then(
      (result) => {
        if (result.ownership !== 'empty') fail('Native Job did not become empty')
        else if (!failure) resolveDone()
      },
      (error) => fail(error instanceof Error ? error.message : String(error)),
    )
    let lineBuffer = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      lineBuffer += chunk.toString()
      if (lineBuffer.length > MAX_LINE && !lineBuffer.includes('\n'))
        return fail('PTY protocol frame too large')
      let at: number
      while ((at = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, at)
        lineBuffer = lineBuffer.slice(at + 1)
        if (line.length > MAX_LINE) return fail('PTY protocol frame too large')
        let frame: any
        try {
          frame = JSON.parse(line)
        } catch {
          return fail('Invalid PTY protocol JSON')
        }
        if (frame.type === 'ready' && Number.isInteger(frame.pid)) {
          pty = {
            pid: frame.pid,
            write: (data) => send({ type: 'input', data }),
            resize: (cols, rows) => send({ type: 'resize', cols, rows }),
            onData: (listener) => {
              dataListeners.add(listener)
              if (pendingData) listener(pendingData)
              pendingData = ''
            },
            onExit: (listener) => {
              exitListeners.add(listener)
              if (pendingExit) listener(pendingExit)
              pendingExit = undefined
            },
          }
          resolveReady(pty)
        } else if (frame.type === 'data' && typeof frame.data === 'string') {
          const data = Buffer.from(frame.data, 'base64').toString()
          if (!dataListeners.size) {
            pendingData += data
            if (pendingData.length > MAX_LINE) return fail('PTY output buffer exceeded')
          } else dataListeners.forEach((listener) => listener(data))
        } else if (frame.type === 'exit' && Number.isInteger(frame.exitCode)) {
          const event = {
            exitCode: frame.exitCode,
            ...(typeof frame.signal === 'number' ? { signal: frame.signal } : {}),
          }
          pendingExit = event
          exitListeners.forEach((listener) => listener(event))
          ended = true
        } else if (frame.type === 'error') fail(String(frame.message ?? 'PTY host error'))
        else fail('Invalid PTY protocol frame')
      }
    })
    child.stdin?.write(`${JSON.stringify({ ...options, env: options.env })}\n`)
  }
  return {
    ready,
    completion,
    stop: async () => {
      if (!child) {
        if (failure) throw failure
        return
      }
      child.kill()
      try {
        await completion
      } catch (error) {
        throw failure ?? error
      }
    },
  }
}
