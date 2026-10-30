/**
 * Pi as a provider (`main/pi/`): its terminal, its jobs over RPC, and the
 * sandbox a job runs in. Pi is not on the test machine, so a job's process
 * is a small node script that speaks the RPC lines Pi does; the sandbox
 * itself is run for real where it exists (macOS).
 */
import { execFile, spawn } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveBin } from '../../../main/plugin-api'
import { createJobs } from '../main/host/jobs'
import {
  installRoot,
  jobArgs,
  jobCommand,
  jobEnv,
  jobInput,
  pickModel,
  piProgram,
  piProvider,
  readJobEvent,
  returnSignIn,
  terminalArgs,
} from '../main/pi'
import { sandboxProfile, vaultHidden } from '../main/pi/sandbox'
import type { JobRun, JobsProvider } from '../main/provider'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const temp = async (prefix: string): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

const RUN: JobRun = { cwd: '/v/tilbud', prompt: 'Work on it.', state: '/data/j1.agent' }

/** The launcher `pi.dev/install.sh` writes, in the part Holi reads. */
const LAUNCHER = [
  '#!/bin/sh',
  'pi_bin_dir=${pi_launcher%/*}',
  'pi_agent_dir=${pi_bin_dir%/*}',
  'pi_current_file=$pi_agent_dir/install/current-version',
  'pi_release_dir=$pi_agent_dir/install/releases/$pi_current_version',
  'pi_release_bin=$pi_release_dir/node_modules/.bin/pi',
  'exec "$pi_release_bin" "$@"',
  '',
].join('\n')

describe('a Pi terminal', () => {
  it('names a new session by the UUID Holi chose, reopens it, forks it, and keeps the ask after --', () => {
    const session = 'p0123456789ab'
    expect(terminalArgs({ session, conversation: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51' })).toEqual(
      ['--session-id', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51'],
    )
    expect(terminalArgs({ session, resume: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51' })).toEqual([
      '--session-id',
      '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51',
    ])
    expect(
      terminalArgs({
        session,
        conversation: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52',
        fork: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51',
      }),
    ).toEqual([
      '--fork',
      '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51',
      '--session-id',
      '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52',
    ])
    expect(terminalArgs({ session, resume: 'pick' })).toEqual(['--resume'])
    expect(
      terminalArgs({
        session,
        conversation: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51',
        prompt: '--help',
      }),
    ).toEqual(['--session-id', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51', '--', '--help'])
    // Only a UUID: never Holi's own id, nor one Pi would read as a flag.
    expect(terminalArgs({ session })).toEqual([])
    expect(terminalArgs({ conversation: '-rf', resume: '../x', fork: '--help' })).toEqual([])
  })

  it('is Pi, found on the machine or not', () => {
    const pi = piProvider({ resolveBin: () => null })
    expect(pi).toMatchObject({ id: 'pi', label: 'Pi', namesConversation: true })
    expect(pi.installed()).toBe(false)
    expect(pi.terminal({ root: '/v', configDir: '/c', binDir: null })).toBeNull()
  })
})

describe('a Pi job', () => {
  it('runs in RPC mode with everything of the person’s setup off, offline, and the file tools alone', () => {
    expect(
      jobArgs(
        { ...RUN, model: 'ignored', resume: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51' },
        { provider: 'openai', model: 'gpt-5' },
      ),
    ).toEqual([
      '--mode',
      'rpc',
      '--session-dir',
      '/data/j1.agent/sessions',
      '--session',
      '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-mcp',
      '--no-approve',
      '--offline',
      '--tools',
      'read,edit,write',
      '--provider',
      'openai',
      '--model',
      'gpt-5',
    ])
    expect(jobInput(RUN).map((l) => JSON.parse(l) as unknown)).toEqual([
      { id: 'holi-state', type: 'get_state' },
      { id: 'holi-prompt', type: 'prompt', message: 'Work on it.' },
    ])
  })

  it('keeps only home, a path, the language, the model keys and the way to the network', () => {
    const env = jobEnv(
      {
        HOME: '/Users/ada',
        PATH: '/holi/bin:/usr/bin',
        LANG: 'da_DK.UTF-8',
        OPENAI_API_KEY: 'sk-1',
        HTTPS_PROXY: 'http://proxy:3128',
        no_proxy: 'localhost',
        NODE_EXTRA_CA_CERTS: '/etc/corp.pem',
        PI_CODING_AGENT_DIR: '/Users/ada/pi',
        GITHUB_TOKEN: 'ghp-no',
        HOLI_BRIDGE_TOKEN: 'no',
        SSH_AUTH_SOCK: '/tmp/agent',
      },
      { runtimeBin: '/opt/node/bin', state: '/data/j1.agent', agentDir: '/data/j1.agent/pi-agent' },
    )
    expect(env).toEqual({
      HOME: '/Users/ada',
      PATH: '/opt/node/bin:/usr/bin:/bin',
      LANG: 'da_DK.UTF-8',
      TMPDIR: '/data/j1.agent/tmp',
      PI_CODING_AGENT_DIR: '/data/j1.agent/pi-agent',
      OPENAI_API_KEY: 'sk-1',
      HTTPS_PROXY: 'http://proxy:3128',
      no_proxy: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/corp.pem',
    })
  })

  /** A home with Pi's folder (settings and models behind symlinks, as a
   *  dotfiles setup has them, and two providers signed in), a Pi install,
   *  a vault and a job's state folder. */
  async function machine() {
    const root = await temp('holi-pi-machine-')
    const home = join(root, 'home')
    const agent = join(home, '.pi', 'agent')
    const dotfiles = join(home, 'dotfiles')
    await mkdir(agent, { recursive: true })
    await mkdir(dotfiles, { recursive: true })
    await writeFile(
      join(dotfiles, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-haiku-4-5' }),
    )
    await symlink(join(dotfiles, 'settings.json'), join(agent, 'settings.json'))
    await writeFile(join(dotfiles, 'models.json'), '{"providers":{}}')
    await symlink(join(dotfiles, 'models.json'), join(agent, 'models.json'))
    await writeFile(
      join(agent, 'auth.json'),
      JSON.stringify({
        anthropic: { type: 'oauth', access: 'a1', refresh: 'r1', expires: 1 },
        openai: { type: 'api_key', key: 'sk-other' },
      }),
    )
    await mkdir(join(agent, 'sessions'), { recursive: true })
    const lib = join(root, 'lib/node_modules/@earendil-works/pi-coding-agent/dist')
    await mkdir(lib, { recursive: true })
    const script = join(lib, 'cli.js')
    await writeFile(script, '#!/usr/bin/env node\n')
    await chmod(script, 0o755)
    const vault = join(root, 'vault')
    await mkdir(join(vault, 'tilbud'), { recursive: true })
    const state = join(root, 'data/j1.agent')
    await mkdir(join(state, 'tmp'), { recursive: true })
    const node = await realpath(process.execPath)
    const run: JobRun = { cwd: join(vault, 'tilbud'), prompt: 'Go.', state, vault }
    return { root, home, agent, script, vault, state, node, run, env: { HOME: home } }
  }

  it('runs under sandbox-exec, its runtime and script named, writing only its folders', async () => {
    const { agent, script, vault, state, node, run, env } = await machine()
    const { command } = jobCommand(
      script,
      { ...run, writable: [join(vault, 'arkiv')] },
      {
        env,
        node,
      },
    )
    expect(command.bin).toBe('/usr/bin/sandbox-exec')
    expect(command.args[0]).toBe('-p')
    const profile = command.args[1]!
    expect(profile).toContain(`(allow process-exec (literal "${node}") (literal "${script}"))`)
    expect(profile).toContain(`(subpath "${script.slice(0, script.indexOf('/@earendil'))}")`)
    expect(profile).toContain(
      `(allow file-read* file-write* (subpath "${join(vault, 'tilbud')}") (subpath "${join(vault, 'arkiv')}") (subpath "${state}"))`,
    )
    // Nothing of the person's Pi folder: the job has its own.
    expect(profile).not.toContain(agent)
    expect(command.env.PI_CODING_AGENT_DIR).toBe(join(state, 'pi-agent'))
    expect(command.args.slice(2)).toEqual([
      node,
      script,
      ...jobArgs(run, { provider: 'anthropic', model: 'claude-haiku-4-5' }),
    ])
    // Read-only: nothing of the vault is writable.
    const ro = jobCommand(script, { ...run, readOnly: true }, { env, node })
    expect(ro.command.args[1]).not.toContain(`(subpath "${join(vault, 'tilbud')}")`)
  })

  it('gets copies of Pi’s settings and the sign-in of its one provider', async () => {
    const { agent, script, state, node, run, env } = await machine()
    const { signIn } = jobCommand(script, run, { env, node })
    const own = join(state, 'pi-agent')
    expect(JSON.parse(await readFile(join(own, 'auth.json'), 'utf8'))).toEqual({
      anthropic: { type: 'oauth', access: 'a1', refresh: 'r1', expires: 1 },
    })
    // The symlinks read through: plain files in the job's folder.
    expect((await lstat(join(own, 'settings.json'))).isSymbolicLink()).toBe(false)
    expect(await readFile(join(own, 'models.json'), 'utf8')).toBe('{"providers":{}}')
    expect(signIn).toMatchObject({ file: join(agent, 'auth.json'), provider: 'anthropic' })
    // The job's own model names its provider.
    jobCommand(script, { ...run, model: 'openai/gpt-5' }, { env, node })
    expect(JSON.parse(await readFile(join(own, 'auth.json'), 'utf8'))).toEqual({
      openai: { type: 'api_key', key: 'sk-other' },
    })
  })

  it('does not run when it cannot tell which provider runs it', async () => {
    const { agent, script, node, run, env } = await machine()
    await rm(join(agent, 'settings.json'))
    expect(() => jobCommand(script, run, { env, node })).toThrow(/Pi has no default model/)
    expect(() => jobCommand(script, { ...run, model: 'gpt-5' }, { env, node })).toThrow(
      /which of Pi's providers runs gpt-5/,
    )
    expect(pickModel({ defaultProvider: 'openai' }, 'gpt-5')).toEqual({
      provider: 'openai',
      model: 'gpt-5',
    })
  })

  it('hands a refreshed token back to that provider alone, under Pi’s lock', async () => {
    const { agent, script, state, node, run, env } = await machine()
    const { signIn } = jobCommand(script, run, { env, node })
    const own = join(state, 'pi-agent', 'auth.json')
    const refreshed = { type: 'oauth', access: 'a2', refresh: 'r2', expires: 2 }
    await writeFile(
      own,
      JSON.stringify({ anthropic: refreshed, openai: { type: 'api_key', key: 'x' } }),
    )
    await returnSignIn(signIn)
    expect(JSON.parse(await readFile(join(agent, 'auth.json'), 'utf8'))).toEqual({
      anthropic: refreshed,
      openai: { type: 'api_key', key: 'sk-other' },
    })
    await expect(lstat(join(agent, 'auth.json.lock'))).rejects.toThrow()
    // One the person changed meanwhile is newer: it stands.
    const second = jobCommand(script, run, { env, node }).signIn
    await writeFile(
      join(agent, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'oauth', access: 'mine', refresh: 'r3', expires: 3 } }),
    )
    await writeFile(own, JSON.stringify({ anthropic: { ...refreshed, access: 'a4' } }))
    await returnSignIn(second)
    expect(JSON.parse(await readFile(join(agent, 'auth.json'), 'utf8'))).toMatchObject({
      anthropic: { access: 'mine' },
    })
    // Nor is a credential of another kind taken back.
    const third = jobCommand(script, run, { env, node }).signIn
    await writeFile(own, JSON.stringify({ anthropic: { type: 'api_key', key: 'planted' } }))
    await returnSignIn(third)
    expect(JSON.parse(await readFile(join(agent, 'auth.json'), 'utf8'))).toMatchObject({
      anthropic: { access: 'mine' },
    })
  })

  it('follows Pi’s own launcher to its release and its Node', async () => {
    const { root, home, node, run, env } = await machine()
    const managed = join(home, '.pi', 'agent')
    const release = join(managed, 'install/releases/1.4.0/node_modules')
    const cli = join(release, '@earendil-works/pi-coding-agent/dist/cli.js')
    await mkdir(dirname(cli), { recursive: true })
    await writeFile(cli, '#!/usr/bin/env node\n')
    await chmod(cli, 0o755)
    await mkdir(join(release, '.bin'), { recursive: true })
    await symlink('../@earendil-works/pi-coding-agent/dist/cli.js', join(release, '.bin/pi'))
    await writeFile(join(managed, 'install/current-version'), '1.4.0\n')
    const launcher = join(managed, 'bin/pi')
    await mkdir(dirname(launcher), { recursive: true })
    await writeFile(launcher, LAUNCHER)
    await chmod(launcher, 0o755)
    const piNode = join(home, '.local/share/pi-node/current/bin/node')
    await mkdir(dirname(piNode), { recursive: true })
    await symlink(node, piNode)
    expect(piProgram(launcher, env, null)).toEqual({ runtime: node, script: cli })
    const { command } = jobCommand(launcher, run, { env, node: null })
    expect(command.args[1]).toContain(`(subpath "${release}")`)
    expect(command.args[1]).not.toContain(`(subpath "${managed}")`)
    // A version it cannot read, or a script it cannot follow, is refused.
    await writeFile(join(managed, 'install/current-version'), '../../..\n')
    expect(() => piProgram(launcher, env, node)).toThrow(/could not tell which Pi release/)
    const shell = join(root, 'pi-wrapper')
    await writeFile(shell, '#!/bin/sh\nexec somewhere "$@"\n')
    expect(() => piProgram(shell, env, node)).toThrow(/cannot follow/)
  })

  it('never opens the home folder or Pi’s own to a job', async () => {
    const { home, node, run, env } = await machine()
    // A script straight in the home folder would make it the install's root.
    const loose = join(home, 'bin/pi')
    await mkdir(dirname(loose), { recursive: true })
    await writeFile(loose, '#!/usr/bin/env node\n')
    expect(() => jobCommand(loose, run, { env, node })).toThrow(/your home folder/)
    const inAgent = join(home, '.pi/agent/pi.js')
    await writeFile(inAgent, '#!/usr/bin/env node\n')
    expect(() => jobCommand(inAgent, run, { env, node })).toThrow(/Pi's own folder/)
  })

  it('finds its install’s packages', () => {
    expect(installRoot('/opt/homebrew/lib/node_modules/@x/pi/dist/cli.js')).toBe(
      '/opt/homebrew/lib/node_modules',
    )
    expect(
      installRoot('/Users/ada/Library/pnpm/global/5/.pnpm/@x+pi@1/node_modules/@x/pi/dist/cli.js'),
    ).toBe('/Users/ada/Library/pnpm/global/5/.pnpm')
    expect(installRoot('/usr/local/pi/bin/pi')).toBe('/usr/local/pi')
  })

  it('does not run where there is no boundary', () => {
    const jobs = piProvider({ resolveBin: () => '/bin/pi', platform: 'linux' }).capabilities.jobs!
    expect(jobs.unavailable?.()).toMatch(/no safe boundary to put around it on this platform/)
  })

  it('reads its session, refusals, replies and settling, and nothing else', () => {
    expect(
      readJobEvent(
        '{"id":"holi-state","type":"response","command":"get_state","success":true,"data":{"sessionId":"0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51","model":{"id":"claude-haiku-4-5"}}}',
      ),
    ).toEqual({
      kind: 'thread',
      id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51',
      model: 'claude-haiku-4-5',
    })
    // A session id that is not a UUID is no thread to resume.
    expect(
      readJobEvent(
        '{"id":"holi-state","type":"response","command":"get_state","success":true,"data":{"sessionId":"--help"}}',
      ),
    ).toBeNull()
    expect(jobArgs({ ...RUN, resume: '--help' })).not.toContain('--session')
    expect(
      readJobEvent(
        '{"id":"holi-prompt","type":"response","command":"prompt","success":false,"error":"No API key found for the selected model.\\n\\nUse /login"}',
      ),
    ).toEqual({ kind: 'error', message: 'No API key found for the selected model.' })
    expect(
      readJobEvent(
        '{"id":"holi-prompt","type":"response","command":"prompt","success":true,"data":{"disposition":"handled"}}',
      ),
    ).toMatchObject({ kind: 'error' })
    expect(
      readJobEvent(
        '{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15},"stopReason":"error","errorMessage":"401 invalid x-api-key"}}',
      ),
    ).toEqual({ kind: 'reply', tokens: 15, error: '401 invalid x-api-key' })
    expect(
      readJobEvent('{"type":"message_end","message":{"role":"user","content":"hi"}}'),
    ).toBeNull()
    expect(readJobEvent('{"type":"agent_settled","aborted":true}')).toEqual({
      kind: 'settled',
      aborted: true,
    })
    expect(readJobEvent('{"type":"agent_end","messages":[]}')).toBeNull()
    expect(readJobEvent('not json')).toBeNull()
  })
})

/** Speaks Pi's RPC lines: the session asked, the prompt run, an abort taken.
 *  `FAKE_MODE` picks how the run goes; each turn's prompt is appended to
 *  `turns.txt` in its folder. */
const FAKE_PI = `
const fs = require('node:fs')
const args = process.argv.slice(2)
const mode = process.env.FAKE_MODE
const at = args.indexOf('--session')
const session = at === -1 ? '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51' : args[at + 1]
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let timer
require('node:readline').createInterface({ input: process.stdin })
  .on('line', (line) => {
    const c = JSON.parse(line)
    if (c.type === 'get_state') {
      if (mode === 'refuse-state') return out({ id: c.id, type: 'response', command: 'get_state', success: false, error: 'Session file is not readable.' })
      out({ id: c.id, type: 'response', command: 'get_state', success: true, data: { sessionId: session, model: { id: 'gpt-5' } } })
    } else if (c.type === 'prompt') {
      if (mode === 'refuse') return out({ id: c.id, type: 'response', command: 'prompt', success: false, error: 'No API key found for the selected model.' })
      out({ id: c.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
      fs.appendFileSync('turns.txt', c.message + '\\n')
      if (mode === 'hang' || mode === 'stubborn') { timer = setInterval(() => {}, 1000); return }
      setTimeout(() => {
        out({ type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 1500 }, stopReason: mode === 'error' ? 'error' : 'stop', ...(mode === 'error' ? { errorMessage: '401 invalid x-api-key' } : {}) } })
        out({ type: 'agent_settled', aborted: false })
      }, mode === 'slow' ? 300 : 0)
    } else if (c.type === 'abort' && mode !== 'stubborn') {
      clearInterval(timer)
      out({ type: 'agent_settled', aborted: true })
    }
  })
  .on('close', () => { if (mode !== 'stubborn') process.exit(0) })
`

describe('Pi jobs over RPC', () => {
  async function rig(mode: string) {
    const root = await temp('holi-pi-vault-')
    const userData = await temp('holi-pi-data-')
    const script = join(userData, 'fake-pi.js')
    await writeFile(script, FAKE_PI)
    const runs: JobRun[] = []
    const edges: string[] = []
    const real = piProvider({ resolveBin: () => '/bin/pi', platform: 'darwin' })
    const provider: JobsProvider = {
      ...real,
      capabilities: {
        jobs: {
          ...real.capabilities.jobs!,
          unavailable: () => null,
          command: (run) => {
            runs.push(run)
            return {
              bin: process.execPath,
              args: [script, ...jobArgs(run)],
              env: { PATH: process.env.PATH ?? '', FAKE_MODE: mode },
            }
          },
        },
      },
    }
    const jobs = createJobs({
      vault: { remote: 'syv/vault', root },
      scratchRoot: join(userData, 'agent-jobs'),
      onChange: () => {},
      bracket: (id, edge) => edges.push(`${edge}:${id}`),
      killGraceMs: 200,
      log: () => {},
    })
    const ended = (id: string) =>
      vi.waitFor(
        () => {
          const row = jobs.sessions().find((s) => s.id === id)
          if (row?.outcome === undefined || row.state !== 'idle') throw new Error('running')
          return row
        },
        { timeout: 5_000 },
      )
    const start = async () => {
      const res = await jobs.start({
        provider,
        name: 'Proposal',
        prompt: 'Work on kunder/Q4.md.',
        allow: ['Edit(tilbud/**)'],
      })
      if (!res.ok) throw new Error(res.message)
      return res.sessionId
    }
    return { root, userData, jobs, runs, edges, ended, start }
  }

  it('waits for the run to settle, then reads its model and tokens and resumes its session', async () => {
    const { root, jobs, runs, edges, ended, start } = await rig('slow')
    const id = await start()
    expect(runs[0]).toMatchObject({ vault: root, state: expect.stringContaining(`${id}.agent`) })
    // A follow-up while it runs waits for the run to settle.
    jobs.message(id, 'Shorter.')
    await vi.waitFor(() => expect(runs).toHaveLength(2), { timeout: 5_000 })
    expect(runs[1]).toMatchObject({
      resume: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51',
      prompt: 'Shorter.',
    })
    await vi.waitFor(() => expect(edges).toHaveLength(4), { timeout: 5_000 })
    expect(await ended(id)).toMatchObject({ outcome: 'done', model: 'gpt-5', tokens: 3000 })
    const turns = await readFile(join(root, 'tilbud/turns.txt'), 'utf8')
    expect(turns.trim().split('\n').at(-1)).toBe('Shorter.')
    await jobs.leave()
  })

  it('fails with the reply’s error, or the command Pi refused', async () => {
    for (const [mode, message] of [
      ['error', '401 invalid x-api-key'],
      ['refuse', 'No API key found for the selected model.'],
      // Refused, though the run that follows settles as it should.
      ['refuse-state', 'Session file is not readable.'],
    ] as const) {
      const { jobs, ended, start } = await rig(mode)
      expect(await ended(await start())).toMatchObject({ outcome: 'failed', message })
      await jobs.leave()
    }
  })

  it('is stopped by an abort, and killed when it does not listen', async () => {
    for (const mode of ['hang', 'stubborn']) {
      const { jobs, ended, start } = await rig(mode)
      const id = await start()
      await vi.waitFor(() => expect(jobs.sessions()[0]?.state).toBe('working'))
      expect(await jobs.stop(id)).toEqual({ ok: true })
      expect(await ended(id)).toMatchObject({ outcome: 'failed', message: 'Stopped.' })
      await jobs.leave()
    }
  })

  it('is refused, never run, where there is no boundary', async () => {
    const { jobs } = await rig('slow')
    const linux = piProvider({ resolveBin: () => '/bin/pi', platform: 'linux' }) as JobsProvider
    const res = await jobs.start({ provider: linux, name: 'x', prompt: 'go', allow: [] })
    expect(res).toMatchObject({ ok: false, message: expect.stringMatching(/no safe boundary/) })
    expect(jobs.sessions()).toEqual([])
  })
})

describe('the sandbox profile', () => {
  it('denies by default, runs and reads only what it is given, and writes only its folders', () => {
    const hidden = vaultHidden('/v')
    expect(
      sandboxProfile({
        exec: ['/opt/node/bin/node', '/opt/pi/cli.js'],
        read: [{ dir: '/opt/pi' }, { dir: '/v', hidden }],
        readFiles: ['/etc/corp.pem'],
        write: ['/v/out', '/data/j1.agent'],
      }),
    ).toMatchInlineSnapshot(`
      "(version 1)
      (deny default)
      (allow process-fork)
      (allow signal (target same-sandbox))
      (allow sysctl-read)
      (allow file-read-metadata)
      (allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/usr/bin") (subpath "/bin") (subpath "/System") (subpath "/Library/Preferences") (subpath "/private/etc") (subpath "/private/var/db/timezone") (subpath "/private/var/db/dyld") (subpath "/opt/homebrew/Cellar") (subpath "/opt/homebrew/opt") (subpath "/usr/local/Cellar") (subpath "/usr/local/opt") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))
      (allow process-exec (literal "/opt/node/bin/node") (literal "/opt/pi/cli.js"))
      (allow file-read* (subpath "/opt/pi") (subpath "/v") (literal "/etc/corp.pem"))
      (allow file-read* file-write* (subpath "/v/out") (subpath "/data/j1.agent"))
      (deny file-read* file-write* (regex #"^/v/(.*/)?\\.[^/]*(/|$)") (regex #"^/v/(.*/)?[^/]*\\.[lL][oO][cC][aA][lL](\\.[^/]*)?(/|$)") (regex #"^/v/(.*/)?\\.([eE][nN][vV]|[sS][eE][cC][rR][eE][tT][sS])(\\.[^/]*)?(/|$)"))
      (allow file-write-data (literal "/dev/null"))
      (allow system-socket)
      (allow network-outbound (remote ip))
      (allow network-outbound (literal "/private/var/run/mDNSResponder"))
      "
    `)
  })

  it('keeps every dot segment, local and secret path of the vault hidden, at any depth', () => {
    const hidden = vaultHidden('/v')
    const isHidden = (path: string) => hidden.some((re) => re.test(path))
    for (const path of [
      '/v/.holi/bridge.local.env',
      '/v/notes/.git/config',
      '/v/.gitignore',
      '/v/USER.local.md',
      '/v/Home.local.app/records.json',
      '/v/apps/Home.LOCAL.app/records.json',
      '/v/a/.env.production',
      '/v/.secrets/token',
      '/v/.env.d/x',
      '/v/.ENV',
      '/v/out/.cache/x',
    ]) {
      expect(isHidden(path), path).toBe(true)
    }
    for (const path of ['/v/notes/plan.md', '/v/env.md', '/v/local.md', '/v/Home.app/index.html']) {
      expect(isHidden(path), path).toBe(false)
    }
    expect(() =>
      sandboxProfile({
        exec: [],
        read: [{ dir: '/v"x', hidden: vaultHidden('/v"x') }],
        readFiles: [],
        write: [],
      }),
    ).toThrow(/double quote/)
  })

  it.runIf(process.platform === 'darwin')(
    'lets a process write its folder and nothing else, under sandbox-exec',
    async () => {
      const dir = await temp('holi-pi-sandbox-')
      const vault = join(dir, 'vault')
      const outside = join(dir, 'outside')
      await mkdir(join(vault, 'out'), { recursive: true })
      await mkdir(join(vault, '.holi'), { recursive: true })
      await mkdir(join(vault, 'Home.local.app'), { recursive: true })
      await mkdir(join(vault, '.secrets'), { recursive: true })
      await mkdir(join(vault, '.env.d'), { recursive: true })
      await mkdir(outside, { recursive: true })
      await writeFile(join(vault, 'note.md'), 'hi')
      await writeFile(join(vault, '.holi/bridge.local.env'), 'TOKEN')
      await writeFile(join(vault, 'Home.local.app/records.json'), '{}')
      await writeFile(join(vault, '.secrets/token'), 'x')
      await writeFile(join(vault, '.env.d/x'), 'x')
      await writeFile(join(vault, '.ENV'), 'x')
      await writeFile(join(outside, 'other.md'), 'x')
      const node = await realpath(process.execPath)
      const profile = sandboxProfile({
        exec: [node],
        read: [{ dir: join(node, '../..') }, { dir: vault, hidden: vaultHidden(vault) }],
        readFiles: [],
        write: [join(vault, 'out')],
      })
      const at = (rel: string) => JSON.stringify(join(vault, rel))
      const probe = `
        const fs = require('node:fs')
        const tryIt = (f) => { try { f(); return 'allowed' } catch (e) { return e.code } }
        console.log(JSON.stringify({
          writeOut: tryIt(() => fs.writeFileSync(${at('out/a.md')}, 'x')),
          writeOutHidden: tryIt(() => fs.writeFileSync(${at('out/.env')}, 'x')),
          writeVault: tryIt(() => fs.writeFileSync(${at('b.md')}, 'x')),
          writeElsewhere: tryIt(() => fs.writeFileSync(${JSON.stringify(join(dir, 'c.md'))}, 'x')),
          readNote: tryIt(() => fs.readFileSync(${at('note.md')})),
          readOutside: tryIt(() => fs.readFileSync(${JSON.stringify(join(outside, 'other.md'))})),
          readHidden: tryIt(() => fs.readFileSync(${at('.holi/bridge.local.env')})),
          readLocalApp: tryIt(() => fs.readFileSync(${at('Home.local.app/records.json')})),
          readSecrets: tryIt(() => fs.readFileSync(${at('.secrets/token')})),
          readEnvFolder: tryIt(() => fs.readFileSync(${at('.env.d/x')})),
          readEnvUpper: tryIt(() => fs.readFileSync(${at('.ENV')})),
          exec: tryIt(() => require('node:child_process').execFileSync('/bin/echo', ['x'])),
        }))
      `
      const { stdout } = await promisify(execFile)('/usr/bin/sandbox-exec', [
        '-p',
        profile,
        node,
        '-e',
        probe,
      ])
      expect(JSON.parse(stdout)).toEqual({
        writeOut: 'allowed',
        writeOutHidden: 'EPERM',
        writeVault: 'EPERM',
        writeElsewhere: 'EPERM',
        readNote: 'allowed',
        readOutside: 'EPERM',
        readHidden: 'EPERM',
        readLocalApp: 'EPERM',
        readSecrets: 'EPERM',
        readEnvFolder: 'EPERM',
        readEnvUpper: 'EPERM',
        exec: 'EPERM',
      })
    },
  )
})

/** The Pi on this machine (`HOLI_PI_BIN`, else `pi` on `PATH`), when there
 *  is one: the smoke test runs it for real, under the real profile. */
const realPi = (() => {
  const override = process.env.HOLI_PI_BIN
  return override !== undefined && override !== '' ? override : resolveBin('pi')
})()

describe.runIf(process.platform === 'darwin' && realPi !== null)('the real Pi, sandboxed', () => {
  it('starts, says its session, and ends on an abort and its input closed', async () => {
    const root = await temp('holi-pi-real-')
    const home = join(root, 'home')
    const agent = join(home, '.pi/agent')
    await mkdir(agent, { recursive: true })
    await writeFile(
      join(agent, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-haiku-4-5' }),
    )
    const vault = join(root, 'vault')
    await mkdir(join(vault, 'out'), { recursive: true })
    const state = join(root, 'data/j1.agent')
    await mkdir(join(state, 'tmp'), { recursive: true })
    const run: JobRun = { cwd: join(vault, 'out'), prompt: 'unused', state, vault }
    const { command } = jobCommand(realPi!, run, {
      env: { HOME: home, PATH: process.env.PATH ?? '' },
    })
    const child = spawn(command.bin, command.args, {
      cwd: run.cwd,
      env: command.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
    const events: unknown[] = []
    createInterface({ input: child.stdout }).on('line', (line) => {
      const event = readJobEvent(line)
      if (event !== null) events.push(event)
    })
    child.stdin.write(`${jobInput(run)[0]}\n`)
    try {
      await vi.waitFor(
        () => expect(events).toContainEqual(expect.objectContaining({ kind: 'thread' })),
        {
          timeout: 20_000,
          interval: 50,
        },
      )
    } catch (err) {
      child.kill('SIGKILL')
      throw new Error(`${(err as Error).message}\n${stderr}`)
    }
    child.stdin.write(`${piProvider().capabilities.jobs!.input!.abort}\n`)
    child.stdin.end()
    expect(await exited).toBe(0)
    // The job's Pi folder was its own: the session landed in its state.
    expect(events[0]).toMatchObject({
      kind: 'thread',
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
  }, 30_000)
})
