import { execFile, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { constants, freemem, loadavg, totalmem } from 'node:os'
import { basename, join } from 'node:path'

// Test output stays on the runner's masked streams; artifacts contain only these events.
async function main() {
  const [directory, command, ...args] = process.argv.slice(2)
  if (!directory || !command) {
    console.error('Usage: ci-test-runner.mjs <diagnostics-directory> <command> [args...]')
    process.exitCode = 2
    return
  }
  mkdirSync(directory, { recursive: true })
  const file = openSync(join(directory, 'events.jsonl'), 'w')
  const started = performance.now()
  let diagnosticFailure = false
  let finished = false
  let sampler
  let terminationSignal
  let spawnError

  function record(event) {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      ...event,
    })
    process.stdout.write(`[holi-ci] ${line}\n`)
    try {
      writeSync(file, `${line}\n`)
    } catch (error) {
      if (!diagnosticFailure) console.error(`[holi-ci] diagnostic write failed: ${error.code}`)
      diagnosticFailure = true
    }
  }

  function sample() {
    if (sampler || finished) return
    record({ event: 'resources', freeBytes: freemem(), totalBytes: totalmem(), load: loadavg() })
    sampler = execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pcpu=,rss=,comm='],
      {
        timeout: 5000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error, stdout) => {
        sampler = undefined
        if (finished) return
        if (error) {
          record({ event: 'sample-error', errorCode: error.code ?? null })
          return
        }
        const processes = stdout.split('\n').flatMap((line) => {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
          return match
            ? [
                {
                  pid: Number(match[1]),
                  parentPid: Number(match[2]),
                  cpuPercent: Number(match[3]),
                  rssKiB: Number(match[4]),
                  command: basename(match[5]),
                },
              ]
            : []
        })
        processes.sort((a, b) => b.rssKiB - a.rssKiB)
        record({ event: 'processes', processes: processes.slice(0, 10) })
      },
    )
  }

  record({
    event: 'start',
    sha: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  })
  sample()
  const timer = setInterval(sample, 60_000)
  // Keep test process-group signals away from the observer and hosted runner.
  const isolated = process.platform !== 'win32'
  const child = spawn(command, args, { stdio: 'inherit', detached: isolated })
  let cancellation
  const send = (signal) => {
    if (!child.pid) return
    try {
      if (isolated) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch (error) {
      if (error.code !== 'ESRCH') {
        diagnosticFailure = true
        record({ event: 'cancellation-error', errorCode: error.code })
      }
    }
  }
  const forward = (signal) => {
    if (cancellation) return
    terminationSignal = signal
    send(signal)
    // Cancellation grace is not a test deadline. Include descendants after root exit.
    cancellation = new Promise((resolve) => {
      setTimeout(() => {
        send('SIGKILL')
        resolve()
      }, 2000)
    })
  }
  const interrupt = () => forward('SIGINT')
  const terminate = () => forward('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  child.on('error', (error) => {
    spawnError = error.code
    record({ event: 'spawn-error', errorCode: error.code })
  })
  const result = await new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  finished = true
  clearInterval(timer)
  sampler?.kill('SIGKILL')
  if (cancellation) await cancellation
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', terminate)
  record({ event: 'exit', ...result, terminationSignal: terminationSignal ?? null })
  closeSync(file)
  const signal = terminationSignal ?? result.signal
  process.exitCode = signal
    ? 128 + constants.signals[signal]
    : spawnError
      ? 1
      : result.code || Number(diagnosticFailure)
}

main().catch((error) => {
  console.error(`[holi-ci] observer failed: ${error.code ?? error.name}`)
  process.exitCode = 1
})
