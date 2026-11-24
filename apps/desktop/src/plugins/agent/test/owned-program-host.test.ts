import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import { parse } from 'smol-toml'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createBridgeServer, type BridgeServer } from '../../../main/bridge/server'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { ensureAskpass, openRepo } from '../../../main/git'
import {
  runGit,
  UnconfirmedOwnedProgramError,
  type execProgram,
  type ManagedOwnedChild,
  ownedProcessDrain,
  type OwnedCompletion,
} from '../../../main/plugin-api'
import { createPluginHost, type OpenVault } from '../../../main/plugin-host/host'
import { holisMain } from '../../holis/main'
import type { HoliSummary } from '../../holis/main/holis'
import { agentMain } from '../main'
import { agentConfigSlug } from '../main/claude/config-dir'
import type { SessionSummary } from '../main/claude/listing'
import { agentScratchRoots } from '../main/host/scratch-roots'

const native = vi.hoisted(() => ({
  children: [] as FakeNativeChild[],
  claude: [] as Array<{ args: readonly string[]; cwd: string; config: string | undefined }>,
  background: new Map<string, { cwd: string; name: string }>(),
}))

vi.mock('../../../main/plugin-api', async (load) => {
  const actual = await load<typeof import('../../../main/plugin-api')>()
  return {
    ...actual,
    spawnOwnedProgram: (
      bin: string,
      args: string[],
      opts: { cwd: string; env: NodeJS.ProcessEnv },
    ) => {
      const child = new FakeNativeChild(bin, args, opts.cwd, opts.env)
      native.children.push(child)
      return child as unknown as ManagedOwnedChild
    },
    execProgram: (...args: Parameters<typeof execProgram>) => fakeClaudeExec(...args),
    // Only Pi needs an installed binary lookup: Claude and Codex have fixture overrides.
    resolveBin: (name: string) => (name === 'pi' ? process.execPath : null),
    killChildTree: unexpectedPidOperation,
    killTree: unexpectedPidOperation,
    defaultProbePid: unexpectedPidOperation,
  }
})

vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  nativeTheme: { shouldUseDarkColors: false },
  // Holis imports these when it activates, even when no run asks for attention.
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}))

function unexpectedPidOperation(): never {
  throw new Error('A fake Windows PID must not reach a process-table operation')
}

const fakePid = 9001
const claudeId = '0123abcd'
const threadId = '123e4567-e89b-42d3-a456-426614174000'
const disposableAuth = JSON.stringify({ tokens: { access_token: 'fixture-not-a-token' } })
const refreshedAuth = JSON.stringify({ tokens: { access_token: 'fixture-refresh-not-a-token' } })
const proofMessage = 'Could not confirm Windows owned-program completion'

// Fake only the CLI conversation with the native exec adapter. Listings include
// both roots on purpose: the real agent must filter them before serving rows.
const fakeClaudeExec: typeof execProgram = (_bin, args, opts, done) => {
  const cwd = opts.cwd!
  const config = opts.env['CLAUDE_CONFIG_DIR']
  native.claude.push({ args, cwd, config })
  if (args[0] === '--bg') expect(opts.retainDescendantsOnSuccess).toBe(true)
  const child = new FakeNativeChild(process.execPath, args, cwd, opts.env)
  queueMicrotask(() => {
    child.dispose()
    switch (args[0]) {
      case 'agents':
        done(
          null,
          JSON.stringify(
            [...native.background.values()].map((row) => ({
              ...row,
              id: claudeId,
              sessionId: threadId,
              kind: 'background',
              pid: fakePid,
              status: 'idle',
            })),
          ),
          '',
          { kind: 'settled' },
        )
        break
      case '--bg': {
        const name = args[args.indexOf('--name') + 1]!
        done(null, `backgrounded · ${claudeId} · ${name}\n`, '', {
          kind: 'settled',
          lease: {
            commit: async () => {
              native.background.set(cwd, { cwd, name })
            },
            revoke: async () => {
              native.background.delete(cwd)
            },
          },
        })
        break
      }
      case 'stop':
        native.background.delete(cwd)
        done(null, '', '', { kind: 'settled' })
        break
      default:
        done(
          Object.assign(new Error(`Unexpected Claude fixture command: ${args[0]}`), {
            cmd: args.join(' '),
          }),
          '',
          '',
          { kind: 'settled' },
        )
    }
  })
  return child as unknown as ManagedOwnedChild
}

class NativeProofFailure extends Error {}

class FakeNativeChild extends EventEmitter {
  readonly pid = fakePid
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  readonly ownedCompletion: Promise<OwnedCompletion>
  readonly [ownedProcessDrain]: { drain: () => Promise<void> }
  drainRequests = 0
  stopRequests = 0
  exited = false
  closed = false
  resourcesReleased = false
  failure?: {
    receipt: UnconfirmedOwnedProgramError
    commandError: Error | null
    observed?: UnconfirmedOwnedProgramError
  }
  private receipt: 'pending' | 'settled' = 'pending'
  private settleDrain!: () => void
  private failDrain!: (error: Error) => void
  private settle!: (value: OwnedCompletion) => void
  private fail!: (error: Error) => void

  constructor(
    readonly bin: string,
    readonly args: readonly string[],
    readonly cwd: string,
    readonly env: NodeJS.ProcessEnv,
  ) {
    super()
    const drainProof = new Promise<void>((resolve, reject) => {
      this.settleDrain = resolve
      this.failDrain = reject
    })
    this.ownedCompletion = new Promise((resolve, reject) => {
      this.settle = resolve
      this.fail = reject
    })
    this[ownedProcessDrain] = {
      drain: () => {
        this.drainRequests += 1
        if (process.platform === 'win32') return Promise.resolve()
        return drainProof
      },
    }
  }

  kill() {
    this.stopRequests += 1
    return true
  }

  codexTurn() {
    if (this.stdout.writableEnded) throw new Error('Fake Codex output already ended')
    this.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`)
    this.stdout.write('{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}\n')
  }

  exit(code = 0) {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, null)
  }

  close(code = 0) {
    if (this.closed) return
    this.closed = true
    this.emit('close', code, null)
  }

  endOutput() {
    if (!this.stdout.writableEnded) this.stdout.end()
    if (!this.stderr.writableEnded) this.stderr.end()
  }

  releaseResources() {
    this.resourcesReleased = true
    this.stdin.destroy()
  }

  proveEmpty() {
    if (this.receipt !== 'pending') return
    this.receipt = 'settled'
    this.releaseResources()
    this.settle('empty')
    this.settleDrain()
  }

  rejectProof(cause: NativeProofFailure, commandError: Error | null = null) {
    expect(this.receipt).toBe('pending')
    const lease = {
      revoke: async () => {
        throw cause
      },
    }
    // The join must retain the first command error along with the proof and lease.
    if (commandError !== null) this.emit('error', commandError)
    const receipt = new UnconfirmedOwnedProgramError(cause, lease)
    this.failure = { receipt, commandError }
    this.receipt = 'settled'
    if (process.platform === 'win32') this.fail(receipt)
    else this.failDrain(receipt)
    return this.failure
  }

  dispose() {
    this.exit(1)
    this.endOutput()
    this.close(1)
    this.releaseResources()
    // Teardown may drain an unfinished fake, but it cannot rewrite a rejected proof.
    this.proveEmpty()
    this.stdout.resume()
    this.stderr.resume()
  }
}

const A = 'owner/owned-a'
const B = 'owner/owned-b'
const remotes = [A, B] as const
type Remote = (typeof remotes)[number]
const cleanups: Array<() => void | Promise<void>> = []

function onlyFailure(error: unknown, message: string): unknown {
  expect(error).toBeInstanceOf(AggregateError)
  const group = error as AggregateError
  expect(group.message).toBe(message)
  expect(group.errors).toHaveLength(1)
  return group.errors[0]
}

function vaultStopCause(error: unknown, remote: Remote): unknown {
  const plugin = onlyFailure(error, `plugins in ${remote} failed to stop`)
  const agent = onlyFailure(plugin, 'plugin agent teardown failed')
  return onlyFailure(agent, 'agent teardown failed')
}

function expectProof(error: unknown, expected: NonNullable<FakeNativeChild['failure']>) {
  expect(error).toBeInstanceOf(UnconfirmedOwnedProgramError)
  const rejected = error as UnconfirmedOwnedProgramError
  expect(rejected.message).toBe(proofMessage)
  expect(rejected.cause).toBe(expected.receipt.cause)
  expect(rejected.lease).toBe(expected.receipt.lease)
  expect(rejected.commandError).toBe(expected.commandError)
  const sameError =
    expected.observed ?? (expected.commandError === null ? expected.receipt : undefined)
  if (sameError !== undefined) expect(rejected).toBe(sameError)
  expected.observed = rejected
  return rejected
}

function rejected(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the call to reject')
    },
    (error: unknown) => error,
  )
}

async function gitVault(parent: string, remote: Remote): Promise<OpenVault> {
  const root = join(parent, remote)
  const settings = join(root, '.holi', 'settings')
  await mkdir(settings, { recursive: true })
  await writeFile(join(settings, 'plugins.yaml'), 'plugins:\n  holis: true\n')
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(parent, 'unused-git-config'),
    GIT_AUTHOR_NAME: 'Owned Host Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Owned Host Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
  await runGit(root, ['init', '--quiet', '--template='], { env })
  const repo = openRepo(root, { env })
  await repo.commitAll('fixture settings', ['.holi/settings/plugins.yaml'])
  return {
    remote,
    root: await realpath(root),
    repo,
    // This local repository has no sync loop or remote traffic to pause or drain.
    pause: () => {},
    resume: () => {},
    drainSync: async () => {},
    commitNow: async () => repo.commitAll('fixture turn', (await repo.status()).dirtyPaths),
  }
}

async function rig() {
  const temp = await mkdtemp(join(tmpdir(), 'holi-owned-host-'))
  cleanups.push(() => rm(temp, { recursive: true, force: true, maxRetries: 5 }))
  const userData = join(await realpath(temp), 'user-data')
  const codexHome = join(userData, 'fixture-codex')
  const auth = join(codexHome, 'auth.json')
  const env = {
    CODEX_HOME: codexHome,
    HOLI_CODEX_BIN: process.execPath,
    HOLI_CLAUDE_BIN: process.execPath,
    OPENAI_API_KEY: undefined,
    CODEX_API_KEY: undefined,
  }
  const previous = Object.keys(env).map((key) => [key, process.env[key]] as const)
  cleanups.push(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const kill = process.kill
  const pidGuard = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (Math.abs(pid) === fakePid) return unexpectedPidOperation()
    return kill(pid, signal)
  })
  cleanups.push(() => {
    pidGuard.mockRestore()
  })
  await mkdir(codexHome, { recursive: true })
  await writeFile(auth, disposableAuth)
  await writeFile(
    join(codexHome, 'config.toml'),
    'model = "fixture-model"\napproval_policy = "on-request"\n',
  )
  const vaults = { [A]: await gitVault(temp, A), [B]: await gitVault(temp, B) }
  const scratch = {
    [A]: (await agentScratchRoots(userData, vaults[A])).jobs,
    [B]: (await agentScratchRoots(userData, vaults[B])).jobs,
  }
  const rootFor = async (remote: string) => vaults[remote as Remote]?.root ?? null
  const registry = createCapabilityRegistry()
  const capabilities = createCapabilityHost({
    registry,
    rootFor,
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async (id, root, allowDrain) => (await host.serving(root, allowDrain)).has(id),
    claims: (root) => host.scanClaimsFor(root),
  })
  const bridge = createBridgeServer({
    cli: {
      dispatch: capabilities.dispatch,
      commands: (remote) => registry.commands(remote),
      rootFor,
    },
  })
  cleanups.push(() => bridge.stop())
  await bridge.start()
  const host = createPluginHost({
    plugins: [agentMain, holisMain],
    registry,
    userData,
    coreSeeds: [],
    active: () => null,
    rootFor,
    events: { send: () => {}, listen: () => () => {}, liveRemote: () => null },
    openAppDoor: capabilities.openAppDoor,
    route: (path, route, remote) => bridge.route(path, route, remote),
    binDir: () => userData,
    githubToken: () => null,
    frameOrigin: () => () => {},
    notify: () => false,
    focused: () => false,
    call: async (remote, name, params, beforeInvoke, finalization) =>
      (
        await capabilities.dispatch(
          { door: 'ui', remote, name, params, beforeInvoke },
          finalization,
        )
      ).value,
  })
  cleanups.push(async () => {
    const failures = native.children.flatMap((child) =>
      child.failure ? [{ cwd: child.cwd, proof: child.failure }] : [],
    )
    if (failures.length === 0) {
      await host.stopAll()
      return
    }
    const error = await rejected(host.stopAll())
    expect(failures).toHaveLength(1)
    const { cwd, proof } = failures[0]!
    const remote = remotes.find(
      (remote) => cwd === vaults[remote].root || dirname(cwd) === scratch[remote],
    )
    if (remote === undefined) throw new Error('Failed receipt has no originating vault')
    const scoped = onlyFailure(error, 'one or more plugin lifetimes failed to stop')
    const original = vaultStopCause(scoped, remote)
    const retained = failureLeaves(original)
    if (cwd !== vaults[remote].root) {
      expectProof(original, proof)
    } else if (process.platform === 'win32') {
      expect(retained).toContain(proof.receipt)
      expect(retained).toContain(proof.receipt.cause)
    } else {
      expect(retained).toContain(proof.receipt)
      expect(retained).toContainEqual(expect.objectContaining({ cause: proof.receipt }))
    }
    expect(await rejected(host.stop(remote))).toBe(scoped)
  })
  await host.reconcile(vaults[A], 'open')
  await host.reconcile(vaults[B], 'open')
  const call = async <T = unknown>(remote: Remote, name: string, params: unknown = {}) =>
    (await capabilities.dispatch({ door: 'ui', remote, name, params })).value as T
  const rows = (remote: Remote) => call<SessionSummary[]>(remote, 'agent.sessions')
  for (const remote of remotes) expect(await rows(remote)).toEqual([])

  async function job(remote: Remote, name: string, read: string[] = [], write = ['same.md']) {
    const result = await call<{ ok: true; sessionId: string } | { ok: false; message: string }>(
      remote,
      'agent.job',
      {
        provider: 'codex',
        name,
        prompt: '- fixture prompt',
        scope: { read, write },
      },
    )
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      sessionId: expect.stringMatching(/^j[0-9a-f]{12}$/),
    })
    if (!result.ok) throw new Error(result.message)
    const id = result.sessionId
    const cwd = await realpath(join(scratch[remote], id))
    const children = native.children.filter((child) => child.cwd === cwd)
    expect(children).toHaveLength(1)
    return {
      id,
      name,
      remote,
      child: children[0]!,
      home: join(dirname(cwd), `${id}.agent`, 'codex-home'),
    }
  }
  return {
    userData,
    codexHome,
    auth,
    vaults,
    scratch,
    host,
    bridge,
    call,
    dispatch: capabilities.dispatch,
    job,
    rows,
    http: (remote: Remote, ...argv: string[]) =>
      httpCall(bridge, bridge.tokenForVault(remote), argv),
  }
}

type Fixture = Awaited<ReturnType<typeof rig>>
type Job = Awaited<ReturnType<Fixture['job']>>

function httpCall(bridge: BridgeServer, token: string, argv: string[]) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: bridge.port()!,
        path: `/cli?t=${token}`,
        method: 'POST',
        agent: false,
      },
      (res) => {
        res.setEncoding('utf8')
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('error', reject)
        res.on('end', () => resolve({ status: res.statusCode!, body }))
      },
    )
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(new Error('Bridge fixture request timed out')))
    req.end(new URLSearchParams(argv.map((arg) => ['argv', arg])).toString())
  })
}

async function cliRefuses(
  f: Fixture,
  remote: Remote,
  namespace: string,
  verb: string,
  ...args: string[]
) {
  const reply = await f.http(remote, namespace, verb, ...args)
  expect(reply.status).toBe(400)
  expect(reply.body.split('\n')[0]).toBe(`holi: no such command: ${namespace} ${verb}`)
}

async function httpRows(f: Fixture, remote: Remote) {
  const reply = await f.http(remote, 'agent', 'sessions', '--json')
  expect(reply.status, reply.body).toBe(200)
  return JSON.parse(reply.body) as SessionSummary[]
}

function safeArgs(args: readonly string[]) {
  for (const flag of [
    '--dangerously-skip-permissions',
    '--dangerously-bypass-approvals-and-sandbox',
    '--yolo',
    '--no-sandbox',
  ]) {
    expect(args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))).toBe(false)
  }
}

function exitCodex(child: FakeNativeChild) {
  child.codexTurn()
  child.exit()
  child.endOutput()
  child.close()
}

async function working(f: Fixture, job: Job, drainedOutput = false) {
  await vi.waitFor(async () => {
    const rows = await f.rows(job.remote)
    expect(rows).toEqual([
      expect.objectContaining({
        id: job.id,
        name: job.name,
        state: 'working',
        ...(drainedOutput ? { usage: { total: 3 } } : {}),
      }),
    ])
    expect(rows[0]).not.toHaveProperty('outcome')
    expect(rows[0]).not.toHaveProperty('error')
  })
}

async function completed(f: Fixture, job: Job) {
  await vi.waitFor(async () => {
    expect(await f.rows(job.remote)).toEqual([
      expect.objectContaining({ id: job.id, state: 'idle', outcome: 'completed' }),
    ])
    expect(await readdir(f.scratch[job.remote])).toEqual([])
  })
  expect(job.child.resourcesReleased).toBe(true)
}

afterEach(async () => {
  const errors: unknown[] = []
  const bestEffort = async (dispose: () => void | Promise<void>) => {
    try {
      await dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  for (const child of native.children) await bestEffort(() => child.dispose())
  for (const dispose of cleanups.splice(0).reverse()) await bestEffort(dispose)
  native.children.length = 0
  native.claude.length = 0
  await bestEffort(() => {
    expect(native.background.size).toBe(0)
  })
  native.background.clear()
  if (errors.length > 0) throw new AggregateError(errors, 'Owned host fixture cleanup failed')
})

let gitTemp: string | undefined
beforeAll(async () => {
  // This module owns the first initialization of the cached Git helper.
  gitTemp = dirname(await ensureAskpass())
})
afterAll(async () => {
  if (gitTemp !== undefined) await rm(gitTemp, { recursive: true, force: true, maxRetries: 5 })
})

describe.skipIf(process.platform !== 'win32')(
  'owned process receipts through real agent host',
  () => {
    it('launches Pi through the UI door and refuses the same launch through CLI', async () => {
      const f = await rig()
      expect(
        await f.call(A, 'agent.launch', {
          provider: 'pi',
          name: 'Pi owned run',
          prompt: 'answer',
          tools: 'none',
        }),
      ).toMatchObject({ ok: true })
      expect(native.children).toHaveLength(1)
      const child = native.children[0]!
      expect(child.cwd).toBe(f.vaults[A].root)
      expect(child.args).toEqual([
        '--mode',
        'rpc',
        '--no-tools',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--no-mcp',
        '--no-approve',
      ])
      safeArgs(child.args)
      for (const remote of remotes)
        await cliRefuses(f, remote, 'agent', 'launch', 'CLI must not launch', 'answer')
      expect(native.children).toHaveLength(1)
    })

    it('routes UI agent.job through PluginHost and CapabilityHost, while authenticated HTTP cli sees sessions and refuses job creation', async () => {
      const f = await rig()
      const [a, b] = await Promise.all([f.job(A, 'owned job'), f.job(B, 'owned job')])
      expect(a.id).not.toBe(b.id)
      expect(f.bridge.tokenForVault(A)).not.toBe(f.bridge.tokenForVault(B))
      expect(
        (await httpCall(f.bridge, 'invalid-fixture-token', ['agent', 'sessions', '--json'])).status,
      ).toBe(403)
      const crossVault = await f.http(A, 'agent', 'sessions', '--json', '--vault', B)
      expect(crossVault).toEqual({
        status: 422,
        body: 'holi: a vault-local credential cannot select another vault',
      })
      for (const job of [a, b]) {
        expect(await httpRows(f, job.remote)).toEqual([
          expect.objectContaining({
            id: job.id,
            name: job.name,
            state: 'working',
            provider: 'codex',
          }),
        ])
        expect(job.child.cwd).toBe(join(f.scratch[job.remote], job.id))
        await cliRefuses(f, job.remote, 'agent', 'job', 'owned job', 'run')
      }
      expect(native.children).toHaveLength(2)
      for (const job of [a, b]) {
        exitCodex(job.child)
        job.child.proveEmpty()
      }
      await Promise.all([completed(f, a), completed(f, b)])
    })

    it('holds completion and finalization to the originating vault despite concurrent same-host work', async () => {
      const f = await rig()
      const [a, b] = await Promise.all([f.job(A, 'A'), f.job(B, 'B')])
      // A has root exit/output but no proof; B has proof/root exit but still holds output.
      exitCodex(a.child)
      b.child.codexTurn()
      b.child.exit()
      b.child.proveEmpty()
      await Promise.all([working(f, a, true), working(f, b, true)])
      a.child.proveEmpty()
      await completed(f, a)
      await working(f, b, true)
      b.child.endOutput()
      await completed(f, b)
      expect(b.child.closed).toBe(false) // ordinary empty ownership doesn't need helper close
    })

    it('copies back each held Windows job only to its own vault after authenticated empty receipts', async () => {
      const f = await rig()
      const fileA = join(f.vaults[A].root, 'same.md')
      const fileB = join(f.vaults[B].root, 'same.md')
      await writeFile(fileA, 'original A')
      await writeFile(fileB, 'original B')
      const [a, b] = await Promise.all([
        f.job(A, 'same caller', ['same.md']),
        f.job(B, 'same caller', ['same.md']),
      ])
      for (const [job, label] of [
        [a, 'A'],
        [b, 'B'],
      ] as const) {
        const { child, home, remote } = job
        expect(child.bin).toBe(process.execPath)
        expect(child.args).toEqual([
          'exec',
          '--json',
          '--skip-git-repo-check',
          '-C',
          child.cwd,
          '--sandbox',
          'workspace-write',
          '-c',
          'approval_policy="never"',
          '-c',
          'sandbox_workspace_write.network_access=false',
          '-c',
          'web_search="disabled"',
          '-c',
          'tools.web_search=false',
          '--',
          '- fixture prompt',
        ])
        safeArgs(child.args)
        expect(child.env['CODEX_HOME']).toBe(home)
        expect(home).not.toBe(f.codexHome)
        expect(child.env['HOLI_AGENT_SESSION']).toBeUndefined()
        expect(parse(await readFile(join(home, 'config.toml'), 'utf8'))).toEqual({
          model: 'fixture-model',
          cli_auth_credentials_store: 'file',
          projects: Object.fromEntries(
            [child.cwd, f.scratch[remote], f.vaults[remote].root].map((path) => [
              path,
              { trust_level: 'untrusted' },
            ]),
          ),
        })
        expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(disposableAuth)
        const scratchFile = join(child.cwd, 'same.md')
        expect(await readFile(scratchFile, 'utf8')).toBe(`original ${label}`)
        await writeFile(scratchFile, `written ${label}`)
      }
      // Simulate Codex's refresh of the synthetic sign-in; its real release runs only after proof.
      await writeFile(join(b.home, 'auth.json'), refreshedAuth)
      exitCodex(a.child)
      exitCodex(b.child)
      await Promise.all([working(f, a, true), working(f, b, true)])
      expect(await readFile(fileA, 'utf8')).toBe('original A')
      expect(await readFile(fileB, 'utf8')).toBe('original B')
      expect(await readFile(f.auth, 'utf8')).toBe(disposableAuth)
      expect(a.child.resourcesReleased || b.child.resourcesReleased).toBe(false)

      b.child.proveEmpty()
      await completed(f, b)
      expect(await readFile(f.auth, 'utf8')).toBe(refreshedAuth)
      expect(await readFile(fileB, 'utf8')).toBe('written B')
      expect(await readFile(fileA, 'utf8')).toBe('original A')
      await working(f, a, true)

      a.child.proveEmpty()
      await completed(f, a)
      expect(await readFile(fileA, 'utf8')).toBe('written A')
      expect(await readFile(fileB, 'utf8')).toBe('written B')
      expect(await readFile(f.auth, 'utf8')).toBe(refreshedAuth)
    })

    // Keep the title consumed by strict Windows CI. Physical close is not proof:
    // this checks the refusal on both sides of it, not permission after it.
    it('retains a receipt failure before and after physical close', async () => {
      const f = await rig()
      const job = await f.job(A, 'pending proof')
      const { child, id } = job
      await working(f, job)
      const current = rejected(f.call(A, 'agent.stop', { id }))
      const concurrent = rejected(f.call(A, 'agent.stop', { id }))
      const stops = Promise.all([current, concurrent])
      void stops.catch(() => {}) // observed now, asserted after injecting the receipt failure
      await vi.waitFor(() => expect(child.stopRequests).toBe(1))
      await tick()
      child.exit()
      const cause = new NativeProofFailure('native drain proof rejected while output was pending')
      const expected = child.rejectProof(cause, new Error('earlier command transport error'))
      let settled: unknown[] | undefined
      void stops.then(
        (errors) => {
          settled = errors
        },
        () => {},
      )
      // This wait is shorter than both the shared output deadline and the stop deadline.
      await vi.waitFor(() => expect(settled).toHaveLength(2))
      const original = expectProof(settled![0], expected)
      expect(settled![1]).toBe(original)
      expect(child.stopRequests).toBe(1)
      expect(child.closed).toBe(false)
      expect(child.stdout.writableEnded || child.stderr.writableEnded).toBe(false)
      const failedRows = [
        expect.objectContaining({ id, state: 'idle', outcome: 'failed', error: proofMessage }),
      ]
      expect(await f.rows(A)).toEqual(failedRows)
      child.endOutput()
      child.close()
      child.releaseResources()
      expect(await rejected(f.call(A, 'agent.stop', { id }))).toBe(original)
      expect(await f.rows(A)).toEqual(failedRows)
    })

    it('retains a receipt failure through repeated stop and blocked restart while the other vault remains usable', async () => {
      const f = await rig()
      const job = await f.job(A, 'failed A')
      await writeFile(join(job.child.cwd, 'same.md'), 'must not copy into A')
      exitCodex(job.child)
      await working(f, job, true)
      const retained = (await readdir(f.scratch[A])).sort()
      expect(retained).toHaveLength(3)
      expect(retained).toEqual(
        expect.arrayContaining([
          job.id,
          `${job.id}.agent`,
          expect.stringMatching(new RegExp(`^${job.id}\\.[0-9a-f]{12}\\.owned$`)),
        ]),
      )
      const expected = job.child.rejectProof(new NativeProofFailure('native ownership unavailable'))
      const stop = () => rejected(f.call(A, 'agent.stop', { id: job.id }))
      const original = expectProof(await stop(), expected)
      expect(await stop()).toBe(original)
      expect(await httpRows(f, A)).toEqual([
        expect.objectContaining({
          id: job.id,
          state: 'idle',
          outcome: 'failed',
          error: proofMessage,
        }),
      ])
      // Scope stop caches the outer error. The still-open job's stop returned
      // the original typed error, which must remain inside that wrapper.
      const scoped = await rejected(f.host.stop(A))
      expect(expectProof(vaultStopCause(scoped, A), expected)).toBe(original)
      expect(await rejected(f.host.reconcile(f.vaults[A], 'open'))).toBe(scoped)
      expect(await rejected(f.host.stop(A))).toBe(scoped)
      await expect(f.call(A, 'agent.sessions')).rejects.toThrow('no such method: agent.sessions')
      await expect(
        f.call(A, 'agent.job', {
          provider: 'codex',
          name: 'blocked',
          prompt: 'run',
          scope: { read: [], write: ['same.md'] },
        }),
      ).rejects.toThrow('no such method: agent.job')
      await cliRefuses(f, A, 'agent', 'sessions', '--json')
      expect(native.children).toHaveLength(1)
      expect(job.child.resourcesReleased).toBe(false)

      const b = await f.job(B, 'fresh B')
      await writeFile(join(b.child.cwd, 'same.md'), 'only B')
      exitCodex(b.child)
      b.child.proveEmpty()
      await completed(f, b)
      expect(await httpRows(f, B)).toEqual([
        expect.objectContaining({ id: b.id, state: 'idle', outcome: 'completed' }),
      ])
      expect(await readFile(join(f.vaults[B].root, 'same.md'), 'utf8')).toBe('only B')
      await expect(readFile(join(f.vaults[A].root, 'same.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect((await readdir(f.scratch[A])).sort()).toEqual(retained)
    })

    it('keeps approved Claude launches and same-id HTTP rows bound to their own vaults', async () => {
      const f = await rig()
      const definitions = new Map<Remote, HoliSummary>()
      for (const [remote, label] of [
        [A, 'A'],
        [B, 'B'],
      ] as const) {
        await writeFile(join(f.vaults[remote].root, 'same.md'), `document ${label}`)
        const definition = await f.call<HoliSummary>(remote, 'holis.create', {
          name: 'Fixture reviewer',
          allow: ['Read(same.md)'],
        })
        expect(definition).toMatchObject({ status: 'new', provider: 'claude' })
        definitions.set(remote, definition)
        const { id, fingerprint } = definition
        if (fingerprint === undefined) throw new Error('Created Holi has no approval fingerprint')
        await cliRefuses(f, remote, 'holis', 'create', 'Fixture reviewer')
        await cliRefuses(f, remote, 'holis', 'approve', id, fingerprint)
        await cliRefuses(f, remote, 'holis', 'send', id, 'same.md')
      }
      const send = (remote: Remote, path = 'same.md') =>
        f.call(remote, 'holis.send', { holi: definitions.get(remote)!.id, path })
      const approve = (remote: Remote) => {
        const { id, fingerprint } = definitions.get(remote)!
        return f.call(remote, 'holis.approve', { holi: id, fingerprint })
      }
      expect(definitions.get(A)!.path).toBe(definitions.get(B)!.path)
      expect(definitions.get(A)!.fingerprint).toBe(definitions.get(B)!.fingerprint)
      await expect(send(A)).rejects.toThrow('not approved on this machine yet')
      expect(await approve(A)).toMatchObject({ status: 'approved', provider: 'claude' })
      await expect(send(B)).rejects.toThrow('not approved on this machine yet')
      expect(native.claude.filter(({ args }) => args[0] === '--bg')).toEqual([])
      expect(await approve(B)).toMatchObject({ status: 'approved', provider: 'claude' })

      // Distinct document names make a leaked same-id row observable in HTTP JSON.
      await writeFile(join(f.vaults[B].root, 'other.md'), 'document B')
      expect(await send(A)).toEqual({ sessionId: claudeId })
      expect(await send(B, 'other.md')).toEqual({ sessionId: claudeId })
      const launches = native.claude.filter(({ args }) => args[0] === '--bg')
      expect(launches).toHaveLength(2)
      const persisted = JSON.parse(
        await readFile(join(f.userData, 'holis.json'), 'utf8'),
      ) as unknown
      const configFor = (remote: Remote) =>
        join(f.userData, 'agent-config', agentConfigSlug(remote))
      const claudeRows = (name: string): SessionSummary[] => [
        { id: claudeId, provider: 'claude', name, state: 'idle', conversationId: threadId },
      ]
      for (const [remote, path, name] of [
        [A, 'same.md', 'Fixture reviewer · same'],
        [B, 'other.md', 'Fixture reviewer · other'],
      ] as const) {
        const root = f.vaults[remote].root
        const scopedLaunches = launches.filter(({ cwd }) => cwd === root)
        expect(scopedLaunches).toHaveLength(1)
        const launch = scopedLaunches[0]!
        expect(launch.config).toBe(configFor(remote))
        expect(launch.args).toContain('--allowedTools=Read(same.md)')
        expect(launch.args.slice(-2)).toEqual(['--', `Work on ${path}.`])
        safeArgs(launch.args)
        expect(await httpRows(f, remote)).toEqual(claudeRows(name))
        await cliRefuses(f, remote, 'agent', 'stop', claudeId)
        expect(persisted).toHaveProperty([remote, definitions.get(remote)!.path], {
          approved: definitions.get(remote)!.fingerprint,
          runs: [expect.objectContaining({ jobId: claudeId, path })],
        })
      }
      await f.host.stop(A)
      expect(native.claude.filter(({ args }) => args[0] === 'stop')).toEqual([
        { args: ['stop', claudeId], cwd: f.vaults[A].root, config: configFor(A) },
      ])
      expect(native.background.has(f.vaults[A].root)).toBe(false)
      expect(native.background.has(f.vaults[B].root)).toBe(true)
      await cliRefuses(f, A, 'agent', 'sessions', '--json')
      await f.host.reconcile(f.vaults[A], 'open')
      expect(await httpRows(f, A)).toEqual([])
      expect(await httpRows(f, B)).toEqual(claudeRows('Fixture reviewer · other'))
      expect(await f.call(A, 'holis.list')).toEqual([
        expect.objectContaining({
          status: 'approved',
          runs: [expect.objectContaining({ jobId: claudeId, path: 'same.md' })],
        }),
      ])
    })
  },
)

function failureLeaves(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(failureLeaves) : [error]
}

// These scenarios cross the production Settings UI door and authenticated HTTP
// transport; only the owned native program is controlled by the fixture.
describe('Settings Test through real activation and capability hosts', () => {
  async function settingsRig() {
    const f = await rig()
    await f.call(A, 'agent.harnessSave', {
      create: true,
      harness: {
        id: 'fixture',
        label: 'Fixture',
        command: { bin: process.execPath, args: [] },
        test: ['--version', 'fixture argument'],
        env: { FIXTURE_PROBE: 'preserved' },
      },
    })
    async function probe(remote: Remote) {
      const previous = native.children.length
      const answer = f.call(remote, 'agent.harnessTest', { id: 'fixture' })
      void answer.catch(() => {})
      await vi.waitFor(() => expect(native.children.length).toBe(previous + 1))
      return { answer, child: native.children[previous]! }
    }
    return { ...f, probe }
  }

  it('cancels and drains A without cancelling B, then admits a replacement with the same harness id', async () => {
    const f = await settingsRig()
    const a = await f.probe(A)
    const b = await f.probe(B)
    for (const [remote, child] of [
      [A, a.child],
      [B, b.child],
    ] as const) {
      expect(child.cwd).toBe(f.vaults[remote].root)
      expect(child.bin).toBe(process.execPath)
      expect(child.args).toEqual(['--version', 'fixture argument'])
      expect(child.env['FIXTURE_PROBE']).toBe('preserved')
      safeArgs(child.args)
      await cliRefuses(f, remote, 'agent', 'harnessTest', 'fixture')
      expect(await httpRows(f, remote)).toEqual([])
    }
    let stopped = false
    const stop = f.host.stop(A).then(() => {
      stopped = true
    })
    await vi.waitFor(() =>
      expect(
        process.platform === 'win32' ? a.child.stopRequests : a.child.drainRequests,
      ).toBeGreaterThan(0),
    )
    await expect(f.call(A, 'agent.harnessTest', { id: 'fixture' })).rejects.toThrow()
    a.child.exit()
    a.child.endOutput()
    a.child.close()
    await tick()
    expect(stopped).toBe(false)
    expect(b.child.stopRequests).toBe(0)
    expect(b.child.drainRequests).toBe(0)
    a.child.proveEmpty()
    await expect(a.answer).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/cancel/i),
    })
    await stop
    await f.host.reconcile(f.vaults[A], 'open')
    const replacement = await f.probe(A)
    replacement.child.stdout.write('replacement version\n')
    replacement.child.exit()
    replacement.child.endOutput()
    replacement.child.close()
    replacement.child.proveEmpty()
    await expect(replacement.answer).resolves.toEqual({ ok: true, output: 'replacement version\n' })
    b.child.stdout.write('original B version\n')
    b.child.exit()
    b.child.endOutput()
    b.child.close()
    b.child.proveEmpty()
    await expect(b.answer).resolves.toEqual({ ok: true, output: 'original B version\n' })
  })

  it('rejects delayed dispatch from A after stop and same-id restart without launching against the replacement', async () => {
    const f = await settingsRig()
    let resume!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      resume = resolve
    })
    const admission = new Promise<void>((resolve) => {
      entered = resolve
    })
    const stale = rejected(
      f.dispatch({
        door: 'ui',
        remote: A,
        name: 'agent.harnessTest',
        params: { id: 'fixture' },
        beforeInvoke: async () => {
          entered()
          await waiting
        },
      }),
    )
    try {
      await admission
      await f.host.stop(A)
      await f.host.reconcile(f.vaults[A], 'open')
    } finally {
      resume()
    }
    expect(await stale).toBeInstanceOf(Error)
    expect(native.children).toHaveLength(0)
    for (const remote of remotes) {
      const next = await f.probe(remote)
      next.child.exit()
      next.child.endOutput()
      next.child.close()
      next.child.proveEmpty()
      await expect(next.answer).resolves.toMatchObject({ ok: true })
      expect(await httpRows(f, remote)).toEqual([])
    }
  })

  it('retains the original failed cleanup through repeated stop and restart without waiting for root close', async () => {
    const f = await settingsRig()
    const a = await f.probe(A)
    const b = await f.probe(B)
    const stopping = rejected(f.host.stop(A))
    await vi.waitFor(() =>
      expect(
        process.platform === 'win32' ? a.child.stopRequests : a.child.drainRequests,
      ).toBeGreaterThan(0),
    )
    const expected = a.child.rejectProof(
      new NativeProofFailure('fixture physical cleanup unavailable'),
    )
    const error = await rejected(a.answer)
    if (process.platform === 'win32') expectProof(error, expected)
    else
      expect(error).toMatchObject({
        cause: expected.receipt,
        authority: a.child[ownedProcessDrain],
      })
    const original = await stopping
    const retained = failureLeaves(vaultStopCause(original, A))
    expect(retained).toContain(error)
    expect(retained).toContain(
      process.platform === 'win32' ? expected.receipt.cause : expected.receipt,
    )
    expect(a.child.closed).toBe(false)
    expect(a.child.exited).toBe(false)
    expect(await rejected(f.host.stop(A))).toBe(original)
    expect(await rejected(f.host.reconcile(f.vaults[A], 'open'))).toBe(original)
    await expect(f.call(A, 'agent.harnessTest', { id: 'fixture' })).rejects.toThrow()
    b.child.stdout.write('B unaffected\n')
    b.child.exit()
    b.child.endOutput()
    b.child.close()
    b.child.proveEmpty()
    await expect(b.answer).resolves.toEqual({ ok: true, output: 'B unaffected\n' })
    expect(await httpRows(f, B)).toEqual([])
  })
})
