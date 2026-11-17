import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  runCommand,
  validateReport,
  validateSharedGraph,
  validateCheckpoint,
} from './host-checks.mjs'
import { captureStorageEvidence, readBoundedJson } from './storage-evidence.mjs'
import { bootSimulator, cleanupSimulator } from './simulator-boot.mjs'
import {
  interruptionBefore,
  interruptionPending,
  interruptionAfter,
  interruptionArtifacts,
  stagingDirectory,
} from '../app/storage-staging.ts'

assert.equal(process.platform, 'darwin', 'test:ios requires macOS and Xcode')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const artifacts = process.env.HOLI_IOS_ARTIFACTS
  ? resolve(process.env.HOLI_IOS_ARTIFACTS)
  : await mkdtemp('/tmp/holi-265-ios-')
await mkdir(artifacts, { recursive: true })
const runId = randomUUID()
const bundleId = 'ai.syv.holi.compatibility'
const controller = new AbortController()
const interrupt = () => controller.abort()
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
const command = (exe, args, options = {}) =>
  runCommand(exe, args, { cwd, signal: controller.signal, ...options })
const simctl = (...args) => command('xcrun', ['simctl', ...args])
let simulator
let canonicalContainer
const appPids = []
const cleanupFailures = []
try {
  const xcode = await command('xcodebuild', ['-version'])
  const runtimes = JSON.parse(await simctl('list', 'runtimes', '--json')).runtimes
  const requested = process.env.HOLI_IOS_RUNTIME
  const deviceType =
    process.env.HOLI_IOS_DEVICE_TYPE ?? 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'
  const supportsDevice = (item) =>
    item.supportedDeviceTypes.some((device) => device.identifier === deviceType)
  const runtime = requested
    ? runtimes.find(
        (item) => item.identifier === requested && item.isAvailable && supportsDevice(item),
      )
    : runtimes
        .filter(
          (item) =>
            item.isAvailable &&
            supportsDevice(item) &&
            item.platform === 'iOS' &&
            Number(item.version.split('.')[0]) >= 26,
        )
        .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]
  assert.ok(runtime, `No available supported iOS runtime${requested ? `: ${requested}` : ''}`)
  assert.ok(Number(runtime.version.split('.')[0]) >= 26)
  await command('ruby', ['-e', "require 'xcodeproj'"])
  await writeFile(
    join(artifacts, 'toolchain.json'),
    JSON.stringify({ xcode, runtime, runId }, null, 2),
  )

  // Force a fresh unsigned build. Never touch desktop/out or use Electron.
  await rm(join(cwd, 'platforms/ios/build'), { recursive: true, force: true })
  await command('pnpm', ['run', 'build:ios'], {
    timeout: 600_000,
    log: join(artifacts, 'build.log'),
    env: { ...process.env, CI: '1', ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
  })
  const app = join(cwd, 'platforms/ios/build/Debug-iphonesimulator/mobile.app')
  const plist = async (key) =>
    command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Info.plist')])
  assert.equal(await plist('MinimumOSVersion'), '26.0')
  assert.equal(await plist('CFBundleIdentifier'), bundleId)
  assert.equal(await plist('DTPlatformName'), 'iphonesimulator')
  const graph = JSON.parse(await readFile(join(app, 'app/shared-bundle-graph.json'), 'utf8'))
  validateSharedGraph(graph)
  await writeFile(join(artifacts, 'shared-bundle-graph.json'), JSON.stringify(graph, null, 2))
  const settings = await command('xcodebuild', [
    '-project',
    'platforms/ios/mobile.xcodeproj',
    '-scheme',
    'mobile',
    '-sdk',
    'iphonesimulator',
    '-showBuildSettings',
    '-json',
  ])
  await writeFile(join(artifacts, 'build-settings.json'), settings)
  const appSettings = JSON.parse(settings).find((item) => item.target === 'mobile').buildSettings
  assert.equal(appSettings.IPHONEOS_DEPLOYMENT_TARGET, '26.0')
  assert.equal(appSettings.CODE_SIGNING_ALLOWED, 'NO')
  const binary = join(app, await plist('CFBundleExecutable'))
  const binaryInfo = await command('xcrun', ['vtool', '-show-build', binary])
  assert.match(binaryInfo, /platform IOSSIMULATOR/)
  assert.match(binaryInfo, /minos 26\.0(?:\s|$)/)
  await writeFile(join(artifacts, 'binary-build.txt'), binaryInfo)
  await cp(app, join(artifacts, 'mobile.app'), { recursive: true, force: true })

  simulator = await simctl('create', `holi-265-${runId}`, deviceType, runtime.identifier)
  assert.match(simulator, /^[A-F0-9-]{36}$/)
  await writeFile(join(artifacts, 'simulator-id.txt'), simulator)
  await bootSimulator({
    simulator,
    artifacts,
    runId,
    command,
    signal: controller.signal,
    metadata: { xcode, runtime: runtime.identifier, deviceType },
  })
  await simctl('status_bar', simulator, 'override', '--time', '9:41')
  await simctl('install', simulator, app)
  const container = await simctl('get_app_container', simulator, bundleId, 'data')
  canonicalContainer = await realpath(container)
  const reportPath = join(canonicalContainer, 'Documents/vault-format-report.json')
  for (const [index, name] of ['Café.md', 'Cafe\u0301.md'].entries()) {
    const directory = join(canonicalContainer, `Documents/holi-raw-${runId}-${index}`)
    await mkdir(directory)
    await writeFile(join(directory, name), 'raw native fixture', { flag: 'wx' })
  }
  const documents = await realpath(join(canonicalContainer, 'Documents'))
  const library = await realpath(join(canonicalContainer, 'Library'))
  const installedApp = await realpath(await simctl('get_app_container', simulator, bundleId, 'app'))
  const installedBinary = join(installedApp, await plist('CFBundleExecutable'))
  const launchPhase = async (phase) => {
    await rm(reportPath, { force: true })
    const launchedAt = Date.now()
    const output = await command('xcrun', ['simctl', 'launch', simulator, bundleId], {
      env: {
        ...process.env,
        SIMCTL_CHILD_HOLI_COMPAT_RUN_ID: runId,
        SIMCTL_CHILD_HOLI_STORAGE_PHASE: phase,
      },
    })
    const pid = Number(output.match(/: (\d+)$/)?.[1])
    assert.ok(Number.isSafeInteger(pid) && pid > 0, `No app PID: ${output}`)
    appPids.push({ phase, pid, launchedAt })
    await writeFile(join(artifacts, 'processes.json'), JSON.stringify(appPids, null, 2))
    return { pid, launchedAt }
  }
  const waitJson = async (path, processInfo, timeout = 90_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      process.kill(processInfo.pid, 0)
      try {
        return await readBoundedJson(path)
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      }
      await sleep(100, undefined, { signal: controller.signal })
    }
    throw new Error(`Timed out waiting for owned evidence: ${path}`)
  }
  const normalProcess = await launchPhase('normal')
  const report = await waitJson(reportPath, normalProcess)
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2))
  const context = { runId, now: Date.now(), osVersion: runtime.version, storageRoot: documents }
  validateReport(report, { ...context, ...normalProcess, phase: 'normal' })
  const durableNote = join(documents, `holi-storage-check-${runId}`, 'same/note.md')
  const durableBefore = await readFile(durableNote)
  for (const [index, name] of ['Café.md', 'Cafe\u0301.md'].entries()) {
    const rawRoot = join(documents, `holi-raw-${runId}-${index}`)
    assert.equal(await readFile(join(rawRoot, name), 'utf8'), 'updated raw native fixture')
  }
  await simctl('io', simulator, 'screenshot', join(artifacts, 'status.png'))
  await simctl('terminate', simulator, bundleId)
  const staged = await launchPhase('stage')
  const checkpointPath = join(documents, `holi-stage-checkpoint-${runId}.json`)
  const marker = await waitJson(checkpointPath, staged, 30_000)
  await writeFile(join(artifacts, 'staged-checkpoint.json'), JSON.stringify(marker, null, 2))
  validateCheckpoint(marker, { runId, ...staged, now: Date.now(), documents, library })
  const interruptionRoot = join(documents, `holi-storage-interruption-${runId}`)
  assert.equal(await realpath(interruptionRoot), interruptionRoot)
  assert.equal(await realpath(marker.stage), marker.stage)
  assert.equal(await readFile(join(interruptionRoot, 'durable.md'), 'utf8'), interruptionBefore)
  assert.equal(await readFile(marker.stage, 'utf8'), interruptionPending)
  for (const [name, value] of interruptionArtifacts)
    assert.equal(await readFile(join(interruptionRoot, name), 'utf8'), value)
  // Verify the executable identity before sending SIGKILL to this run's exact host PID.
  const runningBinary = await command('ps', ['-p', String(staged.pid), '-o', 'comm='])
  assert.equal(await realpath(runningBinary), installedBinary)
  process.kill(staged.pid, 'SIGKILL')
  let gone = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(staged.pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') {
        gone = true
        break
      }
      throw error
    }
    await sleep(50)
  }
  assert.ok(gone, 'Staged app did not terminate')
  assert.equal(await readFile(join(interruptionRoot, 'durable.md'), 'utf8'), interruptionBefore)
  assert.equal(await readFile(marker.stage, 'utf8'), interruptionPending)
  const killedAt = Date.now()
  await writeFile(
    join(artifacts, 'kill-receipt.json'),
    JSON.stringify(
      {
        ...staged,
        killedAt,
        signal: 'SIGKILL',
        executable: installedBinary,
        checkpoint: marker,
        originalPreserved: true,
        stagedBytesVerified: true,
      },
      null,
      2,
    ),
  )
  const recoveryProcess = await launchPhase('recovery')
  assert.equal(
    await realpath(await simctl('get_app_container', simulator, bundleId, 'data')),
    canonicalContainer,
  )
  const recovery = await waitJson(reportPath, recoveryProcess, 30_000)
  await writeFile(join(artifacts, 'recovery-report.json'), JSON.stringify(recovery, null, 2))
  validateReport(recovery, {
    ...context,
    ...recoveryProcess,
    now: Date.now(),
    phase: 'recovery',
    normalBytes: report.storage.finalBytes,
  })
  await assert.rejects(readFile(marker.stage), { code: 'ENOENT' })
  assert.equal(await readFile(join(interruptionRoot, 'durable.md'), 'utf8'), interruptionAfter)
  assert.deepEqual(await readFile(durableNote), durableBefore)
  for (const [name, value] of interruptionArtifacts)
    assert.equal(await readFile(join(interruptionRoot, name), 'utf8'), value)
  process.kill(recoveryProcess.pid, 0)
  await writeFile(
    join(artifacts, 'acceptance.json'),
    JSON.stringify(
      {
        runId,
        simulator,
        container: canonicalContainer,
        normal: true,
        stagedKill: true,
        recovery: true,
        faultOperations: 10,
        rawSpellings: 2,
      },
      null,
      2,
    ),
  )
  console.log(
    `iOS ${runtime.version}: ${report.corpus.passed}/${report.corpus.total} format cases, 10 native failure cases, raw NFC/NFD and staged-kill recovery passed. Evidence: ${artifacts}`,
  )
} catch (error) {
  await writeFile(
    join(artifacts, 'failure.json'),
    JSON.stringify({ error: String(error), appPids }, null, 2),
  )
  if (simulator && canonicalContainer) {
    try {
      await runCommand('xcrun', ['simctl', 'terminate', simulator, bundleId], { timeout: 10_000 })
    } catch {
      /* The owned app may already have crashed. */
    }
    try {
      const logs = await runCommand(
        'xcrun',
        [
          'simctl',
          'spawn',
          simulator,
          'log',
          'show',
          '--last',
          '3m',
          '--style',
          'compact',
          '--predicate',
          'process == "mobile"',
        ],
        { timeout: 20_000 },
      )
      await writeFile(join(artifacts, 'native-console.log'), logs.slice(-100_000))
    } catch (captureError) {
      await writeFile(
        join(artifacts, 'console-capture-error.json'),
        JSON.stringify({ error: String(captureError) }),
      )
    }
  }
  if (canonicalContainer) {
    const documents = join(canonicalContainer, 'Documents')
    const root = join(documents, `holi-storage-interruption-${runId}`)
    await captureStorageEvidence(
      [documents, stagingDirectory(join(canonicalContainer, 'Library'), root)],
      join(artifacts, 'failure-files.json'),
    )
  }
  console.error(`iOS compatibility failed. Evidence: ${artifacts}`)
  throw error
} finally {
  // Never enumerate/delete other devices. Even an interrupted run cleans its own device.
  if (simulator) {
    cleanupFailures.push(...(await cleanupSimulator({ simulator, artifacts })))
    if (cleanupFailures.length)
      console.error(`Simulator cleanup failed: ${cleanupFailures.join('\n')}`)
  }
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
if (cleanupFailures.length) throw new Error('Simulator cleanup did not complete')
