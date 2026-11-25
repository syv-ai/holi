import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { runCommand } from './host-checks.mjs'
import { bootSimulator, cleanupSimulator } from './simulator-boot.mjs'
import { createCredentialLog } from './credential-log.mjs'
import {
  validateCredentialReport,
  summarizeCredentialReport,
  waitForCredentialReport,
} from './credential-evidence.mjs'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const bundleId = 'ai.syv.holi.compatibility'
const phases = [
  'verify-empty',
  'store',
  'replace',
  'read',
  'sign-out',
  'verify-absent',
  'delete-unrelated',
]

export async function runCredentialSimulator() {
  assert.equal(process.platform, 'darwin', 'Credential simulator check requires macOS and Xcode')
  const runId = randomUUID()
  const artifacts = process.env.HOLI_CREDENTIAL_ARTIFACTS
    ? resolve(process.env.HOLI_CREDENTIAL_ARTIFACTS)
    : await mkdtemp('/tmp/holi770-credentials-')
  const repository = await realpath(
    await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd }),
  )
  const artifactParent = await realpath(dirname(artifacts))
  const relativeParent = relative(repository, artifactParent)
  assert.ok(
    relativeParent === '..' || relativeParent.startsWith('../') || isAbsolute(relativeParent),
    'Evidence must be outside the checkout',
  )
  await mkdir(artifacts, { recursive: false }).catch((error) => {
    if (error.code !== 'EEXIST' || process.env.HOLI_CREDENTIAL_ARTIFACTS) throw error
  })
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const command = (exe, args, options = {}) =>
    runCommand(exe, args, { cwd, signal: controller.signal, outputLimit: 64 * 1024, ...options })
  const cleanupCommand = (exe, args, options = {}) =>
    runCommand(exe, args, { cwd, outputLimit: 64 * 1024, ...options })
  const simctl = (...args) => command('xcrun', ['simctl', ...args])
  const pids = []
  const cleanupFailures = []
  const signedBuild = join(artifacts, 'simulator-build')
  const signedDerived = join(artifacts, 'simulator-derived')
  let simulator
  let active
  let build
  let provenance
  let completed = false
  let simulatorRemoved = false
  let stage = 'setup'
  let failure
  const reports = []
  try {
    const sourceHead = await command('git', ['rev-parse', 'HEAD'])
    assert.equal(
      await command('git', ['status', '--porcelain']),
      '',
      'Source checkout must be clean',
    )
    const xcode = await command('xcodebuild', ['-version'])
    const runtimes = JSON.parse(await simctl('list', 'runtimes', '--json')).runtimes
    const deviceType =
      process.env.HOLI_IOS_DEVICE_TYPE ?? 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'
    const supports = (item) =>
      item.supportedDeviceTypes.some((device) => device.identifier === deviceType)
    const requested = process.env.HOLI_IOS_RUNTIME
    const runtime = requested
      ? runtimes.find((item) => item.identifier === requested && item.isAvailable && supports(item))
      : runtimes
          .filter(
            (item) =>
              item.isAvailable &&
              supports(item) &&
              item.platform === 'iOS' &&
              Number(item.version.split('.')[0]) >= 26,
          )
          .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]
    assert.ok(
      runtime && Number(runtime.version.split('.')[0]) >= 26,
      'No compatible available iOS 26+ runtime',
    )
    await command('ruby', ['-e', "require 'xcodeproj'"])
    await writeFile(
      join(artifacts, 'toolchain.json'),
      JSON.stringify({ xcode, runtime, runId }, null, 2),
    )
    await rm(join(cwd, 'platforms/ios/build'), { recursive: true, force: true })
    stage = 'build'
    const buildLog = createCredentialLog(join(artifacts, 'build.log'))
    try {
      await command('pnpm', ['run', 'build:ios'], {
        timeout: 600_000,
        onOutput: (data) => buildLog.write(data),
        env: { ...process.env, CI: '1', ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
      })
      stage = 'simulator-signing'
      await command(
        'xcodebuild',
        [
          '-project',
          'platforms/ios/mobile.xcodeproj',
          '-scheme',
          'mobile',
          '-configuration',
          'Debug',
          '-sdk',
          'iphonesimulator',
          '-destination',
          'generic/platform=iOS Simulator',
          '-derivedDataPath',
          signedDerived,
          `CONFIGURATION_BUILD_DIR=${signedBuild}`,
          'CODE_SIGNING_ALLOWED=YES',
          'CODE_SIGNING_REQUIRED=YES',
          'CODE_SIGN_IDENTITY=-',
          'CODE_SIGN_STYLE=Manual',
          'DEVELOPMENT_TEAM=',
          'PROVISIONING_PROFILE=',
          'PROVISIONING_PROFILE_SPECIFIER=',
        ],
        {
          timeout: 600_000,
          onOutput: (data) => buildLog.write(data),
          env: { ...process.env, CI: '1' },
        },
      )
    } finally {
      await writeFile(join(artifacts, 'build-log.json'), JSON.stringify(buildLog.close(), null, 2))
    }
    stage = 'verify-build'
    const app = join(signedBuild, 'mobile.app')
    const plist = async (key) =>
      command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Info.plist')])
    assert.equal(await plist('MinimumOSVersion'), '26.0')
    assert.equal(await plist('CFBundleIdentifier'), bundleId)
    assert.equal(await plist('DTPlatformName'), 'iphonesimulator')
    build = await plist('CFBundleVersion')
    const binaryHash = createHash('sha256')
      .update(await readFile(join(app, await plist('CFBundleExecutable'))))
      .digest('hex')
    assert.equal(await command('git', ['rev-parse', 'HEAD']), sourceHead)
    assert.equal(
      await command('git', ['status', '--porcelain']),
      '',
      'Source checkout must be clean',
    )
    const bundleHash = createHash('sha256')
      .update(await readFile(join(app, 'app/bundle.mjs')))
      .digest('hex')
    provenance = {
      sourceHead,
      signing: 'xcode-simulator-adhoc',
      provisioning: false,
      binaryHash,
      bundleHash,
      bundleId,
      build,
      xcode,
      runtime: runtime.identifier,
    }
    await writeFile(join(artifacts, 'provenance.json'), JSON.stringify(provenance, null, 2))
    simulator = await simctl('create', `holi-770-${runId}`, deviceType, runtime.identifier)
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
    await simctl('install', simulator, app)
    const container = await simctl('get_app_container', simulator, bundleId, 'data')
    const reportPath = join(container, 'Documents', `credential-diagnostic-${runId}.json`)
    let previousPid
    const drain = async (info) => {
      if (!info) return
      await simctl('terminate', simulator, bundleId)
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(info.pid, 0)
        } catch (error) {
          if (error.code === 'ESRCH') return
          throw error
        }
        await sleep(50)
      }
      throw new Error(`Owned app process ${info.pid} did not exit`)
    }
    for (const phase of phases) {
      stage = phase
      await drain(active)
      await rm(reportPath, { force: true })
      const launchedAt = Date.now()
      const output = await command('xcrun', ['simctl', 'launch', simulator, bundleId], {
        env: {
          ...process.env,
          SIMCTL_CHILD_HOLI_CREDENTIAL_DIAGNOSTIC: '1',
          SIMCTL_CHILD_HOLI_COMPAT_RUN_ID: runId,
          SIMCTL_CHILD_HOLI_CREDENTIAL_PHASE: phase,
        },
      })
      const pid = Number(output.match(/: (\d+)$/)?.[1])
      assert.ok(
        Number.isSafeInteger(pid) && pid > 0 && pid !== previousPid,
        `No fresh process PID for ${phase}`,
      )
      previousPid = pid
      active = { phase, pid, launchedAt }
      pids.push(active)
      const report = await waitForCredentialReport(reportPath, { signal: controller.signal })
      await writeFile(
        join(artifacts, `native-receipt-${phase}.json`),
        JSON.stringify(summarizeCredentialReport(report), null, 2),
      )
      try {
        validateCredentialReport(report, { runId, phase, build, pid, launchedAt, now: Date.now() })
      } catch (error) {
        failure = { stage: phase, reason: error.message }
        throw error
      }
      reports.push(report)
      await writeFile(join(artifacts, `report-${phase}.json`), JSON.stringify(report, null, 2))
    }
    completed = true
  } catch (error) {
    failure ??= {
      stage,
      reason: 'Credential acceptance did not complete',
      filesystemError: ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : null,
      timedOut: error.timedOut === true,
      exitCode: Number.isSafeInteger(error.exitCode) ? error.exitCode : null,
    }
    await writeFile(join(artifacts, 'failure.json'), JSON.stringify(failure, null, 2))
    throw error
  } finally {
    // Cleanup must remain possible after an interrupt.
    if (active && simulator) {
      try {
        await cleanupCommand('xcrun', ['simctl', 'terminate', simulator, bundleId], {
          cwd,
          outputLimit: 64 * 1024,
          timeout: 15_000,
        })
      } catch (error) {
        if (!/Exit 3/.test(error.message)) cleanupFailures.push(String(error))
      }
    }
    if (simulator) {
      try {
        cleanupFailures.push(
          ...(await cleanupSimulator({ simulator, artifacts, command: cleanupCommand })),
        )
        const devices = JSON.parse(
          await cleanupCommand('xcrun', ['simctl', 'list', 'devices', '--json']),
        ).devices
        simulatorRemoved = !Object.values(devices)
          .flat()
          .some((device) => device.udid === simulator)
        if (!simulatorRemoved) cleanupFailures.push('Owned simulator still exists')
      } catch (error) {
        cleanupFailures.push(String(error))
      }
    }
    for (const ownedBuild of [signedBuild, signedDerived]) {
      try {
        await rm(ownedBuild, { recursive: true, force: true })
      } catch {
        cleanupFailures.push('Owned simulator build cleanup failed')
      }
    }
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    await writeFile(
      join(artifacts, 'evidence.json'),
      JSON.stringify(
        {
          source: 'diagnostic-keychain-namespace',
          status:
            completed && simulatorRemoved && !cleanupFailures.length
              ? 'passed'
              : 'incomplete-proof',
          provenance,
          failure,
          reports,
          runId,
          phases: pids,
          finalOwnedCleanup: { simulator, simulatorRemoved, failures: cleanupFailures },
        },
        null,
        2,
      ),
    )
    if (cleanupFailures.length) {
      console.error(`Owned simulator cleanup uncertain: ${cleanupFailures.join('; ')}`)
      process.exitCode = 1
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runCredentialSimulator().catch(() => {
    console.error(
      'Credential acceptance failed; inspect the bounded artifact receipts and build log',
    )
    process.exitCode = 1
  })
