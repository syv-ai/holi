/**
 * Jobs (`host/jobs.ts`) and `agent.job`: a prompt run unwatched by a provider
 * without a supervisor, in a scratch folder, with only what it wrote inside
 * its scope copied back. Codex is not on the test machine, so its process is
 * a small node script that prints the JSONL `codex exec --json` does.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownedProcessDrain } from '../../../main/plugin-api'
import type { CapabilityContext } from '../../../main/capabilities/registry'
import { markPosixNonAdmission } from '../../../main/posix-ownership-journal'
import { codexProvider, fenceArgs, jobArgs, readJobEvent } from '../main/codex'
import { createFencedSessions } from '../main/host/fenced'
import { activationOwnership } from '../main/host/ownership'
import type { Fence } from '../main/host/pty-sessions'
import { agentCapabilities, scopeRules } from '../main/host/capabilities'
import {
  createJobs,
  inWriteScope,
  takenMessage,
  vaultSandbox,
  type JobScope,
} from '../main/host/jobs'
import type { SessionSummary } from '../main/claude/listing'
import type { AgentProvider, JobRun, JobsProvider } from '../main/provider'
import { trackedJobProcesses } from './fixtures/tracked-job-processes'

// Hold a queued publication without holding compensating links from `previous`.
let queuePublication: ((publish: () => Promise<void>) => Promise<void>) | undefined
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    link: (...args: Parameters<typeof fs.link>) =>
      queuePublication && String(args[0]).includes('/.holi-tmp-')
        ? queuePublication(() => fs.link(...args))
        : fs.link(...args),
  }
})

const dirs: string[] = []
const owned: Array<{
  jobs: ReturnType<typeof createJobs>
  tracked: ReturnType<typeof trackedJobProcesses>
}> = []
afterEach(async () => {
  const entries = owned.splice(0)
  await Promise.all(entries.map(({ tracked }) => tracked.drain()))
  await Promise.allSettled(entries.map(({ jobs }) => jobs.leave()))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const temp = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  )

/** The person's own Codex folder: signed in, a model chosen, and an MCP
 *  server a run must not get. */
const PERSON_CONFIG = [
  'model = "gpt-5.5"',
  '',
  '[mcp_servers.synthetic]',
  'command = "echo"',
  'enabled = true',
  '',
].join('\n')
const PERSON_AUTH = JSON.stringify({ tokens: { access_token: 'old', refresh_token: 'r' } })

async function personHome(): Promise<string> {
  const home = await temp('holi-codex-home-')
  await writeFile(join(home, 'config.toml'), PERSON_CONFIG)
  await writeFile(join(home, 'auth.json'), PERSON_AUTH)
  return home
}

const event = (o: unknown) => `console.log(${JSON.stringify(JSON.stringify(o))})`

/** What a successful run does: reads the note it was given, writes an app
 *  beside it, and some things it may not. */
const SUCCESS = [
  "const fs = require('node:fs')",
  event({ type: 'thread.started', thread_id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51' }),
  event({ type: 'turn.started' }),
  "const note = fs.readFileSync('notes/Plan.md', 'utf8')",
  "fs.mkdirSync('notes/Plan.app', { recursive: true })",
  "fs.writeFileSync('notes/Plan.app/index.html', '<h1>' + note.trim() + '</h1>')",
  "fs.writeFileSync('notes/Plan.app/app.yaml', 'description: The plan\\n')",
  // Outside the scope: neither may reach the vault.
  "fs.writeFileSync('notes/Plan.md', 'rewritten')",
  "fs.writeFileSync('stray.txt', 'no')",
  // A link could point anywhere: never followed back.
  "fs.symlinkSync('/etc/hosts', 'notes/Plan.app/hosts')",
  // In scope, but not the vault's shared content: never copied back.
  "fs.writeFileSync('notes/Plan.app/.hidden', 'no')",
  "fs.writeFileSync('notes/Plan.app/me.local.md', 'no')",
  "fs.writeFileSync('notes/Plan.app/.env', 'TOKEN=no')",
  "fs.mkdirSync('notes/Plan.app/sub', { recursive: true })",
  "fs.writeFileSync('notes/Plan.app/sub/AGENTS.md', 'no')",
  "fs.writeFileSync('notes/Plan.app/claude.md', 'no')",
  event({ type: 'turn.completed', usage: {} }),
].join('\n')

const FAILED = [
  "require('node:fs').mkdirSync('notes/Plan.app', { recursive: true })",
  "require('node:fs').writeFileSync('notes/Plan.app/index.html', 'half')",
  event({ type: 'turn.started' }),
  event({ type: 'turn.failed', error: { message: 'The model refused.' } }),
].join('\n')

const CRASH = "console.error('boom: no sign-in'); process.exit(3)"

const HANG = [event({ type: 'turn.started' }), 'setInterval(() => {}, 1000)'].join('\n')

const SCOPE: JobScope = { read: ['notes/Plan.md'], write: ['notes/Plan.app/**'] }

/** A successful run that writes `count` files of `size` bytes in scope. */
const WRITES = (count: number, size: number) =>
  [
    "const fs = require('node:fs')",
    event({ type: 'turn.started' }),
    "fs.mkdirSync('notes/Plan.app', { recursive: true })",
    `for (let i = 0; i < ${count}; i++) fs.writeFileSync('notes/Plan.app/f' + i + '.txt', Buffer.alloc(${size}, 97))`,
    "fs.writeFileSync('notes/Plan.app/app.yaml', 'description: x\\n')",
    event({ type: 'turn.completed' }),
  ].join('\n')

/** A provider whose job is `node <script>`, read as Codex's events. */
function scripted(script: string): JobsProvider {
  return {
    id: 'codex',
    label: 'Codex',
    notInstalled: 'Codex is not installed.',
    installed: () => true,
    configure: async () => ({ dir: '/nowhere' }),
    terminal: () => null,
    capabilities: {
      jobs: {
        command: () => ({
          bin: process.execPath,
          args: [script],
          env: { PATH: process.env.PATH ?? '' },
        }),
        event: readJobEvent,
      },
    },
  }
}

async function rig(
  body: string,
  opts: {
    keepMs?: number
    afterWrite?: (rel: string) => Promise<void> | void
    activationSignal?: AbortSignal
    bracket?: (id: string, edge: 'begin' | 'end' | 'forget') => unknown | Promise<unknown>
    scratchRoot?: string
  } = {},
) {
  const root = await temp('holi-job-vault-')
  const userData = await temp('holi-job-data-')
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(root, 'notes/Plan.md'), 'Ship it\n')
  const script = join(userData, 'fake-codex.js')
  await writeFile(script, body)
  const lists: SessionSummary[][] = []
  const tracked = trackedJobProcesses(userData)
  const jobs = createJobs({
    vault: { remote: 'syv/vault', root },
    scratchRoot: opts.scratchRoot ?? join(userData, 'agent-jobs'),
    onChange: (list) => lists.push(list),
    killGraceMs: 200,
    spawn: tracked.spawn,
    log: () => {},
    ...(opts.bracket === undefined ? {} : { bracket: opts.bracket }),
    ...opts,
  })
  owned.push({ jobs, tracked })
  const ended = (id: string) =>
    vi.waitFor(
      () => {
        const row = jobs.sessions().find((s) => s.id === id)
        if (row?.outcome === undefined) throw new Error('still running')
        return row
      },
      { timeout: 5_000 },
    )
  return { root, userData, script, jobs, lists, ended, provider: scripted(script) }
}

describe('a job', () => {
  it('reports an initial sweep failure without an unowned rejection', async () => {
    const userData = await temp('holi-job-data-')
    const blocker = join(userData, 'not-a-directory')
    await writeFile(blocker, 'file')
    const { jobs, provider } = await rig(SUCCESS, { scratchRoot: join(blocker, 'jobs') })
    await expect(
      jobs.start({ provider, name: 'x', prompt: 'go', scope: SCOPE }),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('sweep') })
  })

  it('runs in a scratch folder and copies back only what it wrote in scope', async () => {
    const { root, userData, jobs, provider, ended } = await rig(SUCCESS)
    const started = await jobs.start({
      provider,
      name: 'Plan: vault app',
      prompt: 'go',
      scope: SCOPE,
    })
    expect(started.ok).toBe(true)
    const id = (started as { sessionId: string }).sessionId
    expect(id).toMatch(/^j[0-9a-f]{12}$/)
    expect(jobs.sessions()[0]).toMatchObject({ id, provider: 'codex', state: 'working' })

    const row = await ended(id)
    expect(row).toMatchObject({ state: 'idle', outcome: 'completed' })
    expect(await readFile(join(root, 'notes/Plan.app/index.html'), 'utf8')).toBe('<h1>Ship it</h1>')
    expect(await readFile(join(root, 'notes/Plan.app/app.yaml'), 'utf8')).toBe(
      'description: The plan\n',
    )
    expect(await readFile(join(root, 'notes/Plan.md'), 'utf8')).toBe('Ship it\n')
    expect(await exists(join(root, 'stray.txt'))).toBe(false)
    expect(await exists(join(root, 'notes/Plan.app/hosts'))).toBe(false)
    for (const name of ['.hidden', 'me.local.md', '.env', 'sub/AGENTS.md', 'claude.md']) {
      expect(await exists(join(root, 'notes/Plan.app', name))).toBe(false)
      expect(row.message).toContain(`notes/Plan.app/${name}`)
    }
    // Scratch and provider state are gone; the settled receipt follows the row.
    const scratch = join(userData, 'agent-jobs')
    const retained = await readdir(scratch)
    expect(retained).not.toContain(id)
    expect(retained).not.toContain(`${id}.agent`)
    expect(retained).not.toContain(`${id}.pid`)
    await jobs.stop(id)
    expect(await readdir(scratch)).toEqual([])
  })

  it('fails with the turn’s own reason, and writes nothing', async () => {
    const { root, jobs, provider, ended } = await rig(FAILED)
    const started = await jobs.start({ provider, name: 'x', prompt: 'go', scope: SCOPE })
    const row = await ended((started as { sessionId: string }).sessionId)
    expect(row).toMatchObject({ outcome: 'failed', error: 'The model refused.' })
    expect(await exists(join(root, 'notes/Plan.app/index.html'))).toBe(false)
  })

  it('fails with what a crash said on stderr', async () => {
    const { jobs, provider, ended } = await rig(CRASH)
    const started = await jobs.start({ provider, name: 'x', prompt: 'go', scope: SCOPE })
    const row = await ended((started as { sessionId: string }).sessionId)
    expect(row.outcome).toBe('failed')
    expect(row.error).toBe('Codex exited with code 3: boom: no sign-in')
  })

  it('spawns nothing once the vault is left while it gets ready', async () => {
    const root = await temp('holi-job-vault-')
    const userData = await temp('holi-job-data-')
    await mkdir(join(root, 'notes'), { recursive: true })
    await writeFile(join(root, 'notes/Plan.md'), 'Ship it\n')
    const spawn = vi.fn(() => {
      throw new Error('spawned after the vault was left')
    })
    const jobs = createJobs({
      vault: { remote: 'syv/vault', root },
      scratchRoot: join(userData, 'agent-jobs'),
      onChange: () => {},
      log: () => {},
      spawn,
    })
    const provider = scripted(join(userData, 'none.js'))
    const scratch = jobs.start({ provider, name: 'a', prompt: 'go', scope: SCOPE })
    const vault = jobs.start({ provider, name: 'b', prompt: 'go', allow: ['Edit(tilbud/**)'] })
    await jobs.leave()
    const gone = { ok: false, message: 'The vault was left before the job started.' }
    expect(await scratch).toEqual(gone)
    expect(await vault).toEqual(gone)
    expect(spawn).not.toHaveBeenCalled()
    expect(jobs.sessions()).toEqual([])
  })

  it('aborts queued follow-ups immediately when activation is invalidated', async () => {
    const activation = new AbortController()
    const body = [
      "const fs = require('node:fs')",
      "fs.appendFileSync(require('node:path').join(__dirname, 'starts'), 'x')",
      event({ type: 'thread.started', thread_id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51' }),
      event({ type: 'turn.started' }),
      'setInterval(() => {}, 1000)',
    ].join('\n')
    const { userData, jobs, provider, ended } = await rig(body, {
      activationSignal: activation.signal,
    })
    const started = await jobs.start({
      provider,
      name: 'queued',
      prompt: 'first',
      allow: ['Edit(tilbud/**)'],
    })
    const id = (started as { sessionId: string }).sessionId
    await vi.waitFor(async () => expect(await readFile(join(userData, 'starts'), 'utf8')).toBe('x'))
    jobs.message(id, 'must not run')
    activation.abort()
    expect(await ended(id)).toMatchObject({ outcome: 'failed', error: 'Stopped.' })
    expect(await readFile(join(userData, 'starts'), 'utf8')).toBe('x')
    expect(jobs.sessions()).toHaveLength(1)
    await jobs.leave()
    expect(jobs.sessions()).toEqual([])
  })

  it('is stopped by Stop, and by leaving the vault', async () => {
    const entered =
      "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'entered'), 'yes')"
    const { userData, jobs, provider, ended } = await rig(`${entered}\n${HANG}`)
    const a = await jobs.start({ provider, name: 'a', prompt: 'go', scope: SCOPE })
    const aId = (a as { sessionId: string }).sessionId
    // Stop immediately after publication, without yielding to startup polling.
    expect(await jobs.stop(aId)).toEqual({ ok: true })
    expect(await ended(aId)).toMatchObject({ outcome: 'failed', error: 'Stopped.' })
    if (process.platform !== 'win32') {
      await expect(readFile(join(userData, 'entered'))).rejects.toMatchObject({ code: 'ENOENT' })
    }

    const b = await jobs.start({ provider, name: 'b', prompt: 'go', scope: SCOPE })
    expect(b.ok).toBe(true)
    await jobs.leave()
    expect(jobs.sessions()).toEqual([])
    expect(await exists(join(userData, 'agent-jobs'))).toBe(false)
  })

  it('copies nothing back past its limits', async () => {
    for (const [count, size] of [
      [201, 1],
      [2, 11 * 1024 * 1024],
    ] as const) {
      const { root, jobs, provider, ended } = await rig(WRITES(count, size))
      const started = await jobs.start({ provider, name: 'x', prompt: 'go', scope: SCOPE })
      const row = await ended((started as { sessionId: string }).sessionId)
      expect(row.outcome).toBe('failed')
      expect(row.error).toMatch(/more than Holi copies back/)
      expect(await exists(join(root, 'notes/Plan.app/f0.txt'))).toBe(false)
      expect(await exists(join(root, 'notes/Plan.app/app.yaml'))).toBe(false)
    }
  })

  it('stops where a Stop comes in during the copy back', async () => {
    let id = ''
    let stopped: Promise<{ ok: boolean; message?: string }> | undefined
    let enterCopy!: () => void
    let resumeCopy!: () => void
    const entered = new Promise<void>((resolve) => (enterCopy = resolve))
    const continueCopy = new Promise<void>((resolve) => (resumeCopy = resolve))
    const r = await rig(WRITES(5, 1), {
      afterWrite: async () => {
        enterCopy()
        await continueCopy
      },
    })
    const started = await r.jobs.start({
      provider: r.provider,
      name: 'x',
      prompt: 'go',
      scope: SCOPE,
    })
    id = (started as { sessionId: string }).sessionId
    await entered
    let stopFinished = false
    stopped = r.jobs.stop(id).then((result) => {
      stopFinished = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stopFinished).toBe(false)
    resumeCopy()
    const row = await r.ended(id)
    expect(await stopped).toEqual({ ok: true })
    expect(row).toMatchObject({ outcome: 'failed', error: 'Stopped.' })
    // One file landed before the Stop; the finished marker never did.
    const written = (await readdir(join(r.root, 'notes/Plan.app'))).sort()
    expect(written).toHaveLength(1)
    expect(await exists(join(r.root, 'notes/Plan.app/app.yaml'))).toBe(false)
  })

  it('never writes over a file that lands between its check and its write', async () => {
    let root = ''
    // The pages are written; then, before the manifest, sync brings one.
    const r = await rig(WRITES(1, 1), {
      afterWrite: async (rel) => {
        if (rel === 'notes/Plan.app/f0.txt') {
          await writeFile(join(root, 'notes/Plan.app/app.yaml'), 'description: Theirs\n')
        }
      },
    })
    root = r.root
    const started = await r.jobs.start({
      provider: r.provider,
      name: 'x',
      prompt: 'go',
      scope: SCOPE,
    })
    const row = await r.ended((started as { sessionId: string }).sessionId)
    expect(row.outcome).toBe('failed')
    expect(row.error).toMatch(/notes\/Plan\.app\/app\.yaml: something else put it in the vault/)
    expect(await readFile(join(root, 'notes/Plan.app/app.yaml'), 'utf8')).toBe(
      'description: Theirs\n',
    )
    // Nothing of the write is left beside it.
    expect((await readdir(join(root, 'notes/Plan.app'))).sort()).toEqual(['app.yaml', 'f0.txt'])
  })

  it('does not start where what it makes is already in the vault', async () => {
    const { root, jobs, provider } = await rig(SUCCESS)
    await mkdir(join(root, 'notes/Plan.app'), { recursive: true })
    await writeFile(join(root, 'notes/Plan.app/app.yaml'), 'description: Theirs\n')
    expect(await jobs.start({ provider, name: 'x', prompt: 'go', scope: SCOPE })).toEqual({
      ok: false,
      message: takenMessage('notes/Plan.app'),
    })
  })

  it('never writes over an app that lands in the vault while it works', async () => {
    const { root, jobs, provider, ended } = await rig(
      ['setTimeout(() => {', WRITES(1, 1), '}, 300)'].join('\n'),
    )
    const started = await jobs.start({ provider, name: 'x', prompt: 'go', scope: SCOPE })
    // Sync brings the same app in meanwhile.
    await mkdir(join(root, 'notes/Plan.app'), { recursive: true })
    await writeFile(join(root, 'notes/Plan.app/app.yaml'), 'description: Theirs\n')
    const row = await ended((started as { sessionId: string }).sessionId)
    expect(row.outcome).toBe('failed')
    expect(row.error).toMatch(/notes\/Plan\.app: something else put it in the vault/)
    expect(await readFile(join(root, 'notes/Plan.app/app.yaml'), 'utf8')).toBe(
      'description: Theirs\n',
    )
    expect(await exists(join(root, 'notes/Plan.app/f0.txt'))).toBe(false)
  })

  it('leaves the list a while after it ends', async () => {
    const { jobs, provider, ended } = await rig(CRASH, { keepMs: 50 })
    const started = await jobs.start({ provider, name: 'x', prompt: 'go', scope: SCOPE })
    await ended((started as { sessionId: string }).sessionId)
    await vi.waitFor(() => expect(jobs.sessions()).toEqual([]))
  })

  it('is refused when the agent is not installed, or a file cannot be read', async () => {
    const { jobs, provider } = await rig(SUCCESS)
    const missing: JobsProvider = {
      ...provider,
      capabilities: { jobs: { ...provider.capabilities.jobs, command: () => null } },
    }
    expect(await jobs.start({ provider: missing, name: 'x', prompt: 'go', scope: SCOPE })).toEqual({
      ok: false,
      message: 'Codex is not installed.',
    })
    expect(
      await jobs.start({
        provider,
        name: 'x',
        prompt: 'go',
        scope: { read: ['notes/Gone.md'], write: [] },
      }),
    ).toEqual({ ok: false, message: 'Holi could not read notes/Gone.md.' })
  })

  it('is never given an agent’s settings folder to read, in any case', async () => {
    const { root, userData, jobs, provider } = await rig(SUCCESS)
    await mkdir(join(root, '.codex'), { recursive: true })
    await writeFile(join(root, '.codex/config.toml'), '[mcp_servers.x]\ncommand = "touch"\n')
    for (const path of ['.codex/config.toml', '.CODEX/config.toml']) {
      expect(
        await jobs.start({ provider, name: 'x', prompt: 'go', scope: { read: [path], write: [] } }),
      ).toEqual({ ok: false, message: `Holi could not read ${path}.` })
    }
    expect(await readdir(join(userData, 'agent-jobs')).catch(() => [])).toEqual([])
  })

  it('runs Codex as `codex exec`, sandboxed in the scratch folder', async () => {
    const { root, userData, jobs, ended } = await rig(SUCCESS)
    // A stand-in `codex` that checks its arguments, then runs the script.
    const argv = join(userData, 'argv.json')
    const check = join(userData, 'check.js')
    await writeFile(
      check,
      [
        "const fs = require('node:fs')",
        `fs.writeFileSync(${JSON.stringify(argv)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.CODEX_HOME, config: fs.readFileSync(process.env.CODEX_HOME + '/config.toml', 'utf8') }))`,
        // Codex refreshes its sign-in in the folder it was given.
        `fs.writeFileSync(process.env.CODEX_HOME + '/auth.json', ${JSON.stringify(JSON.stringify({ tokens: { access_token: 'new', refresh_token: 'r' } }))})`,
        `require(${JSON.stringify(join(userData, 'fake-codex.js'))})`,
      ].join('\n'),
    )
    const bin = join(userData, 'codex')
    await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${check}" "$@"\n`)
    await chmod(bin, 0o755)
    const person = await personHome()
    const codex = codexProvider({
      resolveBin: () => bin,
      base: { PATH: process.env.PATH ?? '', CODEX_HOME: person },
    }) as JobsProvider
    const started = await jobs.start({
      provider: codex,
      name: 'x',
      prompt: 'Make it',
      scope: SCOPE,
    })
    const row = await ended((started as { sessionId: string }).sessionId)
    expect(row.outcome).toBe('completed')
    const seen = JSON.parse(await readFile(argv, 'utf8')) as {
      args: string[]
      cwd: string
      home: string
      config: string
    }
    const scratch = seen.args[seen.args.indexOf('-C') + 1]!
    expect(seen.args).toEqual(jobArgs({ cwd: scratch, prompt: 'Make it' }))
    expect(scratch.startsWith(join(userData, 'agent-jobs'))).toBe(true)
    // Codex ran on a folder of the job's own, outside what it may write,
    // with none of the person's MCP servers.
    expect(seen.home).toBe(`${scratch}.agent/codex-home`)
    expect(seen.config).toContain('model = "gpt-5.5"')
    expect(seen.config).not.toContain('mcp_servers')
    // The sign-in it refreshed went back to the person's.
    expect(JSON.parse(await readFile(join(person, 'auth.json'), 'utf8'))).toMatchObject({
      tokens: { access_token: 'new' },
    })
    expect(await readFile(join(person, 'config.toml'), 'utf8')).toBe(PERSON_CONFIG)
    expect(await readFile(join(root, 'notes/Plan.app/app.yaml'), 'utf8')).toContain('The plan')
  })
})

describe('the Codex job command', () => {
  it('never asks, has no network, and keeps the prompt after --', () => {
    expect(jobArgs({ cwd: '/s', prompt: '--help', model: 'gpt-5' })).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/s',
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
      '-m',
      'gpt-5',
      '--',
      '--help',
    ])
  })

  it('fences a session to its folder with the same tools off, asking in its terminal', async () => {
    const person = await personHome()
    const state = await temp('holi-fenced-state-')
    const codex = codexProvider({
      resolveBin: () => '/usr/local/bin/codex',
      base: { PATH: '/usr/bin', CODEX_HOME: person },
    })
    const cmd = codex.terminal(
      { root: '/v', configDir: '/c', binDir: null },
      { session: 'p0123456789ab', fence: { dir: '/s', state }, prompt: '--help' },
    )
    expect(fenceArgs('/s')).toContain('approval_policy="on-request"')
    expect(fenceArgs('/s')).toContain('sandbox_workspace_write.network_access=false')
    expect(cmd?.args.slice(4)).toEqual([...fenceArgs('/s'), '--', '--help'])
    expect(codex.capabilities.fenced).toBe('sandbox')
    // Its own Codex folder: signed in, without the person's MCP server.
    expect(cmd?.env.CODEX_HOME).toBe(join(state, 'codex-home'))
    const config = await readFile(join(state, 'codex-home/config.toml'), 'utf8')
    expect(config).toContain('model = "gpt-5.5"')
    expect(config).not.toContain('mcp_servers')
    expect(await readFile(join(state, 'codex-home/auth.json'), 'utf8')).toBe(PERSON_AUTH)
  })

  it('carries no Holi commands on its PATH, and runs on a Codex folder of its own', async () => {
    const person = await personHome()
    const state = await temp('holi-job-state-')
    const codex = codexProvider({
      resolveBin: () => '/usr/local/bin/codex',
      base: { PATH: '/usr/bin', CODEX_HOME: person },
    }) as JobsProvider
    const cmd = codex.capabilities.jobs.command({
      cwd: '/scratch/j1',
      root: '/vault',
      prompt: 'p',
      state,
    })
    expect(cmd?.env.PATH?.split(':')).not.toContain('/holi/bin')
    expect(cmd?.env.HOLI_AGENT_SESSION).toBeUndefined()
    expect(cmd?.env.CODEX_HOME).toBe(join(state, 'codex-home'))
    const config = await readFile(join(state, 'codex-home/config.toml'), 'utf8')
    expect(config).not.toContain('mcp_servers')
    // No project's own config.toml either: where it runs, and the vault.
    for (const folder of ['/scratch/j1', '/scratch', '/vault']) {
      expect(config).toContain(`[projects."${folder}"]\ntrust_level = "untrusted"`)
    }
    // The person's folder is untouched.
    expect(await readFile(join(person, 'config.toml'), 'utf8')).toBe(PERSON_CONFIG)
  })

  it('reads upstream Codex JSONL job events and tolerates additive fields', () => {
    // Upstream event schema: https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/exec/src/exec_events.rs (rust-v0.169.0)
    // Added fields here are synthetic; current fields mirror the public event envelope.
    expect(
      readJobEvent(
        '{"type":"thread.started","thread_id":"0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51","future_field":true}',
      ),
    ).toEqual({
      kind: 'thread',
      id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51',
    })
    expect(readJobEvent('{"type":"turn.completed","usage":{},"future_field":true}')).toEqual({
      kind: 'turn-completed',
    })
    expect(readJobEvent('{"type":"turn.failed","error":{"message":"no"}}')).toEqual({
      kind: 'turn-failed',
      message: 'no',
    })
    expect(readJobEvent('{"type":"error","message":"stream lost"}')).toEqual({
      kind: 'error',
      message: 'stream lost',
    })
    expect(readJobEvent('{"type":"item.completed"}')).toBeNull()
    expect(readJobEvent('not json')).toBeNull()
  })

  it('matches a write scope exactly or by folder', () => {
    expect(inWriteScope('a/B.app/index.html', ['a/B.app/**'])).toBe(true)
    expect(inWriteScope('a/B.apps/x', ['a/B.app/**'])).toBe(false)
    expect(inWriteScope('a/B.md', ['a/B.md'])).toBe(true)
    expect(inWriteScope('a/C.md', ['a/B.md'])).toBe(false)
  })
})

describe('agent.job', () => {
  const claude = {
    id: 'claude',
    label: 'Claude Code',
    capabilities: { background: {} },
  } as unknown as AgentProvider
  const codex = {
    id: 'codex',
    label: 'Codex',
    capabilities: { jobs: {} },
  } as unknown as AgentProvider
  const bare = { id: 'codex', label: 'Codex', capabilities: {} } as unknown as AgentProvider

  function table(providers: AgentProvider[]) {
    const launch = vi.fn(async () => ({ ok: true as const, sessionId: 'abcd1234' }))
    const start = vi.fn(async () => ({ ok: true as const, sessionId: 'j0123456789ab' }))
    const caps = agentCapabilities({
      sessions: { launch } as never,
      own: {} as never,
      jobs: { start } as never,
      fenced: {} as never,
      providers: () => providers,
      terminals: {} as never,
      liveRemote: () => 'syv/vault',
      commitNow: async () => null,
      defaultProvider: async () => 'claude' as const,
    })
    const ctx = { remote: 'syv/vault', root: '/v' } as unknown as CapabilityContext
    const entry = caps['agent.job']
    const run = (params: unknown) => entry.run(ctx, entry.params(params))
    return { run, launch, start, params: entry.params }
  }

  const ASK = {
    name: 'Plan: vault app',
    prompt: 'Make it',
    system: 'Nobody is watching.',
    model: 'claude-sonnet-5-5',
    scope: { read: ['notes/Plan.md'], write: ['notes/Plan.app/**'] },
  }

  it('runs on Claude Code as a background session allowed exactly its scope', async () => {
    const { run, launch, start } = table([claude, codex])
    expect(await run({ ...ASK, provider: 'claude' })).toEqual({ ok: true, sessionId: 'abcd1234' })
    expect(start).not.toHaveBeenCalled()
    expect(launch).toHaveBeenCalledWith({
      name: 'Plan: vault app',
      prompt: 'Make it',
      model: 'claude-sonnet-5-5',
      appendSystemPrompt: 'Nobody is watching.',
      allow: scopeRules(ASK.scope),
    })
    expect(scopeRules(ASK.scope)).toEqual([
      'Read(./notes/Plan.md)',
      'Read(./notes/Plan.app/**)',
      'Edit(./notes/Plan.app/**)',
      'Write(./notes/Plan.app/**)',
    ])
  })

  it('runs on Codex as a job, never on Claude Code', async () => {
    const { run, launch, start } = table([claude, codex])
    const { model: _model, ...ask } = ASK
    expect(await run({ ...ask, provider: 'codex' })).toEqual({
      ok: true,
      sessionId: 'j0123456789ab',
    })
    expect(launch).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ provider: codex, scope: ASK.scope, system: 'Nobody is watching.' }),
    )
  })

  it('refuses an agent that cannot run unwatched', async () => {
    const { run, launch, start } = table([claude, bare])
    expect(await run({ ...ASK, provider: 'codex' })).toEqual({
      ok: false,
      message: 'Codex cannot run a job with nobody watching.',
    })
    expect(launch).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses a scope outside what a capability may touch', () => {
    const { params } = table([claude])
    const bad = (scope: unknown) => () => params({ ...ASK, scope })
    expect(bad({ read: ['.holi/memory/x.md'], write: [] })).toThrow()
    expect(bad({ read: [], write: ['notes/*.md'] })).toThrow()
    expect(bad({ read: ['../out.md'], write: [] })).toThrow()
    expect(bad({ read: [], write: ['.env'] })).toThrow()
    expect(bad({ read: ['.codex/config.toml'], write: [] })).toThrow()
    expect(bad({ read: ['.Codex/config.toml'], write: [] })).toThrow()
    expect(bad({ read: ['notes/.agents/x.md'], write: [] })).toThrow()
    expect(bad(undefined)).toThrow()
  })
})

describe('job settlement without Stop', () => {
  it.each(['new file', 'replacement'] as const)(
    'does not let a queued publication change a %s after Stop times out',
    async (mode) => {
      const root = await temp('holi-job-vault-')
      const scratchRoot = await temp('holi-job-data-')
      const target = join(root, 'note.md')
      const read = mode === 'replacement' ? ['note.md'] : []
      if (read.length) await writeFile(target, 'original')
      const stdout = new PassThrough()
      const child = Object.assign(new ChildProcess(), {
        stdout,
        [ownedProcessDrain]: { drain: async () => {} },
      })
      let enterCommit!: () => void
      let resumeCopy!: () => void
      const atCommit = new Promise<void>((resolve) => (enterCommit = resolve))
      const resumed = new Promise<void>((resolve) => (resumeCopy = resolve))
      let queued: Promise<void> | undefined
      queuePublication = (publish) => {
        enterCommit()
        return (queued = resumed.then(publish))
      }
      const jobs = createJobs({
        vault: { remote: 'fixture/vault', root },
        scratchRoot,
        spawn: () => child,
        onChange: () => {},
        afterWrite: () => {
          enterCommit()
          return resumed
        },
        log: () => {},
      })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const started = await jobs.start({
          provider: scripted('/fixture/job'),
          name: 'fixture',
          prompt: 'go',
          scope: { read, write: ['note.md', 'zzz.md'] },
        })
        if (!started.ok) throw new Error(started.message)
        const id = started.sessionId
        await writeFile(join(scratchRoot, id, 'note.md'), 'agent output')
        await writeFile(join(scratchRoot, id, 'zzz.md'), 'later output')
        const closed = new Promise<void>((resolve) => stdout.once('close', resolve))
        stdout.end('{"type":"turn.completed"}\n')
        await closed
        child.emit('close', 0, null)
        await atCommit
        const stopping = jobs.stop(id).catch((error: unknown) => error)
        await vi.advanceTimersByTimeAsync(5_000)
        const timeout = await stopping
        expect(timeout).toMatchObject({
          message: expect.stringMatching(/Finalization of job.*timed out/),
        })
        const bytes = () =>
          readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return null
          })
        const atStop = await bytes()
        resumeCopy()
        await queued
        expect(await bytes()).toBe(atStop)
        expect(atStop).toBe('agent output') // The commit preceded the deadline.
        await expect(jobs.stop(id)).rejects.toBe(timeout)
        await expect(jobs.leave()).rejects.toMatchObject({ errors: [timeout] })
        expect(await readdir(root)).toEqual(['note.md'])
      } finally {
        resumeCopy()
        await queued?.catch(() => {})
        queuePublication = undefined
        stdout.destroy()
        child.emit('close', 0, null)
        const leaving = jobs.leave().catch(() => {})
        await vi.advanceTimersByTimeAsync(20_000)
        await leaving
        vi.useRealTimers()
      }
    },
  )

  it.each(['free path', 'competing file'] as const)(
    'rolls back a timed-out replacement with a %s',
    async (mode) => {
      const root = await temp('holi-job-vault-')
      const userData = await temp('holi-job-data-')
      const vault = { remote: 'fixture/vault', root }
      const scratchRoot = join(userData, 'jobs')
      const activation = new AbortController()
      const ownership = activationOwnership(userData, vault, activation.signal)
      const stdout = new PassThrough()
      const child = Object.assign(new ChildProcess(), {
        stdout,
        [ownedProcessDrain]: { drain: async () => {} },
      })
      const target = join(root, 'note.md')
      await writeFile(target, 'original')
      let enter!: () => void
      let publish!: () => void
      const entered = new Promise<void>((resolve) => (enter = resolve))
      const publishGate = new Promise<void>((resolve) => (publish = resolve))
      const log = vi.fn()
      const jobs = createJobs({
        vault,
        scratchRoot,
        ...(ownership && { ownership }),
        activationSignal: activation.signal,
        spawn: () => child,
        onChange: () => {},
        beforePublish: () => {
          enter()
          return publishGate
        },
        log,
      })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const started = await jobs.start({
          provider: scripted('/fixture/job'),
          name: 'fixture',
          prompt: 'go',
          scope: { read: ['note.md'], write: ['note.md', 'zzz.md'] },
        })
        if (!started.ok) throw new Error(started.message)
        const id = started.sessionId
        await writeFile(join(scratchRoot, id, 'note.md'), 'agent output')
        await writeFile(join(scratchRoot, id, 'zzz.md'), 'later output')
        const closed = new Promise<void>((resolve) => stdout.once('close', resolve))
        stdout.end('{"type":"turn.completed"}\n')
        await closed
        child.emit('close', 0, null)
        await entered
        await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
        const backup = (await readdir(root)).find((name) => name.startsWith('.holi-copy-'))!
        expect(await readFile(join(root, backup, 'previous'), 'utf8')).toBe('original')
        await vi.advanceTimersByTimeAsync(5_000)
        const timeout = await jobs.stop(id).catch((error: unknown) => error)
        expect(timeout).toMatchObject({
          message: expect.stringMatching(/Finalization of job.*timed out/),
        })
        if (mode === 'competing file') await writeFile(target, 'competing version')
        publish()
        if (mode === 'free path') {
          await vi.waitFor(async () => expect(await readdir(root)).toEqual(['note.md']))
          expect(await readFile(target, 'utf8')).toBe('original')
        } else {
          await vi.waitFor(async () => {
            expect(log).toHaveBeenCalledWith(expect.stringContaining(backup))
            expect((await readdir(root)).sort()).toEqual([backup, 'note.md'])
          })
        }
        activation.abort()
        await expect(jobs.stop(id)).rejects.toBe(timeout)
        await expect(jobs.leave()).rejects.toMatchObject({ errors: [timeout] })
        if (ownership) {
          const recovered = createJobs({
            vault,
            scratchRoot,
            ownership: activationOwnership(userData, vault, new AbortController().signal)!,
            spawn: () => {
              throw new Error('recovery must not spawn')
            },
            onChange: () => {},
            log: () => {},
          })
          await expect(recovered.leave()).rejects.toThrow(/Caller failure: .*timed out/)
          expect(await readFile(join(scratchRoot, `${id}.turn`), 'utf8')).toContain('FINALIZING')
        }
        if (mode === 'competing file') {
          expect(await readFile(target, 'utf8')).toBe('competing version')
          expect(await readFile(join(root, backup, 'previous'), 'utf8')).toBe('original')
        }
        expect(await readFile(join(scratchRoot, id, 'note.md'), 'utf8')).toBe('agent output')
        expect(await readFile(join(scratchRoot, id, 'zzz.md'), 'utf8')).toBe('later output')
        await expect(readFile(join(root, 'zzz.md'))).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        publish()
        stdout.destroy()
        child.emit('close', 0, null)
        const leaving = jobs.leave()
        void leaving.catch(() => {})
        await vi.advanceTimersByTimeAsync(20_000)
        await leaving.catch(() => {})
        vi.useRealTimers()
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'does not turn a proven pre-GO pipe closure into a job failure',
    async () => {
      const root = await temp('holi-job-vault-')
      const scratchRoot = await temp('holi-job-data-')
      const stdout = new PassThrough()
      const drain = vi.fn(async () => {})
      const child = Object.assign(new ChildProcess(), { stdout, [ownedProcessDrain]: { drain } })
      const jobs = createJobs({
        vault: { remote: 'fixture/vault', root },
        scratchRoot,
        spawn: () => child,
        onChange: () => {},
        log: () => {},
      })
      const started = await jobs.start({
        provider: scripted('/fixture/job'),
        name: 'fixture',
        prompt: 'go',
        allow: [],
      })
      if (!started.ok) throw new Error(started.message)
      const stop = jobs.stop(started.sessionId)
      const closed = new Promise<void>((resolve) => stdout.once('close', resolve))
      stdout.destroy(new Error('pipe closed before provider exec'))
      await closed
      const refusal = new Error('not admitted')
      markPosixNonAdmission(refusal, Promise.resolve())
      child.emit('error', refusal)
      child.emit('close', null, null)
      await expect(stop).resolves.toEqual({ ok: true })
      expect(drain).toHaveBeenCalledOnce()
      await jobs.leave()
    },
  )

  it.each([
    'missing close',
    'missing end',
    'release',
    'bracket',
    'destroyed stdout',
    'stdout error',
    'stdout error before rejected proof',
    'clean tail',
  ] as const)('requires independent physical, output and caller proof: %s', async (mode) => {
    const root = await temp('holi-job-vault-')
    const userData = await temp('holi-job-data-')
    const scratchRoot = join(userData, 'jobs')
    const vault = { remote: 'fixture/vault', root }
    const ownership = activationOwnership(userData, vault, new AbortController().signal)
    const stdout = new PassThrough()
    // Explicit proof only: this child has no PID or native launch authority.
    const proofError = new Error('physical receipt rejected')
    let rejectProof!: (error: Error) => void
    const proof = new Promise<void>((_, reject) => (rejectProof = reject))
    void proof.catch(() => {})
    const drain = vi.fn(async () => {
      if (mode === 'stdout error before rejected proof') await proof
    })
    const child = Object.assign(new ChildProcess(), { stdout, [ownedProcessDrain]: { drain } })
    const provider = scripted('/fixture/job')
    const cause = new Error('original stdout error')
    const log = vi.fn()
    let resume!: () => void
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const release = vi.fn(async (_state: string, _signal?: AbortSignal) => {
      if (mode === 'release') await gate
    })
    provider.release = release
    const bracket = vi.fn(async (_id: string, edge: string) => {
      if (mode === 'bracket' && edge === 'end') await gate
    })
    const lists: SessionSummary[][] = []
    const jobs = createJobs({
      vault,
      scratchRoot,
      ...(ownership && { ownership }),
      spawn: () => child,
      bracket,
      onChange: (rows) => lists.push(rows),
      log,
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const inVault = mode === 'bracket'
      const started = await jobs.start({
        provider,
        name: 'fixture',
        prompt: 'go',
        ...(inVault ? { allow: [] } : { scope: { read: [], write: ['note.md'] } }),
      })
      if (!started.ok) throw new Error(started.message)
      const id = started.sessionId
      if (!inVault) await writeFile(join(scratchRoot, id, 'note.md'), 'scratch edit')
      const json = JSON.stringify({ type: 'turn.completed' })
      const readClosed = new Promise<void>((resolve) => stdout.once('close', resolve))
      if (mode === 'destroyed stdout' || mode.startsWith('stdout error')) {
        child.emit('spawn')
        stdout.write(`${json}\n`)
        stdout.destroy(mode === 'destroyed stdout' ? undefined : cause)
      } else if (mode === 'missing end') stdout.write(`${json}\n`)
      else stdout.end(mode === 'clean tail' ? json : `${json}\n`)
      if (mode !== 'missing end') await readClosed
      child.emit('exit', 0, null)
      await vi.advanceTimersByTimeAsync(0)
      if (mode === 'release' || mode === 'bracket') await vi.advanceTimersByTimeAsync(4_999)
      if (mode !== 'missing close') child.emit('close', 0, null)
      await vi.advanceTimersByTimeAsync(0)
      expect(drain).toHaveBeenCalledOnce()
      if (mode === 'stdout error before rejected proof') {
        expect(jobs.sessions()[0]?.outcome).toBeUndefined()
        expect(release).not.toHaveBeenCalled()
        rejectProof(proofError)
        await vi.advanceTimersByTimeAsync(0)
      }
      if (mode === 'clean tail') {
        await vi.waitFor(() => expect(jobs.sessions()[0]?.outcome).toBe('completed'))
        expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('scratch edit')
        await jobs.leave()
        return
      }
      const timeout = !mode.includes('stdout')
      if (timeout) {
        if (mode === 'release') expect(release).toHaveBeenCalledOnce()
        if (mode === 'bracket') expect(bracket).toHaveBeenCalledWith(id, 'end')
        await vi.advanceTimersByTimeAsync(4_999)
        expect(jobs.sessions()[0]?.outcome).toBeUndefined()
        expect(lists.flat().some((row) => row.outcome === 'completed')).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
      }
      expect(jobs.sessions()[0]?.outcome).toBe('failed')
      const failure = await jobs.stop(id).catch((error: unknown) => error)
      if (mode.startsWith('stdout error')) expect(failure).toBe(cause)
      else
        expect(failure).toMatchObject({
          message: expect.stringMatching(
            mode === 'destroyed stdout'
              ? /stdout closed before end/
              : mode === 'missing close' || mode === 'missing end'
                ? /Output of job.*timed out/
                : /Finalization of job.*timed out/,
          ),
        })
      if (mode === 'release') expect(release.mock.calls[0]?.[1]?.reason).toBe(failure)
      if (mode === 'stdout error before rejected proof') {
        expect(log).toHaveBeenCalledWith(expect.stringContaining(proofError.message))
      }
      // A late callback or close cannot replace the outcome or retire the owner.
      resume()
      child.emit('close', 0, null)
      if (mode === 'missing end') stdout.end()
      if (mode === 'stdout error') stdout.emit('error', new Error('second stdout error'))
      await vi.advanceTimersByTimeAsync(0)
      expect(lists.flat().some((row) => row.outcome === 'completed')).toBe(false)
      await expect(jobs.stop(id)).rejects.toBe(failure)
      const expectedErrors =
        mode === 'stdout error before rejected proof' ? [cause, proofError] : [failure]
      await expect(jobs.leave()).rejects.toMatchObject({ errors: expectedErrors })
      expect(await readdir(scratchRoot)).toContain(`${id}.agent`)
      if (ownership)
        expect(await readFile(join(scratchRoot, `${id}.turn`), 'utf8')).toContain('FINALIZING')
      if (!inVault)
        expect(await readFile(join(scratchRoot, id, 'note.md'), 'utf8')).toBe('scratch edit')
      expect(await exists(join(root, 'note.md'))).toBe(false)
      if (mode !== 'release' && mode !== 'bracket') expect(release).not.toHaveBeenCalled()
    } finally {
      rejectProof(proofError)
      resume()
      stdout.destroy()
      child.emit('close', 0, null)
      // All work is fake; settle leftovers without giving them a real timer.
      const leaving = jobs.leave()
      void leaving.catch(() => {})
      await vi.advanceTimersByTimeAsync(20_000)
      await leaving.catch(() => {})
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})

describe('a job in the vault', () => {
  /** A provider whose turns are `node <script>`, the first and each
   *  follow-up its own, with what each was asked kept. */
  function turns(first: string, next: string) {
    const runs: JobRun[] = []
    const provider: JobsProvider = {
      ...scripted(first),
      capabilities: {
        jobs: {
          command: (run) => {
            runs.push(run)
            return {
              bin: process.execPath,
              args: [run.resume === undefined ? first : next],
              env: { PATH: process.env.PATH ?? '' },
            }
          },
          event: readJobEvent,
        },
      },
    }
    return { provider, runs }
  }

  const WRITES = [
    "const fs = require('node:fs')",
    event({ type: 'thread.started', thread_id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a59' }),
    event({ type: 'turn.started' }),
    "fs.writeFileSync('Q4.md', 'proposal')",
    // A turn long enough for a follow-up to arrive while it runs.
    'setTimeout(() => {',
    event({
      type: 'turn.completed',
      usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 300 },
    }),
    '}, 300)',
  ].join('\n')
  const FOLLOW = [
    event({ type: 'turn.started' }),
    event({ type: 'turn.completed', usage: { input_tokens: 1600, output_tokens: 400 } }),
  ].join('\n')

  async function vaultRig(
    followUp = FOLLOW,
    bracket?: (id: string, edge: 'begin' | 'end' | 'forget') => unknown | Promise<unknown>,
  ) {
    const root = await temp('holi-job-vault-')
    const userData = await temp('holi-job-data-')
    const first = join(userData, 'first.js')
    const next = join(userData, 'next.js')
    await writeFile(first, WRITES)
    await writeFile(next, followUp)
    const edges: string[] = []
    const tracked = trackedJobProcesses(userData)
    const jobs = createJobs({
      vault: { remote: 'syv/vault', root },
      scratchRoot: join(userData, 'agent-jobs'),
      onChange: () => {},
      bracket: bracket ?? ((id, edge) => edges.push(`${edge}:${id}`)),
      killGraceMs: 200,
      spawn: tracked.spawn,
      log: () => {},
    })
    owned.push({ jobs, tracked })
    return { root, jobs, edges, ...turns(first, next) }
  }

  it.each(['success', 'proof failure', 'missing close', 'provider hang'] as const)(
    'uses the job stop deadline only after leased proof: %s',
    async (mode) => {
      // A ChildProcess-shaped emitter only: no native spawn, pid, or signal.
      const root = await temp('holi-job-vault-')
      const scratchRoot = await temp('holi-job-data-')
      const cause = new Error('original job proof failure')
      let settleProof!: () => void
      const physical = new Promise<void>((resolve, reject) => {
        settleProof = () => (mode === 'proof failure' ? reject(cause) : resolve())
      })
      const drain = vi.fn(() => physical)
      const child = Object.assign(new ChildProcess(), { [ownedProcessDrain]: { drain } })
      const { provider } = turns('/fixture/first', '/fixture/next')
      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      provider.release = vi.fn(() => (mode === 'provider hang' ? released : Promise.resolve()))
      const jobs = createJobs({
        vault: { remote: 'syv/vault', root },
        scratchRoot,
        onChange: () => {},
        spawn: () => child,
        log: () => {},
      })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const result = await jobs.start({
          provider,
          name: 'deadline',
          prompt: 'go',
          allow: ['Write(tilbud/**)'],
        })
        if (!result.ok) throw new Error(result.message)
        const id = result.sessionId
        const stop = jobs.stop(id).catch((error: unknown) => error)
        const stopped = vi.fn()
        void stop.then(stopped)
        if (mode === 'success' || mode === 'provider hang') child.emit('close', 0, null)
        await vi.advanceTimersByTimeAsync(12_000)
        expect(stopped).not.toHaveBeenCalled()
        expect(drain).toHaveBeenCalledOnce()
        expect(provider.release).not.toHaveBeenCalled()
        settleProof()
        if (mode === 'missing close' || mode === 'provider hang') {
          await vi.advanceTimersByTimeAsync(4_999)
          expect(stopped).not.toHaveBeenCalled()
          await vi.advanceTimersByTimeAsync(1)
        }
        if (mode === 'success') {
          expect(await stop).toEqual({ ok: true })
          await jobs.leave()
          expect(jobs.has(id)).toBe(false)
        } else {
          const failure = await stop
          if (mode === 'proof failure') expect(failure).toBe(cause)
          else
            expect(failure).toMatchObject({
              message: expect.stringMatching(
                mode === 'missing close'
                  ? /Output of job.*timed out/
                  : /Finalization of job.*timed out/,
              ),
            })
          await expect(jobs.stop(id)).rejects.toBe(failure)
          await expect(jobs.leave()).rejects.toMatchObject({ errors: [failure] })
          expect(jobs.has(id)).toBe(true)
        }
      } finally {
        settleProof()
        child.emit('close', 0, null)
        release()
        vi.useRealTimers()
        // Leave owns final scratch deletion only on success; the fixture
        // never had a real child and afterEach removes the exact temp paths.
      }
    },
  )

  it('keeps stop draining through bracket persistence after process close', async () => {
    let reachEnd!: () => void
    let finishEnd!: () => void
    const reachedEnd = new Promise<void>((resolve) => (reachEnd = resolve))
    const endGate = new Promise<void>((resolve) => (finishEnd = resolve))
    const { jobs, provider } = await vaultRig(FOLLOW, async (_id, edge) => {
      if (edge === 'end') {
        reachEnd()
        await endGate
      }
    })
    const started = await jobs.start({
      provider,
      name: 'x',
      prompt: 'go',
      allow: ['Write(tilbud/**)'],
    })
    if (!started.ok) throw new Error(started.message)
    const id = started.sessionId
    await reachedEnd
    let stopped = false
    const stopping = jobs.stop(id).then(() => (stopped = true))
    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(stopped).toBe(false)
      const row = jobs.sessions().find((row) => row.id === id)
      expect(row?.state).toBe('working')
      expect(row?.outcome).toBeUndefined()
    } finally {
      finishEnd()
    }
    await stopping
    await jobs.leave()
  })

  it('revokes message admission synchronously when retirement starts', async () => {
    const { jobs, provider } = await vaultRig()
    const started = await jobs.start({
      provider,
      name: 'x',
      prompt: 'go',
      allow: ['Write(tilbud/**)'],
    })
    if (!started.ok) throw new Error(started.message)
    await vi.waitFor(
      () => {
        const row = jobs.sessions().find((session) => session.id === started.sessionId)
        if (row?.outcome === undefined) throw new Error('still running')
      },
      { timeout: 5_000 },
    )
    await jobs.stop(started.sessionId)
    expect(() => jobs.message(started.sessionId, 'too late')).toThrow('That job has ended.')
    await jobs.leave()
  })

  it('retains the original leave failure after a late bracket close', async () => {
    let reachEnd!: () => void
    let finishEnd!: () => void
    const reachedEnd = new Promise<void>((resolve) => (reachEnd = resolve))
    const endGate = new Promise<void>((resolve) => (finishEnd = resolve))
    const { jobs, provider } = await vaultRig(FOLLOW, async (_id, edge) => {
      if (edge === 'end') {
        reachEnd()
        await endGate
      }
    })
    const started = await jobs.start({
      provider,
      name: 'x',
      prompt: 'go',
      allow: ['Write(tilbud/**)'],
    })
    if (!started.ok) throw new Error(started.message)
    await reachedEnd
    let cause: unknown
    try {
      const failure = await jobs.leave().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toHaveLength(1)
      cause = (failure as AggregateError).errors[0]
      expect(cause).toMatchObject({
        message: expect.stringMatching(/Finalization of job.*timed out/),
      })
      expect(jobs.has(started.sessionId)).toBe(true)
    } finally {
      finishEnd()
    }
    await vi.waitFor(() => expect(jobs.sessions()[0]?.state).toBe('idle'))
    await expect(jobs.stop(started.sessionId)).rejects.toBe(cause)
    const retry = await jobs.leave().catch((error: unknown) => error)
    expect(retry).toBeInstanceOf(AggregateError)
    expect((retry as AggregateError).errors).toHaveLength(1)
    expect((retry as AggregateError).errors[0]).toBe(cause)
    expect(jobs.has(started.sessionId)).toBe(true)
  })

  it('writes only named folders and reports the latest cumulative usage total', async () => {
    const { root, jobs, edges, provider, runs } = await vaultRig()
    const started = await jobs.start({
      provider,
      name: 'Proposal · Q4',
      prompt: 'Work on kunder/Q4.md.',
      system: 'You are Proposal.',
      model: 'gpt-5',
      allow: [
        'Edit(tilbud/**)',
        'Write(./arkiv/**)',
        'Read(kunder/**)',
        'Bash(holi holis report:*)',
      ],
    })
    if (!started.ok) throw new Error(started.message)
    const id = started.sessionId
    const real = await realpath(root)
    expect(runs[0]).toMatchObject({
      cwd: join(real, 'tilbud'),
      writable: [join(real, 'arkiv')],
      readOnly: false,
      model: 'gpt-5',
    })
    expect(runs[0]!.prompt).toBe(
      `You are Proposal.\n\nThe vault is ${root}. Every vault path named here is relative to it.\n\nWork on kunder/Q4.md.`,
    )
    expect(edges).toEqual([`begin:${id}`])

    // A follow-up while the turn runs waits for it, then resumes the thread.
    jobs.message(id, 'Make it shorter.')
    await vi.waitFor(() => expect(runs).toHaveLength(2), { timeout: 5_000 })
    expect(runs[1]).toMatchObject({
      resume: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a59',
      prompt: 'Make it shorter.',
    })
    // The follow-up runs on the same state folder, where its thread is.
    expect(runs[1]!.state).toBe(runs[0]!.state)
    const row = await vi.waitFor(
      () => {
        const r = jobs.sessions().find((s) => s.id === id)
        if (r?.outcome === undefined || edges.length < 4) throw new Error('still running')
        return r
      },
      { timeout: 5_000 },
    )
    expect(row).toMatchObject({
      state: 'idle',
      outcome: 'completed',
      model: 'gpt-5',
      usage: { total: 2_000 },
    })
    expect(edges).toEqual([`begin:${id}`, `end:${id}`, `begin:${id}`, `end:${id}`])
    expect(await readFile(join(root, 'tilbud/Q4.md'), 'utf8')).toBe('proposal')
  })

  it('keeps the last cumulative usage total when a follow-up fails', async () => {
    const failedFollowUp = [
      event({ type: 'turn.started' }),
      event({ type: 'turn.failed', error: { message: 'follow-up failed' } }),
    ].join('\n')
    const { jobs, provider, runs } = await vaultRig(failedFollowUp)
    const started = await jobs.start({ provider, name: 'x', prompt: 'go', allow: ['Edit(a/**)'] })
    const id = (started as { sessionId: string }).sessionId
    jobs.message(id, 'follow up')
    await vi.waitFor(() => expect(runs).toHaveLength(2), { timeout: 5_000 })
    const row = await vi.waitFor(
      () => {
        const current = jobs.sessions().find((session) => session.id === id)
        if (current?.outcome === undefined) throw new Error('still running')
        return current
      },
      { timeout: 5_000 },
    )
    expect(row).toMatchObject({
      outcome: 'failed',
      error: 'follow-up failed',
      usage: { total: 1_500 },
    })
  })

  it('keeps the known cumulative usage total when a follow-up omits usage', async () => {
    const noUsageFollowUp = [
      event({ type: 'turn.started' }),
      event({ type: 'turn.completed', usage: {} }),
    ].join('\n')
    const { jobs, provider, runs } = await vaultRig(noUsageFollowUp)
    const started = await jobs.start({ provider, name: 'x', prompt: 'go', allow: ['Edit(a/**)'] })
    const id = (started as { sessionId: string }).sessionId
    jobs.message(id, 'follow up')
    await vi.waitFor(() => expect(runs).toHaveLength(2), { timeout: 5_000 })
    const row = await vi.waitFor(
      () => {
        const current = jobs.sessions().find((session) => session.id === id)
        if (current?.outcome === undefined) throw new Error('still running')
        return current
      },
      { timeout: 5_000 },
    )
    expect(row).toMatchObject({ outcome: 'completed', usage: { total: 1_500 } })
  })

  it('keeps the last cumulative usage total when a follow-up is stopped', async () => {
    const stoppedFollowUp = [event({ type: 'turn.started' }), 'setInterval(() => {}, 1000)'].join(
      '\n',
    )
    const { jobs, provider, runs } = await vaultRig(stoppedFollowUp)
    const started = await jobs.start({ provider, name: 'x', prompt: 'go', allow: ['Edit(a/**)'] })
    const id = (started as { sessionId: string }).sessionId
    jobs.message(id, 'follow up')
    await vi.waitFor(() => expect(runs).toHaveLength(2), { timeout: 5_000 })
    await vi.waitFor(() =>
      expect(jobs.sessions().find((session) => session.id === id)?.state).toBe('working'),
    )
    await jobs.stop(id)
    expect(jobs.sessions().find((session) => session.id === id)).toMatchObject({
      outcome: 'failed',
      error: 'Stopped.',
      usage: { total: 1_500 },
    })
  })

  it('is read-only with no folder to write', async () => {
    const { root, jobs, provider, runs } = await vaultRig()
    const started = await jobs.start({ provider, name: 'x', prompt: 'go', allow: ['Read'] })
    expect(started.ok).toBe(true)
    expect(runs[0]).toMatchObject({ cwd: root, writable: [], readOnly: true })
    await jobs.leave()
  })

  it('is refused, never widened, when a rule is not a folder its sandbox can allow', async () => {
    const { jobs, provider, runs } = await vaultRig()
    for (const rule of [
      'Bash(git push:*)',
      'WebFetch',
      'Edit(notes/Plan.md)',
      'Edit(.holi/**)',
      'Edit(~/notes/**)',
      'Bash(holi google read:*)',
      'Edit',
    ]) {
      const res = await jobs.start({ provider, name: 'x', prompt: 'go', allow: [rule] })
      expect(res.ok).toBe(false)
      expect((res as { message: string }).message).toContain(rule)
    }
    expect(runs).toEqual([])
    expect(jobs.sessions()).toEqual([])
  })

  it('reads rules as sandbox folders', () => {
    expect(vaultSandbox(['Edit(a/**)', 'MultiEdit(./a/**)', 'Write(b/c/**)', 'Grep'])).toEqual({
      ok: true,
      write: ['a', 'b/c'],
    })
    expect(vaultSandbox(['Edit(**)']).ok).toBe(false)
    expect(vaultSandbox(['Edit(a/*.md)']).ok).toBe(false)
    expect(vaultSandbox(['Edit(../out/**)']).ok).toBe(false)
    // A Holi's memory and report rules are its run's, left out; no other.
    expect(vaultSandbox(['Edit(a/**)', 'Bash(holi holis remember:*)'])).toEqual({
      ok: true,
      write: ['a'],
    })
    expect(vaultSandbox(['Bash(holi holis delete:*)']).ok).toBe(false)
  })

  it('takes no message while it is being stopped, and starts no turn after', async () => {
    const { jobs, provider, runs } = await vaultRig()
    const started = await jobs.start({ provider, name: 'x', prompt: 'go', allow: ['Edit(a/**)'] })
    const id = (started as { sessionId: string }).sessionId
    const stopping = jobs.stop(id)
    expect(() => jobs.message(id, 'one more')).toThrow(/being stopped/)
    await stopping
    expect(jobs.sessions().find((s) => s.id === id)).toMatchObject({
      outcome: 'failed',
      error: 'Stopped.',
    })
    expect(runs).toHaveLength(1)
    await jobs.leave()
  })

  it('takes no follow-up in a scratch folder', async () => {
    const { jobs, provider } = await rig(HANG)
    const started = await jobs.start({ provider, name: 'x', prompt: 'go', scope: SCOPE })
    const id = (started as { sessionId: string }).sessionId
    expect(() => jobs.message(id, 'more')).toThrow(/scratch folder/)
    await jobs.leave()
  })
})

describe('the Codex job command in the vault', () => {
  it('takes only a UUID for the thread it resumes, after --', () => {
    expect(() => jobArgs({ cwd: '/v', prompt: 'p', resume: '--yolo' })).toThrow()
    expect(readJobEvent('{"type":"thread.started","thread_id":"--yolo"}')).toBeNull()
  })

  it('writes only its folders, with no web search, and resumes a thread with the prompt last', () => {
    expect(
      jobArgs({
        cwd: '/v/a',
        prompt: 'more',
        writable: ['/v/b'],
        resume: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a59',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/v/a',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c',
      'sandbox_workspace_write.writable_roots=["/v/b"]',
      '-c',
      'web_search="disabled"',
      '-c',
      'tools.web_search=false',
      'resume',
      '--',
      '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a59',
      'more',
    ])
    expect(jobArgs({ cwd: '/v', prompt: 'p', readOnly: true })).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/v',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      'web_search="disabled"',
      '-c',
      'tools.web_search=false',
      '--',
      'p',
    ])
  })

  it('counts what a turn used', () => {
    expect(
      readJobEvent('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'),
    ).toEqual({ kind: 'turn-completed', tokens: 15 })
  })
})

describe('agent.job in the vault', () => {
  const claude = {
    id: 'claude',
    label: 'Claude Code',
    capabilities: { background: {} },
  } as unknown as AgentProvider
  const codex = {
    id: 'codex',
    label: 'Codex',
    capabilities: { jobs: {} },
  } as unknown as AgentProvider

  function table(fallback: 'claude' | 'codex') {
    const launch = vi.fn(async () => ({ ok: true as const, sessionId: 'abcd1234' }))
    const start = vi.fn(async () => ({ ok: true as const, sessionId: 'j0123456789ab' }))
    const caps = agentCapabilities({
      sessions: { launch } as never,
      own: {} as never,
      jobs: { start } as never,
      fenced: {} as never,
      providers: () => [claude, codex],
      terminals: {} as never,
      liveRemote: () => 'syv/vault',
      commitNow: async () => null,
      defaultProvider: async () => fallback,
    })
    const ctx = { remote: 'syv/vault', root: '/v' } as unknown as CapabilityContext
    const entry = caps['agent.job']
    return { run: (p: unknown) => entry.run(ctx, entry.params(p)), launch, start }
  }

  const RUN = {
    name: 'Proposal · Q4',
    prompt: 'Work on kunder/Q4.md.',
    system: 'You are Proposal.',
    model: 'sonnet',
    allow: ['Edit(tilbud/**)'],
  }

  it("runs on this machine's agent: Claude Code as a background session with its rules", async () => {
    const { run, launch, start } = table('claude')
    expect(await run(RUN)).toEqual({ ok: true, sessionId: 'abcd1234' })
    expect(start).not.toHaveBeenCalled()
    expect(launch).toHaveBeenCalledWith({
      name: 'Proposal · Q4',
      prompt: 'Work on kunder/Q4.md.',
      model: 'sonnet',
      allow: ['Edit(tilbud/**)'],
      appendSystemPrompt: 'You are Proposal.',
    })
  })

  it('runs on Codex as a vault job on its own model, never on Claude Code', async () => {
    const { run, launch, start } = table('codex')
    expect(await run(RUN)).toEqual({ ok: true, sessionId: 'j0123456789ab' })
    expect(launch).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledWith({
      provider: codex,
      name: 'Proposal · Q4',
      prompt: 'Work on kunder/Q4.md.',
      allow: ['Edit(tilbud/**)'],
      system: 'You are Proposal.',
    })
  })
})

describe('Codex jobs without a per-vault grant', () => {
  const codex = {
    id: 'codex',
    label: 'Codex',
    capabilities: { jobs: {} },
  } as unknown as AgentProvider

  function table() {
    const start = vi.fn(async () => ({ ok: true as const, sessionId: 'j0123456789ab' }))
    const message = vi.fn()
    const caps = agentCapabilities({
      sessions: {} as never,
      own: { has: () => false } as never,
      jobs: {
        start,
        message,
        has: (id: string) => id === 'j0123456789ab',
      } as never,
      fenced: {} as never,
      providers: () => [codex],
      terminals: {} as never,
      liveRemote: () => 'syv/vault',
      commitNow: async () => null,
      defaultProvider: async () => 'codex',
    })
    const ctx = { remote: 'syv/vault', root: '/v' } as unknown as CapabilityContext
    const call = <K extends 'agent.job' | 'agent.message'>(name: K, p: unknown) =>
      (caps[name].run as (c: unknown, a: unknown) => Promise<unknown>)(ctx, caps[name].params(p))
    return { call, start, message }
  }

  it('starts an Ask AI document job without asking for a vault grant', async () => {
    const { call, start } = table()
    const scope = { read: ['notes/Plan.md'], write: ['notes/Plan.md'] }
    expect(await call('agent.job', { name: 'Ask AI', prompt: 'Rewrite this.', scope })).toEqual({
      ok: true,
      sessionId: 'j0123456789ab',
    })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ provider: codex, scope }))
  })

  it('starts a vault job and takes a follow-up without asking for a grant', async () => {
    const { call, start, message } = table()
    expect(
      await call('agent.job', {
        name: 'Proposal',
        prompt: 'Go.',
        allow: ['Edit(tilbud/**)'],
      }),
    ).toEqual({ ok: true, sessionId: 'j0123456789ab' })
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ provider: codex, allow: ['Edit(tilbud/**)'] }),
    )
    const next = { session: 'j0123456789ab', text: 'And the summary.' }
    expect(await call('agent.message', next)).toEqual({ ok: true })
    expect(message).toHaveBeenCalledWith('j0123456789ab', next.text)
  })
})

describe('agent.scoped', () => {
  const claude = {
    id: 'claude',
    label: 'Claude Code',
    capabilities: { background: {} },
  } as unknown as AgentProvider
  const codex = {
    id: 'codex',
    label: 'Codex',
    capabilities: { jobs: {}, fenced: 'sandbox' },
  } as unknown as AgentProvider
  const unfenced = {
    id: 'codex',
    label: 'Codex',
    capabilities: { jobs: {} },
  } as unknown as AgentProvider

  function table(providers: AgentProvider[]) {
    const launch = vi.fn(async () => ({ ok: true as const, sessionId: 'abcd1234' }))
    const fence = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'p0123456789ab',
      terminalId: 't1',
    }))
    const caps = agentCapabilities({
      sessions: { launch } as never,
      own: {} as never,
      jobs: {} as never,
      fenced: { start: fence },
      providers: () => providers,
      terminals: {} as never,
      liveRemote: () => 'syv/vault',
      commitNow: async () => null,
      defaultProvider: async () => 'claude',
    })
    const ctx = { remote: 'syv/vault', root: '/v' } as unknown as CapabilityContext
    const entry = caps['agent.scoped']
    return { run: (params: unknown) => entry.run(ctx, entry.params(params)), launch, fence }
  }

  const ASK = {
    name: 'Plan: vault app',
    prompt: 'Make it',
    system: 'Make the app.',
    scope: { read: ['notes/Plan.md'], write: ['notes/Plan.app/**'] },
  }

  it('runs on Claude Code as a background session allowed exactly its scope', async () => {
    const { run, launch, fence } = table([claude, codex])
    expect(await run({ ...ASK, model: 'claude-sonnet-5-5', provider: 'claude' })).toEqual({
      ok: true,
      sessionId: 'abcd1234',
    })
    expect(fence).not.toHaveBeenCalled()
    expect(launch).toHaveBeenCalledWith({
      name: 'Plan: vault app',
      prompt: 'Make it',
      model: 'claude-sonnet-5-5',
      appendSystemPrompt: 'Make the app.',
      allow: scopeRules(ASK.scope),
    })
  })

  it('runs on Codex as a session fenced to a folder of Holi’s', async () => {
    const { run, launch, fence } = table([claude, codex])
    expect(await run({ ...ASK, provider: 'codex', cols: 90 })).toMatchObject({
      ok: true,
      sessionId: 'p0123456789ab',
    })
    expect(launch).not.toHaveBeenCalled()
    expect(fence).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: codex,
        scope: ASK.scope,
        system: 'Make the app.',
        cols: 90,
      }),
    )
  })

  it('refuses an agent that cannot be fenced, never running another', async () => {
    const { run, launch, fence } = table([claude, unfenced])
    expect(await run({ ...ASK, provider: 'codex' })).toEqual({
      ok: false,
      message: 'Codex cannot run a session fenced to what it may touch.',
    })
    expect(launch).not.toHaveBeenCalled()
    expect(fence).not.toHaveBeenCalled()
  })
})

describe('a fenced session', () => {
  async function fencedRig(
    release?: (state: string) => Promise<void>,
    scope: JobScope = SCOPE,
    beforeReplace?: (rel: string) => Promise<void> | void,
    beforePublish?: (rel: string) => Promise<void> | void,
  ) {
    const root = await temp('holi-fenced-vault-')
    const userData = await temp('holi-fenced-data-')
    await mkdir(join(root, 'notes'), { recursive: true })
    await writeFile(join(root, 'notes/Plan.md'), 'Ship it\n')
    const jobs = createJobs({
      vault: { remote: 'syv/vault', root },
      scratchRoot: join(userData, 'agent-jobs'),
      onChange: () => {},
      ...(beforeReplace === undefined ? {} : { beforeReplace }),
      ...(beforePublish === undefined ? {} : { beforePublish }),
      log: () => {},
    })
    let fence: Fence | undefined
    const own = {
      start: vi.fn(async (_provider: string, args: { prompt?: string; fence?: Fence }) => {
        fence = args.fence
        return { ok: true as const, sessionId: 'p0123456789ab', terminalId: 't1' }
      }),
    }
    const fenced = createFencedSessions({
      vault: { remote: 'syv/vault', root },
      scratchRoot: join(userData, 'agent-fenced'),
      own,
      copyBack: jobs.copyBack,
      log: () => {},
    })
    const res = await fenced.start({
      provider: {
        id: 'codex',
        label: 'Codex',
        capabilities: { fenced: 'sandbox' },
        ...(release === undefined ? {} : { release }),
      } as never,
      name: 'Plan: vault app',
      prompt: 'Make it',
      system: 'Make the app.',
      scope,
    })
    if (fence === undefined) throw new Error('no fence')
    return { root, userData, res, own, fence, fenced }
  }

  it('starts in a folder holding what it reads, and copies back what it wrote as a turn ends', async () => {
    const { root, res, own, fence } = await fencedRig()
    expect(res.ok).toBe(true)
    expect(own.start.mock.calls[0]?.[1].prompt).toBe('Make the app.\n\nMake it')
    expect(await readFile(join(fence.dir, 'notes/Plan.md'), 'utf8')).toBe('Ship it\n')

    await mkdir(join(fence.dir, 'notes/Plan.app'), { recursive: true })
    await writeFile(join(fence.dir, 'notes/Plan.app/index.html'), '<h1>Ship it</h1>')
    await writeFile(join(fence.dir, 'notes/Plan.app/app.yaml'), 'description: The plan\n')
    await writeFile(join(fence.dir, 'notes/Plan.app/.env'), 'TOKEN=no')
    await writeFile(join(fence.dir, 'notes/Plan.md'), 'rewritten')
    await fence.turnEnded()
    expect(await readFile(join(root, 'notes/Plan.app/app.yaml'), 'utf8')).toBe(
      'description: The plan\n',
    )
    expect(await exists(join(root, 'notes/Plan.app/.env'))).toBe(false)
    expect(await readFile(join(root, 'notes/Plan.md'), 'utf8')).toBe('Ship it\n')

    // A later turn's change, then the session exits: copied, and the folder goes.
    await writeFile(join(fence.dir, 'notes/Plan.app/index.html'), '<h1>Shipped</h1>')
    fence.exited()
    await vi.waitFor(() => expect(exists(join(fence.dir, 'notes/Plan.md'))).resolves.toBe(false))
    expect(await readFile(join(root, 'notes/Plan.app/index.html'), 'utf8')).toBe('<h1>Shipped</h1>')
  })

  it('never writes over an app that lands in the vault meanwhile', async () => {
    const { root, fence } = await fencedRig()
    await mkdir(join(fence.dir, 'notes/Plan.app'), { recursive: true })
    await writeFile(join(fence.dir, 'notes/Plan.app/index.html'), '<h1>Ship it</h1>')
    await writeFile(join(fence.dir, 'notes/Plan.app/app.yaml'), 'description: The plan\n')
    await mkdir(join(root, 'notes/Plan.app'), { recursive: true })
    await writeFile(join(root, 'notes/Plan.app/app.yaml'), 'description: Theirs\n')
    await expect(fence.turnEnded()).rejects.toThrow('did not copy back notes/Plan.app')
    expect(await readFile(join(root, 'notes/Plan.app/app.yaml'), 'utf8')).toBe(
      'description: Theirs\n',
    )
    expect(await exists(join(root, 'notes/Plan.app/index.html'))).toBe(false)
  })

  it('never writes over a file it wrote that someone changed in the vault since', async () => {
    const { root, fence } = await fencedRig()
    await mkdir(join(fence.dir, 'notes/Plan.app'), { recursive: true })
    await writeFile(join(fence.dir, 'notes/Plan.app/index.html'), '<h1>One</h1>')
    await writeFile(join(fence.dir, 'notes/Plan.app/app.yaml'), 'description: One\n')
    await fence.turnEnded()
    // Someone edits the manifest between turns; the agent leaves it alone.
    await writeFile(join(root, 'notes/Plan.app/app.yaml'), 'description: Theirs\n')
    await writeFile(join(fence.dir, 'notes/Plan.app/index.html'), '<h1>Two</h1>')
    await fence.turnEnded()
    expect(await readFile(join(root, 'notes/Plan.app/index.html'), 'utf8')).toBe('<h1>Two</h1>')
    expect(await readFile(join(root, 'notes/Plan.app/app.yaml'), 'utf8')).toBe(
      'description: Theirs\n',
    )

    // Now the agent changes what was edited: nothing of the turn is written.
    await writeFile(join(fence.dir, 'notes/Plan.app/index.html'), '<h1>Three</h1>')
    await writeFile(join(fence.dir, 'notes/Plan.app/app.yaml'), 'description: Mine\n')
    await expect(fence.turnEnded()).rejects.toThrow('notes/Plan.app/app.yaml changed')
    expect(await readFile(join(root, 'notes/Plan.app/index.html'), 'utf8')).toBe('<h1>Two</h1>')
    expect(await readFile(join(root, 'notes/Plan.app/app.yaml'), 'utf8')).toBe(
      'description: Theirs\n',
    )
  })

  it('preserves an existing app file changed after the last hash check', async () => {
    let rootPath = ''
    let inject = false
    const { root, fence } = await fencedRig(undefined, SCOPE, async (rel) => {
      if (inject && rel === 'notes/Plan.app/index.html') {
        await writeFile(join(rootPath, rel), '<h1>Theirs</h1>')
      }
    })
    rootPath = root
    await mkdir(join(fence.dir, 'notes/Plan.app'), { recursive: true })
    await writeFile(join(fence.dir, 'notes/Plan.app/index.html'), '<h1>First</h1>')
    await writeFile(join(fence.dir, 'notes/Plan.app/app.yaml'), 'description: First\n')
    await fence.turnEnded()
    await writeFile(join(fence.dir, 'notes/Plan.app/index.html'), '<h1>Second</h1>')
    inject = true
    await expect(fence.turnEnded()).rejects.toThrow('did not copy back notes/Plan.app/index.html')
    expect(await readFile(join(root, 'notes/Plan.app/index.html'), 'utf8')).toBe('<h1>Theirs</h1>')
    expect((await readdir(join(root, 'notes/Plan.app'))).sort()).toEqual(['app.yaml', 'index.html'])
  })

  it('restores a vault file changed through an open descriptor after it was moved aside', async () => {
    let writer: Awaited<ReturnType<typeof open>> | undefined
    let inject = false
    const { root, fence } = await fencedRig(undefined, SCOPE, undefined, async (rel) => {
      if (!inject || rel !== 'notes/Plan.app/index.html' || writer === undefined) return
      await writer.truncate(0)
      await writer.writeFile('<h1>Theirs</h1>')
    })
    await mkdir(join(fence.dir, 'notes/Plan.app'), { recursive: true })
    await writeFile(join(fence.dir, 'notes/Plan.app/index.html'), '<h1>First</h1>')
    await writeFile(join(fence.dir, 'notes/Plan.app/app.yaml'), 'description: First\n')
    await fence.turnEnded()
    writer = await open(join(root, 'notes/Plan.app/index.html'), 'r+')
    try {
      await writeFile(join(fence.dir, 'notes/Plan.app/index.html'), '<h1>Second</h1>')
      inject = true
      await expect(fence.turnEnded()).rejects.toThrow('did not copy back notes/Plan.app/index.html')
      expect(await readFile(join(root, 'notes/Plan.app/index.html'), 'utf8')).toBe(
        '<h1>Theirs</h1>',
      )
    } finally {
      await writer.close()
    }
  })

  it('never writes over a file it was given that someone changed in the vault meanwhile', async () => {
    const { root, fence } = await fencedRig(undefined, {
      read: ['notes/Plan.md'],
      write: ['notes/Plan.md'],
    })
    // Edited in the vault during the first turn, which leaves its copy alone.
    await writeFile(join(root, 'notes/Plan.md'), 'Theirs\n')
    await fence.turnEnded()
    expect(await readFile(join(root, 'notes/Plan.md'), 'utf8')).toBe('Theirs\n')
    // The next turn changes its copy: still not written over theirs.
    await writeFile(join(fence.dir, 'notes/Plan.md'), 'Mine\n')
    await expect(fence.turnEnded()).rejects.toThrow('notes/Plan.md changed')
    expect(await readFile(join(root, 'notes/Plan.md'), 'utf8')).toBe('Theirs\n')
  })

  it('does not start where what it makes is already in the vault', async () => {
    const { root, fenced, own } = await fencedRig()
    await mkdir(join(root, 'notes/Plan.app'), { recursive: true })
    own.start.mockClear()
    expect(
      await fenced.start({
        provider: { id: 'codex' } as never,
        name: 'x',
        prompt: 'x',
        scope: SCOPE,
      }),
    ).toEqual({ ok: false, message: takenMessage('notes/Plan.app') })
    expect(own.start).not.toHaveBeenCalled()
  })

  it('gives the agent a state folder of its own, released and gone when it exits', async () => {
    const release = vi.fn(async () => {})
    const { fence } = await fencedRig(release)
    expect(fence.state).toBe(`${fence.dir}.agent`)
    expect((await readdir(fence.state)).length).toBe(0)
    await fence.exited()
    expect(release).toHaveBeenCalledWith(fence.state, undefined)
    await expect(readdir(fence.state)).resolves.toEqual([])
    expect(fence.retire).toBeTypeOf('function')
    await fence.retire?.()
    await expect(readdir(fence.state)).rejects.toThrow()
  })

  it('fails its drain and retains ownership when provider state release fails', async () => {
    const cause = new Error('provider state is busy')
    const release = vi.fn(async () => {
      throw cause
    })
    const { fenced, fence } = await fencedRig(release)
    await expect(fence.exited()).rejects.toBe(cause)
    await expect(fenced.leave()).rejects.toMatchObject({ errors: [cause] })
    await expect(readdir(fence.state)).resolves.toEqual([])
    expect(release).toHaveBeenCalledOnce()
  })

  it('opens no session once the vault is being left', async () => {
    const { fenced, own } = await fencedRig()
    own.start.mockClear()
    const res = fenced.start({
      provider: { id: 'codex' } as never,
      name: 'x',
      prompt: 'x',
      scope: { read: ['notes/Plan.md'], write: ['notes/Other.app/**'] },
    })
    await fenced.closing()
    expect(await res).toEqual({
      ok: false,
      message: 'The vault was left before the session started.',
    })
    expect(own.start).not.toHaveBeenCalled()
  })

  it('says why when its session does not start', async () => {
    const { fenced, own, fence } = await fencedRig()
    own.start.mockResolvedValueOnce({ ok: false, message: 'Codex is not installed.' } as never)
    const res = await fenced.start({
      provider: { id: 'codex' } as never,
      name: 'x',
      prompt: 'x',
      scope: SCOPE,
    })
    expect(res).toEqual({ ok: false, message: 'Codex is not installed.' })
    await fence.exited()
    await fenced.leave()
  })
})
