import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, test, vi } from 'vitest'
import { runCommand } from '../scripts/host-checks.mjs'
import { bootSimulator, cleanupSimulator } from '../scripts/simulator-boot.mjs'

const { spawnCapture } = vi.hoisted(() => ({ spawnCapture: { enabled: false, child: null } }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    spawn: (...args) => {
      const child = actual.spawn(...args)
      if (spawnCapture.enabled) spawnCapture.child = child
      return child
    },
  }
})

const simulator = '11111111-1111-4111-8111-111111111111'
const readEvents = async (root, name) =>
  (await readFile(join(root, name), 'utf8')).trim().split('\n').map(JSON.parse)

// Projection and ordering cross the public command seam without paying for a host
// process per probe. The real spawn/deadline/reaping adapter is exercised separately.
function adapter(events, root, mode, onHang) {
  return async (exe, args, options) => {
    const action = args[0] === 'simctl' ? args[1] : exe
    events.push(action)
    if (exe === 'xcrun') {
      assert.deepEqual(args, [
        'simctl',
        action,
        simulator,
        ...(action === 'bootstatus' ? ['-b'] : []),
      ])
      assert.ok(['boot', 'bootstatus', 'shutdown', 'delete'].includes(action))
    }
    if (options.signal?.aborted) throw new Error('Simulator check interrupted')
    const emit = (output, stream = 'stdout') => {
      options.onOutput?.(Buffer.from(output), stream)
      return output.trim()
    }
    if (action === 'bootstatus') {
      if (mode === 'success') return emit('Waiting on System App\nFinished\n')
      emit(
        mode === 'noisy'
          ? 'Status=2\nWaiting on Data Migration SECRET /Users/private/account\n'.repeat(3000)
          : 'Waiting on Data Migration\n',
      )
      const progress = await readEvents(root, 'boot-progress.jsonl')
      assert.ok(
        progress.some((entry) => entry.event === 'output'),
        'progress must be written while the command is running, not after rejection',
      )
      events.bootError = Object.assign(new Error('Exit 7: bootstatus'), { exitCode: 7 })
      throw events.bootError
    }
    if (exe === '/usr/bin/sw_vers') {
      assert.equal(events.includes('shutdown'), false, 'evidence must precede teardown')
      const progress = await readEvents(root, 'boot-progress.jsonl')
      assert.equal(progress.at(-1).event, 'failed')
      if (mode === 'hang') {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('Timed out: host probe'), { timedOut: true })),
            { once: true },
          )
          onHang()
        })
      }
      if (mode === 'diagnostic-error') {
        emit('secret /Users/private/account', 'stderr')
        throw Object.assign(new Error('secret /Users/private/account'), { exitCode: 9 })
      }
    }
    if (exe === '/bin/ps') {
      return emit(
        '123 1 0.1 0.2 4321 55:00 S /private/com.apple.CoreSimulator.CoreSimulatorService\n124 1 0.0 0.0 1234 55:00 Ss /private/simdiskimaged\n125 1 1.0 2.0 9876 55:00 S /Users/private/unrelated\n',
      )
    }
    if (exe === '/usr/bin/log') {
      assert.equal(
        args.at(-1),
        `(process == "com.apple.CoreSimulator.CoreSimulatorService" OR process == "CoreSimulatorService" OR process == "simdiskimaged") AND eventMessage CONTAINS[c] "${simulator}"`,
      )
      const entry = {
        timestamp: '2026-11-17 10:00:00.000+0000',
        processImagePath: '/private/com.apple.CoreSimulator.CoreSimulatorService',
        eventMessage: `Device ${simulator} boot failed NSCocoaErrorDomain Code=4099 token=SECRET /Users/private/account`,
        messageType: 'Error',
      }
      // Neither another device nor another process may enter the owned evidence.
      emit(
        JSON.stringify({
          ...entry,
          eventMessage: 'Device 22222222-2222-4222-8222-222222222222 watchdog',
        }) + '\n',
      )
      emit(
        JSON.stringify({
          ...entry,
          processImagePath: '/Users/private/unrelated',
          eventMessage: `Device ${simulator} launchd`,
        }) + '\n',
      )
      return emit((JSON.stringify(entry) + '\n').repeat(mode === 'noisy' ? 3000 : 1))
    }
    if (action === 'shutdown') {
      const evidence = await readEvents(root, 'boot-host-diagnostics.jsonl')
      assert.equal(evidence.at(-1).event, 'finished')
      throw Object.assign(
        new Error(mode === 'cleanup-timeout' ? 'Timed out: shutdown' : 'Exit 8: shutdown'),
        { exitCode: mode === 'cleanup-timeout' ? null : 8, timedOut: mode === 'cleanup-timeout' },
      )
    }
    return emit('ok')
  }
}

for (const mode of ['failure', 'diagnostic-error', 'hang', 'cleanup-timeout']) {
  test(`boot ${mode} preserves failure and evidence before cleanup, then deletes after shutdown failure`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-boot-test-'))
    const events = []
    let probeStarted
    const hanging = new Promise((resolve) => {
      probeStarted = resolve
    })
    const command = adapter(events, root, mode, probeStarted)
    // Keep the diagnostic deadline independent of CI scheduling. Only the hang
    // case advances it, after the probe has installed its abort listener.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    try {
      const rejected = assert.rejects(
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
      if (mode === 'hang') {
        await Promise.race([
          hanging,
          rejected.then(() => assert.fail('the hanging host probe must be reached')),
        ])
        vi.advanceTimersByTime(180)
      }
      await rejected
      const diagnostics = await readEvents(root, 'boot-host-diagnostics.jsonl')
      assert.equal(diagnostics[0].event, 'started')
      assert.equal(diagnostics.at(-1).event, 'finished')
      assert.ok(diagnostics.some((entry) => entry.event === 'command-started'))
      if (mode === 'hang') {
        assert.ok(diagnostics.some((entry) => entry.status === 'timeout'))
        assert.equal(diagnostics.at(-1).budgetExhausted, true)
        assert.ok(diagnostics.some((entry) => entry.status === 'budget-exhausted'))
        assert.deepEqual([...events], ['boot', 'bootstatus', '/usr/bin/sw_vers'])
      } else {
        assert.ok(
          diagnostics.some(
            (entry) =>
              entry.probe === 'host-log' &&
              entry.event === 'command-finished' &&
              entry.status === 'ok',
          ),
        )
        const content = await readFile(join(root, 'boot-host-diagnostics.jsonl'), 'utf8')
        assert.equal(/SECRET|\/Users\/|private\/account/.test(content), false)
        assert.match(content, /NSCocoaErrorDomain/)
        assert.deepEqual(
          diagnostics
            .filter((entry) => entry.event === 'command-started')
            .map((entry) => entry.probe),
          ['os', 'resources', 'memory', 'disk', 'services', 'host-log'],
        )
        assert.equal(
          diagnostics.find((entry) => entry.probe === 'os' && entry.event === 'command-finished')
            .status,
          mode === 'diagnostic-error' ? 'error' : 'ok',
        )
        const logs = diagnostics.filter(
          (entry) => entry.probe === 'host-log' && entry.event === 'output',
        )
        assert.equal(logs.length, 1)
        assert.deepEqual(logs[0].value.codes, [{ domain: 'NSCocoaErrorDomain', code: 4099 }])
        assert.deepEqual(logs[0].value.signals, ['boot', 'failed'])
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
      vi.useRealTimers()
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
  let ready
  const childReady = new Promise((resolve) => {
    ready = resolve
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  spawnCapture.enabled = true
  spawnCapture.child = null
  let childClosed
  onTestFinished(async () => {
    vi.useRealTimers()
    spawnCapture.enabled = false
    const child = spawnCapture.child
    if (!child) {
      vi.restoreAllMocks()
      return
    }
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    await childClosed
    vi.restoreAllMocks()
  })
  try {
    const timedOut = assert.rejects(
      runCommand(
        process.execPath,
        [
          '-e',
          'process.on("SIGTERM", () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)',
        ],
        {
          timeout: 100,
          killGrace: 50,
          onOutput: (data) => {
            ownedPid = Number(data.toString())
            ready()
          },
        },
      ),
      /Timed out/,
    )
    const child = spawnCapture.child
    assert.ok(child, 'the real spawned child must be captured')
    childClosed = new Promise((resolve) => child.once('close', resolve))
    const endedBeforeReady = new Promise((_, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (ownedPid === undefined)
          reject(new Error(`Command closed before readiness (${code}, ${signal})`))
      })
    })
    // The child's PID output is the readiness handshake; only then advance timers.
    await Promise.race([childReady, endedBeforeReady])
    vi.advanceTimersByTime(150)
    await timedOut
    // runCommand's kill-grace callback can settle before the OS reaps the process.
    await childClosed
  } finally {
    vi.useRealTimers()
    spawnCapture.enabled = false
  }
  assert.ok(Number.isSafeInteger(ownedPid) && ownedPid > 0)
  assert.throws(() => process.kill(ownedPid, 0), { code: 'ESRCH' })
})

test('noisy output is projected and capped without losing the terminal failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-boot-test-'))
  const events = []
  const command = adapter(events, root, 'noisy')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
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
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  }
})

test('interrupted boot still gathers bounded host evidence with an independent signal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-boot-test-'))
  const controller = new AbortController()
  const events = []
  controller.abort()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
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
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  }
})
