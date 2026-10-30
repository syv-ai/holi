/**
 * Pi as a provider (`main/pi/`): its terminal, its jobs over RPC, and the
 * sandbox a job runs in. Pi is not on the test machine, so a job's process
 * is a small node script that speaks the RPC lines Pi does; the sandbox
 * itself is run for real where it exists (macOS).
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJobs } from '../main/host/jobs'
import {
  installRoot,
  jobArgs,
  jobCommand,
  jobEnv,
  jobInput,
  piProvider,
  readJobEvent,
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
  it('runs in RPC mode with everything of the person’s setup off and the file tools alone', () => {
    expect(
      jobArgs({ ...RUN, model: 'gpt-5', resume: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51' }),
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
      '--tools',
      'read,edit,write',
      '--model',
      'gpt-5',
    ])
    expect(jobInput(RUN).map((l) => JSON.parse(l) as unknown)).toEqual([
      { id: 'holi-state', type: 'get_state' },
      { id: 'holi-prompt', type: 'prompt', message: 'Work on it.' },
    ])
  })

  it('keeps only home, a path, the language and the model keys of its environment', () => {
    const env = jobEnv(
      {
        HOME: '/Users/ada',
        PATH: '/holi/bin:/usr/bin',
        LANG: 'da_DK.UTF-8',
        OPENAI_API_KEY: 'sk-1',
        GITHUB_TOKEN: 'ghp-no',
        HOLI_BRIDGE_TOKEN: 'no',
        SSH_AUTH_SOCK: '/tmp/agent',
      },
      { runtimeBin: '/opt/node/bin', state: '/data/j1.agent' },
    )
    expect(env).toEqual({
      HOME: '/Users/ada',
      PATH: '/opt/node/bin:/usr/bin:/bin',
      LANG: 'da_DK.UTF-8',
      TMPDIR: '/data/j1.agent/tmp',
      OPENAI_API_KEY: 'sk-1',
    })
  })

  it('runs under sandbox-exec, its runtime named, writing only its folders', () => {
    const cmd = jobCommand(
      '/nowhere/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
      { ...RUN, writable: ['/v/arkiv'], vault: '/v' },
      { env: { HOME: '/Users/ada' }, node: null },
    )
    expect(cmd.bin).toBe('/usr/bin/sandbox-exec')
    expect(cmd.args[0]).toBe('-p')
    const profile = cmd.args[1]!
    expect(profile).toContain('(subpath "/nowhere/lib/node_modules")')
    expect(profile).toContain(
      '(allow file-read* file-write* (subpath "/v/tilbud") (subpath "/v/arkiv") (subpath "/data/j1.agent") (subpath "/Users/ada/.pi/agent/auth.json") (subpath "/Users/ada/.pi/agent/auth.json.lock"))',
    )
    expect(profile).not.toContain('/Users/ada/.pi/agent/sessions')
    expect(cmd.args.slice(2)).toEqual([
      '/nowhere/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
      ...jobArgs(RUN),
    ])
    // Read-only: nothing of the vault is writable.
    const ro = jobCommand('/p/cli.js', { ...RUN, readOnly: true, vault: '/v' }, { node: null })
    expect(ro.args[1]).not.toContain('(subpath "/v/tilbud")')
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
  it('denies by default, reads the system and what it is given, and writes only its folders', () => {
    const hidden = vaultHidden('/v')
    expect(
      sandboxProfile({
        read: [{ dir: '/opt/pi' }, { dir: '/v', hidden }],
        readFiles: ['/Users/ada/.pi/agent/settings.json'],
        write: ['/v/out', '/data/j1.agent'],
      }),
    ).toMatchInlineSnapshot(`
      "(version 1)
      (deny default)
      (allow process-fork)
      (allow process-exec)
      (allow signal (target same-sandbox))
      (allow sysctl-read)
      (allow file-read-metadata)
      (allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/usr/bin") (subpath "/bin") (subpath "/System") (subpath "/Library/Preferences") (subpath "/private/etc") (subpath "/private/var/db/timezone") (subpath "/private/var/db/dyld") (subpath "/opt/homebrew/Cellar") (subpath "/opt/homebrew/opt") (subpath "/usr/local/Cellar") (subpath "/usr/local/opt") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))
      (allow file-read* (subpath "/opt/pi") (subpath "/v") (literal "/Users/ada/.pi/agent/settings.json"))
      (allow file-read* file-write* (subpath "/v/out") (subpath "/data/j1.agent"))
      (deny file-read* file-write* (regex #"^/v/(.*/)?\\.(git|holi|claude|codex|pi|agents)(/|$)") (regex #"^/v/(.*/)?[^/]*\\.local(\\.[^/]*)?$") (regex #"^/v/(.*/)?\\.(env|secrets)(\\.[^/]*)?$"))
      (allow file-write-data (literal "/dev/null"))
      (allow system-socket)
      (allow network-outbound (remote ip))
      (allow network-outbound (literal "/private/var/run/mDNSResponder"))
      "
    `)
  })

  it('keeps git, Holi’s folders, local and secret files of the vault hidden', () => {
    const [folders, local, secret] = vaultHidden('/v')
    expect(folders!.test('/v/.holi/bridge.local.env')).toBe(true)
    expect(folders!.test('/v/notes/.git/config')).toBe(true)
    expect(local!.test('/v/USER.local.md')).toBe(true)
    expect(secret!.test('/v/a/.env.production')).toBe(true)
    for (const re of [folders!, local!, secret!]) expect(re.test('/v/notes/plan.md')).toBe(false)
  })

  it.runIf(process.platform === 'darwin')(
    'lets a process write its folder and nothing else, under sandbox-exec',
    async () => {
      const dir = await temp('holi-pi-sandbox-')
      const vault = join(dir, 'vault')
      await mkdir(join(vault, 'out'), { recursive: true })
      await mkdir(join(vault, '.holi'), { recursive: true })
      await writeFile(join(vault, 'note.md'), 'hi')
      await writeFile(join(vault, '.holi/bridge.local.env'), 'TOKEN')
      const node = await realpath(process.execPath)
      const profile = sandboxProfile({
        read: [{ dir: join(node, '../..') }, { dir: vault, hidden: vaultHidden(vault) }],
        readFiles: [],
        write: [join(vault, 'out')],
      })
      const probe = `
        const fs = require('node:fs')
        const tryIt = (f) => { try { f(); return 'allowed' } catch (e) { return e.code } }
        console.log(JSON.stringify({
          writeOut: tryIt(() => fs.writeFileSync(${JSON.stringify(join(vault, 'out/a.md'))}, 'x')),
          writeVault: tryIt(() => fs.writeFileSync(${JSON.stringify(join(vault, 'b.md'))}, 'x')),
          writeElsewhere: tryIt(() => fs.writeFileSync(${JSON.stringify(join(dir, 'c.md'))}, 'x')),
          readNote: tryIt(() => fs.readFileSync(${JSON.stringify(join(vault, 'note.md'))})),
          readHidden: tryIt(() => fs.readFileSync(${JSON.stringify(join(vault, '.holi/bridge.local.env'))})),
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
        writeVault: 'EPERM',
        writeElsewhere: 'EPERM',
        readNote: 'allowed',
        readHidden: 'EPERM',
      })
    },
  )
})
