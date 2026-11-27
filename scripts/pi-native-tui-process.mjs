import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const worker = fileURLToPath(new URL('./pi-native-tui-process-worker.py', import.meta.url))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Own a PTY, native producer and session anchor until verified drainage. */
export async function startOwnedPty({
  command,
  args,
  cwd,
  env,
  stateDirectory,
  timeoutMs,
  terminalSize,
  maxOutputBytes = 262144,
}) {
  if (
    !command ||
    !Array.isArray(args) ||
    !cwd ||
    !env ||
    !stateDirectory ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(maxOutputBytes) ||
    maxOutputBytes <= 0
  )
    throw new TypeError('Invalid owned PTY configuration')
  if (
    terminalSize !== undefined &&
    (!Number.isInteger(terminalSize?.rows) ||
      !Number.isInteger(terminalSize?.columns) ||
      terminalSize.rows < 1 ||
      terminalSize.rows > 1000 ||
      terminalSize.columns < 1 ||
      terminalSize.columns > 1000)
  )
    throw new TypeError('Invalid terminal size')
  await mkdir(stateDirectory, { recursive: true })
  const child = spawn(
    'python3',
    [worker, JSON.stringify({ command, args, cwd, env, terminalSize })],
    {
      cwd,
      env: { ...env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    },
  )
  let anchorPid, nativePid, nativeExit, failure, drain, closePromise
  let output = Buffer.alloc(0),
    events = '',
    stderr = '',
    closed = false
  let resolveNative, rejectNative, resolveObserved, resolveProcess
  let serial = 0
  const acknowledgements = new Map()
  const nativeObserved = new Promise((resolve) => {
    resolveObserved = resolve
  })
  const nativePromise = new Promise((resolve, reject) => {
    resolveNative = resolve
    rejectNative = reject
  })
  nativePromise.catch(() => {})
  const processPromise = new Promise((resolve) => {
    resolveProcess = resolve
  })
  const send = (message) =>
    new Promise((resolve, reject) => {
      if (child.stdio[4].destroyed || !child.stdio[4].writable) {
        reject(new Error('Supervisor control channel closed'))
        return
      }
      child.stdio[4].write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(error) : resolve(),
      )
    })
  const fail = (error) => {
    if (failure) return
    failure = error instanceof Error ? error : new Error(String(error))
    rejectNative(failure)
    for (const ack of acknowledgements.values()) ack.reject(failure)
    acknowledgements.clear()
    void send({ type: 'stop' }).catch(() => {})
  }
  child.stdout.on('data', (chunk) => {
    if (failure) return
    if (output.length + chunk.length > maxOutputBytes) {
      fail(new Error(`PTY output exceeded ${maxOutputBytes} bytes`))
      return
    }
    output = Buffer.concat([output, chunk])
  })
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8192)
  })
  for (const stream of [child.stdout, child.stderr, child.stdio[3], child.stdio[4]])
    stream.on('error', (error) => fail(new Error(`PTY pipe failed: ${error.message}`)))
  child.stdio[3].on('data', (chunk) => {
    events += chunk.toString()
    if (events.length > 65536) {
      fail(new Error('Supervisor event bound exceeded'))
      return
    }
    for (;;) {
      const newline = events.indexOf('\n')
      if (newline < 0) break
      const line = events.slice(0, newline)
      events = events.slice(newline + 1)
      try {
        const event = JSON.parse(line)
        if (event.type === 'started') {
          if (!Number.isSafeInteger(event.anchorPid) || event.anchorPid <= 1 || anchorPid)
            throw new Error('Invalid session anchor identity')
          anchorPid = event.anchorPid
        } else if (event.type === 'native-pid') {
          if (!Number.isSafeInteger(event.pid) || event.pid <= 1 || nativePid)
            throw new Error('Invalid native producer identity')
          nativePid = event.pid
        } else if (event.type === 'native-exit') {
          nativeExit = { code: event.code, signal: event.signal }
          resolveNative(nativeExit)
          resolveObserved(nativeExit)
        } else if (event.type === 'drained') {
          if (event.anchorPid !== anchorPid) throw new Error('Anchor identity changed')
          drain = event
        } else if (event.type === 'interrupted') {
          fail(new Error(`PTY supervisor interrupted by signal ${event.signal}`))
        } else if (event.type === 'input-ack') {
          acknowledgements.get(event.id)?.resolve()
          acknowledgements.delete(event.id)
        } else throw new Error('Unknown supervisor event')
        writeFileSync(
          join(stateDirectory, 'owned-pty.json'),
          JSON.stringify(
            { supervisorPid: child.pid, anchorPid, nativePid, nativeExit, drained: false },
            null,
            2,
          ),
        )
      } catch (error) {
        fail(new Error(`Invalid supervisor event: ${error.message}`))
      }
    }
  })
  child.once('error', (error) => {
    fail(new Error(`PTY supervisor spawn failed: ${error.message}`))
    resolveProcess({ error })
  })
  child.once('close', (code, signal) => {
    resolveProcess({ code, signal })
    if (!closed || !drain) fail(new Error(`Unexpected supervisor closure: ${stderr}`))
  })
  const timer = setTimeout(
    () => fail(new Error(`PTY process exceeded ${timeoutMs}ms deadline`)),
    timeoutMs,
  )
  const close = () => {
    closePromise ??= (async () => {
      closed = true
      clearTimeout(timer)
      if (!child.pid) {
        const result = await processPromise
        if (!result.error) throw new Error('Missing supervisor ownership status')
        const receipt = { started: false, drained: true, failure: failure?.message }
        await writeFile(join(stateDirectory, 'owned-pty.json'), JSON.stringify(receipt, null, 2))
        return receipt
      }
      if (!nativeExit) {
        await send({ type: 'stop' }).catch(fail)
        await Promise.race([nativeObserved, delay(250)])
        if (!nativeExit) {
          await send({ type: 'kill-native' }).catch(fail)
          await Promise.race([nativeObserved, delay(2000)])
        }
      }
      await send({ type: 'release' }).catch(fail)
      let watchdog
      const result = await Promise.race([
        processPromise,
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('Supervisor drainage timed out')), 5000)
        }),
      ]).finally(() => clearTimeout(watchdog))
      const receipt = {
        supervisorPid: child.pid,
        anchorPid,
        nativePid,
        nativeExit,
        failure: failure?.message,
        drained:
          result.code === 0 &&
          drain?.groupGone === true &&
          drain?.nativeReaped === true &&
          Boolean(nativePid),
      }
      await writeFile(join(stateDirectory, 'owned-pty.json'), JSON.stringify(receipt, null, 2))
      if (!receipt.drained)
        throw new Error(`PTY ownership/drainage uncertain: ${stderr || JSON.stringify(result)}`)
      return receipt
    })()
    return closePromise
  }
  return {
    async write(bytes) {
      // The anchor establishes raw mode before reporting the native PID.
      while (!nativePid && !closed && !failure && !nativeExit) await delay(5)
      if (closed || failure || nativeExit) throw failure ?? new Error('Native PTY is closed')
      const id = ++serial
      const ack = new Promise((resolve, reject) => acknowledgements.set(id, { resolve, reject }))
      ack.catch(() => {})
      await send({ type: 'input', id, hex: Buffer.from(bytes).toString('hex') }).catch((error) => {
        fail(error)
        throw error
      })
      await ack
    },
    async waitForExit() {
      const result = await nativePromise
      if (failure) throw failure
      return result
    },
    get output() {
      return Buffer.from(output)
    },
    get failure() {
      return failure
    },
    get nativeExit() {
      return nativeExit
    },
    close,
  }
}
