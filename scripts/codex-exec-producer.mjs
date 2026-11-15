import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, lstat, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const VERSION = '0.169.0'
const MAX_OUTPUT = 2 * 1024 * 1024
const MAX_EVIDENCE = 1024 * 1024
const TOTAL_TIMEOUT = 180_000
const TEST_TIMEOUT = 100_000

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

function groupExists(pid) {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function cleanupGroup(pid) {
  if (process.platform === 'win32' || !pid || !groupExists(pid)) return true
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {}
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  if (groupExists(pid)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }
  return waitGroupGone(pid)
}

async function drainOwnedNativeGroups(packageRoot, ledgerPath, root) {
  if (process.platform === 'win32') return false
  const groups = new Set()
  const forbidden = new Set([process.pid, process.ppid])
  const normalizeMacPath = (path) => (path.startsWith('/var/') ? `/private${path}` : path)
  const packageRoots = new Set()
  const candidateRoots = [
    packageRoot,
    join(dirname(packageRoot), `codex-${process.platform}-${process.arch}`),
  ]
  for (const candidate of candidateRoots) {
    packageRoots.add(resolve(candidate))
    try {
      packageRoots.add(await realpath(candidate))
    } catch {}
  }
  for (const path of [...packageRoots]) packageRoots.add(normalizeMacPath(path))
  const isWithin = (path, parent) => path === parent || path.startsWith(`${parent}/`)
  // The ledger is only a recovery hint: PIDs may have been reused, and its
  // contents are not authority to signal a process. The live process snapshot
  // below is the sole source of killable process groups.
  void ledgerPath
  void root
  try {
    const { spawnSync } = await import('node:child_process')
    const scan = spawnSync('ps', ['-axo', 'pid=,pgid=,command='], {
      encoding: 'utf8',
      timeout: 1500,
      maxBuffer: 4 * 1024 * 1024,
    })
    if (scan.status !== 0 || scan.error || scan.stdout.length > 4 * 1024 * 1024) return false
    for (const line of scan.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
      if (!match) continue
      const pid = Number(match[1]),
        group = Number(match[2]),
        command = match[3]
      if (pid === process.pid || pid === process.ppid) forbidden.add(group)
      if (pid <= 1 || group <= 1 || forbidden.has(group)) continue
      const exactPath = command.split(/\s+/).some((part) => {
        const cleaned = normalizeMacPath(part.replace(/^['"]|['"]$/g, ''))
        const candidates = [cleaned]
        try {
          candidates.push(normalizeMacPath(resolve(cleaned)))
        } catch {}
        return candidates.some((path) =>
          [...packageRoots].some((base) => path === base || path.startsWith(`${base}/`)),
        )
      })
      if (exactPath) groups.add(group)
    }
  } catch {
    return false
  }
  for (const group of groups) {
    if (group <= 1 || forbidden.has(group)) continue
    try {
      process.kill(-group, 'SIGTERM')
    } catch {}
  }
  const drainDeadline = Date.now() + 12_000
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
  for (const group of groups) {
    if (group <= 1 || forbidden.has(group)) continue
    if (groupExists(group))
      try {
        process.kill(-group, 'SIGKILL')
      } catch {}
  }
  for (const group of groups) {
    if (group <= 1 || forbidden.has(group)) continue
    if (!(await waitGroupGone(group, Math.max(0, drainDeadline - Date.now())))) return false
  }
  return true
}

async function waitGroupGone(pid, ms = 2_000) {
  if (process.platform === 'win32' || !pid) return true
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!groupExists(pid)) return true
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  return !groupExists(pid)
}

async function run(command, args, { cwd, env, timeout, deadline, recoveryPackageRoot }) {
  const remaining = Math.min(timeout, deadline - Date.now())
  if (remaining <= 0)
    return {
      code: null,
      timedOut: true,
      outputLimited: false,
      stdout: '',
      stderr: '',
      groupDrained: true,
    }
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      outputBytes = 0,
      outputLimited = false,
      timedOut = false,
      finalized = false,
      escalator,
      finalizer
    const append = (stream, chunk) => {
      const room = Math.max(0, MAX_OUTPUT - outputBytes)
      const retained = chunk.subarray(0, room)
      outputBytes += retained.length
      if (stream === 'stdout') stdout = Buffer.concat([stdout, retained])
      else stderr = Buffer.concat([stderr, retained])
      if (retained.length < chunk.length && !outputLimited) {
        outputLimited = true
        terminate()
      }
    }
    child.stdout.on('data', (chunk) => append('stdout', chunk))
    child.stderr.on('data', (chunk) => append('stderr', chunk))
    const signal = (name) => {
      try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, name)
      } catch {}
    }
    const terminate = () => {
      signal('SIGTERM')
      if (!escalator) escalator = setTimeout(() => signal('SIGKILL'), 500)
      // A descendant can keep inherited pipes open after the process exits.
      if (!finalizer) finalizer = setTimeout(() => void finish(null, null, true), 750)
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, remaining)
    const finish = async (code, childSignal, force = false) => {
      if (finalized) return
      finalized = true
      clearTimeout(timer)
      if (finalizer) clearTimeout(finalizer)
      if (force) {
        signal('SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
      }
      const groupDrained = await cleanupGroup(child.pid)
      const ownedDrained =
        recoveryPackageRoot && process.platform !== 'win32'
          ? await drainOwnedNativeGroups(recoveryPackageRoot, '', cwd)
          : true
      if (escalator) clearTimeout(escalator)
      resolveRun({
        code,
        signal: childSignal,
        timedOut,
        outputLimited,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        groupDrained: groupDrained && ownedDrained,
      })
    }
    child.once('error', (error) => {
      append('stderr', Buffer.from(`\n${error.message}`))
      void finish(null, null)
    })
    child.once('close', (code, childSignal) => void finish(code, childSignal))
  })
}

export function validateNativeProof(proof, expectedBin) {
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
  const expected = ['initial-turn', 'follow-up', 'http-400', 'stall-stop', 'stall-leave']
  if (!Array.isArray(proof.scenarios) || proof.scenarios.length !== expected.length)
    return 'native evidence scenarios are incomplete'
  if (new Set(proof.scenarios.map((row) => row?.name)).size !== expected.length)
    return 'native evidence scenarios are duplicated'
  for (const name of expected) {
    const s = proof.scenarios.find((row) => row?.name === name)
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

export async function runProducerProof({
  npm = 'npm',
  pnpm = 'pnpm',
  timeout = TOTAL_TIMEOUT,
  testEnv = {},
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'holi-codex-exec-proof-'))
  const deadline = Date.now() + timeout
  const proofPath = join(root, 'native-evidence.json')
  const ledgerPath = join(root, 'native-processes.jsonl')
  let nativePackageRoot
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
    const installResult = await run(
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
      { cwd: root, env, timeout: Math.min(60_000, timeout), deadline },
    )
    evidence.cleanup.processesDrained = installResult.groupDrained
    if (
      installResult.code !== 0 ||
      installResult.timedOut ||
      installResult.outputLimited ||
      !installResult.groupDrained
    ) {
      evidence.detail = `pinned package installation ${installResult.timedOut ? 'timed out' : installResult.outputLimited ? 'exceeded output limit' : `exited ${installResult.code}`}`
      evidence.diagnostics = installResult.stderr.slice(-8000)
      evidence.classification =
        installResult.timedOut || installResult.outputLimited
          ? 'incomplete-proof'
          : 'setup-unavailable'
      return result
    }
    const packageRoot = join(install, 'node_modules', '@openai', 'codex')
    nativePackageRoot = packageRoot
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    evidence.packageVersion = manifest.version ?? null
    if (manifest.name !== '@openai/codex' || manifest.version !== VERSION) {
      evidence.classification = 'observed-contract-error'
      evidence.detail = `unexpected package provenance: ${manifest.name ?? 'unknown'}@${manifest.version ?? 'unknown'}`
      return result
    }
    const bin = join(packageRoot, 'bin', 'codex.js')
    const version = await run(process.execPath, [bin, '--version'], {
      cwd: root,
      env,
      recoveryPackageRoot: nativePackageRoot,
      timeout: 15_000,
      deadline,
    })
    evidence.cleanup.processesDrained = evidence.cleanup.processesDrained && version.groupDrained
    evidence.version = version.stdout.trim()
    if (version.timedOut || version.outputLimited || !version.groupDrained) {
      evidence.classification = 'incomplete-proof'
      evidence.detail = 'pinned CLI version probe did not finish and drain cleanly'
      evidence.diagnostics = version.stderr.slice(-8000)
      return result
    }
    if (version.code !== 0) {
      evidence.classification = 'setup-unavailable'
      evidence.detail = `pinned CLI version probe could not observe a version (exit ${version.code})`
      evidence.diagnostics = version.stderr.slice(-8000)
      return result
    }
    if (!new RegExp(`^codex-cli ${VERSION.replaceAll('.', '\\.')}\\s*$`).test(evidence.version)) {
      evidence.classification = 'observed-contract-error'
      evidence.detail = `expected exact codex-cli ${VERSION}`
      evidence.diagnostics = version.stderr.slice(-8000)
      return result
    }
    const test = await run(
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
        recoveryPackageRoot: nativePackageRoot,
        env: cleanEnvironment(home, {
          ...env,
          ...testEnv,
          HOLI_CODEX_BIN: bin,
          HOLI_CODEX_PROOF_OUTPUT: proofPath,
          HOLI_CODEX_PROCESS_LEDGER: ledgerPath,
        }),
        timeout: TEST_TIMEOUT,
        deadline,
      },
    )
    evidence.cleanup.processesDrained = evidence.cleanup.processesDrained && test.groupDrained
    evidence.test = {
      code: test.code,
      timedOut: test.timedOut,
      outputLimited: test.outputLimited,
      retainedBytes: Buffer.byteLength(test.stdout) + Buffer.byteLength(test.stderr),
      groupDrained: test.groupDrained,
      stdout: test.stdout.slice(-12000),
      stderr: test.stderr.slice(-8000),
    }
    let proof
    try {
      const stat = await (await import('node:fs/promises')).stat(proofPath)
      if (stat.size > MAX_EVIDENCE) throw new Error('native proof artifact exceeds size limit')
      proof = JSON.parse(await readFile(proofPath, 'utf8'))
    } catch (error) {
      evidence.classification = 'incomplete-proof'
      evidence.detail = `native evidence unavailable: ${String(error)}`
      return result
    }
    evidence.native = proof
    let issue
    try {
      issue = validateNativeProof(proof, bin)
    } catch {
      issue = 'native evidence is malformed'
    }
    const testsPassed =
      test.code === 0 &&
      !test.timedOut &&
      !test.outputLimited &&
      test.groupDrained &&
      /\b5 passed\b/.test(test.stdout) &&
      !/\b[1-9]\d* skipped\b/.test(test.stdout)
    const scenarios = Array.isArray(proof.scenarios) ? proof.scenarios : []
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
      !test.groupDrained ||
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
    if (issue) evidence.detail = issue
    else if (!testsPassed)
      evidence.detail = 'Vitest did not report five executed, non-skipped scenarios'
    return result
  } catch (error) {
    evidence.detail = String(error)
    evidence.classification = 'setup-unavailable'
    return result
  } finally {
    if (nativePackageRoot) {
      const nativeDrained = await drainOwnedNativeGroups(nativePackageRoot, ledgerPath, root)
      evidence.cleanup.processesDrained = evidence.cleanup.processesDrained && nativeDrained
    }
    if (evidence.cleanup.processesDrained) {
      await rm(root, { recursive: true, force: true }).catch((error) => {
        evidence.cleanup.error = String(error)
      })
    } else {
      evidence.cleanup.error ??= 'owned native process groups did not drain; retained private root'
    }
    try {
      await lstat(root)
      evidence.cleanup.rootRemoved = false
    } catch (error) {
      evidence.cleanup.rootRemoved = error.code === 'ENOENT'
      if (!evidence.cleanup.rootRemoved) evidence.cleanup.error = String(error)
    }
    if (!evidence.cleanup.rootRemoved || !evidence.cleanup.processesDrained) {
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
