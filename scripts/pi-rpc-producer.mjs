import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const maxDiagnosticChars = 1000
const maxEvidenceBytes = 64 * 1024
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

function validEvidence(evidence, expectedVersion) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false
  const allowedKeys = new Set([
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
  if (Object.keys(evidence).some((key) => !allowedKeys.has(key))) return false
  if (
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
    !evidence.cleanup ||
    evidence.cleanup.piRunDrained !== true ||
    evidence.cleanup.fixtureServerClosed !== true ||
    evidence.cleanup.localRootRemoved !== true
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

function runBounded(command, args, options, timeout) {
  return new Promise((resolveRun, reject) => {
    let child
    try {
      child = spawn(command, args, options)
    } catch (error) {
      reject(error)
      return
    }
    let out = ''
    let err = ''
    let timer
    let killTimer
    let settled = false
    let timedOut = false
    let totalOutputBytes = 0
    let overflowed = false
    let terminating = false
    let terminationError
    const terminationCallbacks = []
    const signalOwned = (signal) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) {
        if (error?.code !== 'ESRCH') terminationError = error
      }
    }
    const groupExists = () => {
      if (process.platform === 'win32' || !child.pid) return false
      try {
        process.kill(-child.pid, 0)
        return true
      } catch (error) {
        if (error?.code === 'ESRCH') return false
        if (error?.code !== 'EPERM') terminationError = error
        return true
      }
    }
    const completeTermination = () => {
      const callbacks = terminationCallbacks.splice(0)
      for (const callback of callbacks) callback(terminationError)
    }
    const waitForGroupDrain = () => {
      if (process.platform === 'win32' || !child.pid) return completeTermination()
      const deadline = Date.now() + 1500
      const poll = () => {
        if (!groupExists()) return completeTermination()
        if (Date.now() >= deadline) {
          terminationError ??= new Error('Owned native probe process group did not drain')
          completeTermination()
        } else killTimer = setTimeout(poll, 20)
      }
      poll()
    }
    const terminate = (done) => {
      if (done) terminationCallbacks.push(done)
      if (terminating) return
      terminating = true
      if (process.platform === 'win32')
        terminationError = new Error('Owned descendant cleanup is unsupported on Windows')
      signalOwned('SIGTERM')
      killTimer = setTimeout(() => {
        signalOwned('SIGKILL')
        waitForGroupDrain()
      }, 200)
      killTimer.unref?.()
    }
    const bounded = (stream, assign) =>
      stream.on('data', (chunk) => {
        totalOutputBytes += chunk.length
        if (totalOutputBytes > 256 * 1024 && !overflowed) {
          overflowed = true
          terminate(() =>
            finish(terminationError ?? new Error('Native Pi RPC probe output exceeded bound')),
          )
        }
        if (overflowed) return
        const text = chunk.toString()
        if (assign === 'out') out = (out + text).slice(-maxDiagnosticChars)
        else err = (err + text).slice(-maxDiagnosticChars)
      })
    bounded(child.stdout, 'out')
    bounded(child.stderr, 'err')
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (error) reject(error)
      else resolveRun(value)
    }
    child.once('error', (error) => finish(error))
    child.once('close', (code, signal) => {
      if (timedOut || overflowed) return
      const result = { code, signal, out, err }
      if (!groupExists()) return finish(null, result)
      terminate((error) => {
        if (timedOut || overflowed) return
        finish(error ?? null, error ? undefined : result)
      })
    })
    timer = setTimeout(() => {
      timedOut = true
      timer = undefined
      terminate(() =>
        finish(terminationError ?? new Error(`Native Pi RPC probe timed out after ${timeout}ms`)),
      )
    }, timeout)
  })
}

export async function checkPiRpcProducer({
  bin,
  expectedVersion,
  cwd = process.cwd(),
  timeout = timeoutMs,
}) {
  if (!bin || !expectedVersion) throw new Error('Pi binary and exact expected version are required')
  let root
  let outcome
  let stage = 'setup'
  let runnerResult
  let capturedEvidence
  try {
    root = mkdtempSync(join(tmpdir(), 'holi-pi-rpc-producer-'))
    const evidencePath = join(root, 'evidence.json')
    const env = {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8',
      HOME: root,
      COREPACK_HOME: process.env.COREPACK_HOME ?? join(homedir(), '.cache/node/corepack'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      TMPDIR: root,
      PI_OFFLINE: '1',
      PI_NATIVE_PROBE_BIN: resolve(bin),
      PI_NATIVE_PROBE_VERSION: expectedVersion,
      PI_NATIVE_PROBE_EVIDENCE: evidencePath,
    }
    stage = 'runner'
    runnerResult = await runBounded(
      'pnpm',
      [
        '--filter',
        '@holi/desktop',
        'exec',
        'vitest',
        'run',
        'src/plugins/agent/test/pi-rpc-producer.test.ts',
      ],
      {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
      timeout,
    )
    stage = 'evidence'
    let bytes
    try {
      if (statSync(evidencePath).size > maxEvidenceBytes) throw new Error('too large')
      bytes = readFileSync(evidencePath, 'utf8')
    } catch {
      const diagnostic = (runnerResult.err || runnerResult.out).slice(-maxDiagnosticChars)
      throw new Error(
        `Native Pi RPC evidence is missing or oversized (runner exit ${runnerResult.code}: ${diagnostic || 'no diagnostic'})`,
      )
    }
    try {
      capturedEvidence = JSON.parse(bytes)
    } catch {
      throw new Error('Native Pi RPC evidence is malformed')
    }
    if (capturedEvidence.observedVersion && capturedEvidence.observedVersion !== expectedVersion) {
      stage = 'version'
      throw new Error(
        `Observed Pi version ${String(capturedEvidence.observedVersion).slice(0, 128)} did not match ${expectedVersion}`,
      )
    }
    if (runnerResult.code !== 0) {
      if (capturedEvidence.failure?.stage === 'native-rpc') {
        stage = 'native-rpc'
        throw new Error(
          `Native RPC assertion failed: ${String(capturedEvidence.failure.message ?? 'consumer assertion failed').slice(0, 500)}`,
        )
      }
      throw new Error(`Probe runner exited ${runnerResult.code} without a verified native failure`)
    }
    if (!validEvidence(capturedEvidence, expectedVersion))
      throw new Error('Native Pi RPC evidence is incomplete or inconsistent')
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
  let cleanupError
  if (root) {
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
  if (!temporaryRootRemoved) {
    outcome = {
      ...outcome,
      outcome: 'unverified',
      stage: 'cleanup',
      detail: `Native Pi RPC probe cleanup failed: ${cleanupError}`,
    }
  }
  return {
    ...outcome,
    cleanup: { temporaryRootRemoved, ...(cleanupError ? { error: cleanupError } : {}) },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.stdout.write(
    `${JSON.stringify(await checkPiRpcProducer({ bin: process.argv[2], expectedVersion: process.argv[3] }))}\n`,
  )
}
