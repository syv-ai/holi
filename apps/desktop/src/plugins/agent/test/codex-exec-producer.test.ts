import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { spawnOwnedProgram } from '../../../main/plugin-api'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { codexProvider } from '../main/codex/index'
import { createJobs } from '../main/host/jobs'

const version = '0.169.0'
const bin = process.env.HOLI_CODEX_BIN
const roots: string[] = []
const servers: Server[] = []
const jobsList: ReturnType<typeof createJobs>[] = []
const bracketGateReleases: Array<() => void> = []
const nativePids: number[] = []
function persistProof() {
  const output = process.env.HOLI_CODEX_PROOF_OUTPUT
  if (!output) return
  mkdirSync(dirname(output), { recursive: true })
  const temporary = `${output}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(proof, null, 2)}\n`)
    renameSync(temporary, output)
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {}
  }
}
function beginScenario(name: string): ScenarioEvidence {
  const scenario: ScenarioEvidence = { name, stage: 'setup', status: 'pending' }
  proof.scenarios.push(scenario)
  persistProof()
  return scenario
}
function progress(scenario: ScenarioEvidence, stage: Stage) {
  scenario.stage = stage
  persistProof()
}
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}
function finishScenario(scenario: ScenarioEvidence, status: Status, error?: unknown) {
  scenario.status = status
  if (error !== undefined) {
    const message = errorMessage(error)
    scenario.failure = message
    scenario.failureKind = /timeout|timed out|did not settle|not observed/i.test(message)
      ? 'timeout'
      : scenario.stage === 'setup' || scenario.stage === 'native-launch'
        ? 'setup'
        : 'contract'
  }
  persistProof()
}
function captureScenarioFailure(title: string, error: unknown) {
  const names: Record<string, string> = {
    'consumes the pinned CLI version and native initial-turn events': 'initial-turn',
    'resumes the native thread and reports the cumulative usage total': 'follow-up',
    'marks a genuine model error failed, never completed': 'http-400',
    'stops a stalled native run and drains its state and process': 'stall-stop',
    'leave drains a stalled native run and clears all job sessions': 'stall-leave',
  }
  const scenario = proof.scenarios.find((row) => row.name === names[title])
  if (
    !scenario ||
    (scenario.status !== 'pending' &&
      !(
        scenario.status === 'unverified' &&
        scenario.failure === 'native evidence was not fully captured'
      ))
  )
    return
  const rawProcesses = Array.isArray(scenario.rawProcesses) ? scenario.rawProcesses : []
  const credibleEvidence = rawProcesses.length > 0
  const outputLimited = rawProcesses.some((process) => process.outputLimited === true)
  const message = errorMessage(error)
  const isTimeout = /timeout|timed out|did not settle|not observed/i.test(message)
  const status = isTimeout || outputLimited || !credibleEvidence ? 'unverified' : 'mismatch'
  const previousFailure = scenario.failure
  finishScenario(scenario, status, error)
  if (previousFailure && previousFailure !== 'native evidence was not fully captured') {
    scenario.failure = `${scenario.failure}; teardown: ${previousFailure}`
  }
}
type Stage = 'setup' | 'native-launch' | 'native-contract' | 'host-lifecycle' | 'cleanup'
type Status = 'pending' | 'pass' | 'unverified' | 'mismatch'
type ScenarioEvidence = {
  name: string
  stage: Stage
  status: Status
  failureKind?: 'setup' | 'timeout' | 'contract'
  failure?: string
  [key: string]: unknown
}
const proof = {
  schema: 'holi.codex-exec-producer.v1',
  package: '@openai/codex',
  expectedVersion: version,
  version: null as string | null,
  bin: bin ?? null,
  scenarios: [] as ScenarioEvidence[],
  cleanup: { nativeGroupsDrained: false, rootsRemoved: false },
}
async function fixture(mode: 'success' | 'failure' | 'stall' = 'success', delayBracketEnd = false) {
  if (!bin) throw new Error('HOLI_CODEX_BIN is required for native producer verification')
  const root = await mkdtemp(join(tmpdir(), 'holi-native-codex-'))
  roots.push(root)
  const home = join(root, 'home')
  const person = join(root, 'person')
  const xdg = join(root, 'xdg')
  const work = join(root, 'vault')
  const state = join(root, 'state')
  for (const path of [home, person, xdg, work, state]) await mkdir(path, { recursive: true })
  const requests: Array<{ url: string; model: string; body: string }> = []
  const processes: Array<{
    pid: number
    bin: string
    args: string[]
    cwd: string
    codeHome?: string
  }> = []
  const jsonl: Array<{ line: string; event: unknown }> = []
  const rawProcesses: Array<Record<string, unknown>> = []
  const host: Array<{
    id: string
    outcome?: string
    message?: string
    error?: string
    tokens?: number
  }> = []
  const brackets: Array<{ id: string; edge: string }> = []
  const bracketEndEntries: Array<{ promise: Promise<void>; resolve: () => void }> = []
  const bracketEndGates: Array<{ promise: Promise<void>; resolve: () => void }> = []
  for (let i = 0; i < 2; i++) {
    let entered!: () => void
    let release!: () => void
    bracketEndEntries.push({
      promise: new Promise<void>((resolve) => (entered = resolve)),
      resolve: entered,
    })
    bracketEndGates.push({
      promise: new Promise<void>((resolve) => (release = resolve)),
      resolve: release,
    })
  }
  let bracketEndCount = 0
  const releaseBracketEnd = (turn = 1) => bracketEndGates[turn - 1]?.resolve()
  if (delayBracketEnd) {
    bracketGateReleases.push(() => {
      for (const gate of bracketEndGates) gate.resolve()
    })
  }
  let requestSeen: (() => void) | undefined
  const requestReceived = new Promise<void>((resolve) => {
    requestSeen = resolve
  })
  let releaseStall: (() => void) | undefined
  const stalled = new Promise<void>((resolve) => (releaseStall = resolve))
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      res.writeHead(400)
      res.end('{"error":"unexpected method or path"}')
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1024 * 1024) {
        res.destroy()
        return
      }
      chunks.push(Buffer.from(chunk))
    }
    let bodyText: string
    let body: { model: string }
    try {
      let bytes = Buffer.concat(chunks)
      if (req.headers['content-encoding'] === 'gzip')
        bytes = gunzipSync(bytes, { maxOutputLength: 1024 * 1024 })
      else if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
        throw new Error('unsupported content encoding')
      if (bytes.length > 1024 * 1024) throw new Error('oversized request')
      bodyText = bytes.toString()
      body = JSON.parse(bodyText) as { model: string }
    } catch {
      res.writeHead(400)
      res.end('{"error":"invalid or oversized JSON body"}')
      return
    }
    requests.push({ url: req.url ?? '', model: body.model, body: bodyText })
    requestSeen?.()
    if (mode === 'stall') {
      await stalled
      return
    }
    if (mode === 'failure') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fixture rejected request' } }))
      return
    }
    const model = body.model
    const msg = {
      id: 'msg_fixture',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'native fixture answer', annotations: [] }],
    }
    const response = {
      id: 'resp_fixture',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model,
      output: [msg],
      usage: {
        input_tokens: 9,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 4,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 13,
      },
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...msg, status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added',
        item_id: msg.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: msg.id,
        output_index: 0,
        content_index: 0,
        delta: 'native fixture answer',
      },
      {
        type: 'response.output_text.done',
        item_id: msg.id,
        output_index: 0,
        content_index: 0,
        text: 'native fixture answer',
      },
      { type: 'response.output_item.done', output_index: 0, item: msg },
      { type: 'response.completed', response },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  server.requestTimeout = 15_000
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind')
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    CODEX_HOME: person,
    XDG_CONFIG_HOME: xdg,
    TMPDIR: join(root, 'tmp'),
    OPENAI_API_KEY: 'synthetic-fixture-key',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
  }
  await mkdir(env.TMPDIR!, { recursive: true })
  await writeFile(
    join(person, 'config.toml'),
    `model = "gpt-5.1-codex-mini"\nmodel_provider = "holi-fixture"\n[model_providers.holi-fixture]\nname = "Holi fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
  )
  const provider = codexProvider({ resolveBin: () => bin!, base: env })
  const actualEvent = provider.capabilities.jobs.event
  provider.capabilities.jobs.event = (line) => {
    const event = actualEvent(line)
    if (event) jsonl.push({ line: line.slice(0, 16_384), event })
    return event
  }
  const jobs = createJobs({
    vault: { remote: 'fixture/vault', root: work },
    scratchRoot: state,
    onChange: (rows) => {
      for (const row of rows)
        host.push({
          id: row.id,
          outcome: row.outcome,
          message: row.message,
          error: row.error,
          tokens: row.usage?.total,
        })
    },
    bracket: async (id, edge) => {
      if (delayBracketEnd && edge === 'end') {
        const turn = ++bracketEndCount
        bracketEndEntries[turn - 1]?.resolve()
        await bracketEndGates[turn - 1]?.promise
      }
      brackets.push({ id, edge })
    },
    spawn: (command, args, opts) => {
      const child = spawnOwnedProgram(command, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
      if (child.pid) {
        const processRecord: Record<string, unknown> = {
          pid: child.pid,
          bin: command,
          args: [...args],
          cwd: opts.cwd,
          codeHome: opts.env.CODEX_HOME,
          stdout: '',
          stderr: '',
          stdoutBytes: 0,
          stderrBytes: 0,
          outputLimited: false,
          lineLimit: 2000,
          byteLimit: 262144,
          exitCode: null,
          signal: null,
        }
        processes.push({
          pid: child.pid,
          bin: command,
          args: [...args],
          cwd: opts.cwd,
          codeHome: opts.env.CODEX_HOME,
        })
        rawProcesses.push(processRecord)
        nativePids.push(child.pid)
        const ledger = process.env.HOLI_CODEX_PROCESS_LEDGER
        if (ledger) {
          mkdirSync(dirname(ledger), { recursive: true })
          appendFileSync(
            ledger,
            `${JSON.stringify({ pid: child.pid, group: process.platform === 'win32' ? child.pid : -child.pid, bin: command, cwd: opts.cwd, ownedRoot: root })}\n`,
          )
        }
        let rawBytes = 0
        let rawLines = 0
        let lineCarry = ''
        const capture = (chunk: Buffer, target: 'stdout' | 'stderr') => {
          const current = Number(processRecord[`${target}Bytes`])
          const allowed = Math.max(0, Math.min(chunk.length, 262144 - rawBytes))
          const text = chunk.subarray(0, allowed).toString('utf8')
          processRecord[target] = `${String(processRecord[target])}${text}`
          processRecord[`${target}Bytes`] = current + chunk.length
          rawBytes += chunk.length
          const all = lineCarry + text
          const lines = all.split('\n')
          lineCarry = lines.pop() ?? ''
          rawLines += lines.length
          if (rawLines > 2000 || allowed < chunk.length) {
            processRecord.outputLimited = true
            try {
              child.kill('SIGTERM')
            } catch {}
          }
        }
        child.stdout?.on('data', (chunk: Buffer) => capture(chunk, 'stdout'))
        child.stderr?.on('data', (chunk: Buffer) => capture(chunk, 'stderr'))
        persistProof()
        child.once('close', (code, signal) => {
          processRecord.exitCode = code
          processRecord.signal = signal
          processRecord.outputLines = rawLines
          processRecord.finalLine = lineCarry.slice(0, 4096)
          persistProof()
        })
      }
      return child
    },
    maxMs: 30_000,
    killGraceMs: 100,
    log: () => {},
  })
  jobsList.push(jobs)
  return {
    root,
    work,
    state,
    env,
    provider,
    jobs,
    requests,
    processes,
    jsonl,
    rawProcesses,
    host,
    brackets,
    requestReceived,
    bracketEndEntered: (turn = 1) => bracketEndEntries[turn - 1]!.promise,
    releaseBracketEnd,
    stopServer: () => releaseStall?.(),
  }
}

async function nativeVersion(
  env: NodeJS.ProcessEnv,
  scenario: ScenarioEvidence,
  ownedRoot: string,
) {
  const cwd = process.cwd()
  const child = spawn(bin!, ['--version'], {
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const record: Record<string, unknown> = {
    pid: child.pid ?? null,
    bin,
    args: ['--version'],
    cwd,
    codeHome: env.CODEX_HOME,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    outputLimited: false,
  }
  scenario.versionProcess = record
  if (child.pid) {
    nativePids.push(child.pid)
    const ledger = process.env.HOLI_CODEX_PROCESS_LEDGER
    if (ledger) {
      mkdirSync(dirname(ledger), { recursive: true })
      appendFileSync(
        ledger,
        `${JSON.stringify({ pid: child.pid, group: process.platform === 'win32' ? child.pid : -child.pid, bin, cwd, ownedRoot })}\n`,
      )
    }
  }
  let stdout = '',
    stderr = '',
    timedOut = false,
    limited = false
  let escalation: ReturnType<typeof setTimeout> | undefined
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid) {
      try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal)
      } catch {}
    }
  }
  let versionBytes = 0
  const collect = (chunk: Buffer, target: 'out' | 'err') => {
    const text = chunk.toString()
    if (target === 'out') stdout = `${stdout}${text}`.slice(0, 8192)
    else stderr = `${stderr}${text}`.slice(0, 8192)
    versionBytes += chunk.length
    record[target === 'out' ? 'stdout' : 'stderr'] = target === 'out' ? stdout : stderr
    if (versionBytes > 8192) {
      record.outputLimited = true
      limited = true
      killGroup('SIGTERM')
    }
  }
  child.stdout.on('data', (chunk) => collect(chunk, 'out'))
  child.stderr.on('data', (chunk) => collect(chunk, 'err'))
  const timeout = setTimeout(() => {
    timedOut = true
    killGroup('SIGTERM')
    escalation = setTimeout(() => killGroup('SIGKILL'), 250)
  }, 10_000)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => {
      record.exitCode = exitCode
      record.signal = signal
      persistProof()
      resolve(exitCode)
    })
  }).finally(() => {
    clearTimeout(timeout)
    if (escalation) clearTimeout(escalation)
  })
  let groupDrained = true
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      try {
        process.kill(-child.pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 25))
      } catch {
        break
      }
    }
    try {
      process.kill(-child.pid, 0)
      groupDrained = false
    } catch {}
  }
  return { code, stdout, timedOut, limited, groupDrained }
}

async function ended(
  jobs: ReturnType<typeof createJobs>,
  id: string,
  brackets: Array<{ id: string; edge: string }>,
  expectedEnds = 1,
) {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const row = jobs.sessions().find((session) => session.id === id)
    const completedEnds = brackets.filter(
      (bracket) => bracket.id === id && bracket.edge === 'end',
    ).length
    if (row?.outcome && completedEnds >= expectedEnds) return row
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('native job did not settle')
}

afterEach(async () => {
  // Unblock bracket persistence before draining jobs, even when an assertion or
  // native call failed while a turn was held at the test gate.
  for (const release of bracketGateReleases.splice(0)) release()
  // Vitest runs afterEach before onTestFailed. Clean up first; the callback
  // replaces incomplete-capture fallback evidence with the actual failure.
  for (const jobs of jobsList.splice(0)) await jobs.leave()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  let rootsRemoved = true
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true })
    } catch {
      rootsRemoved = false
    }
  }
  proof.cleanup.rootsRemoved = rootsRemoved
  for (const scenario of proof.scenarios) {
    if (scenario.status === 'pending') {
      scenario.status = 'unverified'
      scenario.failureKind = 'setup'
      scenario.failure ??= 'native evidence was not fully captured'
    }
  }
  proof.cleanup.nativeGroupsDrained = nativePids.every((pid) => {
    try {
      process.kill(-pid, 0)
      return false
    } catch {
      return true
    }
  })
  persistProof()
})

if (bin) {
  describe('native Codex exec producer → real jobs host', () => {
    it('consumes the pinned CLI version and native initial-turn events', async () => {
      const scenario = beginScenario('initial-turn')
      onTestFailed(({ task }) => captureScenarioFailure(task.name, task.result?.errors?.[0]))
      const f = await fixture()
      scenario.processes = f.processes
      scenario.rawProcesses = f.rawProcesses
      scenario.jsonl = f.jsonl
      scenario.requests = f.requests
      scenario.host = f.host
      scenario.brackets = f.brackets
      progress(scenario, 'native-launch')
      const versionResult = await nativeVersion(f.env, scenario, f.root)
      progress(scenario, 'native-contract')
      expect(versionResult.timedOut).toBe(false)
      expect(versionResult.limited).toBe(false)
      expect(versionResult.groupDrained).toBe(true)
      expect(versionResult.code).toBe(0)
      expect(versionResult.stdout.trim()).toBe(`codex-cli ${version}`)
      proof.version = versionResult.stdout.trim()
      progress(scenario, 'host-lifecycle')
      const result = await f.jobs.start({
        provider: f.provider,
        name: 'native proof',
        prompt: 'Return a short response',
        allow: [],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const row = await ended(f.jobs, result.sessionId, f.brackets)
      expect(row.outcome).toBe('completed')
      expect(row.usage?.total).toBe(13)
      expect(f.requests).toHaveLength(1)
      expect(f.requests[0]?.url).toBe('/v1/responses')
      expect(f.requests[0]?.body).toContain('Return a short response')
      expect(
        f.jsonl.some(
          ({ event }) =>
            (event as { kind?: string; tokens?: number }).kind === 'turn-completed' &&
            (event as { tokens?: number }).tokens === 13,
        ),
      ).toBe(true)
      expect(
        f.host.some(
          (event) =>
            event.id === result.sessionId && event.outcome === 'completed' && event.tokens === 13,
        ),
      ).toBe(true)
      expect(f.brackets.map((entry) => entry.edge)).toEqual(['begin', 'end'])
      Object.assign(scenario, {
        sessionId: result.sessionId,
        outcome: row.outcome,
        tokens: row.usage?.total,
        requests: f.requests.map(({ url, model, body }) => ({
          url,
          model,
          promptSeen: body.includes('Return a short response'),
        })),
        processes: f.processes,
        jsonl: f.jsonl,
        host: f.host,
        brackets: f.brackets,
      })
      if (process.env.HOLI_CODEX_TEST_FAILURE === 'initial-turn-timeout') {
        throw new Error('native job timed out')
      }
      finishScenario(scenario, 'pass')
    }, 35_000)

    it('resumes the native thread and reports the cumulative usage total', async () => {
      const scenario = beginScenario('follow-up')
      onTestFailed(({ task }) => captureScenarioFailure(task.name, task.result?.errors?.[0]))
      const f = await fixture('success', true)
      scenario.processes = f.processes
      scenario.rawProcesses = f.rawProcesses
      scenario.jsonl = f.jsonl
      scenario.requests = f.requests
      scenario.host = f.host
      scenario.brackets = f.brackets
      progress(scenario, 'native-launch')
      const result = await f.jobs.start({
        provider: f.provider,
        name: 'resume proof',
        prompt: 'First',
        allow: [],
      })
      progress(scenario, 'native-contract')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      progress(scenario, 'host-lifecycle')
      let pendingCompletion: Promise<Awaited<ReturnType<typeof ended>>> | undefined
      try {
        let firstEntryTimeout: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            f.bracketEndEntered(1),
            new Promise<never>((_, reject) => {
              firstEntryTimeout = setTimeout(
                () => reject(new Error('first bracket end was not entered')),
                15_000,
              )
            }),
          ])
        } finally {
          if (firstEntryTimeout) clearTimeout(firstEntryTimeout)
        }
        pendingCompletion = ended(f.jobs, result.sessionId, f.brackets, 1)
        let firstCompleted = false
        void pendingCompletion.then(
          () => (firstCompleted = true),
          () => {},
        )
        expect(f.jobs.sessions().find((session) => session.id === result.sessionId)?.outcome).toBe(
          'completed',
        )
        await Promise.resolve()
        expect(firstCompleted).toBe(false)
        f.releaseBracketEnd(1)
        const first = await pendingCompletion
        expect(first.outcome).toBe('completed')
        const firstThread = f.jsonl
          .map(({ event }) => event as { kind?: string; id?: string })
          .find((event) => event.kind === 'thread')?.id
        expect(firstThread).toBeTruthy()
        f.jobs.message(result.sessionId, 'Follow up')
        let secondEntryTimeout: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            f.bracketEndEntered(2),
            new Promise<never>((_, reject) => {
              secondEntryTimeout = setTimeout(
                () => reject(new Error('second bracket end was not entered')),
                15_000,
              )
            }),
          ])
        } finally {
          if (secondEntryTimeout) clearTimeout(secondEntryTimeout)
        }
        pendingCompletion = ended(f.jobs, result.sessionId, f.brackets, 2)
        let secondCompleted = false
        void pendingCompletion.then(
          () => (secondCompleted = true),
          () => {},
        )
        await Promise.resolve()
        expect(secondCompleted).toBe(false)
        f.releaseBracketEnd(2)
        const row = await pendingCompletion
        expect(row.outcome).toBe('completed')
        expect(row.usage?.total).toBe(26)
        expect(f.requests).toHaveLength(2)
        expect(f.requests[1]?.body).toContain('Follow up')
        expect(f.processes[1]?.args.join(' ')).toContain(firstThread!)
        expect(
          f.jsonl
            .filter(({ event }) => (event as { kind?: string }).kind === 'thread')
            .every(({ event }) => (event as { id?: string }).id === firstThread),
        ).toBe(true)
        expect(
          f.host.some(
            (event) =>
              event.id === result.sessionId && event.outcome === 'completed' && event.tokens === 26,
          ),
        ).toBe(true)
        expect(f.brackets.map((entry) => entry.edge)).toEqual(['begin', 'end', 'begin', 'end'])
        Object.assign(scenario, {
          sessionId: result.sessionId,
          thread: firstThread,
          outcome: row.outcome,
          tokens: row.usage?.total,
          requests: f.requests.map(({ url, model, body }) => ({
            url,
            model,
            promptSeen: body.includes('Follow up'),
          })),
          processes: f.processes,
          jsonl: f.jsonl,
          host: f.host,
          brackets: f.brackets,
        })
        finishScenario(scenario, 'pass')
      } finally {
        f.releaseBracketEnd(1)
        f.releaseBracketEnd(2)
        await pendingCompletion?.catch(() => {})
      }
    }, 55_000)

    it('marks a genuine model error failed, never completed', async () => {
      const scenario = beginScenario('http-400')
      onTestFailed(({ task }) => captureScenarioFailure(task.name, task.result?.errors?.[0]))
      const f = await fixture('failure')
      scenario.processes = f.processes
      scenario.rawProcesses = f.rawProcesses
      scenario.jsonl = f.jsonl
      scenario.requests = f.requests
      scenario.host = f.host
      scenario.brackets = f.brackets
      progress(scenario, 'native-launch')
      const result = await f.jobs.start({
        provider: f.provider,
        name: 'failure proof',
        prompt: 'Fail',
        allow: [],
      })
      progress(scenario, 'native-contract')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      progress(scenario, 'host-lifecycle')
      const row = await ended(f.jobs, result.sessionId, f.brackets)
      expect(row.outcome).toBe('failed')
      expect(row.outcome).not.toBe('completed')
      expect(row.error).toContain('fixture rejected request')
      expect(
        f.host.some((event) => event.id === result.sessionId && event.outcome === 'failed'),
      ).toBe(true)
      expect(f.requests).toHaveLength(1)
      Object.assign(scenario, {
        sessionId: result.sessionId,
        outcome: row.outcome,
        error: row.error,
        requests: f.requests.map(({ url, model }) => ({ url, model })),
        processes: f.processes,
        jsonl: f.jsonl,
        host: f.host,
        brackets: f.brackets,
      })
      finishScenario(scenario, 'pass')
    }, 35_000)

    it('stops a stalled native run and drains its state and process', async () => {
      const scenario = beginScenario('stall-stop')
      onTestFailed(({ task }) => captureScenarioFailure(task.name, task.result?.errors?.[0]))
      const f = await fixture('stall')
      scenario.processes = f.processes
      scenario.rawProcesses = f.rawProcesses
      scenario.jsonl = f.jsonl
      scenario.requests = f.requests
      scenario.host = f.host
      scenario.brackets = f.brackets
      progress(scenario, 'native-launch')
      const result = await f.jobs.start({
        provider: f.provider,
        name: 'stop proof',
        prompt: 'Wait',
        allow: [],
      })
      progress(scenario, 'native-contract')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      progress(scenario, 'host-lifecycle')
      await Promise.race([
        f.requestReceived,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('native request was not observed')), 15_000),
        ),
      ])
      expect(await f.jobs.stop(result.sessionId)).toEqual({ ok: true })
      const stopped = await ended(f.jobs, result.sessionId, f.brackets)
      expect(stopped.outcome).toBe('failed')
      expect(stopped.error).toContain('Stopped')
      expect(
        f.host.some((event) => event.id === result.sessionId && event.outcome === 'failed'),
      ).toBe(true)
      f.stopServer()
      expect(f.jobs.sessions()).toHaveLength(1)
      expect(await f.jobs.stop(result.sessionId)).toEqual({ ok: true })
      expect(f.jobs.sessions()).toHaveLength(0)
      Object.assign(scenario, {
        sessionId: result.sessionId,
        outcome: stopped.outcome,
        error: stopped.error,
        requests: f.requests.map(({ url, model }) => ({ url, model })),
        processes: f.processes,
        host: f.host,
        brackets: f.brackets,
      })
      finishScenario(scenario, 'pass')
    }, 35_000)

    it('leave drains a stalled native run and clears all job sessions', async () => {
      const scenario = beginScenario('stall-leave')
      onTestFailed(({ task }) => captureScenarioFailure(task.name, task.result?.errors?.[0]))
      const f = await fixture('stall')
      scenario.processes = f.processes
      scenario.rawProcesses = f.rawProcesses
      scenario.jsonl = f.jsonl
      scenario.requests = f.requests
      scenario.host = f.host
      scenario.brackets = f.brackets
      progress(scenario, 'native-launch')
      const result = await f.jobs.start({
        provider: f.provider,
        name: 'leave proof',
        prompt: 'Wait',
        allow: [],
      })
      progress(scenario, 'native-contract')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      progress(scenario, 'host-lifecycle')
      await Promise.race([
        f.requestReceived,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('native request was not observed')), 15_000),
        ),
      ])
      await f.jobs.leave()
      f.stopServer()
      expect(f.jobs.sessions()).toHaveLength(0)
      expect(f.jobs.has(result.sessionId)).toBe(false)
      Object.assign(scenario, {
        sessionId: result.sessionId,
        outcome: 'left',
        sessionsAfterLeave: f.jobs.sessions().length,
        hasAfterLeave: f.jobs.has(result.sessionId),
        requests: f.requests.map(({ url, model }) => ({ url, model })),
        processes: f.processes,
        host: f.host,
        brackets: f.brackets,
      })
      finishScenario(scenario, 'pass')
    }, 35_000)
  })
} else {
  describe.skip('native Codex exec producer → real jobs host (HOLI_CODEX_BIN unset)', () => {
    it('requires the native CLI', () => {})
  })
}
