import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  runCommand,
  validateReport,
  validateSharedGraph,
  validateCheckpoint,
  moveCrashCases,
  validateMoveCheckpoint,
  moveCheckpointState,
  validateMoveCheckpointState,
} from './host-checks.mjs'
import { captureStorageEvidence, readBoundedJson } from './storage-evidence.mjs'
import { bootSimulator, cleanupSimulator } from './simulator-boot.mjs'
import { createGitFixture } from './git-fixture.mjs'
import { createWorkingCopyFixture, verifyWorkingCopyUnchanged } from './working-copy-fixture.mjs'
import {
  createWorkingCopyTreeFixture,
  verifyWorkingCopyTreeResults,
} from './working-copy-tree-fixture.mjs'
import { validateWorkingCopyResults } from './host-checks.mjs'
import {
  interruptionBefore,
  interruptionPending,
  interruptionAfter,
  interruptionArtifacts,
  stagingDirectory,
} from '../app/storage-staging.ts'
import { moveFixtureBytes as moveBytes } from '../app/move-fixtures.ts'

assert.equal(process.platform, 'darwin', 'test:ios requires macOS and Xcode')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const artifacts = process.env.HOLI_IOS_ARTIFACTS
  ? resolve(process.env.HOLI_IOS_ARTIFACTS)
  : await mkdtemp('/tmp/holi-265-ios-')
await mkdir(artifacts, { recursive: true })
const runId = randomUUID()
const bundleId = 'ai.syv.holi.compatibility'
const workingCopyOnly = process.env.HOLI_IOS_WORKING_COPY_ONLY === '1'
const controller = new AbortController()
const interrupt = () => controller.abort()
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
const command = (exe, args, options = {}) =>
  runCommand(exe, args, { cwd, signal: controller.signal, ...options })
const simctl = (...args) => command('xcrun', ['simctl', ...args])
let simulator
let canonicalContainer
let gitFixture
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

  if (!workingCopyOnly) gitFixture = await createGitFixture(artifacts, runId)
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
  if (gitFixture) await simctl('keychain', simulator, 'add-root-cert', gitFixture.cert)
  await simctl('status_bar', simulator, 'override', '--time', '9:41')
  await simctl('install', simulator, app)
  const container = await simctl('get_app_container', simulator, bundleId, 'data')
  canonicalContainer = await realpath(container)
  const reportPath = join(canonicalContainer, 'Documents/vault-format-report.json')
  const workingCopyFixture = await createWorkingCopyFixture(
    join(canonicalContainer, 'Documents'),
    runId,
    await realpath(join(canonicalContainer, 'Library')),
  )
  const library = await realpath(join(canonicalContainer, 'Library'))
  const workingCopyManifest = join(canonicalContainer, 'Documents/working-copy-manifest.json')
  await writeFile(workingCopyManifest, JSON.stringify(workingCopyFixture, null, 2))
  const treeFixture = await createWorkingCopyTreeFixture(
    join(canonicalContainer, 'Documents'),
    runId,
    library,
  )
  const treeManifest = join(canonicalContainer, 'Documents/tree-manifest.json')
  await writeFile(treeManifest, JSON.stringify(treeFixture, null, 2))
  await writeFile(join(artifacts, 'tree-fixture.json'), JSON.stringify(treeFixture, null, 2))
  await writeFile(
    join(artifacts, 'working-copy-fixture.json'),
    JSON.stringify(workingCopyFixture, null, 2),
  )
  for (const [index, name] of ['Café.md', 'Cafe\u0301.md'].entries()) {
    const directory = join(canonicalContainer, `Documents/holi-raw-${runId}-${index}`)
    await mkdir(directory)
    await writeFile(join(directory, name), 'raw native fixture', { flag: 'wx' })
  }
  const documents = await realpath(join(canonicalContainer, 'Documents'))
  const installedApp = await realpath(await simctl('get_app_container', simulator, bundleId, 'app'))
  const installedBinary = join(installedApp, await plist('CFBundleExecutable'))
  let activeProcess
  let lastLaunchedPid
  const drainProcess = async (processInfo) => {
    if (!processInfo) return
    let exited = false
    try {
      process.kill(processInfo.pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await simctl('terminate', simulator, bundleId)
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(processInfo.pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') {
          exited = true
          break
        }
        throw error
      }
      await sleep(50)
    }
    assert.ok(exited, `Owned app process ${processInfo.pid} did not exit before relaunch`)
  }
  const launchPhase = async (phase, moveCase) => {
    const previous = activeProcess
    await drainProcess(previous)
    await rm(reportPath, { force: true })
    const launchedAt = Date.now()
    const output = await command('xcrun', ['simctl', 'launch', simulator, bundleId], {
      env: {
        ...process.env,
        SIMCTL_CHILD_HOLI_COMPAT_RUN_ID: runId,
        SIMCTL_CHILD_HOLI_STORAGE_PHASE: phase,
        ...(['normal', 'working-copy'].includes(phase)
          ? {
              SIMCTL_CHILD_HOLI_GIT_FIXTURE_MANIFEST: workingCopyManifest,
              SIMCTL_CHILD_HOLI_GIT_TREE_MANIFEST: treeManifest,
              ...(gitFixture
                ? {
                    SIMCTL_CHILD_HOLI_GIT_FIXTURE_ROOT: `${canonicalContainer}/Documents/holi-git-${runId}`,
                    SIMCTL_CHILD_HOLI_GIT_FIXTURE_URL: gitFixture.url,
                    SIMCTL_CHILD_HOLI_GIT_INVALID_TLS_URL: gitFixture.invalidUrl,
                    SIMCTL_CHILD_HOLI_GIT_FIXTURE_USER: gitFixture.username,
                    SIMCTL_CHILD_HOLI_GIT_FIXTURE_PASSWORD: gitFixture.password,
                  }
                : {}),
            }
          : {}),
        ...(moveCase ? { SIMCTL_CHILD_HOLI_MOVE_CASE: String(moveCase.ordinal) } : {}),
      },
    })
    const pid = Number(output.match(/: (\d+)$/)?.[1])
    assert.ok(Number.isSafeInteger(pid) && pid > 0, `No app PID: ${output}`)
    assert.notEqual(pid, previous?.pid, 'Simulator reused the previous app PID')
    assert.notEqual(pid, lastLaunchedPid, 'Simulator did not launch a fresh app process')
    lastLaunchedPid = pid
    activeProcess = { phase, pid, launchedAt }
    appPids.push(activeProcess)
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
  const normalProcess = await launchPhase(workingCopyOnly ? 'working-copy' : 'normal')
  const report = await waitJson(reportPath, normalProcess)
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2))
  if (workingCopyOnly) {
    assert.equal(report.schemaVersion, 2)
    assert.equal(report.runId, runId)
    assert.equal(report.phase, 'working-copy')
    assert.equal(report.platform, 'ios')
    assert.equal(Number(report.osVersion.split('.')[0]), Number(runtime.version.split('.')[0]))
    assert.ok(
      report.startedAt >= normalProcess.launchedAt &&
        report.finishedAt >= report.startedAt &&
        report.finishedAt <= Date.now(),
    )
    assert.ok(!report.error, report.error)
    const statusEvidence = validateWorkingCopyResults(
      report.workingCopy?.cases,
      workingCopyFixture.cases,
      runId,
    )
    const treeEvidence = await verifyWorkingCopyTreeResults(
      report.workingCopy?.treeCases,
      treeFixture,
    )
    for (const item of workingCopyFixture.cases) {
      assert.equal(
        await verifyWorkingCopyUnchanged(item.root, item.before),
        true,
        `Status mutated ${item.name}`,
      )
      for (const artifact of item.recovery)
        assert.equal((await readFile(artifact.path)).toString('base64'), artifact.bytes)
    }
    await writeFile(
      join(artifacts, 'working-copy-evidence.json'),
      JSON.stringify(statusEvidence, null, 2),
    )
    await writeFile(
      join(artifacts, 'working-copy-tree-evidence.json'),
      JSON.stringify(treeEvidence, null, 2),
    )
    await simctl('io', simulator, 'screenshot', join(artifacts, 'working-copy.png'))
    await drainProcess(normalProcess)
    await writeFile(
      join(artifacts, 'acceptance.json'),
      JSON.stringify(
        {
          runId,
          simulator,
          sourceHead: await command('git', ['rev-parse', 'HEAD']),
          workingCopyStatusCases: statusEvidence.cases.length,
          workingCopyTreeCases: treeEvidence.length,
          transportRun: false,
          certificateTrustChanged: false,
        },
        null,
        2,
      ),
    )
    console.log(
      `iOS ${runtime.version}: ${statusEvidence.cases.length} status and ${treeEvidence.length} tree cases passed. No transport or certificate trust changes. Evidence: ${artifacts}`,
    )
  } else {
    const context = {
      runId,
      now: Date.now(),
      osVersion: runtime.version,
      storageRoot: documents,
      library,
    }
    validateReport(report, { ...context, ...normalProcess, phase: 'normal' })
    const statusEvidence = validateWorkingCopyResults(
      report.workingCopy?.cases,
      workingCopyFixture.cases,
      runId,
    )
    const treeEvidence = await verifyWorkingCopyTreeResults(
      report.workingCopy?.treeCases,
      treeFixture,
    )
    await writeFile(
      join(artifacts, 'working-copy-tree-evidence.json'),
      JSON.stringify(treeEvidence, null, 2),
    )
    for (const item of workingCopyFixture.cases) {
      assert.equal(
        await verifyWorkingCopyUnchanged(item.root, item.before),
        true,
        `Status mutated ${item.name}`,
      )
    }
    for (const item of workingCopyFixture.cases) {
      for (const artifact of item.recovery)
        assert.equal(
          (await readFile(artifact.path)).toString('base64'),
          artifact.bytes,
          'Recovery artifact mutated',
        )
    }
    await writeFile(
      join(artifacts, 'working-copy-evidence.json'),
      JSON.stringify(statusEvidence, null, 2),
    )
    assert.ok(gitFixture.remoteAdvanced, 'Fixture host did not advance remote after native clone')
    assert.ok(gitFixture.authChallengeCount > 0, 'Fixture did not challenge native credentials')
    assert.equal(gitFixture.backendFailures, 0, 'Fixture backend request failed')
    const remoteRefs = await command('git', [
      '--git-dir',
      join(gitFixture.root, 'repos/fixture.git'),
      'show-ref',
      '--heads',
    ])
    const refs = Object.fromEntries(
      remoteRefs
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [oid, ref] = line.split(' ')
          return [ref, oid]
        }),
    )
    assert.equal(refs['refs/heads/fixture-start'], report.git.fetchedRef)
    assert.equal(refs['refs/heads/holi-compat'], report.git.pushedHead)
    await writeFile(
      join(artifacts, 'git-transport-proof.json'),
      JSON.stringify(
        {
          runId,
          authChallenges: gitFixture.authChallengeCount,
          remoteAdvancedAfterClone: gitFixture.remoteAdvanced,
          pushedRef: 'refs/heads/holi-compat',
          refs: Object.keys(refs),
        },
        null,
        2,
      ),
    )
    const prefixProof = report.prefixNamespace
    assert.equal(await realpath(prefixProof.rootA), prefixProof.rootA)
    assert.equal(await realpath(prefixProof.rootB), prefixProof.rootB)
    assert.equal(await realpath(prefixProof.privateA), prefixProof.privateA)
    assert.equal(await realpath(prefixProof.privateB), prefixProof.privateB)
    assert.ok(!prefixProof.privateB.startsWith(`${prefixProof.privateA}/`))
    assert.ok(!prefixProof.privateA.startsWith(`${prefixProof.privateB}/`))
    assert.equal(
      await readFile(join(prefixProof.rootA, 'same/note.md'), 'utf8'),
      prefixProof.bytesA,
    )
    assert.equal(
      await readFile(join(prefixProof.rootB, 'same/note.md'), 'utf8'),
      prefixProof.bytesB,
    )
    assert.equal(
      await readFile(join(prefixProof.privateB, prefixProof.poisonName), 'utf8'),
      prefixProof.poisonBytes,
    )
    assert.deepEqual(await readdir(prefixProof.privateA), [])
    const durableNote = join(documents, `holi-storage-check-${runId}`, 'same/note.md')
    const durableBefore = await readFile(durableNote)
    for (const [index, name] of ['Café.md', 'Cafe\u0301.md'].entries()) {
      const rawRoot = join(documents, `holi-raw-${runId}-${index}`)
      assert.equal(await readFile(join(rawRoot, name), 'utf8'), 'updated raw native fixture')
    }
    await simctl('io', simulator, 'screenshot', join(artifacts, 'status.png'))
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
    await drainProcess(recoveryProcess)
    activeProcess = undefined
    const moveEvidence = []
    const moveRootFor = (ordinal) => join(documents, `holi-move-${runId}-${ordinal}`)
    const verifyMoveBoundary = async (caseInfo, marker) => {
      const root = moveRootFor(caseInfo.ordinal)
      const privatePath = stagingDirectory(library, root)
      const privateInfo = await lstat(privatePath)
      assert.ok(privateInfo.isDirectory() && !privateInfo.isSymbolicLink())
      assert.equal(await realpath(privatePath), privatePath)
      const current = await Promise.all(
        ['from.md', 'to.md', 'back-a.md', 'back-b.md'].map(async (path) => {
          try {
            return [path, await readFile(join(root, path))]
          } catch (error) {
            if (error.code === 'ENOENT') return [path, null]
            throw error
          }
        }),
      )
      const currentMap = Object.fromEntries(current)
      const expectedState = moveCheckpointState(caseInfo, marker.operationId, moveBytes, root)
      let journal = null
      try {
        journal = JSON.parse(
          await readFile(join(privatePath, `move-${marker.operationId}.json`), 'utf8'),
        )
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      validateMoveCheckpointState(expectedState, {
        caseInfo,
        operationId: marker.operationId,
        files: currentMap,
        journal,
      })
      return currentMap
    }
    for (const caseInfo of moveCrashCases()) {
      const root = moveRootFor(caseInfo.ordinal)
      const privatePath = stagingDirectory(library, root)
      const markerPath = join(documents, `holi-move-checkpoint-${runId}-${caseInfo.ordinal}.json`)
      const stagedMove = await launchPhase('move-stage', caseInfo)
      const marker = await waitJson(markerPath, stagedMove, 30_000)
      validateMoveCheckpoint(marker, {
        runId,
        caseInfo,
        ...stagedMove,
        now: Date.now(),
        root,
        privatePath: stagingDirectory(library, root),
      })
      assert.equal(await realpath(root), root)
      assert.equal(await realpath(marker.privatePath), marker.privatePath)
      const currentMap = await verifyMoveBoundary(caseInfo, marker)
      const runningBinary = await command('ps', ['-p', String(stagedMove.pid), '-o', 'comm='])
      assert.equal(await realpath(runningBinary), installedBinary)
      process.kill(stagedMove.pid, 'SIGKILL')
      let moveGone = false
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(stagedMove.pid, 0)
        } catch (error) {
          if (error.code === 'ESRCH') {
            moveGone = true
            break
          }
          throw error
        }
        await sleep(50)
      }
      assert.ok(moveGone, `Move process ${caseInfo.ordinal} did not terminate`)
      await drainProcess(stagedMove)
      activeProcess = undefined
      const bytesAfterDrain = await verifyMoveBoundary(caseInfo, marker)
      assert.deepEqual(bytesAfterDrain, currentMap, 'Boundary bytes changed after process drain')
      const receipt = {
        runId,
        ordinal: caseInfo.ordinal,
        pid: stagedMove.pid,
        container: canonicalContainer,
        root,
        marker,
        bytesAtKill: currentMap,
        killedAt: Date.now(),
        signal: 'SIGKILL',
        executable: installedBinary,
      }
      await writeFile(
        join(artifacts, `move-${caseInfo.ordinal}-kill.json`),
        JSON.stringify(receipt, null, 2),
      )
      const moveRecovery = await launchPhase('move-recovery', caseInfo)
      assert.equal(
        await realpath(await simctl('get_app_container', simulator, bundleId, 'data')),
        canonicalContainer,
      )
      const moveReport = await waitJson(reportPath, moveRecovery, 30_000)
      assert.equal(moveReport.runId, runId)
      assert.equal(moveReport.phase, 'move-recovery')
      assert.equal(moveReport.moveRestart.root, root)
      assert.equal(moveReport.moveRestart.recovered, caseInfo.phase !== 'journal-before')
      assert.equal(moveReport.moveRestart.malformedJournalRefused, true)
      assert.equal(moveReport.moveRestart.conflictJournalRefused, true)
      const wrongRootId = `20000000-0000-4000-8000-${String(caseInfo.ordinal).padStart(12, '0')}`
      const wrongRoot = join(documents, `holi-move-wrong-root-${runId}-${caseInfo.ordinal}`)
      const namedRoot = join(documents, `holi-move-named-root-${runId}-${caseInfo.ordinal}`)
      const wrongRootPrivate = stagingDirectory(library, wrongRoot)
      const wrongRootName = `move-${wrongRootId}.json`
      const wrongRootReceipt = moveReport.moveRestart.wrongRootRefusal
      assert.deepEqual(
        { ...wrongRootReceipt, error: undefined },
        {
          receivingRoot: wrongRoot,
          namedRoot,
          journalName: wrongRootName,
          error: undefined,
          sourceUnchanged: true,
          destinationAbsent: true,
          namedRootUnchanged: true,
          journalBytesPreserved: true,
        },
      )
      assert.match(wrongRootReceipt.error, /Invalid move recovery journal identity/)
      assert.equal(await realpath(wrongRoot), wrongRoot)
      assert.equal(await realpath(namedRoot), namedRoot)
      assert.equal(await realpath(wrongRootPrivate), wrongRootPrivate)
      assert.equal(await readFile(join(wrongRoot, 'from.md'), 'utf8'), '[[from.md]]')
      await assert.rejects(readFile(join(wrongRoot, 'to.md')), { code: 'ENOENT' })
      assert.equal(await readFile(join(namedRoot, 'keep.md'), 'utf8'), 'named root preserved')
      const wrongRootJournal = {
        schema: 2,
        root: namedRoot,
        operationId: wrongRootId,
        from: 'from.md',
        to: 'to.md',
        changes: [
          { path: 'from.md', before: [...new TextEncoder().encode('[[from.md]]')], after: null },
          { path: 'to.md', before: null, after: [...new TextEncoder().encode('[[to.md]]')] },
        ],
      }
      assert.equal(
        await readFile(join(wrongRootPrivate, wrongRootName), 'utf8'),
        JSON.stringify(wrongRootJournal),
      )
      const expectedSource = caseInfo.phase === 'journal-before' ? moveBytes.source : null
      const expectedDestination = caseInfo.phase === 'journal-before' ? null : moveBytes.moved
      const expectedBackA = caseInfo.phase === 'journal-before' ? moveBytes.backA : moveBytes.movedA
      const expectedBackB = caseInfo.phase === 'journal-before' ? moveBytes.backB : moveBytes.movedB
      assert.equal(
        await readFile(join(root, 'from.md'), 'utf8').catch((error) =>
          error.code === 'ENOENT' ? null : Promise.reject(error),
        ),
        expectedSource,
      )
      assert.equal(
        await readFile(join(root, 'to.md'), 'utf8').catch((error) =>
          error.code === 'ENOENT' ? null : Promise.reject(error),
        ),
        expectedDestination,
      )
      assert.equal(await readFile(join(root, 'back-a.md'), 'utf8'), expectedBackA)
      assert.equal(await readFile(join(root, 'back-b.md'), 'utf8'), expectedBackB)
      assert.deepEqual(await readFile(join(root, 'occupied.md'), 'utf8'), 'occupied')
      assert.equal(await readFile(join(root, 'Case.md'), 'utf8'), 'case alias fixture')
      assert.equal(await readFile(join(root, 'private.local.md'), 'utf8'), 'local source')
      assert.equal(
        await readFile(
          join(documents, `holi-move-other-${runId}-${caseInfo.ordinal}`, 'from.md'),
          'utf8',
        ),
        'other root',
      )
      const malformedRoot = join(documents, `holi-move-malformed-${runId}-${caseInfo.ordinal}`)
      const conflictRoot = join(documents, `holi-move-conflict-${runId}-${caseInfo.ordinal}`)
      assert.equal(
        await readFile(join(malformedRoot, 'keep.md'), 'utf8'),
        'malformed fixture preserved',
      )
      assert.equal(await readFile(join(conflictRoot, 'from.md'), 'utf8'), 'newer user bytes')
      const malformedPrivate = stagingDirectory(library, malformedRoot)
      const conflictPrivate = stagingDirectory(library, conflictRoot)
      assert.equal(await realpath(malformedPrivate), malformedPrivate)
      assert.equal(await realpath(conflictPrivate), conflictPrivate)
      const malformedId = `00000000-0000-4000-8000-${String(caseInfo.ordinal).padStart(12, '0')}`
      const conflictId = `10000000-0000-4000-8000-${String(caseInfo.ordinal).padStart(12, '0')}`
      assert.equal(
        await readFile(join(malformedPrivate, `move-${malformedId}.json`), 'utf8'),
        '{bad',
      )
      const retainedConflict = JSON.parse(
        await readFile(join(conflictPrivate, `move-${conflictId}.json`), 'utf8'),
      )
      assert.equal(retainedConflict.operationId, conflictId)
      assert.equal(retainedConflict.from, 'from.md')
      assert.deepEqual(await readdir(privatePath), [], 'Cleaned move namespace retained artifacts')
      moveEvidence.push(receipt)
      await writeFile(
        join(artifacts, `move-${caseInfo.ordinal}-evidence.json`),
        JSON.stringify(
          {
            ...receipt,
            recovered: true,
            expectedSource,
            expectedDestination,
            expectedBackA,
            expectedBackB,
            malformedRoot,
            conflictRoot,
          },
          null,
          2,
        ),
      )
    }
    await writeFile(
      join(artifacts, 'move-matrix.json'),
      JSON.stringify({ cases: moveEvidence.length, evidence: moveEvidence }, null, 2),
    )
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
          gitTransport: true,
          moveCrashCases: moveEvidence.length,
          faultOperations: 10,
          rawSpellings: 2,
        },
        null,
        2,
      ),
    )
    console.log(
      `iOS ${runtime.version}: ${report.corpus.passed}/${report.corpus.total} format cases, native Git transport, 10 storage faults, ${moveEvidence.length} move crash cases, raw NFC/NFD and staged-kill recovery passed. Evidence: ${artifacts}`,
    )
  }
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
      [
        documents,
        stagingDirectory(join(canonicalContainer, 'Library'), root),
        ...moveCrashCases().flatMap(({ ordinal }) => {
          const moveRoot = join(documents, `holi-move-${runId}-${ordinal}`)
          const malformedRoot = join(documents, `holi-move-malformed-${runId}-${ordinal}`)
          const conflictRoot = join(documents, `holi-move-conflict-${runId}-${ordinal}`)
          return [
            moveRoot,
            malformedRoot,
            conflictRoot,
            stagingDirectory(join(canonicalContainer, 'Library'), moveRoot),
            stagingDirectory(join(canonicalContainer, 'Library'), malformedRoot),
            stagingDirectory(join(canonicalContainer, 'Library'), conflictRoot),
          ]
        }),
      ],
      join(artifacts, 'failure-files.json'),
    )
  }
  console.error(`iOS compatibility failed. Evidence: ${artifacts}`)
  throw error
} finally {
  // Never enumerate/delete other devices. Even an interrupted run cleans its own device.
  if (gitFixture) {
    try {
      await gitFixture.close()
    } catch (error) {
      cleanupFailures.push(`Git fixture cleanup: ${String(error)}`)
    }
  }
  if (simulator) {
    cleanupFailures.push(...(await cleanupSimulator({ simulator, artifacts })))
    if (cleanupFailures.length)
      console.error(`Simulator cleanup failed: ${cleanupFailures.join('\n')}`)
  }
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
if (cleanupFailures.length) throw new Error('Simulator cleanup did not complete')
