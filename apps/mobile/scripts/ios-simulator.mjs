import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { runCommand, validateReport, validateSharedGraph } from './host-checks.mjs'

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
  await simctl('boot', simulator)
  await simctl('bootstatus', simulator, '-b')
  await simctl('status_bar', simulator, 'override', '--time', '9:41')
  await simctl('install', simulator, app)
  const container = await simctl('get_app_container', simulator, bundleId, 'data')
  const reportPath = join(container, 'Documents/vault-format-report.json')
  await rm(reportPath, { force: true })
  const launchedAt = Date.now()
  const launch = await command('xcrun', ['simctl', 'launch', simulator, bundleId], {
    env: { ...process.env, SIMCTL_CHILD_HOLI_COMPAT_RUN_ID: runId },
  })
  const pid = Number(launch.match(/: (\d+)$/)?.[1])
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `No app PID: ${launch}`)
  const deadline = Date.now() + 90_000
  let report
  while (Date.now() < deadline) {
    process.kill(pid, 0) // Simulator app PIDs are host PIDs; a crash is not a timeout/pass.
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'))
      break
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    await sleep(250, undefined, { signal: controller.signal })
  }
  assert.ok(report, 'Timed out waiting for a complete sandbox report')
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2))
  // Let the native view arrive, and catch a crash immediately after writing evidence.
  await sleep(2_000, undefined, { signal: controller.signal })
  process.kill(pid, 0)
  await simctl('io', simulator, 'screenshot', join(artifacts, 'status.png'))
  validateReport(report, { runId, launchedAt, now: Date.now(), osVersion: runtime.version })
  console.log(
    `iOS ${runtime.version}: ${report.corpus.passed}/${report.corpus.total} cases passed. Evidence: ${artifacts}`,
  )
} catch (error) {
  console.error(`iOS compatibility failed. Evidence: ${artifacts}`)
  throw error
} finally {
  // Never enumerate/delete other devices. Even an interrupted run cleans its own device.
  if (simulator) {
    const cleanup = async (...args) => runCommand('xcrun', ['simctl', ...args], { timeout: 60_000 })
    for (const args of [
      ['shutdown', simulator],
      ['delete', simulator],
    ]) {
      try {
        await cleanup(...args)
      } catch (error) {
        cleanupFailures.push(String(error))
      }
    }
    await writeFile(
      join(artifacts, 'cleanup.json'),
      JSON.stringify({ simulator, failures: cleanupFailures }, null, 2),
    )
    if (cleanupFailures.length)
      console.error(`Simulator cleanup failed: ${cleanupFailures.join('\n')}`)
  }
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
if (cleanupFailures.length) throw new Error('Simulator cleanup did not complete')
