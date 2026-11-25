import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { producerCommandFailure, runProducerCommand } from './producer-command.mjs'
import { reviewedCodexTuiRelease, verifyCodexTuiProvenance } from './codex-tui-provenance.mjs'

const names = ['success', 'approval-cancel', 'closed-session-notify', 'leave-isolation']
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Read the worker's bounded, nonce-bound evidence and final settlement protocol. */
export function inspectCodexTuiEvidence(bytes, receipt, identity) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 4 * 1024 * 1024)
    throw new Error('Native evidence size exceeded')
  const proof = JSON.parse(bytes)
  if (
    proof.schema !== 'holi.codex-tui-producer.v1' ||
    proof.runId !== identity.runId ||
    proof.nonce !== identity.nonce ||
    !Number.isSafeInteger(proof.workerPid) ||
    proof.workerPid <= 1
  )
    throw new Error('Native worker identity mismatch')
  const scenarios = Array.isArray(proof.scenarios) ? proof.scenarios : []
  const contexts = scenarios.flatMap((scenario) =>
    Array.isArray(scenario.contexts) ? scenario.contexts : [],
  )
  const native = contexts.flatMap((context) =>
    Array.isArray(context.native) ? context.native : [],
  )
  const settled =
    Array.isArray(proof.owners) &&
    proof.owners.every((owner) => owner.removed === true && owner.nativeDrained === true) &&
    receipt?.settled === true &&
    receipt.runId === identity.runId &&
    receipt.nonce === identity.nonce &&
    receipt.workerPid === proof.workerPid &&
    receipt.sha256 === digest(bytes) &&
    proof.cleanup?.bridgeClosed === true &&
    proof.cleanup?.contextsRemoved === true &&
    proof.cleanup?.nativeDrained === true &&
    contexts.every((context) => context.removed === true) &&
    native.every(
      (entry) =>
        entry.receipt?.drained === true &&
        ['supervisorPid', 'anchorPid', 'nativePid'].every(
          (key) => Number.isSafeInteger(entry.receipt[key]) && entry.receipt[key] > 1,
        ),
    )
  const complete =
    settled &&
    proof.classification === 'pass' &&
    scenarios.length === names.length &&
    names.every(
      (name, index) =>
        scenarios[index]?.name === name &&
        scenarios[index].status === 'pass' &&
        scenarios[index].contexts.length === (index < 2 ? 1 : 2),
    ) &&
    native.length === 6 &&
    native.every((entry) => {
      const raw = Buffer.from(entry.rawBase64 ?? '', 'base64')
      return (
        !entry.failure &&
        raw.length > 0 &&
        raw.length <= 262144 &&
        digest(raw) === entry.sha256 &&
        Array.isArray(entry.argv) &&
        entry.argv.includes('--no-daemon') &&
        Array.isArray(entry.inputs) &&
        entry.inputs.every(({ hex }) =>
          ['1b5b313b3152', '1b5b3f3075', '1b5b3f313b3263', '1b'].includes(hex),
        )
      )
    }) &&
    scenarios.every((scenario) =>
      scenario.contexts.every(
        (context) => Array.isArray(context.requests) && context.requests.length > 0,
      ),
    ) &&
    scenarios[0].contexts[0].consumed?.some(
      (event) =>
        event.kind === 'turn' &&
        event.after?.some((row) => row.state === 'idle' && row.conversationId),
    ) &&
    scenarios[1].contexts[0].changes?.some((rows) =>
      rows.some((row) => row.state === 'needs-you'),
    ) &&
    scenarios[1].contexts[0].native[0].inputs.some(({ hex }) => hex === '1b')
  return { proof, native, settled, complete }
}

/** Own the pinned installation, bounded native worker and evidence-preserving cleanup. */
export async function runCodexTuiProducer({
  npm = 'npm',
  pnpm = 'pnpm',
  timeout = 300_000,
  adapter,
  evidencePath = process.env.HOLI_CODEX_TUI_EVIDENCE,
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holi-codex-tui-proof-')))
  const artifact = resolve(
    evidencePath ??
      join(await mkdtemp(join(tmpdir(), 'holi-codex-tui-evidence-')), 'evidence.json'),
  )
  const identity = { runId: randomUUID(), nonce: randomUUID() }
  const evidence = {
    ...reviewedCodexTuiRelease,
    classification: 'setup-unavailable',
    provenance: null,
    native: null,
    cleanup: { rootRemoved: false, processesDrained: true },
    artifact,
  }
  const result = {
    get failed() {
      return evidence.classification !== 'pass'
    },
    evidence,
  }
  const deadline = Date.now() + timeout
  let unsettled
  let stage = 'setup'
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    CODEX_HOME: join(root, 'empty-codex'),
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    COREPACK_HOME: join(root, 'corepack'),
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_userconfig: join(root, 'npmrc'),
    npm_config_globalconfig: join(root, 'global-npmrc'),
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  }
  const run = async (command, args, limit, extra = {}, worker = false) => {
    unsettled = 'Runner settlement missing'
    const value = await runProducerCommand(command, args, {
      cwd: worker ? resolve(import.meta.dirname, '..') : root,
      env: { ...env, ...extra },
      timeout: Math.min(limit, deadline - Date.now()),
      maxOutput: 1_048_576,
      adapter,
    })
    unsettled =
      value.cleanupError ??
      (worker && !value.notStarted ? 'Native worker settlement missing' : undefined)
    return value
  }
  try {
    if (process.platform !== 'darwin')
      throw new Error('Native TUI containment requires macOS Seatbelt')
    for (const directory of [
      env.HOME,
      env.CODEX_HOME,
      env.TMPDIR,
      env.COREPACK_HOME,
      env.npm_config_cache,
    ])
      await mkdir(directory, { mode: 0o700 })
    await writeFile(env.npm_config_userconfig, '', { mode: 0o600 })
    await writeFile(env.npm_config_globalconfig, '', { mode: 0o600 })
    await writeFile(
      join(env.COREPACK_HOME, 'lastKnownGood.json'),
      JSON.stringify({ pnpm: '10.8.1' }),
    )
    const installation = join(root, 'install')
    const installed = await run(
      npm,
      [
        'install',
        '--prefix',
        installation,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        `${reviewedCodexTuiRelease.package}@${reviewedCodexTuiRelease.version}`,
      ],
      60_000,
    )
    const installFailure = producerCommandFailure(installed, 'Pinned TUI installation')
    if (installFailure || unsettled) {
      evidence.detail = installFailure ?? unsettled
      evidence.diagnostics = installed.stderr
      return result
    }
    stage = 'provenance'
    evidence.provenance = verifyCodexTuiProvenance(installation)
    for (const [label, args] of [
      ['sourceHead', ['rev-parse', 'HEAD']],
      ['sourceDirty', ['status', '--porcelain']],
    ]) {
      const source = await runProducerCommand('git', args, {
        cwd: resolve(import.meta.dirname, '..'),
        env,
        timeout: Math.min(5000, deadline - Date.now()),
        maxOutput: 8192,
        adapter,
      })
      unsettled = source.cleanupError
      if (producerCommandFailure(source, 'Source provenance') || unsettled)
        throw new Error('Source provenance unavailable')
      evidence[label] = source.stdout.trim()
    }
    if (evidence.sourceDirty)
      throw new Error('Native acceptance requires a committed, clean source tree')
    const versionPolicy = join(root, 'version.sb')
    await writeFile(
      versionPolicy,
      `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))`,
    )
    const version = await run(
      '/usr/bin/sandbox-exec',
      ['-f', versionPolicy, evidence.provenance.executable, '--version'],
      10_000,
    )
    evidence.observedVersion = version.stdout.trim()
    if (
      producerCommandFailure(version, 'Native version probe') ||
      unsettled ||
      evidence.observedVersion !== `codex-cli ${reviewedCodexTuiRelease.version}`
    )
      throw new Error(
        `Unexpected native version probe: ${evidence.observedVersion}; ${version.stderr}`,
      )
    stage = 'native'
    const proofPath = join(root, 'native-evidence.json')
    const worker = await run(
      pnpm,
      [
        '--filter',
        '@holi/desktop',
        'exec',
        'vitest',
        'run',
        'src/plugins/agent/test/codex-tui-producer.test.ts',
        '--project',
        'node',
        '--reporter=verbose',
      ],
      170_000,
      {
        HOLI_CODEX_TUI_ROOT: root,
        HOLI_CODEX_TUI_BIN: evidence.provenance.executable,
        HOLI_CODEX_TUI_PROOF_OUTPUT: proofPath,
        HOLI_CODEX_TUI_RUN_ID: identity.runId,
        HOLI_CODEX_TUI_NONCE: identity.nonce,
      },
      true,
    )
    evidence.worker = worker
    const stat = await lstat(proofPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
      throw new Error('Invalid native evidence file')
    const receiptPath = join(root, 'tui-settlement.json')
    const receiptStat = await lstat(receiptPath)
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > 8192)
      throw new Error('Invalid native settlement file')
    const bytes = await readFile(proofPath)
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    const inspected = inspectCodexTuiEvidence(bytes, receipt, identity)
    evidence.native = inspected.proof
    evidence.settlement = receipt
    const absent = (pid) => {
      try {
        process.kill(pid, 0)
        return false
      } catch (error) {
        return error.code === 'ESRCH'
      }
    }
    if (
      !worker.cleanupError &&
      inspected.settled &&
      inspected.native.every(
        ({ receipt: owned }) =>
          absent(owned.supervisorPid) && absent(-owned.anchorPid) && absent(owned.nativePid),
      )
    )
      unsettled = undefined
    const failure = producerCommandFailure(worker, 'Native TUI worker')
    evidence.classification =
      !unsettled && inspected.complete && !failure
        ? 'pass'
        : worker.timedOut || worker.outputLimited || unsettled
          ? 'incomplete-proof'
          : inspected.proof.classification === 'observed-contract-error'
            ? 'observed-contract-error'
            : 'incomplete-proof'
    evidence.detail =
      failure ??
      (inspected.complete
        ? undefined
        : (inspected.proof.error ?? 'Native consumer proof incomplete'))
  } catch (error) {
    evidence.detail = String(error)
    evidence.classification =
      stage === 'setup'
        ? 'setup-unavailable'
        : stage === 'provenance'
          ? 'observed-contract-error'
          : 'incomplete-proof'
  } finally {
    try {
      await mkdir(dirname(artifact), { recursive: true, mode: 0o700 })
      const parent = await realpath(dirname(artifact))
      const rel = relative(root, parent)
      if (!rel || (!rel.startsWith('..') && !isAbsolute(rel)))
        throw new Error('Evidence must be outside runtime root')
      await writeFile(artifact, JSON.stringify(evidence, null, 2), { mode: 0o600 })
    } catch (error) {
      unsettled ??= `Evidence persistence failed: ${error}`
    }
    evidence.cleanup.processesDrained = !unsettled
    if (!unsettled) {
      try {
        await rm(root, { recursive: true, force: true })
        evidence.cleanup.rootRemoved = true
      } catch (error) {
        unsettled = String(error)
      }
    }
    if (unsettled) {
      evidence.firstFailure = evidence.classification
      evidence.classification = 'incomplete-proof'
      evidence.cleanup.retainedRoot = root
      evidence.cleanup.error = unsettled
    }
    try {
      await writeFile(artifact, JSON.stringify(evidence, null, 2), { mode: 0o600 })
    } catch (error) {
      evidence.classification = 'incomplete-proof'
      evidence.detail = `Final evidence persistence failed: ${error}`
    }
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { failed, evidence } = await runCodexTuiProducer()
  console.log(
    JSON.stringify(
      {
        classification: evidence.classification,
        detail: evidence.detail,
        cleanup: evidence.cleanup,
        artifact: evidence.artifact,
      },
      null,
      2,
    ),
  )
  process.exitCode = failed ? 1 : 0
}
