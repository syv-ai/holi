/**
 * Jobs (`host/jobs.ts`) and `agent.job`: a prompt run unwatched by a provider
 * without a supervisor, in a scratch folder, with only what it wrote inside
 * its scope copied back. Codex is not on the test machine, so its process is
 * a small node script that prints the JSONL `codex exec --json` does.
 */
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityContext } from '../../../main/capabilities/registry'
import { codexProvider, fenceArgs, jobArgs, readJobEvent } from '../main/codex'
import { createFencedSessions } from '../main/host/fenced'
import type { Fence } from '../main/host/pty-sessions'
import { agentCapabilities, scopeRules } from '../main/host/capabilities'
import { createUnattendedStore, unattendedRefusal } from '../main/host/unattended'
import {
  createJobs,
  inWriteScope,
  JOB_SESSION_ID,
  takenMessage,
  vaultSandbox,
  type JobScope,
} from '../main/host/jobs'
import type { SessionSummary } from '../main/claude/listing'
import type { AgentProvider, JobRun, JobsProvider } from '../main/provider'

const dirs: string[] = []
afterEach(async () => {
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
  opts: { keepMs?: number; afterWrite?: (rel: string) => Promise<void> | void } = {},
) {
  const root = await temp('holi-job-vault-')
  const userData = await temp('holi-job-data-')
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(root, 'notes/Plan.md'), 'Ship it\n')
  const script = join(userData, 'fake-codex.js')
  await writeFile(script, body)
  const lists: SessionSummary[][] = []
  const jobs = createJobs({
    vault: { remote: 'syv/vault', root },
    scratchRoot: join(userData, 'agent-jobs'),
    onChange: (list) => lists.push(list),
    killGraceMs: 200,
    log: () => {},
    ...opts,
  })
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
    expect(id).toMatch(JOB_SESSION_ID)
    expect(jobs.sessions()[0]).toMatchObject({ id, provider: 'codex', state: 'working' })

    const row = await ended(id)
    expect(row).toMatchObject({ state: 'idle', outcome: 'done' })
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
    // The scratch folder is gone.
    await vi.waitFor(async () => expect(await readdir(join(userData, 'agent-jobs'))).toEqual([]))
  })

  it('fails with the turn’s own reason, and writes nothing', async () => {
    const { root, jobs, provider, ended } = await rig(FAILED)
    const started = await jobs.start({ provider, name: 'x', prompt: 'go', scope: SCOPE })
    const row = await ended((started as { sessionId: string }).sessionId)
    expect(row).toMatchObject({ outcome: 'failed', message: 'The model refused.' })
    expect(await exists(join(root, 'notes/Plan.app/index.html'))).toBe(false)
  })

  it('fails with what a crash said on stderr', async () => {
    const { jobs, provider, ended } = await rig(CRASH)
    const started = await jobs.start({ provider, name: 'x', prompt: 'go', scope: SCOPE })
    const row = await ended((started as { sessionId: string }).sessionId)
    expect(row.outcome).toBe('failed')
    expect(row.message).toBe('Codex exited with code 3: boom: no sign-in')
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

  it('is stopped by Stop, and by leaving the vault', async () => {
    const { userData, jobs, provider, ended } = await rig(HANG)
    const a = await jobs.start({ provider, name: 'a', prompt: 'go', scope: SCOPE })
    const aId = (a as { sessionId: string }).sessionId
    await vi.waitFor(() => expect(jobs.sessions()[0]?.state).toBe('working'))
    expect(await jobs.stop(aId)).toEqual({ ok: true })
    expect(await ended(aId)).toMatchObject({ outcome: 'failed', message: 'Stopped.' })

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
      expect(row.message).toMatch(/more than Holi copies back/)
      expect(await exists(join(root, 'notes/Plan.app/f0.txt'))).toBe(false)
      expect(await exists(join(root, 'notes/Plan.app/app.yaml'))).toBe(false)
    }
  })

  it('stops where a Stop comes in during the copy back', async () => {
    let id = ''
    let jobs: Awaited<ReturnType<typeof rig>>['jobs'] | undefined
    const r = await rig(WRITES(5, 1), {
      afterWrite: async () => {
        await jobs!.stop(id)
      },
    })
    jobs = r.jobs
    const started = await r.jobs.start({
      provider: r.provider,
      name: 'x',
      prompt: 'go',
      scope: SCOPE,
    })
    id = (started as { sessionId: string }).sessionId
    const row = await r.ended(id)
    expect(row).toMatchObject({ outcome: 'failed', message: 'Stopped.' })
    // One file landed before the Stop; the finished marker never did.
    const written = (await readdir(join(r.root, 'notes/Plan.app'))).sort()
    expect(written).toHaveLength(1)
    expect(await exists(join(r.root, 'notes/Plan.app/app.yaml'))).toBe(false)
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
    expect(row.message).toMatch(/notes\/Plan\.app: something else put it in the vault/)
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
      env: { PATH: process.env.PATH ?? '', CODEX_HOME: person },
    }) as JobsProvider
    const started = await jobs.start({
      provider: codex,
      name: 'x',
      prompt: 'Make it',
      scope: SCOPE,
    })
    const row = await ended((started as { sessionId: string }).sessionId)
    expect(row.outcome).toBe('done')
    const seen = JSON.parse(await readFile(argv, 'utf8')) as {
      args: string[]
      cwd: string
      home: string
      config: string
    }
    const scratch = seen.args[seen.args.indexOf('-C') + 1]!
    // Its state folder is on its command line, where the startup sweep looks.
    const state = dirname(seen.args[seen.args.indexOf('--output-last-message') + 1]!)
    expect(state.endsWith('.agent')).toBe(true)
    expect(seen.args).toEqual(jobArgs({ cwd: scratch, prompt: 'Make it', state }))
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

describe('a job that outlived a crash', () => {
  it('is killed at the next start, known by the state folder its command line names', async () => {
    const userData = await temp('holi-job-data-')
    const scratchRoot = join(userData, 'agent-jobs')
    const state = join(scratchRoot, 'j0123456789ab.agent')
    await mkdir(state, { recursive: true })
    const orphan = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', '--', join(state, 'sessions')],
      { detached: true, stdio: 'ignore' },
    )
    const gone = new Promise((resolve) => orphan.on('exit', resolve))
    await writeFile(join(scratchRoot, 'j0123456789ab.pid'), `${orphan.pid}\n${state}\n`)
    createJobs({
      vault: { remote: 'syv/vault', root: userData },
      scratchRoot,
      onChange: () => {},
      log: () => {},
    })
    await gone
    await vi.waitFor(async () =>
      expect(await exists(join(scratchRoot, 'j0123456789ab.pid'))).toBe(false),
    )
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
      env: { PATH: '/usr/bin', CODEX_HOME: person },
    })
    const cmd = codex.terminal(
      { root: '/v', configDir: '/c', binDir: null },
      { session: 'p0123456789ab', fence: { dir: '/s', state }, prompt: '--help' },
    )
    expect(fenceArgs('/s')).toContain('approval_policy="on-request"')
    expect(fenceArgs('/s')).toContain('sandbox_workspace_write.network_access=false')
    expect(cmd?.args.slice(4)).toEqual([...fenceArgs('/s'), '--', '--help'])
    expect(codex.capabilities.fenced).toBe(true)
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
      env: { PATH: '/usr/bin', CODEX_HOME: person },
    }) as JobsProvider
    const cmd = codex.capabilities.jobs.command({ cwd: '/s', prompt: 'p', state })
    expect(cmd?.env.PATH?.split(':')).not.toContain('/holi/bin')
    expect(cmd?.env.HOLI_AGENT_SESSION).toBeUndefined()
    expect(cmd?.env.CODEX_HOME).toBe(join(state, 'codex-home'))
    expect(await readFile(join(state, 'codex-home/config.toml'), 'utf8')).not.toContain(
      'mcp_servers',
    )
    // The person's folder is untouched.
    expect(await readFile(join(person, 'config.toml'), 'utf8')).toBe(PERSON_CONFIG)
  })

  it('reads the events it needs and nothing else', () => {
    expect(
      readJobEvent('{"type":"thread.started","thread_id":"0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51"}'),
    ).toEqual({
      kind: 'thread',
      id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51',
    })
    expect(readJobEvent('{"type":"turn.completed","usage":{}}')).toEqual({
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
      unattended: { allowed: async () => true, set: async () => {} },
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
    expect(bad(undefined)).toThrow()
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
    event({ type: 'turn.completed', usage: { input_tokens: 400, output_tokens: 100 } }),
  ].join('\n')

  async function vaultRig() {
    const root = await temp('holi-job-vault-')
    const userData = await temp('holi-job-data-')
    const first = join(userData, 'first.js')
    const next = join(userData, 'next.js')
    await writeFile(first, WRITES)
    await writeFile(next, FOLLOW)
    const edges: string[] = []
    const jobs = createJobs({
      vault: { remote: 'syv/vault', root },
      scratchRoot: join(userData, 'agent-jobs'),
      onChange: () => {},
      bracket: (id, edge) => edges.push(`${edge}:${id}`),
      killGraceMs: 200,
      log: () => {},
    })
    return { root, jobs, edges, ...turns(first, next) }
  }

  it('writes only the folders its rules name, through the turn bracket, and counts tokens', async () => {
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
    expect(row).toMatchObject({ state: 'idle', outcome: 'done', model: 'gpt-5', tokens: 2000 })
    expect(edges).toEqual([`begin:${id}`, `end:${id}`, `begin:${id}`, `end:${id}`])
    expect(await readFile(join(root, 'tilbud/Q4.md'), 'utf8')).toBe('proposal')
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
      message: 'Stopped.',
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
      unattended: { allowed: async () => true, set: async () => {} },
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

describe('an unattended Codex run', () => {
  const codex = {
    id: 'codex',
    label: 'Codex',
    capabilities: { jobs: { readsAnywhere: true } },
  } as unknown as AgentProvider

  async function gate() {
    const unattended = createUnattendedStore(join(await temp('holi-unattended-'), 'u.json'))
    const start = vi.fn(async () => ({ ok: true as const, sessionId: 'j0123456789ab' }))
    const caps = agentCapabilities({
      sessions: {} as never,
      own: {} as never,
      jobs: { start } as never,
      fenced: {} as never,
      providers: () => [codex],
      terminals: {} as never,
      liveRemote: () => 'syv/vault',
      commitNow: async () => null,
      defaultProvider: async () => 'codex',
      unattended,
    })
    const ctx = { remote: 'syv/vault', root: '/v' } as unknown as CapabilityContext
    const call = <K extends 'agent.job' | 'agent.unattended' | 'agent.allowUnattended'>(
      name: K,
      p: unknown,
    ) => (caps[name].run as (c: unknown, a: unknown) => Promise<unknown>)(ctx, caps[name].params(p))
    return { call, start, unattended }
  }

  const RUN = { name: 'Proposal', prompt: 'Go.', allow: ['Edit(tilbud/**)'] }

  it('is refused in main until this machine allows it for the vault, and says how and why', async () => {
    const { call, start, unattended } = await gate()
    expect(await call('agent.unattended', { provider: 'codex' })).toBe(false)
    expect(await call('agent.job', RUN)).toEqual({
      ok: false,
      message: unattendedRefusal('Codex'),
    })
    expect(unattendedRefusal('Codex')).toMatch(/Settings, General, Agents/)
    expect(unattendedRefusal('Codex')).toMatch(/read any file on this computer/)
    expect(start).not.toHaveBeenCalled()

    // Another vault's yes is not this one's.
    await unattended.set('syv/other', 'codex', true)
    expect(await call('agent.job', RUN)).toMatchObject({ ok: false })

    await call('agent.allowUnattended', { provider: 'codex', on: true })
    expect(await call('agent.unattended', { provider: 'codex' })).toBe(true)
    expect(await call('agent.job', RUN)).toEqual({ ok: true, sessionId: 'j0123456789ab' })

    await call('agent.allowUnattended', { provider: 'codex', on: false })
    expect(await call('agent.job', RUN)).toMatchObject({ ok: false })
    expect(start).toHaveBeenCalledOnce()
  })

  it('is what Codex declares', () => {
    const real = codexProvider({ resolveBin: () => '/usr/local/bin/codex' }) as JobsProvider
    expect(real.capabilities.jobs.readsAnywhere).toBe(true)
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
    capabilities: { jobs: {}, fenced: true },
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
      unattended: { allowed: async () => true, set: async () => {} },
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
  async function fencedRig(release?: (state: string) => Promise<void>) {
    const root = await temp('holi-fenced-vault-')
    const userData = await temp('holi-fenced-data-')
    await mkdir(join(root, 'notes'), { recursive: true })
    await writeFile(join(root, 'notes/Plan.md'), 'Ship it\n')
    const jobs = createJobs({
      vault: { remote: 'syv/vault', root },
      scratchRoot: join(userData, 'agent-jobs'),
      onChange: () => {},
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
        capabilities: { fenced: true },
        ...(release === undefined ? {} : { release }),
      } as never,
      name: 'Plan: vault app',
      prompt: 'Make it',
      system: 'Make the app.',
      scope: SCOPE,
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
    await fence.turnEnded()
    expect(await readFile(join(root, 'notes/Plan.app/app.yaml'), 'utf8')).toBe(
      'description: Theirs\n',
    )
    expect(await exists(join(root, 'notes/Plan.app/index.html'))).toBe(false)
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
    fence.exited()
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(fence.state))
    await vi.waitFor(() => expect(readdir(fence.state)).rejects.toThrow())
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
    const { fenced, own } = await fencedRig()
    own.start.mockResolvedValueOnce({ ok: false, message: 'Codex is not installed.' } as never)
    const res = await fenced.start({
      provider: { id: 'codex' } as never,
      name: 'x',
      prompt: 'x',
      scope: SCOPE,
    })
    expect(res).toEqual({ ok: false, message: 'Codex is not installed.' })
    await fenced.leave()
  })
})
