import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  leaseBuildScript,
  producerCommandFailure,
  runProducerCommand,
} from './producer-command.mjs'

const maxDiagnosticChars = 1000
const maxEvidenceBytes = 64 * 1024
const maxReceiptBytes = 4096
const leaseRoles = ['version', 'rpc-first', 'rpc-cancel']
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const timeoutMs = 90_000
const requiredScenarios = [
  'streamCompletion',
  'consecutiveTurns',
  'modelError',
  'cancel',
  'noToolsRequest',
  'appendSystemPrompt',
  'statsResponse',
  'steerAndFollowUp',
]

const allowedEvidenceKeys = new Set([
  'expectedVersion',
  'observedVersion',
  'package',
  'scenarios',
  'records',
  'commands',
  'tools',
  'recordCount',
  'commandCount',
  'stderr',
  'failure',
  'cleanup',
])
function validEvidence(evidence, expectedVersion) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false
  if (Object.keys(evidence).some((key) => !allowedEvidenceKeys.has(key))) return false
  if (
    evidence.failure !== undefined ||
    evidence.expectedVersion !== expectedVersion ||
    evidence.observedVersion !== expectedVersion ||
    evidence.package !== '@earendil-works/pi-coding-agent' ||
    evidence.recordCount < 1 ||
    !Number.isInteger(evidence.recordCount) ||
    evidence.commandCount < 1 ||
    !Number.isInteger(evidence.commandCount) ||
    !Array.isArray(evidence.records) ||
    evidence.records.length !== evidence.recordCount ||
    evidence.recordCount > 500 ||
    !Array.isArray(evidence.commands) ||
    evidence.commands.length !== evidence.commandCount ||
    evidence.commandCount > 256 ||
    !Array.isArray(evidence.tools) ||
    evidence.tools.length !== 0 ||
    !evidence.scenarios ||
    typeof evidence.scenarios !== 'object' ||
    Array.isArray(evidence.scenarios) ||
    (evidence.stderr !== undefined &&
      (typeof evidence.stderr !== 'string' || evidence.stderr.length > 16 * 1024)) ||
    !settled(evidence)
  )
    return false
  const scenarios = evidence.scenarios
  const launchCommands = evidence.commands.filter((command) => Array.isArray(command?.argv))
  const protocolCommands = evidence.commands.filter((command) => typeof command?.type === 'string')
  return (
    scenarios.modelErrorReported === true &&
    requiredScenarios.every((key) => scenarios[key] === 'pass') &&
    launchCommands.length >= 1 &&
    launchCommands.every((command) => command.noTools === true) &&
    protocolCommands.some((command) => command.type === 'abort') &&
    evidence.records.every((record) => record && typeof record.type === 'string') &&
    evidence.records.some((r) => r?.type === 'agent_start') &&
    evidence.records.some((r) => r?.type === 'agent_settled') &&
    evidence.records.some(
      (r) => r?.type === 'response' && r.command === 'set_model' && r.success === true,
    ) &&
    evidence.records.some(
      (r) => r?.type === 'response' && r.command === 'prompt' && r.success === true,
    ) &&
    evidence.records.some(
      (r) => r?.type === 'response' && r.command === 'get_session_stats' && r.success === true,
    )
  )
}

function settled(evidence) {
  return (
    evidence?.cleanup?.piRunDrained === true &&
    evidence.cleanup.fixtureServerClosed === true &&
    evidence.cleanup.localRootRemoved === true
  )
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function privateDirectory(path) {
  const stat = lstatSync(path)
  if (
    realpathSync(path) !== path ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error('Not a private directory')
}

function readPrivate(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new Error('Not a private regular file')
    const bytes = Buffer.alloc(limit + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null)
      if (!count) break
      size += count
    }
    if (size > limit) throw new Error('Private producer file exceeded bound')
    return bytes.subarray(0, size)
  } finally {
    closeSync(fd)
  }
}

function readReceipt(path) {
  const text = readPrivate(path, maxReceiptBytes).toString('utf8')
  const record = JSON.parse(text)
  // The writer uses compact JSON. Reject duplicate members and noncanonical framing.
  if (JSON.stringify(record) !== text) throw new Error('Invalid private receipt framing')
  return record
}

function validFailureEvidence(evidence, expectedVersion) {
  const failure = evidence?.failure
  return (
    evidence &&
    typeof evidence === 'object' &&
    !Array.isArray(evidence) &&
    Object.keys(evidence).every((key) => allowedEvidenceKeys.has(key)) &&
    evidence.expectedVersion === expectedVersion &&
    (evidence.observedVersion === undefined ||
      (typeof evidence.observedVersion === 'string' && evidence.observedVersion.length <= 128)) &&
    exactKeys(failure, ['stage', 'message']) &&
    ['setup', 'version', 'native-rpc'].includes(failure.stage) &&
    typeof failure.message === 'string' &&
    failure.message.length > 0 &&
    failure.message.length <= 1000 &&
    (failure.stage !== 'setup' || evidence.observedVersion === undefined) &&
    (failure.stage !== 'native-rpc' || evidence.observedVersion === expectedVersion)
  )
}

// The outer ChildProcess receipt covers its own non-detached descendants, not
// these leases. Join the private worker claim, pre-launch admissions, and final
// receipt; never re-probe PIDs that the worker already proved absent.
function verifyWorkerSettlement(root, identity, bytes, evidence, successful) {
  const admissions = join(root, 'admissions')
  const ownership = join(root, 'ownership')
  for (const path of [root, join(root, 'worker-tmp'), admissions, ownership]) privateDirectory(path)
  if (lstatSync(join(root, 'settlement.tmp'), { throwIfNoEntry: false })) return false
  const worker = readReceipt(join(root, 'worker.json'))
  const receipt = readReceipt(join(root, 'settlement.json'))
  const identityKeys = ['version', 'runId', 'nonce', 'workerPid']
  if (
    !exactKeys(worker, identityKeys) ||
    !exactKeys(receipt, [...identityKeys, 'state', 'admission', 'leases', 'evidenceSha256']) ||
    worker.version !== 1 ||
    worker.runId !== identity.runId ||
    worker.nonce !== identity.nonce ||
    !Number.isSafeInteger(worker.workerPid) ||
    worker.workerPid <= 1 ||
    worker.workerPid > 0x7fffffff ||
    !identityKeys.every((key) => receipt[key] === worker[key]) ||
    receipt.state !== 'final' ||
    receipt.evidenceSha256 !== createHash('sha256').update(bytes).digest('hex') ||
    !Array.isArray(receipt.leases) ||
    receipt.leases.length > leaseRoles.length
  )
    return false

  const seen = new Set()
  const expectedAdmissions = []
  for (const [index, lease] of receipt.leases.entries()) {
    if (
      !exactKeys(lease, ['id', 'role', 'proof']) ||
      typeof lease.id !== 'string' ||
      !uuid.test(lease.id) ||
      seen.has(lease.id) ||
      lease.role !== leaseRoles[index] ||
      !['settled', 'kernel-absence'].includes(lease.proof)
    )
      return false
    seen.add(lease.id)
    expectedAdmissions.push(`${lease.role}-${lease.id}`)
    privateDirectory(join(ownership, lease.id))
    privateDirectory(join(admissions, expectedAdmissions[index]))
  }
  const sameEntries = (path, expected) => {
    const entries = readdirSync(path)
    return entries.length === expected.length && expected.every((name) => entries.includes(name))
  }
  if (!sameEntries(admissions, expectedAdmissions) || !sameEntries(ownership, [...seen]))
    return false
  // This exact working directory is a separate resource, not a prefix scan or
  // evidence of process absence. Even a valid native proof cannot join it.
  if (lstatSync(join(root, 'worker-tmp', 'probe-work'), { throwIfNoEntry: false })) return false
  if (successful) return receipt.admission === 'leases-settled' && seen.size === leaseRoles.length
  if (evidence.failure.stage === 'native-rpc' && seen.size < 2) return false
  if (evidence.failure.stage === 'version' && seen.size !== 1) return false
  return seen.size > 0
    ? evidence.failure.stage !== 'setup' && receipt.admission === 'leases-settled'
    : evidence.failure.stage === 'setup' && receipt.admission === 'no-admission'
}

export async function checkPiRpcProducer({
  bin,
  expectedVersion,
  cwd = process.cwd(),
  timeout = timeoutMs,
  pnpm = 'pnpm',
  adapter,
}) {
  if (!bin || !expectedVersion) throw new Error('Pi binary and exact expected version are required')
  let root
  let outcome
  let stage = 'setup'
  let runnerResult
  let capturedEvidence
  let unsettled
  let runnerPid
  try {
    root = mkdtempSync(join(tmpdir(), 'holi-pi-rpc-producer-'))
    root = realpathSync(root)
    const evidencePath = join(root, 'evidence.json')
    const identity = { runId: randomUUID(), nonce: randomUUID() }
    const workerTmp = join(root, 'worker-tmp')
    for (const dir of [workerTmp, join(root, 'admissions'), join(root, 'ownership')])
      mkdirSync(dir, { mode: 0o700 })
    const env = {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8',
      HOME: root,
      COREPACK_HOME: process.env.COREPACK_HOME ?? join(homedir(), '.cache/node/corepack'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      TMPDIR: workerTmp,
      TMP: workerTmp,
      TEMP: workerTmp,
      PI_OFFLINE: '1',
      PI_NATIVE_PROBE_BIN: resolve(bin),
      PI_NATIVE_PROBE_VERSION: expectedVersion,
      PI_NATIVE_PROBE_EVIDENCE: evidencePath,
    }
    const options = { cwd, env, maxOutput: 256 * 1024, diagnosticTail: maxDiagnosticChars, adapter }
    unsettled = 'Missing POSIX launch helper build settlement receipt'
    const build = await runProducerCommand(process.execPath, [leaseBuildScript], {
      ...options,
      timeout: 35_000,
    })
    runnerPid = build.pid
    unsettled = build.cleanupError
    if (!unsettled && !build.notStarted && (build.timedOut || build.outputLimited || build.signal))
      unsettled = 'POSIX launch helper build was interrupted before normal settlement'
    const buildFailure = producerCommandFailure(build, 'POSIX launch helper build')
    if (buildFailure || unsettled)
      throw new Error(`${buildFailure ?? unsettled}${build.stderr ? `: ${build.stderr}` : ''}`)

    stage = 'runner'
    unsettled = 'Missing runner settlement receipt'
    runnerResult = await runProducerCommand(
      pnpm,
      [
        '--filter',
        '@holi/desktop',
        'exec',
        'vitest',
        'run',
        'src/plugins/agent/test/pi-rpc-producer.test.ts',
        '-t',
        '^captures bounded native Pi RPC producer records through PiRpcRun$',
      ],
      {
        ...options,
        env: {
          ...env,
          PI_NATIVE_PROBE_RUN_ID: identity.runId,
          PI_NATIVE_PROBE_NONCE: identity.nonce,
        },
        timeout,
      },
    )
    runnerPid = runnerResult.pid
    unsettled =
      runnerResult.cleanupError ??
      (runnerResult.notStarted
        ? undefined
        : 'Missing complete detached worker lease settlement receipt')
    if (unsettled && runnerResult.stopError) unsettled += `; ${runnerResult.stopError}`
    const runnerFailure = producerCommandFailure(
      runnerResult,
      'Native Pi RPC probe runner',
      timeout,
    )
    if (
      runnerResult.timedOut ||
      runnerResult.outputLimited ||
      runnerResult.error ||
      runnerResult.signal
    )
      throw new Error(runnerFailure)

    stage = 'evidence'
    let bytes
    try {
      privateDirectory(root)
      bytes = readPrivate(evidencePath, maxEvidenceBytes)
    } catch {
      const diagnostic = (runnerResult.stderr || runnerResult.stdout).slice(-maxDiagnosticChars)
      throw new Error(
        `${runnerFailure ? `${runnerFailure}: ` : ''}Native Pi RPC evidence is missing, not private, or oversized (runner exit ${runnerResult.code}: ${diagnostic || 'no diagnostic'})`,
      )
    }
    try {
      capturedEvidence = JSON.parse(bytes)
    } catch {
      throw new Error(
        `${runnerFailure ? `${runnerFailure}: ` : ''}Native Pi RPC evidence is malformed`,
      )
    }
    const verifiedSuccess = !runnerFailure && validEvidence(capturedEvidence, expectedVersion)
    const reportedFailure = runnerFailure && validFailureEvidence(capturedEvidence, expectedVersion)
    if (
      !runnerResult.cleanupError &&
      !runnerResult.notStarted &&
      (verifiedSuccess || (reportedFailure && settled(capturedEvidence)))
    ) {
      try {
        if (verifyWorkerSettlement(root, identity, bytes, capturedEvidence, verifiedSuccess))
          unsettled = undefined
      } catch {
        // Inaccessible, missing, oversized, or malformed private records are not proof.
      }
    }
    if (
      reportedFailure &&
      capturedEvidence.failure.stage === 'version' &&
      capturedEvidence.observedVersion &&
      capturedEvidence.observedVersion !== expectedVersion
    ) {
      stage = 'version'
      throw new Error(
        `Observed Pi version ${String(capturedEvidence.observedVersion).slice(0, 128)} did not match ${expectedVersion}`,
      )
    }
    if (runnerFailure) {
      if (reportedFailure && capturedEvidence.failure.stage === 'native-rpc') {
        stage = 'native-rpc'
        throw new Error(
          `Native RPC assertion failed: ${String(capturedEvidence.failure.message ?? 'consumer assertion failed').slice(0, 500)}`,
        )
      }
      throw new Error(
        reportedFailure
          ? `${runnerFailure}: ${capturedEvidence.failure.message}`
          : `${runnerFailure} without a verified native failure`,
      )
    }
    if (!verifiedSuccess) throw new Error('Native Pi RPC evidence is incomplete or inconsistent')
    stage = 'complete'
    outcome = {
      outcome: 'pass',
      detail: `Native Pi ${expectedVersion} RPC producer verified through PiRpcRun (${capturedEvidence.recordCount} captured JSONL records).`,
      evidence: capturedEvidence,
    }
  } catch (error) {
    const mismatch = stage === 'version' || stage === 'native-rpc'
    outcome = {
      outcome: mismatch ? 'mismatch' : 'unverified',
      stage,
      detail: `Native Pi RPC producer check ${mismatch ? 'mismatch' : 'unverified'} at ${stage}: ${String(error instanceof Error ? error.message : error).slice(0, maxDiagnosticChars)}`,
      ...(capturedEvidence ? { evidence: capturedEvidence } : {}),
    }
  }
  let temporaryRootRemoved = root === undefined
  let cleanupError = unsettled
  if (root && !unsettled) {
    try {
      rmSync(root, { recursive: true, force: true })
      temporaryRootRemoved = true
    } catch (error) {
      cleanupError = String(error instanceof Error ? error.message : error).slice(
        0,
        maxDiagnosticChars,
      )
    }
  }
  if (!temporaryRootRemoved && outcome.outcome === 'pass') {
    outcome = {
      ...outcome,
      outcome: 'unverified',
      stage: 'cleanup',
      detail: `Native Pi RPC probe cleanup incomplete: ${cleanupError}`,
    }
  }
  return {
    ...outcome,
    cleanup: temporaryRootRemoved
      ? { temporaryRootRemoved }
      : {
          temporaryRootRemoved,
          status: 'incomplete',
          error: cleanupError,
          retainedRoot: root,
          ...(unsettled && runnerPid ? { runnerPid } : {}),
        },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.stdout.write(
    `${JSON.stringify(await checkPiRpcProducer({ bin: process.argv[2], expectedVersion: process.argv[3] }))}\n`,
  )
}
