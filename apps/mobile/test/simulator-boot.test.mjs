import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as watchdog, clearTimeout as clearWatchdog } from 'node:timers'
import { test, vi } from 'vitest'
import { runCommand } from '../scripts/host-checks.mjs'
import { bootSimulator, cleanupSimulator } from '../scripts/simulator-boot.mjs'

const simulator = '11111111-1111-4111-8111-111111111111'
const readEvents = async (root, name) =>
  (await readFile(join(root, name), 'utf8')).trim().split('\n').map(JSON.parse)

// Substitute executable/arguments, not process execution: every command still crosses
// the production spawn/stream/process-group/deadline adapter.
function adapter(events, root, mode) {
  return async (exe, args, options) => {
    const action = args[0] === 'simctl' ? args[1] : exe
    events.push(action)
    let source = 'process.stdout.write("ok")'
    if (action === 'bootstatus') {
      source =
        mode === 'success'
          ? 'process.stdout.write("Waiting on System App\\nFinished\\n")'
          : 'process.stdout.write("Waiting on Data Migration\\n"); process.exitCode = 7'
    }
    if (exe === '/usr/bin/sw_vers') {
      assert.equal(events.includes('shutdown'), false, 'evidence must precede teardown')
      const progress = await readEvents(root, 'boot-progress.jsonl')
      assert.equal(progress.at(-1).event, 'failed')
      if (mode === 'hang') source = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'
      else if (mode === 'diagnostic-error')
        source = 'process.stderr.write("secret /Users/private/account"); process.exit(9)'
    }
    if (exe === '/bin/ps') {
      source =
        'process.stdout.write("123 1 0.1 0.2 4321 55:00 S /private/com.apple.CoreSimulator.CoreSimulatorService\\n124 1 0.0 0.0 1234 55:00 Ss /private/simdiskimaged\\n125 1 1.0 2.0 9876 55:00 S /Users/private/unrelated\\n")'
    }
    if (exe === '/usr/bin/log') {
      assert.ok(args.at(-1).includes(simulator))
      assert.ok(args.at(-1).includes('com.apple.CoreSimulator.CoreSimulatorService'))
      source = `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          timestamp: '2026-11-17 10:00:00.000+0000',
          processImagePath: '/private/com.apple.CoreSimulator.CoreSimulatorService',
          eventMessage: `Device ${simulator} boot failed NSCocoaErrorDomain Code=4099 token=SECRET /Users/private/account`,
          messageType: 'Error',
        }) + '\n',
      )}.repeat(${mode === 'noisy' ? 3000 : 1}))`
    }
    if (action === 'shutdown') {
      const evidence = await readEvents(root, 'boot-host-diagnostics.jsonl')
      assert.equal(evidence.at(-1).event, 'finished')
      source = mode === 'cleanup-timeout' ? 'setInterval(() => {}, 1000)' : 'process.exit(8)'
    }
    try {
      return await runCommand(process.execPath, ['-e', source], {
        ...options,
        timeout: mode === 'cleanup-timeout' && action === 'shutdown' ? 100 : options.timeout,
        killGrace: 50,
      })
    } catch (error) {
      if (action === 'bootstatus') {
        const progress = await readEvents(root, 'boot-progress.jsonl')
        assert.ok(
          progress.some((entry) => entry.event === 'output'),
          'progress must be written while the command is running, not after rejection',
        )
        events.bootError = error
      }
      throw error
    }
  }
}

for (const mode of ['failure', 'diagnostic-error', 'hang', 'cleanup-timeout']) {
  test(`boot ${mode} preserves failure and evidence before cleanup, then deletes after shutdown failure`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-boot-test-'))
    const events = []
    const command = adapter(events, root, mode)
    const started = performance.now()
    try {
      await assert.rejects(
        bootSimulator({
          simulator,
          artifacts: root,
          runId: 'owned-test',
          command,
          diagnosticBudget: mode === 'hang' ? 180 : 3000,
          diagnosticTimeout: mode === 'hang' ? 100 : 1000,
        }),
        (error) => error === events.bootError && error.exitCode === 7,
      )
      const diagnostics = await readEvents(root, 'boot-host-diagnostics.jsonl')
      assert.equal(diagnostics[0].event, 'started')
      assert.equal(diagnostics.at(-1).event, 'finished')
      assert.ok(diagnostics.some((entry) => entry.event === 'command-started'))
      if (mode === 'hang') {
        assert.ok(diagnostics.some((entry) => entry.status === 'timeout'))
        assert.ok(performance.now() - started < 1500)
        assert.ok(diagnostics.some((entry) => entry.status === 'budget-exhausted'))
      } else {
        assert.ok(
          diagnostics.some(
            (entry) => entry.probe === 'host-log' && entry.event === 'command-finished',
          ),
        )
        const content = await readFile(join(root, 'boot-host-diagnostics.jsonl'), 'utf8')
        assert.equal(/SECRET|\/Users\/|private\/account/.test(content), false)
        assert.match(content, /NSCocoaErrorDomain/)
        const processes = diagnostics
          .filter((entry) => entry.event === 'output' && entry.probe === 'services')
          .flatMap((entry) => entry.value.processes)
        assert.deepEqual(
          processes.map((item) => item.name),
          ['CoreSimulatorService', 'simdiskimaged'],
        )
      }
      const failures = await cleanupSimulator({ simulator, artifacts: root, command })
      assert.equal(failures.length, 1)
      if (mode === 'cleanup-timeout') assert.match(failures[0], /Timed out/)
      assert.deepEqual(events.slice(-2), ['shutdown', 'delete'])
      const progress = await readEvents(root, 'boot-progress.jsonl')
      assert.ok(
        progress.some(
          (entry) => entry.event === 'output' && entry.signals.includes('data-migration'),
        ),
      )
      assert.ok(
        progress.every((entry) => Number.isFinite(Date.parse(entry.at)) && entry.elapsedMs >= 0),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('successful boot records streamed progress but performs no failure diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-boot-test-'))
  const events = []
  try {
    await bootSimulator({
      simulator,
      artifacts: root,
      runId: 'owned-test',
      command: adapter(events, root, 'success'),
    })
    assert.deepEqual(events, ['boot', 'bootstatus'])
    const progress = await readEvents(root, 'boot-progress.jsonl')
    assert.equal(progress.at(-1).event, 'ready')
    await assert.rejects(readFile(join(root, 'boot-host-diagnostics.jsonl')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('process adapter caps noisy stdout, streams both pipes, and reaps a TERM-resistant command', async () => {
  const streams = new Set()
  const output = await runCommand(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(200000)); process.stderr.write("warning")'],
    {
      outputLimit: 1024,
      onOutput: (_data, stream) => streams.add(stream),
    },
  )
  assert.equal(output.length, 1024)
  assert.deepEqual([...streams].sort(), ['stderr', 'stdout'])
  let ownedPid
  const controller = new AbortController()
  // Advance only the adapter's deadlines after a real child reports readiness.
  // CPU contention must not turn process startup into the failure under test.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const guard = watchdog(() => {
    controller.abort()
    vi.advanceTimersByTime(50)
  }, 3000)
  try {
    await assert.rejects(
      runCommand(
        process.execPath,
        [
          '-e',
          'process.on("SIGTERM", () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)',
        ],
        {
          timeout: 100,
          killGrace: 50,
          signal: controller.signal,
          onOutput: (data) => {
            ownedPid = Number(data.toString())
            vi.advanceTimersByTime(150)
          },
        },
      ),
      /Timed out/,
    )
  } finally {
    clearWatchdog(guard)
    vi.useRealTimers()
  }
  assert.ok(Number.isSafeInteger(ownedPid) && ownedPid > 0)
  let gone = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(ownedPid, 0)
    } catch (error) {
      assert.equal(error.code, 'ESRCH')
      gone = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(gone, 'the owned timed-out process must actually be reaped')
})

test('noisy output is projected and capped without losing the terminal failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-boot-test-'))
  const events = []
  const fallback = adapter(events, root, 'noisy')
  const command = (exe, args, options) => {
    if (args[1] === 'bootstatus')
      return runCommand(
        process.execPath,
        [
          '-e',
          'process.stdout.write(("Status=2\\nWaiting on Data Migration SECRET /Users/private/account\\n").repeat(3000)); process.exitCode = 7',
        ],
        options,
      )
    return fallback(exe, args, options)
  }
  try {
    await assert.rejects(
      bootSimulator({
        simulator,
        artifacts: root,
        runId: 'owned-test',
        command,
        metadata: { token: 'SECRET', account: '/Users/private/account' },
      }),
      (error) => error.exitCode === 7,
    )
    const content = await readFile(join(root, 'boot-progress.jsonl'), 'utf8')
    assert.ok(Buffer.byteLength(content) <= 128 * 1024)
    assert.equal(/SECRET|private\/account/.test(content), false)
    const progress = await readEvents(root, 'boot-progress.jsonl')
    assert.equal(progress.at(-1).event, 'failed')
    assert.ok(progress.at(-1).droppedEvents > 0)
    const diagnostics = await readFile(join(root, 'boot-host-diagnostics.jsonl'), 'utf8')
    assert.equal(/SECRET|private\/account/.test(diagnostics), false)
    assert.ok(Buffer.byteLength(diagnostics) <= 128 * 1024)
    const hostEvents = await readEvents(root, 'boot-host-diagnostics.jsonl')
    assert.equal(hostEvents.at(-1).event, 'finished')
    assert.ok(hostEvents.at(-1).droppedEvents > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('interrupted boot still gathers bounded host evidence with an independent signal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-boot-test-'))
  const controller = new AbortController()
  const events = []
  controller.abort()
  try {
    await assert.rejects(
      bootSimulator({
        simulator,
        artifacts: root,
        runId: 'owned-test',
        signal: controller.signal,
        command: adapter(events, root, 'failure'),
      }),
      /Simulator check interrupted/,
    )
    const diagnostics = await readEvents(root, 'boot-host-diagnostics.jsonl')
    assert.ok(diagnostics.some((entry) => entry.probe === 'os' && entry.status === 'ok'))
    assert.equal(diagnostics.at(-1).event, 'finished')
    await cleanupSimulator({
      simulator,
      artifacts: root,
      command: adapter(events, root, 'failure'),
    })
    assert.deepEqual(events.slice(-2), ['shutdown', 'delete'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
