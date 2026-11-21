import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export const leaseBuildScript = fileURLToPath(
  new URL('../apps/desktop/scripts/build-posix-lease.mjs', import.meta.url),
)

function probe(pid) {
  process.kill(pid, 0)
}

async function proveAbsent(pid, probePresence) {
  const deadline = Date.now() + 1500
  for (const id of [pid, -pid]) {
    for (;;) {
      let reason = 'still present'
      try {
        probePresence(id)
      } catch (error) {
        if (error.code === 'ESRCH') break
        reason = error.code ?? String(error)
      }
      if (Date.now() >= deadline) {
        return `Could not confirm ${id < 0 ? 'runner group' : 'runner PID'} ${Math.abs(id)} absent: ${reason}`
      }
      await delay(20)
    }
  }
}

// Own only the direct ChildProcess and its pipes. POSIX group checks are read-only
// and include zombies. A group check cannot account for separately detached leases:
// the caller must also validate the worker's settlement evidence before removing a root.
export function runProducerCommand(
  command,
  args,
  { cwd, env, timeout, maxOutput, diagnosticTail, adapter },
) {
  const { spawnChild, probePresence } = adapter ?? { spawnChild: spawn, probePresence: probe }
  const posix = process.platform !== 'win32'
  const result = {
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    retainedBytes: 0,
    timedOut: false,
    outputLimited: false,
  }
  if (timeout <= 0) return Promise.resolve({ ...result, timedOut: true, notStarted: true })
  return new Promise((resolve) => {
    let child
    try {
      child = spawnChild(command, args, {
        cwd,
        env,
        detached: posix,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ...result, error: error.message, cleanupError: 'Missing runner launch receipt' })
      return
    }
    let spawned = false
    let exited = false
    let closed = false
    let finalized = false
    let escalation
    let finalizer
    const stdout = []
    const stderr = []
    const requestStop = (signal) => {
      if (!spawned || exited || closed) return
      try {
        if (!child.kill(signal)) result.stopError ??= `Could not deliver ${signal} to runner handle`
      } catch (error) {
        result.stopError ??= error.message
      }
    }
    const terminate = () => {
      clearTimeout(timer)
      requestStop('SIGTERM')
      escalation = setTimeout(() => requestStop('SIGKILL'), 200)
      finalizer = setTimeout(() => {
        // Exit alone doesn't join inherited pipes. Bound the wait, but don't
        // confuse closing our pipe ends with proof that their writers exited.
        child.stdout.destroy()
        child.stderr.destroy()
        if (!exited) child.unref()
        void finish()
      }, 750)
    }
    const append = (output, chunk) => {
      if (finalized) return
      const remaining = maxOutput - result.retainedBytes
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining)
        output.push(retained)
        result.retainedBytes += retained.length
      }
      if (remaining < chunk.length && !result.timedOut && !result.outputLimited) {
        result.outputLimited = true
        terminate()
      }
    }
    const timer = setTimeout(() => {
      result.timedOut = true
      terminate()
    }, timeout)
    const finish = async () => {
      if (finalized) return
      finalized = true
      clearTimeout(timer)
      clearTimeout(escalation)
      clearTimeout(finalizer)
      const render = (chunks) =>
        Buffer.concat(chunks)
          .toString()
          .slice(-(diagnosticTail ?? Infinity))
      result.stdout = render(stdout)
      result.stderr = render(stderr)
      if (!closed) result.cleanupError = 'Runner close was not observed'
      else if (!result.notStarted) {
        if (!result.pid || !exited) result.cleanupError = 'Missing runner launch or exit receipt'
        else if (posix) result.cleanupError = await proveAbsent(result.pid, probePresence)
      }
      resolve(result)
    }
    child.stdout.on('data', (chunk) => append(stdout, chunk))
    child.stderr.on('data', (chunk) => append(stderr, chunk))
    child.once('spawn', () => {
      spawned = true
      if (Number.isSafeInteger(child.pid) && child.pid > 1) result.pid = child.pid
      if (result.timedOut || result.outputLimited) requestStop('SIGTERM')
    })
    child.once('exit', (code, signal) => {
      exited = true
      result.code = code
      result.signal = signal
    })
    child.on('error', (error) => {
      if (!spawned) {
        result.error = error.message
        // Node reported an actual exec failure, not merely a missing PID.
        if (child.pid === undefined && ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code))
          result.notStarted = true
      } else result.stopError ??= error.message
    })
    child.once('close', () => {
      closed = true
      void finish()
    })
  })
}

export function producerCommandFailure(result, label, timeout) {
  if (result.timedOut)
    return `${label} timed out${timeout === undefined ? '' : ` after ${timeout}ms`}`
  if (result.outputLimited) return `${label} output exceeded bound`
  if (result.error) return `${label} could not start: ${result.error}`
  if (result.signal) return `${label} exited on ${result.signal}`
  if (result.code !== 0) return `${label} exited ${result.code}`
}
