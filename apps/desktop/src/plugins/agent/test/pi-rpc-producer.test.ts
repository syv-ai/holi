import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { PiRpcRun, type PiChild } from '../main/pi/rpc'

const maxEvidenceBytes = 64 * 1024
const timeoutMs = 20_000

async function waitFor(predicate: () => boolean, timeout: number): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for native Pi evidence')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** EPERM is ambiguous on Darwin after a group exits, never evidence of absence.
 * A successful, strictly parsed process-table snapshot supplies independent proof. */
async function versionGroupExists(pgid: number): Promise<boolean> {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code !== 'EPERM') throw error
  }
  const table = await new Promise<string>((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,pgid='],
      { timeout: 2000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })
  const rows = table
    .trim()
    .split('\n')
    .map((row) => row.trim().split(/\s+/).map(Number))
  if (
    !rows.length ||
    rows.some((row) => row.length !== 2 || row.some((id) => !Number.isSafeInteger(id) || id < 0))
  )
    throw new Error('Could not verify version process group membership')
  return rows.some(([, group]) => group === pgid)
}

// Keep a ready, SIGTERM-resistant group leader until escalation. The version
// command may exit first: its numeric PID alone must not authorize a later kill.
const versionAnchor = `
const { spawn } = require('node:child_process')
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
process.once('message', ({ bin }) => {
  const command = spawn(bin, ['--version'], { stdio: ['ignore', 1, 2] })
  command.once('error', (error) => process.send({ type: 'result', code: null, spawnError: error.message }))
  command.once('exit', (code) => process.send({ type: 'result', code }))
})
process.send({ type: 'ready' })
`

async function runVersionCommand(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  scheduleDeadline: (callback: () => void, delayMs: number) => () => void = (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
): Promise<{
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputExceeded: boolean
  spawnError?: string
}> {
  const child = spawn(process.execPath, ['-e', versionAnchor], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
  })
  let stdout = ''
  let stderr = ''
  let outputBytes = 0
  let timedOut = false
  let outputExceeded = false
  let stopping = false
  let ready = false
  let code: number | null = null
  let spawnError: string | undefined
  let cleanupError: unknown
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const alive = () => child.exitCode === null && child.signalCode === null
  const signal = (name: NodeJS.Signals) => {
    // Never signal a numeric group after its owned anchor exited.
    if (!ready || !alive()) return
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name)
      else child.kill(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupError = error
    }
  }
  const terminate = () => {
    signal('SIGTERM')
    killTimer = setTimeout(() => signal('SIGKILL'), 200)
  }
  const stop = () => {
    if (stopping) return
    stopping = true
    if (ready) terminate()
    // Before ready, the anchor has not launched any command. Kill only this
    // owned child handle, never an unconfirmed numeric process group.
    else if (alive()) child.kill('SIGKILL')
  }
  child.on('message', (message: { type: string; code?: number | null; spawnError?: string }) => {
    if (message.type === 'ready') {
      ready = true
      if (stopping) terminate()
      else child.send({ bin })
    } else if (message.type === 'result') {
      code = message.code ?? null
      spawnError ??= message.spawnError
      stop()
    }
  })
  child.once('error', (error) => {
    spawnError = error.message
  })
  const collect = (assign: 'stdout' | 'stderr') => (chunk: string) => {
    outputBytes += Buffer.byteLength(chunk)
    if (outputBytes > 16 * 1024) {
      outputExceeded = true
      stop()
    } else if (assign === 'stdout') stdout = (stdout + chunk).slice(-16 * 1024)
    else stderr = (stderr + chunk).slice(-16 * 1024)
  }
  child.stdout!.setEncoding('utf8').on('data', collect('stdout'))
  child.stderr!.setEncoding('utf8').on('data', collect('stderr'))
  const cancelDeadline = scheduleDeadline(() => {
    timedOut = true
    stop()
  }, timeoutMs)
  try {
    await new Promise<void>((resolve) => child.once('close', () => resolve()))
    if (!stopping && !spawnError)
      throw new Error('Native Pi version anchor exited before reporting a result')
    if (cleanupError) throw cleanupError
    if (process.platform !== 'win32' && child.pid) {
      const deadline = Date.now() + 2000
      while (await versionGroupExists(child.pid)) {
        if (Date.now() >= deadline) throw new Error('Native Pi version process group did not drain')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
  } finally {
    cancelDeadline()
    clearTimeout(killTimer)
  }
  return { code, stdout, stderr, timedOut, outputExceeded, spawnError }
}

it('drains a SIGTERM-resistant descendant when the version check hangs', async () => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(join(tmpdir(), 'holi-pi-version-hang-'))
  const bin = join(root, 'pi')
  const pidPath = join(root, 'descendant.pid')
  const readyPath = join(root, 'descendant.ready')
  try {
    await writeFile(
      bin,
      `#!/usr/bin/env node\nconst { spawn } = require('node:child_process')\nconst fs = require('node:fs')\nsetTimeout(() => {\n  const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(()=>{},1000)`)}], {stdio:'ignore'})\n  fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))\n}, 700)\nsetInterval(()=>{},1000)\n`,
    )
    await chmod(bin, 0o755)
    let deadlineMs: number | undefined
    let fireDeadline: (() => void) | undefined
    let deadlineFired = false
    let resultPromise: ReturnType<typeof runVersionCommand> | undefined
    const scheduleDeadline = (callback: () => void, delayMs: number) => {
      deadlineMs = delayMs
      fireDeadline = () => {
        deadlineFired = true
        callback()
      }
      return () => {}
    }
    resultPromise = runVersionCommand(bin, root, process.env, 500, scheduleDeadline)
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
      await resultPromise
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([0, 7])('drains a SIGTERM-resistant descendant after version exit %i', async (exitCode) => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(join(tmpdir(), 'holi-pi-version-exit-'))
  const bin = join(root, 'pi')
  const pidPath = join(root, 'descendant.pid')
  const readyPath = join(root, 'descendant.ready')
  try {
    await writeFile(
      bin,
      `#!/usr/bin/env node\nconst { spawn } = require('node:child_process')\nconst fs = require('node:fs')\nconst child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(()=>{},1000)`)}], {stdio:'ignore'})\nconst ready = setInterval(() => {\n  if (!fs.existsSync(${JSON.stringify(readyPath)})) return\n  clearInterval(ready)\n  fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))\n  console.log('version')\n  process.exit(${exitCode})\n}, 10)\n`,
    )
    await chmod(bin, 0o755)
    const result = await runVersionCommand(bin, root, process.env, 5_000)
    expect(result.code).toBe(exitCode)
    expect(result.timedOut).toBe(false)
    expect(result.stdout.trim()).toBe('version')
    const pid = Number(await readFile(pidPath, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('confirms group absence independently when macOS kill-zero returns EPERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-pi-version-eperm-'))
  const bin = join(root, 'pi')
  const kill = process.kill.bind(process)
  const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid < 0 && signal === 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    return kill(pid, signal)
  })
  try {
    await writeFile(bin, '#!/usr/bin/env node\nconsole.log("version")\n')
    await chmod(bin, 0o755)
    expect(await runVersionCommand(bin, root, process.env, 5_000)).toMatchObject({
      code: 0,
      timedOut: false,
      stdout: 'version\n',
    })
  } finally {
    probe.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

it('does not launch the version command when the deadline fires before anchor readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-pi-version-startup-'))
  const bin = join(root, 'pi')
  const started = join(root, 'started')
  try {
    await writeFile(
      bin,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(started)}, 'started')\n`,
    )
    await chmod(bin, 0o755)
    expect(
      await runVersionCommand(bin, root, process.env, 500, (callback) => {
        callback()
        return () => {}
      }),
    ).toMatchObject({ timedOut: true, code: null })
    expect(existsSync(started)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('does not mistake an inaccessible live group for an absent group', async () => {
  if (process.platform === 'win32') return
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  await once(child, 'spawn')
  const kill = process.kill.bind(process)
  const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -child.pid! && signal === 0)
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    return kill(pid, signal)
  })
  try {
    expect(await versionGroupExists(child.pid!)).toBe(true)
    probe.mockImplementation(() => {
      throw Object.assign(new Error('unexpected probe error'), { code: 'EACCES' })
    })
    await expect(versionGroupExists(child.pid!)).rejects.toThrow('unexpected probe error')
  } finally {
    probe.mockRestore()
    const closed = once(child, 'close')
    child.kill('SIGKILL')
    await closed
  }
})

it('reports version spawn failure and bounds excessive output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-pi-version-errors-'))
  try {
    expect(await runVersionCommand(join(root, 'missing'), root, process.env, 5_000)).toMatchObject({
      code: null,
      spawnError: expect.stringContaining('ENOENT'),
    })
    const bin = join(root, 'pi')
    await writeFile(
      bin,
      '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(32 * 1024)); setInterval(() => {}, 1000)\n',
    )
    await chmod(bin, 0o755)
    expect(await runVersionCommand(bin, root, process.env, 5_000)).toMatchObject({
      outputExceeded: true,
      timedOut: false,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const nativeProbeEnabled = Boolean(
  process.env.PI_NATIVE_PROBE_BIN &&
  process.env.PI_NATIVE_PROBE_EVIDENCE &&
  process.env.PI_NATIVE_PROBE_VERSION,
)

it.skipIf(!nativeProbeEnabled)(
  'captures bounded native Pi RPC producer records through PiRpcRun',
  async () => {
    const bin = process.env.PI_NATIVE_PROBE_BIN!
    const evidencePath = process.env.PI_NATIVE_PROBE_EVIDENCE!
    const expectedVersion = process.env.PI_NATIVE_PROBE_VERSION!
    let root: string | undefined
    let dirs: Record<string, string> = {}
    let server: ReturnType<typeof createServer> | undefined
    let active: PiRpcRun | undefined
    let heldCancelResponse: import('node:http').ServerResponse | undefined
    let heldQueueResponse: import('node:http').ServerResponse | undefined
    const runTimers = new Map<PiRpcRun, ReturnType<typeof setTimeout>>()
    const cleanupEvidence = {
      piRunDrained: false,
      fixtureServerClosed: false,
      localRootRemoved: false,
    }
    let evidence: Record<string, unknown> | undefined
    let probeStage: 'setup' | 'version' | 'native-rpc' = 'setup'
    let probeFailure: string | undefined
    try {
      root = await mkdtemp(join(tmpdir(), 'holi-pi-producer-'))
      dirs = Object.fromEntries(
        await Promise.all(
          ['home', 'config', 'data', 'tmp', 'work', 'pi'].map(async (name) => {
            const path = join(root!, name)
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
      let captureError: string | undefined
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
      const versionResult = await runVersionCommand(bin, dirs.work!, env, 5_000)
      if (versionResult.spawnError)
        throw new Error(`Could not spawn native Pi version command: ${versionResult.spawnError}`)
      if (versionResult.timedOut || versionResult.outputExceeded)
        throw new Error('Native Pi version command timed out or exceeded output bound')
      version = versionResult.stdout.trim()
      evidence.observedVersion = version
      if (versionResult.code !== 0 || version !== expectedVersion || versionResult.stderr)
        throw new Error('Native Pi version did not match the observed package')

      let statsObserved = false
      const childSpawn = (
        executable: string,
        args: string[],
        options: { cwd: string; env?: NodeJS.ProcessEnv; stdio: 'pipe' },
      ) => {
        const child = spawn(executable, args, options) as unknown as PiChild
        probeStage = 'native-rpc'
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
          try {
            child.kill('SIGTERM')
          } catch {}
          const escalation = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {}
          }, 200)
          escalation.unref()
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
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderrBytesTotal += Buffer.byteLength(chunk)
          if (stderrBytesTotal > 16 * 1024) stopChild()
          else stderrText = (stderrText + chunk).slice(-16 * 1024)
        })
        return child
      }
      const run = () => {
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
          spawn: childSpawn,
        })
        active = instance
        const timer = setTimeout(() => {
          void instance.cancel()
        }, timeoutMs)
        runTimers.set(instance, timer)
        void instance.drained.then(() => {
          clearTimeout(timer)
          runTimers.delete(instance)
        })
        return instance
      }
      const firstRun = run()
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
      await Promise.race([
        queueRequest,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Queued-turn endpoint request was not observed')),
            timeoutMs,
          ),
        ),
      ])
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
      active = undefined

      const cancelRun = run()
      const pending = cancelRun.prompt('cancel this turn')
      await Promise.race([
        cancelRequest,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error('Native cancellation request did not reach the local model endpoint'),
              ),
            timeoutMs,
          ),
        ),
      ])
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
      for (const timer of runTimers.values()) clearTimeout(timer)
      try {
        await active?.cancel()
        cleanupEvidence.piRunDrained = true
      } catch {}
      if (heldCancelResponse && !heldCancelResponse.destroyed) heldCancelResponse.destroy()
      if (heldQueueResponse && !heldQueueResponse.destroyed) heldQueueResponse.destroy()
      try {
        if (server?.listening) {
          server.closeAllConnections()
          await new Promise<void>((resolve) => server!.close(() => resolve()))
        }
        cleanupEvidence.fixtureServerClosed = true
      } catch {}
      try {
        if (root) await rm(root, { recursive: true, force: true })
        cleanupEvidence.localRootRemoved = true
      } catch {}
      const finalEvidence = {
        ...(evidence ?? {}),
        ...(probeFailure ? { failure: { stage: probeStage, message: probeFailure } } : {}),
        cleanup: cleanupEvidence,
      }
      try {
        if (Buffer.byteLength(JSON.stringify(finalEvidence)) <= maxEvidenceBytes)
          await writeFile(evidencePath, JSON.stringify(finalEvidence, null, 2))
      } catch {}
    }
  },
  35_000,
)
