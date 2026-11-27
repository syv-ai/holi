import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { runCommand } from './host-checks.mjs'
import { bootSimulator } from './simulator-boot.mjs'
import { buildCredentialApp } from './credential-build.mjs'
import { ownCredentialSimulator } from './credential-device.mjs'
import { credentialFailure } from './credential-log.mjs'
import {
  validateCredentialBuildIdentity,
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

async function runCredentialSimulator() {
  assert.equal(process.platform, 'darwin', 'Credential simulator check requires macOS and Xcode')
  const runId = randomUUID()
  const requestedArtifacts = process.env.HOLI_CREDENTIAL_ARTIFACTS
  const repository = await realpath(
    await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd }),
  )
  let artifacts
  if (requestedArtifacts) {
    artifacts = resolve(requestedArtifacts)
    const relativeParent = relative(repository, await realpath(dirname(artifacts)))
    assert.ok(
      relativeParent === '..' || relativeParent.startsWith('../') || isAbsolute(relativeParent),
      'Evidence must be outside the checkout',
    )
    await mkdir(artifacts, { mode: 0o700 })
  } else artifacts = await mkdtemp('/tmp/holi770-credentials-')
  const receipt = (name, value) =>
    writeFile(join(artifacts, `${name}.json`), JSON.stringify(value, null, 2), { mode: 0o600 })
  const controller = new AbortController()
  const signal = controller.signal
  const interrupt = () => controller.abort()
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const command = (exe, args, options = {}) =>
    runCommand(exe, args, { cwd, signal, outputLimit: 64 * 1024, ...options })
  const cleanupCommand = (exe, args, options = {}) =>
    runCommand(exe, args, { cwd, outputLimit: 64 * 1024, ...options })
  const simctl = (...args) => command('xcrun', ['simctl', ...args])
  const pids = []
  const reports = []
  const buildReceipts = []
  let device
  let fixture
  let buildDrainUnconfirmed = false
  let provenance
  let completed = false
  let stage = 'setup'
  let failure
  try {
    const sourceHead = await command('git', ['rev-parse', 'HEAD'])
    assert.match(sourceHead, /^[0-9a-f]{40}$/)
    assert.equal(
      await command('git', ['status', '--porcelain']),
      '',
      'Source checkout must be clean',
    )
    const xcode = await command('xcodebuild', ['-version'])
    assert.match(xcode, /^Xcode \d{1,3}(?:\.\d{1,3}){0,2}\nBuild version [A-Za-z0-9]{1,20}$/)
    stage = 'select-runtime'
    const runtimes = JSON.parse(await simctl('list', 'runtimes', '--json')).runtimes
    const deviceType =
      process.env.HOLI_IOS_DEVICE_TYPE ?? 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'
    assert.match(deviceType, /^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9-]{1,80}$/)
    const requested = process.env.HOLI_IOS_RUNTIME
    const runtime = runtimes
      .filter(
        (item) =>
          item.isAvailable === true &&
          item.platform === 'iOS' &&
          typeof item.identifier === 'string' &&
          /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-\d{1,3}(?:-\d{1,3}){1,2}$/.test(
            item.identifier,
          ) &&
          (!requested || requested === item.identifier) &&
          typeof item.version === 'string' &&
          /^\d{1,3}(?:\.\d{1,3}){1,2}$/.test(item.version) &&
          Number(item.version.split('.')[0]) >= 26 &&
          item.supportedDeviceTypes.some((type) => type.identifier === deviceType),
      )
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]
    assert.ok(runtime, 'No compatible available iOS 26+ runtime')
    const toolchain = { xcode, runtime: runtime.identifier, osVersion: runtime.version, deviceType }
    await receipt('toolchain', { runId, ...toolchain })

    stage = 'build'
    const buildRoot = `/tmp/holi770-build-${runId}`
    await mkdir(buildRoot, { mode: 0o700 })
    fixture = buildRoot
    const app = await buildCredentialApp({
      root: fixture,
      sourceHead,
      command,
      receipts: buildReceipts,
      signal,
    })
    stage = 'verify-build'
    const info = await command('/usr/bin/plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      join(app, 'Info.plist'),
    ])
    const buildIdentity = validateCredentialBuildIdentity(JSON.parse(info), bundleId)
    const hash = async (file) =>
      createHash('sha256')
        .update(await readFile(join(app, file)))
        .digest('hex')
    provenance = {
      sourceHead,
      signing: 'xcode-simulator-adhoc',
      provisioning: false,
      binaryHash: await hash('mobile'),
      bundleHash: await hash('app/bundle.mjs'),
      ...buildIdentity,
      ...toolchain,
    }
    await receipt('provenance', provenance)
    stage = 'create-simulator'
    device = ownCredentialSimulator({
      name: `holi-770-${runId}`,
      runtime: runtime.identifier,
      deviceType,
      command,
      cleanupCommand,
    })
    const simulator = await device.create()
    await writeFile(join(artifacts, 'simulator-id.txt'), simulator)
    stage = 'boot-simulator'
    await bootSimulator({ simulator, artifacts, runId, command, signal, metadata: toolchain })
    stage = 'install'
    await simctl('install', simulator, app)
    const container = await simctl('get_app_container', simulator, bundleId, 'data')
    const reportPath = join(container, 'Documents', `credential-diagnostic-${runId}.json`)
    const launchEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('SIMCTL_CHILD_')),
    )
    const drain = async (pid) => {
      if (!pid) return
      await simctl('terminate', simulator, bundleId)
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0)
        } catch (error) {
          if (error.code === 'ESRCH') return
          throw error
        }
        await sleep(50, undefined, { signal })
      }
      throw new Error('Owned app process did not exit')
    }
    let previousPid
    for (const phase of phases) {
      stage = phase
      await drain(previousPid)
      await rm(reportPath, { force: true })
      const launchedAt = Date.now()
      const output = await command('xcrun', ['simctl', 'launch', simulator, bundleId], {
        env: {
          ...launchEnv,
          SIMCTL_CHILD_HOLI_CREDENTIAL_DIAGNOSTIC: '1',
          SIMCTL_CHILD_HOLI_COMPAT_RUN_ID: runId,
          SIMCTL_CHILD_HOLI_CREDENTIAL_PHASE: phase,
        },
      })
      const pid = Number(output.match(/: (\d+)$/)?.[1])
      assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== previousPid, 'No fresh process PID')
      previousPid = pid
      pids.push({ phase, pid, launchedAt })
      const report = await waitForCredentialReport(reportPath, { signal })
      await receipt(`native-receipt-${phase}`, summarizeCredentialReport(report))
      const observed = validateCredentialReport(report, {
        runId,
        phase,
        build: buildIdentity.build,
        pid,
        launchedAt,
        now: Date.now(),
      })
      reports.push(observed)
      await receipt(`report-${phase}`, observed)
    }
    signal.throwIfAborted()
    completed = true
  } catch (error) {
    buildDrainUnconfirmed = stage === 'build' && error.drainUnconfirmed === true
    failure = { stage, ...credentialFailure(error, signal) }
    throw error
  } finally {
    // Simulator shutdown drains its installed app too. Reconcile ownership first;
    // a failed create or launch may have changed the device before replying.
    let simulatorCleanup
    let buildCleanup = 'not-created'
    try {
      simulatorCleanup = await device?.cleanup()
    } finally {
      if (fixture) {
        if (buildDrainUnconfirmed) buildCleanup = 'drain-unconfirmed'
        else {
          try {
            await rm(fixture, { recursive: true, force: true })
            buildCleanup = 'removed'
          } catch {
            buildCleanup = 'remove-failed'
          }
        }
      }
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', interrupt)
      const passed =
        completed &&
        !signal.aborted &&
        simulatorCleanup?.simulatorRemoved &&
        buildCleanup === 'removed'
      await receipt('evidence', {
        source: 'diagnostic-keychain-namespace',
        status: passed ? 'passed' : 'incomplete-proof',
        provenance,
        failure,
        reports,
        runId,
        phases: pids,
        buildCommands: buildReceipts,
        finalOwnedCleanup: {
          simulator: simulatorCleanup,
          build: buildCleanup,
          ...(buildCleanup === 'drain-unconfirmed' || buildCleanup === 'remove-failed'
            ? { retainedBuildWorkspace: fixture }
            : {}),
        },
      })
      if (!passed) process.exitCode = 1
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runCredentialSimulator().catch(() => {
    console.error('Credential acceptance failed; inspect the structured evidence receipts')
    process.exitCode = 1
  })
