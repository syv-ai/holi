import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, lstat, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  leaseBuildScript,
  producerCommandFailure,
  runProducerCommand,
} from './producer-command.mjs'
import {
  exactKeys,
  privateDirectory,
  readFinalSettlement,
  readPrivate,
} from './producer-settlement.mjs'

const VERSION = '0.169.0'
const MAX_OUTPUT = 2 * 1024 * 1024
const MAX_EVIDENCE = 1024 * 1024
const TOTAL_TIMEOUT = 180_000
const TEST_TIMEOUT = 100_000
const scenarioNames = ['initial-turn', 'follow-up', 'http-400', 'stall-stop', 'stall-leave']

const leaseRoles = [
  'initial-turn-version',
  'initial-turn',
  'follow-up',
  'follow-up-resume',
  ...scenarioNames.slice(2),
]

function hasFinalSettlement(root, identity, workerTmp, bytes, requireComplete) {
  const receipt = readFinalSettlement(root, identity, leaseRoles, bytes, requireComplete)
  return (
    receipt &&
    receipt.leases.length === leaseRoles.length &&
    scenarioNames.every((name) => !lstatSync(join(workerTmp, name), { throwIfNoEntry: false }))
  )
}

function cleanEnvironment(home, extra = {}) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: join(home, 'tmp'),
    CI: '1',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    NO_COLOR: '1',
    ...extra,
  }
}

function validFailedScenario(scenario, bin) {
  return (
    scenario &&
    ['unverified', 'mismatch'].includes(scenario.status) &&
    ['setup', 'native-launch', 'native-contract', 'host-lifecycle', 'cleanup'].includes(
      scenario.stage,
    ) &&
    ['setup', 'timeout', 'contract'].includes(scenario.failureKind) &&
    typeof scenario.failure === 'string' &&
    scenario.failure.length > 0 &&
    // Seven registered roles means every scenario entered its capture fixture.
    ['processes', 'rawProcesses', 'jsonl', 'requests', 'host', 'brackets'].every(
      (key) =>
        Array.isArray(scenario[key]) &&
        scenario[key].every((row) => row && typeof row === 'object' && !Array.isArray(row)),
    ) &&
    scenario.rawProcesses.length === scenario.processes.length &&
    scenario.rawProcesses.every((raw, index) => {
      const captured = scenario.processes[index]
      return (
        Number.isInteger(raw.pid) &&
        raw.pid > 1 &&
        raw.bin === bin &&
        captured.pid === raw.pid &&
        captured.bin === raw.bin &&
        typeof raw.cwd === 'string' &&
        captured.cwd === raw.cwd &&
        Array.isArray(raw.args) &&
        raw.args.includes('exec') &&
        raw.args.includes('--json') &&
        JSON.stringify(captured.args) === JSON.stringify(raw.args) &&
        typeof raw.stdout === 'string' &&
        typeof raw.stderr === 'string' &&
        Number.isSafeInteger(raw.stdoutBytes) &&
        raw.stdoutBytes >= 0 &&
        Number.isSafeInteger(raw.stderrBytes) &&
        raw.stderrBytes >= 0 &&
        Number.isSafeInteger(raw.outputLines) &&
        raw.outputLines >= 0 &&
        typeof raw.outputLimited === 'boolean' &&
        (Number.isInteger(raw.exitCode) ||
          (raw.exitCode === null && typeof raw.signal === 'string')) &&
        (raw.signal === null || typeof raw.signal === 'string')
      )
    })
  )
}

function validateProbe(proof, expectedBin, allowFailure) {
  if (
    !proof ||
    proof.schema !== 'holi.codex-exec-producer.v1' ||
    proof.package !== '@openai/codex' ||
    proof.expectedVersion !== VERSION ||
    proof.version !== `codex-cli ${VERSION}`
  )
    return 'native evidence identity is incomplete or mismatched'
  if (typeof expectedBin !== 'string' || proof.bin !== expectedBin)
    return 'native CLI path does not match the pinned package installation'
  const expected = scenarioNames
  if (!Array.isArray(proof.scenarios) || proof.scenarios.length !== expected.length)
    return 'native evidence scenarios are incomplete'
  if (new Set(proof.scenarios.map((row) => row?.name)).size !== expected.length)
    return 'native evidence scenarios are duplicated'
  for (const name of expected) {
    const s = proof.scenarios.find((row) => row?.name === name)
    if (allowFailure && s?.status !== 'pass') {
      if (!validFailedScenario(s, expectedBin))
        return `native evidence ${name} has an incomplete failure record`
      continue
    }
    if (!s || s.status !== 'pass' || s.failure || s.failureKind)
      return `native evidence ${name} did not finish passing`
    if (!['cleanup', 'host-lifecycle', 'native-contract'].includes(s.stage))
      return `${name} did not reach a complete lifecycle stage`
    if (
      !Array.isArray(s.processes) ||
      !Array.isArray(s.rawProcesses) ||
      !s.rawProcesses.length ||
      !Array.isArray(s.jsonl) ||
      !s.jsonl.length ||
      !Array.isArray(s.requests) ||
      !Array.isArray(s.host) ||
      !Array.isArray(s.brackets)
    )
      return `native evidence lacks ${name} observations`
    if (
      s.rawProcesses.length !== s.processes.length ||
      s.rawProcesses.some(
        (p) =>
          !Number.isInteger(p?.pid) ||
          p.pid <= 1 ||
          p.bin !== expectedBin ||
          !Array.isArray(p.args) ||
          !p.args.includes('exec') ||
          !p.args.includes('--json') ||
          !(Number.isInteger(p.exitCode) || p.exitCode === null) ||
          !(p.signal === null || typeof p.signal === 'string') ||
          (p.exitCode === null && !p.signal) ||
          p.outputLimited !== false ||
          typeof p.stdout !== 'string' ||
          p.stdout.length > 262144 ||
          typeof p.stderr !== 'string' ||
          p.stderr.length > 262144 ||
          !Number.isInteger(p.stdoutBytes) ||
          p.stdoutBytes !== Buffer.byteLength(p.stdout) ||
          p.stdoutBytes > 262144 ||
          !Number.isInteger(p.stderrBytes) ||
          p.stderrBytes !== Buffer.byteLength(p.stderr) ||
          p.stderrBytes > 262144 ||
          !Number.isInteger(p.outputLines) ||
          p.outputLines > 2000 ||
          p.outputLines < 0 ||
          p.outputLines <
            Math.max(p.stdout.split('\n').length - 1, p.stderr.split('\n').length - 1) ||
          p.outputLines > p.stdout.split('\n').length + p.stderr.split('\n').length - 2 ||
          !Number.isInteger(p.lineLimit) ||
          p.lineLimit > 2000 ||
          p.lineLimit < 1 ||
          !Number.isInteger(p.byteLimit) ||
          p.byteLimit > 262144 ||
          p.byteLimit < 1,
      )
    )
      return `${name} has malformed or bounded-out native process evidence`
    for (let i = 0; i < s.rawProcesses.length; i++) {
      const raw = s.rawProcesses[i]
      const captured = s.processes[i]
      if (
        captured.pid !== raw.pid ||
        captured.bin !== raw.bin ||
        JSON.stringify(captured.args) !== JSON.stringify(raw.args) ||
        captured.cwd !== raw.cwd
      )
        return `${name} has contradictory native process metadata`
      const stdoutLines = raw.stdout.split('\n').filter(Boolean)
      for (const line of stdoutLines) {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          return `${name} has invalid raw native JSONL`
        }
        if (!event || typeof event !== 'object' || Array.isArray(event))
          return `${name} has invalid raw native JSONL records`
      }
      for (const row of s.jsonl) {
        if (
          typeof row?.line !== 'string' ||
          row.line.length > 16384 ||
          !row.event ||
          typeof row.event !== 'object' ||
          Array.isArray(row.event) ||
          !s.rawProcesses.some((process) => process.stdout.split('\n').includes(row.line))
        )
          return `${name} has malformed or unsubstantiated consumed JSONL evidence`
        try {
          JSON.parse(row.line)
        } catch {
          return `${name} has malformed consumed JSONL evidence`
        }
      }
    }
    if (!s.sessionId || !/^j[0-9a-f]{12}$/.test(s.sessionId))
      return `${name} has no actual Holi job id`
    if (
      !s.processes.every(
        (p) =>
          p.bin === expectedBin &&
          Number.isInteger(p.pid) &&
          p.pid > 1 &&
          p.args.includes('exec') &&
          p.args.includes('--json') &&
          typeof p.codeHome === 'string' &&
          p.codeHome.length > 0 &&
          typeof p.cwd === 'string' &&
          p.args.includes(p.cwd),
      )
    )
      return `${name} lacks captured native production process evidence`
    if (
      !s.brackets.some((b) => b.id === s.sessionId && b.edge === 'begin') ||
      !s.brackets.some((b) => b.id === s.sessionId && b.edge === 'end')
    )
      return `${name} lacks the host turn bracket`
    if (
      name === 'initial-turn' &&
      (s.outcome !== 'completed' ||
        s.tokens !== 13 ||
        s.processes.length !== 1 ||
        !s.jsonl?.some((e) => e.event?.kind === 'turn-completed' && e.event.tokens === 13) ||
        !s.host.some((h) => h.id === s.sessionId && h.outcome === 'completed' && h.tokens === 13) ||
        s.requests.length !== 1)
    )
      return 'initial native turn assertions are incomplete'
    if (
      name === 'follow-up' &&
      (s.outcome !== 'completed' ||
        s.tokens !== 26 ||
        s.processes.length !== 2 ||
        typeof s.thread !== 'string' ||
        !s.processes[1].args.includes('resume') ||
        !s.processes[1].args.includes(s.thread) ||
        !s.jsonl?.some((e) => e.event?.kind === 'turn-completed' && e.event.tokens === 26) ||
        !s.host.some((h) => h.id === s.sessionId && h.outcome === 'completed' && h.tokens === 26) ||
        s.brackets.filter((b) => b.id === s.sessionId).length !== 4)
    )
      return 'native follow-up assertions are incomplete'
    if (
      name === 'http-400' &&
      (s.outcome !== 'failed' ||
        !String(s.error).includes('fixture rejected request') ||
        !s.jsonl?.some(
          (e) =>
            e.event?.kind === 'error' &&
            String(e.event.message).includes('fixture rejected request'),
        ) ||
        !s.host.some(
          (h) =>
            h.id === s.sessionId &&
            h.outcome === 'failed' &&
            String(h.error).includes('fixture rejected request'),
        ))
    )
      return 'native HTTP 400 failure assertions are incomplete'
    if (
      name.startsWith('stall-') &&
      (s.requests.length !== 1 || s.requests[0].url !== '/v1/responses')
    )
      return `${name} did not observe exactly one native request`
    if (name === 'stall-stop' && (s.outcome !== 'failed' || !String(s.error).includes('Stopped.')))
      return 'native Stop outcome is incomplete'
    if (
      name === 'stall-leave' &&
      (s.outcome !== 'left' || s.sessionsAfterLeave !== 0 || s.hasAfterLeave !== false)
    )
      return 'native leave cleanup is incomplete'
  }
  if (!proof.cleanup?.rootsRemoved || !proof.cleanup?.nativeGroupsDrained)
    return 'native cleanup was not verified'
  return null
}

export function validateNativeProof(proof, expectedBin) {
  return validateProbe(proof, expectedBin, false)
}

// Cleanup can follow a failed probe, but it still requires the complete terminal
// artifact, not a progress snapshot or a success envelope with missing observations.
function validFinalArtifact(proof, bin, issue) {
  return (
    exactKeys(proof, [
      'schema',
      'package',
      'expectedVersion',
      'version',
      'bin',
      'scenarios',
      'cleanup',
    ]) &&
    exactKeys(proof.cleanup, ['nativeGroupsDrained', 'rootsRemoved']) &&
    proof.cleanup.nativeGroupsDrained === true &&
    proof.cleanup.rootsRemoved === true &&
    Array.isArray(proof.scenarios) &&
    proof.scenarios.length === scenarioNames.length &&
    scenarioNames.every((name, index) => {
      const scenario = proof.scenarios[index]
      return (
        scenario?.name === name &&
        (scenario.status !== 'pass' ||
          (scenario.failure === undefined && scenario.failureKind === undefined))
      )
    }) &&
    (!issue || !validateProbe(proof, bin, true))
  )
}

export async function runProducerProof({
  npm = 'npm',
  pnpm = 'pnpm',
  timeout = TOTAL_TIMEOUT,
  testEnv = {},
  adapter,
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holi-codex-exec-proof-')))
  const deadline = Date.now() + timeout
  const proofPath = join(root, 'native-evidence.json')
  const ledgerPath = join(root, 'native-processes.jsonl')
  let unsettled
  let runnerPid
  const evidence = {
    package: '@openai/codex',
    expectedVersion: VERSION,
    classification: 'setup-unavailable',
    packageVersion: null,
    version: null,
    test: null,
    native: null,
    cleanup: { rootRemoved: false, processesDrained: true },
  }
  const result = {
    get failed() {
      return evidence.classification !== 'pass'
    },
    evidence,
  }
  try {
    const run = async (label, command, args, options, worker = false) => {
      unsettled = `Missing settlement for ${label}`
      const commandResult = await runProducerCommand(command, args, {
        ...options,
        timeout: Math.min(options.timeout, deadline - Date.now()),
        maxOutput: MAX_OUTPUT,
        adapter,
      })
      runnerPid = commandResult.pid
      unsettled = commandResult.cleanupError
      if (!unsettled && !commandResult.notStarted) {
        if (worker) unsettled = 'Missing complete detached worker lease settlement receipt'
        else if (commandResult.signal || commandResult.timedOut || commandResult.outputLimited)
          unsettled = `${label} was interrupted before normal settlement`
      }
      if (unsettled && commandResult.stopError) unsettled += `; ${commandResult.stopError}`
      return commandResult
    }
    const home = join(root, 'home'),
      install = join(root, 'install'),
      cache = join(root, 'npm-cache'),
      corepack = join(root, 'corepack')
    await Promise.all(
      [home, install, cache, corepack, join(home, 'tmp')].map((path) =>
        mkdir(path, { recursive: true, mode: 0o700 }),
      ),
    )
    const env = cleanEnvironment(home, {
      COREPACK_HOME: corepack,
      npm_config_cache: cache,
      npm_config_userconfig: join(root, 'npmrc'),
      npm_config_globalconfig: join(root, 'global-npmrc'),
      npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    })
    await writeFile(env.npm_config_userconfig, '')
    await writeFile(join(corepack, 'lastKnownGood.json'), JSON.stringify({ pnpm: '10.8.1' }))
    const build = await run('POSIX launch helper build', process.execPath, [leaseBuildScript], {
      cwd: root,
      env,
      timeout: 35_000,
    })
    const buildFailure = producerCommandFailure(build, 'POSIX launch helper build')
    if (buildFailure || unsettled) {
      evidence.detail = buildFailure ?? unsettled
      evidence.diagnostics = build.stderr.slice(-8000)
      return result
    }
    const installResult = await run(
      'Pinned package installation',
      npm,
      [
        'install',
        '--prefix',
        install,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        `@openai/codex@${VERSION}`,
      ],
      { cwd: root, env, timeout: 60_000 },
    )
    const installFailure = producerCommandFailure(installResult, 'Pinned package installation')
    if (installFailure || unsettled) {
      evidence.detail = installFailure ?? unsettled
      evidence.diagnostics = installResult.stderr.slice(-8000)
      evidence.classification =
        installResult.timedOut || installResult.outputLimited
          ? 'incomplete-proof'
          : 'setup-unavailable'
      return result
    }
    const packageRoot = join(install, 'node_modules', '@openai', 'codex')
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    evidence.packageVersion = manifest.version ?? null
    if (manifest.name !== '@openai/codex' || manifest.version !== VERSION) {
      evidence.classification = 'observed-contract-error'
      evidence.detail = `unexpected package provenance: ${manifest.name ?? 'unknown'}@${manifest.version ?? 'unknown'}`
      return result
    }
    const bin = join(packageRoot, 'bin', 'codex.js')
    const version = await run('Pinned CLI version probe', process.execPath, [bin, '--version'], {
      cwd: root,
      env,
      timeout: 15_000,
    })
    evidence.version = version.stdout.trim()
    const versionFailure = producerCommandFailure(version, 'Pinned CLI version probe')
    if (versionFailure || unsettled) {
      evidence.classification =
        version.timedOut || version.outputLimited ? 'incomplete-proof' : 'setup-unavailable'
      evidence.detail = versionFailure ?? unsettled
      evidence.diagnostics = version.stderr.slice(-8000)
      return result
    }
    if (!new RegExp(`^codex-cli ${VERSION.replaceAll('.', '\\.')}\\s*$`).test(evidence.version)) {
      evidence.classification = 'observed-contract-error'
      evidence.detail = `expected exact codex-cli ${VERSION}`
      evidence.diagnostics = version.stderr.slice(-8000)
      return result
    }
    const workerTmp = join(root, 'worker-tmp')
    const identity = { runId: randomUUID(), nonce: randomUUID() }
    for (const dir of [workerTmp, join(root, 'admissions'), join(root, 'ownership')])
      await mkdir(dir, { mode: 0o700 })
    const test = await run(
      'Vitest runner',
      pnpm,
      [
        '--filter',
        '@holi/desktop',
        'exec',
        'vitest',
        'run',
        'src/plugins/agent/test/codex-exec-producer.test.ts',
        '--project',
        'node',
        '--reporter=verbose',
      ],
      {
        cwd: resolve(import.meta.dirname, '..'),
        env: cleanEnvironment(home, {
          ...env,
          ...testEnv,
          TMPDIR: workerTmp,
          TMP: workerTmp,
          TEMP: workerTmp,
          HOLI_CODEX_BIN: bin,
          HOLI_CODEX_PROOF_OUTPUT: proofPath,
          HOLI_CODEX_PROOF_RUN_ID: identity.runId,
          HOLI_CODEX_PROOF_NONCE: identity.nonce,
          HOLI_CODEX_PROCESS_LEDGER: ledgerPath,
        }),
        timeout: TEST_TIMEOUT,
      },
      true,
    )
    const runnerFailure = producerCommandFailure(test, 'Vitest runner')
    evidence.test = {
      code: test.code,
      timedOut: test.timedOut,
      outputLimited: test.outputLimited,
      retainedBytes: test.retainedBytes,
      ...(runnerFailure ? { failure: runnerFailure } : {}),
      stdout: test.stdout.slice(-12000),
      stderr: test.stderr.slice(-8000),
    }
    let proof, bytes
    try {
      privateDirectory(root)
      bytes = readPrivate(proofPath, MAX_EVIDENCE)
      proof = JSON.parse(bytes)
    } catch (error) {
      evidence.classification = 'incomplete-proof'
      evidence.detail = runnerFailure ?? `native evidence unavailable: ${String(error)}`
      return result
    }
    evidence.native = proof
    let issue
    try {
      issue = validateNativeProof(proof, bin)
    } catch {
      issue = 'native evidence is malformed'
    }
    if (!test.cleanupError && !test.notStarted) {
      try {
        // Parse and hash the same read. Only the worker's final artifact can
        // authorize cleanup, even if an earlier diagnostic snapshot parses.
        if (
          bytes.equals(Buffer.from(JSON.stringify(proof))) &&
          validFinalArtifact(proof, bin, issue) &&
          hasFinalSettlement(root, identity, workerTmp, bytes, !issue)
        )
          unsettled = undefined
      } catch {
        // Keep the worker's root and the original runner/probe failure.
      }
    }
    const testsPassed =
      !runnerFailure &&
      /\b5 passed\b/.test(test.stdout) &&
      !/\b[1-9]\d* skipped\b/.test(test.stdout)
    const scenarios = Array.isArray(proof?.scenarios) ? proof.scenarios : []
    const credibleAttempt = (scenario) =>
      Array.isArray(scenario?.rawProcesses) &&
      scenario.rawProcesses.some(
        (p) =>
          Number.isInteger(p?.pid) &&
          p.pid > 1 &&
          p.bin === bin &&
          Array.isArray(p.args) &&
          p.args.includes('exec') &&
          p.args.includes('--json') &&
          typeof p.stdout === 'string' &&
          typeof p.stderr === 'string' &&
          (Number.isInteger(p.exitCode) || p.exitCode === null) &&
          (p.signal === null || typeof p.signal === 'string'),
      )
    const attempted = scenarios.some(credibleAttempt)
    const nativeContractFailure = scenarios.some(
      (scenario) =>
        scenario?.status === 'mismatch' &&
        scenario?.failureKind === 'contract' &&
        ['native-contract', 'host-lifecycle', 'cleanup'].includes(scenario?.stage) &&
        credibleAttempt(scenario),
    )
    const setupFailure = scenarios.some(
      (scenario) =>
        (scenario?.failureKind === 'setup' || scenario?.stage === 'setup') &&
        !credibleAttempt(scenario),
    )
    const incomplete =
      test.timedOut ||
      test.outputLimited ||
      scenarios.some(
        (scenario) =>
          scenario?.failureKind === 'timeout' ||
          (Array.isArray(scenario?.rawProcesses) &&
            scenario.rawProcesses.some((process) => process?.outputLimited === true)),
      )
    if (incomplete) evidence.classification = 'incomplete-proof'
    else if (nativeContractFailure) evidence.classification = 'observed-contract-error'
    else if (setupFailure && !nativeContractFailure) evidence.classification = 'setup-unavailable'
    else if (issue)
      evidence.classification =
        attempted &&
        scenarios.some(
          (s) => s?.status === 'mismatch' && s?.failureKind === 'contract' && credibleAttempt(s),
        )
          ? 'observed-contract-error'
          : 'incomplete-proof'
    else if (!testsPassed) evidence.classification = 'incomplete-proof'
    else evidence.classification = 'pass'
    if (test.timedOut || test.outputLimited) evidence.detail = runnerFailure
    else if (issue) evidence.detail = issue
    else if (runnerFailure) evidence.detail = runnerFailure
    else if (!testsPassed)
      evidence.detail = 'Vitest did not report five executed, non-skipped scenarios'
    return result
  } catch (error) {
    evidence.detail = String(error)
    evidence.classification = 'setup-unavailable'
    return result
  } finally {
    evidence.cleanup.processesDrained = !unsettled
    if (!unsettled) {
      await rm(root, { recursive: true, force: true }).catch((error) => {
        evidence.cleanup.error = String(error)
      })
      try {
        await lstat(root)
      } catch (error) {
        evidence.cleanup.rootRemoved = error.code === 'ENOENT'
        if (!evidence.cleanup.rootRemoved) evidence.cleanup.error ??= String(error)
      }
    }
    if (!evidence.cleanup.rootRemoved) {
      evidence.cleanup.status = 'incomplete'
      evidence.cleanup.retainedRoot = root
      evidence.cleanup.error ??= unsettled ?? 'Temporary root removal was not confirmed'
      if (unsettled && runnerPid) evidence.cleanup.runnerPid = runnerPid
      if (!['pass', 'incomplete-proof'].includes(evidence.classification))
        evidence.firstFailure = evidence.classification
      evidence.classification = 'incomplete-proof'
      evidence.detail ??= 'temporary roots or owned processes were not fully cleaned up'
    }
    if (process.env.HOLI_CODEX_EVIDENCE) {
      try {
        await mkdir(resolve(process.env.HOLI_CODEX_EVIDENCE, '..'), { recursive: true })
        await writeFile(process.env.HOLI_CODEX_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`)
      } catch (error) {
        evidence.classification = 'incomplete-proof'
        evidence.detail ??= `could not persist producer evidence: ${String(error)}`
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const result = await runProducerProof()
  process.stdout.write(`${JSON.stringify(result.evidence, null, 2)}\n`)
  process.exitCode = result.failed ? 1 : 0
}
