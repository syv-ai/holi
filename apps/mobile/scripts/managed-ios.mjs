import assert from 'node:assert/strict'
import { mkdtemp, lstat, rm, realpath, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { runCommand } from './host-checks.mjs'
import { bootSimulator, cleanupSimulator } from './simulator-boot.mjs'
import { runManagedIOSScenarios } from './managed-ios-scenarios.mjs'

assert.equal(process.platform, 'darwin')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const artifacts = await mkdtemp('/tmp/holi-657-ios-')
const runId = randomUUID(),
  bundleId = 'ai.syv.holi.compatibility'
const controller = new AbortController()
const interrupt = () => controller.abort()
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
const command = (exe, args, options = {}) =>
  runCommand(exe, args, { cwd, signal: controller.signal, ...options })
const simctl = (...args) => command('xcrun', ['simctl', ...args])
let simulator,
  cleanupFailures = []
try {
  console.log(`Managed iOS evidence: ${artifacts}`)
  await command('xcodebuild', ['-version'])
  await command('ruby', ['-e', "require 'xcodeproj'"])
  const runtimes = JSON.parse(await simctl('list', 'runtimes', '--json')).runtimes
  const deviceType = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'
  const runtime = runtimes
    .filter(
      (item) =>
        item.isAvailable &&
        item.platform === 'iOS' &&
        Number(item.version.split('.')[0]) >= 26 &&
        item.supportedDeviceTypes.some((device) => device.identifier === deviceType),
    )
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]
  assert.ok(runtime, 'No supported available Simulator runtime')
  for (const path of ['platforms', 'platforms/ios', 'platforms/ios/build']) {
    try {
      assert.equal(
        (await lstat(join(cwd, path))).isSymbolicLink(),
        false,
        `Refusing linked build output: ${path}`,
      )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  await rm(join(cwd, 'platforms/ios/build'), { recursive: true, force: true })
  await command('pnpm', ['run', 'build:ios'], {
    timeout: 600000,
    log: join(artifacts, 'build.log'),
    env: { ...process.env, CI: '1', ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
  })
  simulator = await simctl('create', `holi-657-${runId}`, deviceType, runtime.identifier)
  await bootSimulator({
    simulator,
    artifacts,
    runId,
    command,
    signal: controller.signal,
    metadata: { runtime: runtime.identifier, deviceType },
  })
  const app = join(cwd, 'platforms/ios/build/Debug-iphonesimulator/mobile.app')
  await simctl('install', simulator, app)
  const container = await realpath(await simctl('get_app_container', simulator, bundleId, 'data'))
  const proof = await runManagedIOSScenarios({
    simulator,
    container,
    bundleId,
    artifacts,
    runId,
    command,
    signal: controller.signal,
  })
  await writeFile(
    join(artifacts, 'managed-proof.json'),
    JSON.stringify({ ...proof, ownedCleanup: 'pending' }, null, 2),
  )
  console.log(`Managed native cases passed: ${proof.cases}`)
} catch (error) {
  await writeFile(
    join(artifacts, 'failure.json'),
    JSON.stringify({ runId, error: String(error) }, null, 2),
  )
  if (simulator) {
    try {
      await writeFile(
        join(artifacts, 'native-console.log'),
        await runCommand(
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
          { timeout: 20000 },
        ),
      )
    } catch (capture) {
      console.error(String(capture))
    }
  }
  throw error
} finally {
  if (simulator) cleanupFailures = await cleanupSimulator({ simulator, artifacts })
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  await writeFile(
    join(artifacts, 'managed-cleanup.json'),
    JSON.stringify({ runId, simulator, failures: cleanupFailures }, null, 2),
  )
}
assert.deepEqual(cleanupFailures, [])
const proofPath = join(artifacts, 'managed-proof.json')
const proof = JSON.parse(await readFile(proofPath, 'utf8'))
await writeFile(proofPath, JSON.stringify({ ...proof, ownedCleanup: true }, null, 2))
