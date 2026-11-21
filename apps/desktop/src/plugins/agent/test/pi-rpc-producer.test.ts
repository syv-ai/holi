import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process'

import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PiRpcRun, type PiRpcOptions } from '../main/pi/rpc'
import {
  inspectPosixOwnership,
  ownedProcessDrain,
  posixLaunchNonAdmission,
  spawnOwnedProgram,
} from '../../../main/plugin-api'

import {
  kernelGroupAbsent,
  posixFixtureLedger,
} from '../../../../test/fixtures/posix-fixture-ledger'

type PiChild = ReturnType<NonNullable<PiRpcOptions['spawn']>>

const { cacheLeaseProof, publishFinalSettlement, readFinalSettlement } = createRequire(
  import.meta.url,
)('../../../../../../scripts/producer-settlement.mjs') as {
  cacheLeaseProof(
    root: string,
    identity: { version: number; runId: string; nonce: string; workerPid: number },
    lease: { id: string; role: string },
    inspect: typeof inspectPosixOwnership,
  ): { id: string; role: string; proof: 'settled' | 'kernel-absence'; proofSha256: string }
  publishFinalSettlement(
    root: string,
    identity: { version: number; runId: string; nonce: string; workerPid: number },
    leases: readonly ReturnType<typeof cacheLeaseProof>[],
    evidenceName: string,
    bytes: string,
  ): Promise<void>
  readFinalSettlement(
    root: string,
    identity: { runId: string; nonce: string },
    roles: readonly string[],
    bytes: Buffer,
    requireComplete: boolean,
  ): false | { leases: ReturnType<typeof cacheLeaseProof>[] }
}

const maxEvidenceBytes = 64 * 1024
const timeoutMs = 20_000

async function waitFor(predicate: () => boolean, timeout: number): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for native Pi evidence')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type Ledger = Awaited<ReturnType<typeof posixFixtureLedger>>

async function versionFixture(prefix: string) {
  const ledger = await posixFixtureLedger(prefix)
  onTestFinished(async () => {
    await ledger.reap()
    await ledger.remove()
  })
  return ledger
}

async function runVersionCommand(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  ledger: Ledger | undefined,
  scheduleDeadline: (callback: () => void, delayMs: number) => () => void = (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
  launch = spawnOwnedProgram,
) {
  let stdout = ''
  let stderr = ''
  let outputBytes = 0
  let timedOut = false
  let outputExceeded = false
  let spawnError: string | undefined
  let drain: (() => Promise<void>) | undefined
  const stop = () => {
    if (drain) void drain().catch(() => {})
  }
  const cancelDeadline = scheduleDeadline(() => {
    timedOut = true
    stop()
  }, timeoutMs)
  try {
    if (timedOut) return { code: null, stdout, stderr, timedOut, outputExceeded, spawnError }
    const child = launch(bin, ['--version'], {
      cwd,
      env,
      stdio: 'pipe',
      posixGroupLease: true,
    })
    drain = child[ownedProcessDrain]?.drain
    if (!drain) throw new Error('Missing Pi version lease')
    const closed = new Promise<number | null>((resolve) => {
      child.once('close', (code) => resolve(code))
    })
    child.once('error', (error) => {
      spawnError = error.message
    })
    if (ledger && child.pid) {
      const ancestry = ledger.retain(
        ledger.record(child),
        drain,
        closed,
        'version owned-process descriptor',
      )
      child.once('spawn', ancestry)
    }
    const collect = (assign: 'stdout' | 'stderr') => (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > 16 * 1024) {
        outputExceeded = true
        stop()
      } else if (assign === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout!.setEncoding('utf8').on('data', collect('stdout'))
    child.stderr!.setEncoding('utf8').on('data', collect('stderr'))
    // Root exit is independent of the output pipes that descendants may hold.
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
    })
    await Promise.race([exited, closed])
    await drain()
    const exitCode = await closed
    const code = spawnError ? null : exitCode
    if (ledger && child.pid) kernelGroupAbsent(child.pid)
    return { code, stdout, stderr, timedOut, outputExceeded, spawnError }
  } finally {
    cancelDeadline()
  }
}

const posixIt = it.runIf(process.platform !== 'win32')

posixIt('drains a SIGTERM-resistant descendant when the version check hangs', async () => {
  const ledger = await versionFixture('holi-pi-version-hang-')
  const { root } = ledger
  const bin = join(root, 'pi')
  const pidPath = join(root, 'descendant.pid')
  const readyPath = join(root, 'descendant.ready')
  await writeFile(
    bin,
    `#!/usr/bin/env node\nconst { spawn } = require('node:child_process')\nconst fs = require('node:fs')\nsetTimeout(() => {\n  const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(()=>{},1000)`)}], {stdio:'ignore'})\n  fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))\n}, 700)\nsetInterval(()=>{},1000)\n`,
  )
  await chmod(bin, 0o755)
  let deadlineMs: number | undefined
  let fireDeadline: (() => void) | undefined
  let deadlineFired = false
  const scheduleDeadline = (callback: () => void, delayMs: number) => {
    deadlineMs = delayMs
    fireDeadline = () => {
      deadlineFired = true
      callback()
    }
    return () => {}
  }
  const resultPromise = runVersionCommand(bin, root, process.env, 500, ledger, scheduleDeadline)
  void resultPromise.catch(() => {})
  try {
    await waitFor(() => existsSync(pidPath) && existsSync(readyPath), 10_000)
    expect(deadlineMs).toBe(500)
    expect(fireDeadline).toBeDefined()
    fireDeadline!()
    const result = await resultPromise
    expect(result.timedOut).toBe(true)
    const pid = Number(await readFile(pidPath, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  } finally {
    if (!deadlineFired) fireDeadline?.()
    onTestFinished(() => resultPromise.then(() => {}))
  }
})

posixIt.each([0, 7])(
  'drains a SIGTERM-resistant descendant after version exit %i',
  async (exitCode) => {
    const ledger = await versionFixture('holi-pi-version-exit-')
    const { root } = ledger
    const bin = join(root, 'pi')
    const pidPath = join(root, 'descendant.pid')
    const readyPath = join(root, 'descendant.ready')
    await writeFile(
      bin,
      `#!/usr/bin/env node\nconst { spawn } = require('node:child_process')\nconst fs = require('node:fs')\nconst child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(()=>{},1000)`)}], {stdio:'ignore'})\nconst ready = setInterval(() => {\n  if (!fs.existsSync(${JSON.stringify(readyPath)})) return\n  clearInterval(ready)\n  fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))\n  console.log('version')\n  process.exit(${exitCode})\n}, 10)\n`,
    )
    await chmod(bin, 0o755)
    const result = await runVersionCommand(bin, root, process.env, 5_000, ledger)
    expect(result.code).toBe(exitCode)
    expect(result.timedOut).toBe(false)
    expect(result.stdout.trim()).toBe('version')
    const pid = Number(await readFile(pidPath, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  },
)

posixIt('does not launch the version command when the deadline fires before launch', async () => {
  const ledger = await versionFixture('holi-pi-version-startup-')
  const { root } = ledger
  const bin = join(root, 'pi')
  const started = join(root, 'started')
  await writeFile(
    bin,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(started)}, 'started')\n`,
  )
  await chmod(bin, 0o755)
  expect(
    await runVersionCommand(bin, root, process.env, 500, ledger, (callback) => {
      callback()
      return () => {}
    }),
  ).toMatchObject({ timedOut: true, code: null })
  expect(existsSync(started)).toBe(false)
})

posixIt('reports version spawn failure and bounds excessive output', async () => {
  const ledger = await versionFixture('holi-pi-version-errors-')
  const { root } = ledger
  expect(
    await runVersionCommand(join(root, 'missing'), root, process.env, 5_000, ledger),
  ).toMatchObject({
    code: null,
    spawnError: expect.stringContaining('ENOENT'),
  })
  const bin = join(root, 'pi')
  await writeFile(
    bin,
    '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(32 * 1024)); setInterval(() => {}, 1000)\n',
  )
  await chmod(bin, 0o755)
  expect(await runVersionCommand(bin, root, process.env, 5_000, ledger)).toMatchObject({
    outputExceeded: true,
    timedOut: false,
  })
})

const leaseRoles = ['version', 'rpc-first', 'rpc-cancel'] as const
type LeaseRole = (typeof leaseRoles)[number]
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// The challenge belongs to this one trusted Vitest worker, never the provider.
// All spawn calls go through the ledger and publish an intent before entering
// native code; a launch that never establishes durable proof stays unsettled.
function claimWorker(evidencePath: string, runId: string, nonce: string) {
  const root = dirname(evidencePath)
  const workerTmp = join(root, 'worker-tmp')
  const admissions = join(root, 'admissions')
  const ownership = join(root, 'ownership')
  if (!uuid.test(runId) || !uuid.test(nonce) || evidencePath !== join(root, 'evidence.json'))
    throw new Error('Invalid private Pi probe challenge')
  for (const path of [root, workerTmp, admissions, ownership]) {
    const stat = lstatSync(path)
    if (
      realpathSync(path) !== path ||
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw new Error('Invalid private Pi probe directory')
  }
  const identity = { version: 1, runId, nonce, workerPid: process.pid }
  const privateFile = { mode: 0o600, flag: 'wx' } as const
  writeFileSync(join(root, 'worker.json'), JSON.stringify(identity), privateFile)
  const work = join(workerTmp, 'probe-work')
  let workCreated = false
  let admissionClosed = false
  const attempts: { role: LeaseRole; id: string; join?: () => Promise<void> }[] = []
  return {
    createWork() {
      mkdirSync(work, { mode: 0o700 })
      workCreated = true
      return work
    },
    launch(role: LeaseRole, bin: string, args: readonly string[], options: SpawnOptions) {
      if (admissionClosed || role !== leaseRoles[attempts.length])
        throw new Error('Unexpected Pi probe lease admission')
      const id = randomUUID()
      const path = join(ownership, id)
      const attempt: (typeof attempts)[number] = { role, id }
      attempts.push(attempt)
      mkdirSync(join(admissions, `${role}-${id}`), { mode: 0o700 })
      try {
        const child = spawnOwnedProgram(bin, args, {
          ...options,
          posixGroupLease: true,
          ownershipRecordPath: path,
        })
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
        const drain = child[ownedProcessDrain]?.drain
        let outputError: Error | undefined
        for (const stream of [child.stdout, child.stderr])
          stream?.on('error', (error: Error) => {
            outputError ??= error
          })
        attempt.join = async () => {
          if (!drain) throw new Error('Missing retained Pi probe lease')
          await drain()
          await closed
          if (outputError) throw outputError
          if (!child.stdout?.readableEnded || !child.stderr?.readableEnded)
            throw new Error('Pi probe output did not reach EOF')
        }
        return child
      } catch (error) {
        const failure = error as { cleanup?: Promise<void> } | null
        const cleanup = posixLaunchNonAdmission(error)?.cleanup ?? failure?.cleanup
        if (cleanup) attempt.join = () => cleanup
        throw error
      }
    },
    async finish(
      joinCaller: (rpcAdmissions: number) => Promise<void>,
      joinServer: () => Promise<void>,
      artifact: () => Record<string, unknown>,
    ) {
      admissionClosed = true
      const cleanup = { piRunDrained: false, fixtureServerClosed: false, localRootRemoved: false }
      // Always try both caller finalization and owned lease drains, even if one fails.
      const [caller, leases] = await Promise.all([
        Promise.allSettled([
          Promise.resolve().then(() =>
            joinCaller(attempts.filter(({ role }) => role !== 'version').length),
          ),
        ]),
        Promise.allSettled(
          attempts.map(async ({ role, id, join: joinLease }) => {
            if (!joinLease) throw new Error('Missing Pi probe launch settlement')
            await joinLease()
            return cacheLeaseProof(root, identity, { role, id }, inspectPosixOwnership)
          }),
        ),
      ])
      cleanup.piRunDrained =
        caller[0]?.status === 'fulfilled' && leases.every((result) => result.status === 'fulfilled')
      try {
        await joinServer()
        cleanup.fixtureServerClosed = true
        if (cleanup.piRunDrained) {
          if (workCreated) await rm(work, { recursive: true })
          cleanup.localRootRemoved = true
        }
      } catch {}
      const bytes = JSON.stringify({ ...artifact(), cleanup })
      if (Buffer.byteLength(bytes) > maxEvidenceBytes) return
      const settled = leases.flatMap((lease) => (lease.status === 'fulfilled' ? [lease.value] : []))
      if (!cleanup.piRunDrained || !cleanup.fixtureServerClosed || !cleanup.localRootRemoved) {
        await writeFile(evidencePath, bytes, privateFile)
        return
      }
      await publishFinalSettlement(root, identity, settled, 'evidence.json', bytes)
    },
  }
}

async function withinDeadline(promise: Promise<void>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const nativeProbeEnabled =
  process.platform !== 'win32' &&
  Boolean(
    process.env.PI_NATIVE_PROBE_BIN &&
    process.env.PI_NATIVE_PROBE_EVIDENCE &&
    process.env.PI_NATIVE_PROBE_VERSION &&
    process.env.PI_NATIVE_PROBE_RUN_ID &&
    process.env.PI_NATIVE_PROBE_NONCE,
  )

it.skipIf(!nativeProbeEnabled)(
  'captures bounded native Pi RPC producer records through PiRpcRun',
  async () => {
    const bin = process.env.PI_NATIVE_PROBE_BIN!
    const evidencePath = process.env.PI_NATIVE_PROBE_EVIDENCE!
    const expectedVersion = process.env.PI_NATIVE_PROBE_VERSION!
    const worker = claimWorker(
      evidencePath,
      process.env.PI_NATIVE_PROBE_RUN_ID!,
      process.env.PI_NATIVE_PROBE_NONCE!,
    )
    let dirs: Record<string, string> = {}
    let server: ReturnType<typeof createServer> | undefined
    let heldCancelResponse: import('node:http').ServerResponse | undefined
    let heldQueueResponse: import('node:http').ServerResponse | undefined
    const runTimers = new Map<PiRpcRun, ReturnType<typeof setTimeout>>()
    const runs: PiRpcRun[] = []
    let captureError: string | undefined
    let evidence: Record<string, unknown> | undefined
    let probeStage: 'setup' | 'version' | 'native-rpc' = 'setup'
    let probeFailure: string | undefined
    try {
      const root = worker.createWork()
      dirs = Object.fromEntries(
        await Promise.all(
          ['home', 'config', 'data', 'tmp', 'work', 'pi'].map(async (name) => {
            const path = join(root, name)
            await mkdir(path)
            return [name, path]
          }),
        ),
      ) as Record<string, string>
      const records: Record<string, unknown>[] = []
      const commands: Record<string, unknown>[] = []
      const endpointRequests: Array<{
        messages?: Array<{ content?: unknown }>
        tools?: unknown[]
      }> = []
      let stderrText = ''
      let stderrBytesTotal = 0
      let latestStats: { tokens?: { total?: number } } | undefined
      let version = ''
      let queueRequestResolve: (() => void) | undefined
      const queueRequest = new Promise<void>((resolve) => {
        queueRequestResolve = resolve
      })
      let cancelRequestResolve: (() => void) | undefined
      const cancelRequest = new Promise<void>((resolve) => {
        cancelRequestResolve = resolve
      })
      server = createServer(async (request, response) => {
        if (request.method === 'GET' && request.url === '/v1/model') {
          response.setHeader('content-type', 'application/json')
          response.end(
            JSON.stringify({ id: 'fixture', object: 'model', created: 0, owned_by: 'fixture' }),
          )
          return
        }
        if (request.method === 'POST' && request.url === '/v1/chat/completions') {
          let body = ''
          for await (const chunk of request) {
            body += chunk.toString()
            if (body.length > 16 * 1024) {
              response.writeHead(413).end()
              request.destroy()
              return
            }
          }
          const parsed = JSON.parse(body) as {
            messages?: Array<{ content?: unknown }>
            tools?: unknown[]
          }
          if (Array.isArray(parsed.tools) && parsed.tools.length > 0)
            captureError = 'Native endpoint request unexpectedly included tools'
          endpointRequests.push(parsed)
          const prompt = JSON.stringify(parsed.messages?.at(-1)?.content)
          if (prompt.includes('trigger deterministic model failure')) {
            response.writeHead(500, { 'content-type': 'application/json' })
            response.end(
              JSON.stringify({
                error: { message: 'fixture model failure', type: 'fixture_error' },
              }),
            )
            return
          }
          if (prompt.includes('hold queued turn')) {
            heldQueueResponse = response
            queueRequestResolve?.()
            return
          }
          if (prompt.includes('cancel this turn')) {
            heldCancelResponse = response
            cancelRequestResolve?.()
            return
          }
          if (response.destroyed) return
          const text = prompt.includes('second turn')
            ? 'second answer'
            : prompt.includes('hold queued turn')
              ? 'queued answer'
              : 'first answer'
          response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })}\n\n`,
          )
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })}\n\n`,
          )
          response.end('data: [DONE]\n\n')
          return
        }
        response.writeHead(404).end()
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Fixture server did not bind')
      const env = {
        HOME: dirs.home!,
        XDG_CONFIG_HOME: dirs.config!,
        XDG_DATA_HOME: dirs.data!,
        TMPDIR: dirs.tmp!,
        PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/usr/bin:/bin`,
        PI_OFFLINE: '1',
        PI_CODING_AGENT_DIR: dirs.pi!,
      }
      await writeFile(
        join(dirs.pi!, 'models.json'),
        JSON.stringify({
          providers: {
            'holi-fixture': {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: 'openai-completions',
              apiKey: 'fixture-key',
              models: [{ id: 'fixture', name: 'Fixture', contextWindow: 4096, maxTokens: 128 }],
            },
          },
        }),
      )
      evidence = {
        expectedVersion,
        scenarios: {},
        records,
        commands,
        tools: [],
      }
      probeStage = 'version'
      const versionResult = await runVersionCommand(
        bin,
        dirs.work!,
        env,
        5_000,
        undefined,
        undefined,
        (bin, args, options) => worker.launch('version', bin, args, options),
      )
      if (versionResult.spawnError)
        throw new Error(`Could not spawn native Pi version command: ${versionResult.spawnError}`)
      if (versionResult.timedOut || versionResult.outputExceeded)
        throw new Error('Native Pi version command timed out or exceeded output bound')
      version = versionResult.stdout.trim()
      evidence.observedVersion = version.slice(0, 128)
      if (versionResult.code !== 0 || version !== expectedVersion || versionResult.stderr)
        throw new Error('Native Pi version did not match the observed package')

      let statsObserved = false
      const childSpawn = (
        role: LeaseRole,
        executable: string,
        args: string[],
        options: { cwd: string; env?: NodeJS.ProcessEnv; stdio: 'pipe' },
      ) => {
        probeStage = 'native-rpc'
        const child = worker.launch(
          role,
          executable,
          args,
          options,
        ) as ChildProcessWithoutNullStreams & PiChild
        commands.push({
          argv: args,
          noTools: [
            '--no-tools',
            '--no-extensions',
            '--no-skills',
            '--no-prompt-templates',
            '--no-context-files',
            '--no-mcp',
            '--no-approve',
          ].every((flag) => args.includes(flag)),
        })
        const stdin = child.stdin.write.bind(child.stdin)
        child.stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
          const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
          for (const line of text.split('\n').filter(Boolean)) {
            if (line.length > 16 * 1024) captureError = 'Native command exceeded record bound'
            else
              try {
                commands.push(JSON.parse(line) as Record<string, unknown>)
              } catch {
                captureError = 'Native stdin contained malformed JSONL'
              }
          }
          return (stdin as (...args: unknown[]) => boolean)(chunk, ...rest)
        }) as typeof child.stdin.write
        let pending = ''
        let outputBytes = 0
        let stopping = false
        const stopChild = () => {
          if (stopping) return
          stopping = true
          captureError = 'Native output evidence exceeded bound'
          void runs
            .at(-1)
            ?.close()
            .catch(() => {})
        }
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          if (stopping) return
          outputBytes += Buffer.byteLength(chunk)
          if (outputBytes > maxEvidenceBytes || pending.length + chunk.length > maxEvidenceBytes) {
            stopChild()
            return
          }
          pending += chunk
          let end
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end)
            pending = pending.slice(end + 1)
            if (line.length > 16 * 1024) {
              stopChild()
              continue
            }
            try {
              const record = JSON.parse(line) as Record<string, unknown>
              const safe: Record<string, unknown> = { type: record.type }
              if (typeof record.id === 'string') safe.id = record.id
              if (record.type === 'response') {
                safe.command = commands.find((command) => command.id === record.id)?.type
                safe.success = record.success
                const disposition = (record.data as Record<string, unknown> | undefined)
                  ?.disposition
                if (disposition) safe.disposition = disposition
              } else if (record.type === 'message_update') {
                const event = record.assistantMessageEvent as Record<string, unknown> | undefined
                safe.event = event?.type
                if (event?.type === 'text_delta') safe.delta = event.delta
              } else if (record.type === 'message_end') {
                const message = record.message as Record<string, unknown> | undefined
                if (message?.role === 'assistant')
                  Object.assign(safe, {
                    role: message.role,
                    stopReason: message.stopReason,
                    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
                  })
              } else if (record.type === 'agent_settled') safe.aborted = record.aborted
              records.push(safe)
            } catch {
              captureError = 'Native stdout contained malformed JSONL'
              stopChild()
            }
          }
        })
        child.stdout.once('end', () => {
          if (pending && !stopping) captureError = 'Native stdout ended with a partial JSONL record'
        })
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderrBytesTotal += Buffer.byteLength(chunk)
          if (stderrBytesTotal > 16 * 1024) stopChild()
          else stderrText = (stderrText + chunk).slice(-16 * 1024)
        })
        return child as PiChild
      }
      const run = (role: 'rpc-first' | 'rpc-cancel') => {
        const instance = new PiRpcRun({
          bin: bin!,
          cwd: dirs.work!,
          env,
          model: 'holi-fixture/fixture',
          system: 'Holi native fixture instruction',
          noTools: true,
          onStats: (stats) => {
            statsObserved = true
            latestStats = stats as typeof latestStats
          },
          spawn: (bin, args, options) => childSpawn(role, bin, args, options),
        })
        runs.push(instance)
        const timer = setTimeout(() => {
          void instance.cancel().catch(() => {})
        }, timeoutMs)
        runTimers.set(instance, timer)
        const releaseTimer = () => {
          clearTimeout(timer)
          runTimers.delete(instance)
        }
        void instance.drained.then(releaseTimer, releaseTimer)
        return instance
      }
      const firstRun = run('rpc-first')
      const first = await firstRun.prompt('first turn')
      expect(first.status).toBe('completed')
      expect(first.output).toContain('first answer')
      evidence.scenarios = { streamCompletion: 'pass', firstTurnOutput: first.output }
      const second = await firstRun.prompt('second turn')
      expect(second.status).toBe('completed')
      expect(second.output).toContain('second answer')
      expect(second.output).not.toContain('first answer')
      evidence.scenarios = {
        ...(evidence.scenarios as object),
        consecutiveTurns: 'pass',
        secondTurnOutput: second.output,
      }
      const failed = await firstRun.prompt('trigger deterministic model failure')
      expect(failed.status).toBe('failed')
      const queuedTurn = firstRun.prompt('hold queued turn')
      await withinDeadline(queueRequest, 'Queued-turn endpoint request was not observed')
      firstRun.steer('steer consumed marker')
      firstRun.followUp('follow-up consumed marker')
      if (!heldQueueResponse) throw new Error('Queued turn response was not held')
      heldQueueResponse.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      heldQueueResponse.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'queued answer' }, index: 0 }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })}\n\ndata: [DONE]\n\n`,
      )
      const queuedResult = await queuedTurn
      expect(queuedResult.status).toBe('completed')
      expect(
        endpointRequests.some((request) =>
          JSON.stringify(request.messages).includes('steer consumed marker'),
        ),
      ).toBe(true)
      expect(
        endpointRequests.some((request) =>
          JSON.stringify(request.messages).includes('follow-up consumed marker'),
        ),
      ).toBe(true)
      evidence.scenarios = {
        ...(evidence.scenarios as object),
        steerAndFollowUp: 'pass',
        modelError: 'pass',
        modelErrorReported: Boolean(failed.error),
        statsResponse:
          statsObserved &&
          records.some(
            (record) =>
              record.type === 'response' &&
              record.command === 'get_session_stats' &&
              record.success === true,
          ) &&
          typeof (latestStats as { usage?: { total?: number } } | undefined)?.usage?.total ===
            'number'
            ? 'pass'
            : 'unverified',
        appendSystemPrompt: endpointRequests.some((request) =>
          JSON.stringify(request.messages).includes('Holi native fixture instruction'),
        )
          ? 'pass'
          : 'unverified',
        noToolsRequest:
          endpointRequests.length > 0 && endpointRequests.every((request) => !request.tools?.length)
            ? 'pass'
            : 'unverified',
      }
      await firstRun.close()
      await firstRun.drained

      const cancelRun = run('rpc-cancel')
      const pending = cancelRun.prompt('cancel this turn')
      await withinDeadline(
        cancelRequest,
        'Native cancellation request did not reach the local model endpoint',
      )
      await waitFor(() => records.some((record) => record.type === 'agent_start'), timeoutMs)
      await cancelRun.cancel()
      const cancelled = await pending
      expect(cancelled.status).toBe('aborted')
      expect(commands.some((command) => command.type === 'abort')).toBe(true)
      await cancelRun.drained
      evidence.scenarios = {
        ...(evidence.scenarios as object),
        cancel: 'pass',
        abortAcknowledgement: records.some(
          (record) => record.type === 'agent_settled' && record.aborted === true,
        )
          ? 'observed'
          : 'not observed; cancel terminates the child after sending abort',
      }
      expect(
        commands.filter((command) => 'argv' in command).every((command) => command.noTools),
      ).toBe(true)
      expect(captureError).toBeUndefined()
      if (stderrText) evidence.stderr = stderrText
      evidence.package = '@earendil-works/pi-coding-agent'
      evidence.commandCount = commands.length
      evidence.recordCount = records.length
      evidence.tools = records
        .filter((record) => ['tool_call', 'tool_execution_start'].includes(String(record.type)))
        .map((record) => record.type)
      expect(evidence.tools).toEqual([])
      expect((evidence.scenarios as Record<string, unknown>).noToolsRequest).toBe('pass')
      expect((evidence.scenarios as Record<string, unknown>).appendSystemPrompt).toBe('pass')
      expect((evidence.scenarios as Record<string, unknown>).statsResponse).toBe('pass')
      expect((evidence.scenarios as Record<string, unknown>).steerAndFollowUp).toBe('pass')
      expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(maxEvidenceBytes)
    } catch (error) {
      probeFailure = String(error instanceof Error ? error.message : error).slice(0, 1000)
      throw error
    } finally {
      try {
        await worker.finish(
          async (rpcAdmissions) => {
            for (const timer of runTimers.values()) clearTimeout(timer)
            const drained = await Promise.allSettled(runs.map((run) => run.cancel()))
            if (
              runs.length !== rpcAdmissions ||
              drained.some((result) => result.status === 'rejected')
            )
              throw new Error('Pi RPC caller did not finalize every admitted run')
            if (captureError) throw new Error(captureError)
          },
          async () => {
            if (heldCancelResponse && !heldCancelResponse.destroyed) heldCancelResponse.destroy()
            if (heldQueueResponse && !heldQueueResponse.destroyed) heldQueueResponse.destroy()
            if (server?.listening) {
              const closed = new Promise<void>((resolve, reject) =>
                server!.close((error) => (error ? reject(error) : resolve())),
              )
              server.closeAllConnections()
              await closed
            }
          },
          () => ({
            expectedVersion,
            ...evidence,
            ...(probeFailure && { failure: { stage: probeStage, message: probeFailure } }),
          }),
        )
      } catch {
        // A failed or partial write must not replace the original probe error.
        // Without a final receipt the parent retains the private root.
      }
    }
  },
  35_000,
)

// This fixture never invokes the real producer binary or starts a model. Run
// only this named test with the explicit synthetic-native fixture gate.
it
  .runIf(process.platform !== 'win32' && process.env.HOLI_PI_SETTLEMENT_FIXTURE === '1')
  .each(['settled', 'kernel-absence'] as const)(
  'joins the last worker resource before publishing the synthetic Pi settlement (%s)',
  async (proof) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'holi-pi-settlement-fixture-')))
    const ownership = join(root, 'ownership')
    const evidencePath = join(root, 'evidence.json')
    const settlementPath = join(root, 'settlement.json')
    for (const name of ['worker-tmp', 'admissions', 'ownership'])
      await mkdir(join(root, name), { mode: 0o700 })
    const runId = randomUUID()
    const nonce = randomUUID()
    const worker = claimWorker(evidencePath, runId, nonce)
    const work = worker.createWork()
    const bin = join(work, 'pi-fixture')
    let releaseLastResource!: () => void
    const lastResource = new Promise<void>((resolve) => {
      releaseLastResource = resolve
    })
    let reportJoining!: () => void
    const joiningLastResource = new Promise<void>((resolve) => {
      reportJoining = resolve
    })
    let finish: Promise<void> | undefined
    const beginFinish = () =>
      worker.finish(
        async (rpcAdmissions) => {
          expect(rpcAdmissions).toBe(0)
        },
        async () => {
          reportJoining()
          await lastResource
        },
        () => ({
          expectedVersion: '1.0.0',
          observedVersion: '0.0.0-fixture',
          failure: { stage: 'version', message: 'synthetic version mismatch' },
        }),
      )
    try {
      await writeFile(bin, '#!/bin/sh\nprintf "0.0.0-fixture\\n"\n', { mode: 0o700 })
      const result = await runVersionCommand(
        bin,
        work,
        { PATH: '/usr/bin:/bin', HOME: work },
        5_000,
        undefined,
        undefined,
        (bin, args, options) => worker.launch('version', bin, args, options),
      )
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe('0.0.0-fixture')
      const [id] = await readdir(ownership)
      expect(id).toMatch(uuid)
      const path = join(ownership, id!)
      if (proof === 'kernel-absence') {
        // Keep the real complete journal, but model EOF cleanup without a
        // published terminal marker. The cold inspector must prove absence.
        await rename(join(path, 'settled'), join(root, 'fixture-native-terminal'))
      }
      finish = beginFinish()
      await joiningLastResource
      const cache = JSON.parse(
        await readFile(join(root, 'admissions', `version-${id}`, 'proof.json'), 'utf8'),
      )
      const journal = await readFile(join(path, 'journal'), 'utf8')
      expect(cache.journal).toBe(journal)
      if (proof === 'kernel-absence') {
        expect(cache).not.toHaveProperty('settled')
        const [rootPid, reaper, anchor] = Array.from(
          journal.matchAll(/(?:ROOT|REAPER|ANCHOR) (\d+)\n/g),
          (match) => Number(match[1]),
        )
        expect(cache.absenceSnapshot).toEqual({
          protocol: 'posix-kill-0',
          absent: [reaper, -reaper!, anchor, rootPid, -rootPid!],
        })
      } else {
        expect(cache).not.toHaveProperty('absenceSnapshot')
        expect(cache.settled).toBe(await readFile(join(path, 'settled'), 'utf8'))
      }
      expect(existsSync(settlementPath)).toBe(false)
      expect(existsSync(evidencePath)).toBe(false)
      expect(existsSync(work)).toBe(true)
      releaseLastResource()
      await finish
      const bytes = await readFile(evidencePath)
      expect(JSON.parse(await readFile(settlementPath, 'utf8'))).toEqual({
        version: 1,
        runId,
        nonce,
        workerPid: process.pid,
        state: 'final',
        admission: 'leases-settled',
        leases: [
          {
            id,
            role: 'version',
            proof,
            proofSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ],
        evidenceSha256: createHash('sha256').update(bytes).digest('hex'),
      })
      const probe = vi.spyOn(process, 'kill')
      try {
        expect(readFinalSettlement(root, { runId, nonce }, leaseRoles, bytes, true)).toBeTruthy()
        expect(probe).not.toHaveBeenCalled()
      } finally {
        probe.mockRestore()
      }
      expect(existsSync(work)).toBe(false)
    } finally {
      releaseLastResource()
      await (finish ?? beginFinish())
      // Test owns the retained launcher, never a PID from the disk receipt.
      const records = await readdir(ownership)
      if (
        records.every((id) => inspectPosixOwnership(join(ownership, id)).state === 'confirmed') &&
        records.length === (await readdir(join(root, 'admissions'))).length
      )
        await rm(root, { recursive: true })
      else throw new Error(`Retained synthetic Pi settlement fixture at ${root}`)
    }
  },
  20_000,
)
