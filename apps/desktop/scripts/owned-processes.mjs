import { spawn as nodeSpawn } from 'node:child_process'

const pollIntervalMs = 20

export function createOwnedProcesses({ spawn = nodeSpawn, signal, onChange = () => {} } = {}) {
  const children = new Set()

  function start(command, args, { env = process.env, cwd = process.cwd(), input } = {}) {
    if (signal?.aborted) throw new Error(`${command} aborted before spawn`)
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-2_000_000)
    })
    child.stderr.on('data', (chunk) => {
      output = (output + chunk).slice(-2_000_000)
    })
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.stdin.on('error', (error) => {
        output = (output + `\nstdin error: ${error.message}`).slice(-2_000_000)
        reject(error)
      })
      child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }))
    })
    exited.catch(() => {})
    child.stdin.end(input)
    const record = {
      child,
      exited,
      get output() {
        return output
      },
    }
    children.add(record)
    onChange([...children].map((owned) => owned.child.pid).filter(Boolean))
    return record
  }

  function groupExists(record) {
    const pid = record.child.pid
    if (!pid) return false
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 0)
      return true
    } catch (error) {
      if (error?.code === 'EPERM') return true
      if (error?.code === 'ESRCH') return false
      throw error
    }
  }

  function signalGroup(record, name) {
    const pid = record.child.pid
    if (!pid) return
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, name)
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }

  async function waitForGroupGone(record, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (groupExists(record)) {
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
    return true
  }

  async function stop(record, grace = 1000, killGrace = 2000) {
    if (!record || !children.has(record)) return
    signalGroup(record, 'SIGTERM')
    if (!(await waitForGroupGone(record, grace))) {
      signalGroup(record, 'SIGKILL')
      if (!(await waitForGroupGone(record, killGrace)))
        throw new Error(`process group ${record.child.pid} did not exit after SIGKILL`)
    }
    await record.exited.catch(() => {})
    children.delete(record)
    onChange([...children].map((owned) => owned.child.pid).filter(Boolean))
  }

  async function stopAll(grace = 1000, killGrace = 2000) {
    const results = await Promise.allSettled(
      [...children].map((record) => stop(record, grace, killGrace)),
    )
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) =>
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      )
    if (errors.length) throw new Error(`process cleanup failed: ${errors.join('; ')}`)
  }

  async function run(
    command,
    args,
    {
      env,
      cwd,
      input,
      signal: runSignal,
      timeoutMs = 20000,
      label = command,
      stopGraceMs = 1000,
      killGraceMs = 2000,
    } = {},
  ) {
    if (runSignal?.aborted) throw new Error(`${label} aborted before spawn`)
    const record = start(command, args, { env, cwd, input })
    let timer
    const listeners = []
    try {
      const races = [record.exited]
      for (const abortSignal of [signal, runSignal].filter(Boolean)) {
        races.push(
          new Promise((_, reject) => {
            const abort = () => reject(new Error(`${label} aborted`))
            if (abortSignal.aborted) abort()
            else {
              listeners.push([abortSignal, abort])
              abortSignal.addEventListener('abort', abort, { once: true })
            }
          }),
        )
      }
      races.push(
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
            timeoutMs,
          )
        }),
      )
      const exit = await Promise.race(races)
      if (exit.code !== 0)
        throw Object.assign(
          new Error(`${label} exited ${exit.code ?? exit.signal}: ${record.output}`),
          { exitCode: exit.code },
        )
      await stop(record, stopGraceMs, killGraceMs)
      return { ...exit, output: record.output }
    } catch (error) {
      await stop(record, stopGraceMs, killGraceMs)
      if (error instanceof Error && record.output && !error.message.includes(record.output))
        error.message += `\n${record.output}`
      throw error
    } finally {
      clearTimeout(timer)
      for (const [abortSignal, listener] of listeners)
        abortSignal.removeEventListener('abort', listener)
    }
  }

  return {
    start,
    stop,
    stopAll,
    run,
    get size() {
      return children.size
    },
    get remainingPids() {
      return [...children].map((record) => record.child.pid).filter(Boolean)
    },
  }
}
