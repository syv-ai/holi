import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'vitest'

const runner = resolve(import.meta.dirname, '../scripts/run-browser-frame-addressing-smoke.mjs')
const delay = (milliseconds: number) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))

async function waitForGroupExit(group: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(-group, 0)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return true
      if (code !== 'EPERM') throw error
    }
    await delay(25)
  }
  return false
}

async function cancelSupervisor(
  supervisor: ChildProcess,
  closePromise: Promise<unknown>,
): Promise<Error[]> {
  const failures: Error[] = []
  const attempt = async (label: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      failures.push(new Error(`${label}: ${error}`))
    }
  }
  const isRunning = () => supervisor.exitCode === null && supervisor.signalCode === null
  if (isRunning())
    await attempt('supervisor TERM', async () => {
      supervisor.kill('SIGTERM')
    })
  if (isRunning())
    await attempt('supervisor TERM close wait', async () => {
      await Promise.race([
        closePromise,
        delay(5_000).then(() => {
          throw new Error('supervisor close wait timed out')
        }),
      ])
    })
  if (isRunning())
    await attempt('supervisor KILL', async () => {
      supervisor.kill('SIGKILL')
    })
  if (isRunning())
    await attempt('supervisor KILL close wait', async () => {
      await Promise.race([
        closePromise,
        delay(1_000).then(() => {
          throw new Error('supervisor close wait timed out after KILL')
        }),
      ])
    })
  return failures
}

async function drainOwnedBuild(pid: number): Promise<{ failures: Error[]; termGraceful: boolean }> {
  const failures: Error[] = []
  const attempt = async (label: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      failures.push(new Error(`${label}: ${error}`))
    }
  }
  const signalGroup = async (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }

  // TERM is only a grace period. Its timeout or failure never prevents escalation.
  await attempt('build group TERM', () => signalGroup('SIGTERM'))
  let termGraceful = false
  await attempt('build group TERM grace', async () => {
    termGraceful = await waitForGroupExit(pid, 750)
  })
  if (!termGraceful) {
    await attempt('build group KILL', () => signalGroup('SIGKILL'))
    await attempt('build group KILL verification', async () => {
      assert(await waitForGroupExit(pid, 2_000), `owned process group ${pid} survived KILL`)
    })
  }

  return { failures, termGraceful }
}

function captureClose(processRef: ChildProcess): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
}> {
  return new Promise((resolveExit, rejectExit) => {
    processRef.once('error', rejectExit)
    processRef.once('close', (code, signal) => resolveExit({ code, signal }))
  })
}

describe('browser frame addressing smoke supervision', () => {
  it.skipIf(process.platform === 'win32')(
    'drains the owned build process group before repeated signal cleanup completes',
    async () => {
      const parent = await mkdtemp(join(tmpdir(), 'holi-670-runner-test-'))
      const evidence = join(parent, 'evidence')
      const buildGate = join(parent, 'held-vite-build')
      const processRef = spawn(process.execPath, [runner, evidence], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOLI_670_TEST_BUILD_GATE: buildGate },
      })
      const closePromise = captureClose(processRef)
      let output = ''
      processRef.stdout.setEncoding('utf8')
      processRef.stderr.setEncoding('utf8')
      processRef.stdout.on('data', (chunk: string) => (output += chunk))
      processRef.stderr.on('data', (chunk: string) => (output += chunk))
      let checkpoint: { pid: number } | undefined
      let assertionFailure: unknown
      const cleanupFailures: Error[] = []
      try {
        // Keep ten seconds of the declared test deadline available for teardown.
        const deadline = Date.now() + 15_000
        while (
          !checkpoint &&
          Date.now() < deadline &&
          processRef.exitCode === null &&
          processRef.signalCode === null
        ) {
          try {
            checkpoint = JSON.parse(await readFile(`${buildGate}.started`, 'utf8'))
          } catch {
            await delay(25)
          }
        }
        assert(
          checkpoint?.pid && checkpoint.pid > 1 && Number.isSafeInteger(checkpoint.pid),
          'actual Vite buildStart checkpoint is held',
        )
        process.kill(checkpoint.pid, 0)
        assert.equal(processRef.kill('SIGTERM'), true, 'first signal was delivered')
        const firstSignalDeadline = Date.now() + 3_000
        while (
          !output.includes('signal received: SIGTERM during build') &&
          Date.now() < firstSignalDeadline
        )
          await delay(10)
        assert.match(output, /signal received: SIGTERM during build/)
        assert.equal(
          processRef.kill('SIGINT'),
          true,
          'repeated signal was delivered during cleanup',
        )
        const exit = await Promise.race([
          closePromise,
          delay(5_000).then(() => {
            throw new Error('runner close timed out')
          }),
        ])
        assert.notEqual(exit.code, 0, 'signal cancellation reports failure')
        const receipt = JSON.parse(await readFile(join(evidence, 'failure.json'), 'utf8'))
        assert.equal(receipt.cancellation, 'received SIGTERM', 'signal was the cancellation cause')
        assert.deepEqual(
          receipt.errors,
          ['Error: received SIGTERM'],
          'no earlier failure was masked',
        )
        assert.deepEqual(
          receipt.signals.slice(0, 2).map(({ signal }) => signal),
          ['SIGTERM', 'SIGINT'],
        )
        assert.equal(receipt.signals[0].phase, 'build')
        assert.equal(receipt.signals[1].phase, 'cleanup')
        assert.equal(receipt.cleanup.buildGroupDrained, true)
        assert.equal(receipt.cleanup.buildTerminationRecorded, true)
        assert.equal(receipt.cleanup.ownedBuildPid, checkpoint.pid)
        assert.equal(receipt.cleanup.buildGroupDrainedAfterSignal, true)
        assert.throws(() => process.kill(checkpoint!.pid, 0), { code: 'ESRCH' })
        assert.equal(receipt.cleanup.childGroupDrained, true)
        assert.equal(receipt.cleanup.sandboxRemoved, true)
        assert.equal(receipt.cleanup.serverClosed, true)
      } catch (error) {
        assertionFailure = error
      } finally {
        cleanupFailures.push(...(await cancelSupervisor(processRef, closePromise)))
        if (checkpoint?.pid)
          cleanupFailures.push(...(await drainOwnedBuild(checkpoint.pid)).failures)
        try {
          await rm(parent, { recursive: true, force: true })
        } catch (error) {
          cleanupFailures.push(new Error(`temporary directory cleanup: ${error}`))
        }
      }
      try {
        await assert.rejects(stat(parent), { code: 'ENOENT' })
      } catch (error) {
        cleanupFailures.push(new Error(`temporary directory removal verification: ${error}`))
      }
      if (assertionFailure && cleanupFailures.length)
        throw new AggregateError(
          [assertionFailure, ...cleanupFailures],
          'assertion and cleanup failed',
        )
      if (assertionFailure) throw assertionFailure
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'cleanup failed')
    },
    30_000,
  )

  it.skipIf(process.platform === 'win32')(
    'escalates TERM-ignoring owned groups after the supervisor has exited',
    async () => {
      const parent = await mkdtemp(join(tmpdir(), 'holi-670-term-ignore-'))
      const receiptPath = join(parent, 'owned-build.json')
      // This disposable detached process is the test's only process-group target.
      const build = spawn(
        process.execPath,
        [
          '-e',
          `
            const fs = require('node:fs')
            process.on('SIGTERM', () => {})
            setInterval(() => {}, 1000)
            const temporaryReceipt = process.argv[1] + '.tmp-' + process.pid
            fs.writeFileSync(temporaryReceipt, JSON.stringify({ pid: process.pid }))
            fs.renameSync(temporaryReceipt, process.argv[1])
          `,
          receiptPath,
        ],
        { detached: true, stdio: 'ignore' },
      )
      const buildClose = captureClose(build)
      const supervisor = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
      const supervisorClose = captureClose(supervisor)
      let pid: number | undefined
      let assertionFailure: unknown
      let buildGroupDrained = false
      const cleanupFailures: Error[] = []
      try {
        const deadline = Date.now() + 2_000
        while (!pid && Date.now() < deadline) {
          try {
            const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
            assert.equal(receipt.pid, build.pid, 'receipt identifies the spawned owned leader')
            pid = receipt.pid
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            await delay(10)
          }
        }
        assert(
          pid && pid > 1 && Number.isSafeInteger(pid),
          'disposable group readiness receipt exists',
        )
        assert.equal(build.pid, pid)
        process.kill(pid, 0)
        const supervisorExit = await Promise.race([
          supervisorClose,
          delay(1_000).then(() => {
            throw new Error('disposable supervisor did not exit')
          }),
        ])
        assert.equal(supervisorExit.code, 0)
        assert.equal(supervisor.exitCode, 0, 'supervisor exited before build cleanup')
        const drain = await drainOwnedBuild(pid)
        cleanupFailures.push(...drain.failures)
        buildGroupDrained = drain.failures.length === 0
        assert.equal(drain.termGraceful, false, 'owned build ignored TERM and required KILL')
        await Promise.race([
          buildClose,
          delay(1_000).then(() => {
            throw new Error('owned disposable build close timed out')
          }),
        ])
        assert.throws(() => process.kill(-pid!, 0), { code: 'ESRCH' })
      } catch (error) {
        assertionFailure = error
      } finally {
        if (!buildGroupDrained && build.pid) {
          const drain = await drainOwnedBuild(build.pid)
          cleanupFailures.push(...drain.failures)
          buildGroupDrained = drain.failures.length === 0
        }
        cleanupFailures.push(...(await cancelSupervisor(supervisor, supervisorClose)))
        try {
          await rm(parent, { recursive: true, force: true })
        } catch (error) {
          cleanupFailures.push(new Error(`temporary directory cleanup: ${error}`))
        }
      }
      try {
        await assert.rejects(stat(parent), { code: 'ENOENT' })
      } catch (error) {
        cleanupFailures.push(new Error(`temporary directory removal verification: ${error}`))
      }
      if (assertionFailure && cleanupFailures.length)
        throw new AggregateError(
          [assertionFailure, ...cleanupFailures],
          'assertion and cleanup failed',
        )
      if (assertionFailure) throw assertionFailure
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'cleanup failed')
    },
    10_000,
  )

  it.skipIf(process.platform === 'win32')(
    'drains its spawned group when readiness receipt acquisition fails',
    async () => {
      const parent = await mkdtemp(join(tmpdir(), 'holi-670-receipt-failure-'))
      const receiptPath = join(parent, 'receipt')
      await mkdir(receiptPath)
      const build = spawn(
        process.execPath,
        [
          '-e',
          `
            const fs = require('node:fs')
            process.on('SIGTERM', () => {})
            setInterval(() => {}, 1000)
            const temporaryReceipt = process.argv[1] + '.tmp-' + process.pid
            try {
              fs.writeFileSync(temporaryReceipt, JSON.stringify({ pid: process.pid }))
              fs.renameSync(temporaryReceipt, process.argv[1])
            } catch { console.log('readiness receipt acquisition failed') }
          `,
          receiptPath,
        ],
        { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      const buildClose = captureClose(build)
      let output = ''
      let buildGroupDrained = false
      build.stdout?.setEncoding('utf8')
      build.stdout?.on('data', (chunk: string) => (output += chunk))
      const cleanupFailures: Error[] = []
      let assertionFailure: unknown
      try {
        const deadline = Date.now() + 2_000
        while (!output.includes('readiness receipt acquisition failed') && Date.now() < deadline)
          await delay(10)
        assert.match(output, /readiness receipt acquisition failed/)
        assert(build.pid && build.pid > 1 && Number.isSafeInteger(build.pid))
        assert.equal(build.exitCode, null, 'fixture remains alive after receipt failure')
        process.kill(build.pid, 0)
        const drain = await drainOwnedBuild(build.pid)
        cleanupFailures.push(...drain.failures)
        buildGroupDrained = drain.failures.length === 0
        assert.equal(drain.termGraceful, false, 'fixture ignores TERM and is escalated')
        await Promise.race([
          buildClose,
          delay(1_000).then(() => {
            throw new Error('receipt-failure fixture close timed out')
          }),
        ])
        assert.throws(() => process.kill(-build.pid!, 0), { code: 'ESRCH' })
      } catch (error) {
        assertionFailure = error
      } finally {
        if (!buildGroupDrained && build.pid) {
          const drain = await drainOwnedBuild(build.pid)
          cleanupFailures.push(...drain.failures)
          buildGroupDrained = drain.failures.length === 0
        }
        try {
          await rm(parent, { recursive: true, force: true })
        } catch (error) {
          cleanupFailures.push(new Error(`temporary directory cleanup: ${error}`))
        }
      }
      try {
        await assert.rejects(stat(parent), { code: 'ENOENT' })
      } catch (error) {
        cleanupFailures.push(new Error(`temporary directory removal verification: ${error}`))
      }
      if (assertionFailure && cleanupFailures.length)
        throw new AggregateError(
          [assertionFailure, ...cleanupFailures],
          'assertion and cleanup failed',
        )
      if (assertionFailure) throw assertionFailure
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'cleanup failed')
    },
    10_000,
  )

  it('rejects unsupported Windows process-group execution before creating evidence', async () => {
    if (process.platform !== 'win32') return
    const parent = await mkdtemp(join(tmpdir(), 'holi-670-runner-guard-'))
    const evidence = join(parent, 'evidence')
    try {
      const result = await new Promise<{ code: number | null; output: string }>((resolveExit) => {
        const processRef = spawn(process.execPath, [runner, evidence], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let output = ''
        processRef.stdout.on('data', (chunk) => (output += chunk))
        processRef.stderr.on('data', (chunk) => (output += chunk))
        processRef.once('close', (code) => resolveExit({ code, output }))
      })
      assert.notEqual(result.code, 0)
      assert.match(result.output, /requires POSIX owned process groups/)
      await assert.rejects(readFile(evidence), { code: 'ENOENT' })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
