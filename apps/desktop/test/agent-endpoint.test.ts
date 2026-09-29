/**
 * How a background session finds the running Holi: the endpoint file in
 * its config dir, the job-keyed turn route, and the readers of the file (the
 * seeded `turn-signal.mjs` hook, the seeded status line and the `holi` script),
 * run for real.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installHoliCli } from '../src/main/agent/cli'
import {
  endpointText,
  removeEndpointFile,
  writeEndpointFile,
} from '../src/main/agent/endpoint-file'
import { createHookServer, type HookServer } from '../src/main/agent/hook-server'
import { createAgentOps } from '../src/main/agent/ops'
import { SEED_FILES } from '../src/main/agent/seed-content'

const execFileAsync = promisify(execFile)
const HOOK = join(__dirname, '../src/main/agent/hooks/turn-signal.mjs')

async function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input = '',
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const child = execFileAsync(file, args, { env })
    child.child.stdin?.end(input)
    const { stdout, stderr } = await child
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

let dir: string
let server: HookServer
let turns: Array<[string, string, boolean]>
let statuses: Array<[string, string, unknown]>
const pdfComments = vi.fn((path: string) =>
  Promise.resolve({ ok: true as const, path, threads: [] }),
)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-endpoint-'))
  turns = []
  statuses = []
  server = createHookServer({
    onJobTurn: (remote, job, active) => turns.push([remote, job, active]),
    onStatus: (remote, job, status) => statuses.push([remote, job, status]),
    log: () => {},
    opsFor: () =>
      createAgentOps({
        openApp: vi.fn(),
        initApp: vi.fn(),
        refreshSeed: vi.fn(),
        pdfComments,
      } as never),
  })
  await server.start()
})

afterEach(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

/** The environment of a background session: its config dir and job dir, and
 *  none of Holi's variables. */
function sessionEnv(job = '1234abcd'): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    CLAUDE_CONFIG_DIR: dir,
    CLAUDE_JOB_DIR: `/Users/ada/.config/jobs/${job}`,
  }
}

async function writeFor(remote = 'syv/vault'): Promise<void> {
  await writeEndpointFile(dir, {
    hookPort: server.port() ?? 0,
    hookToken: server.tokenForVault(remote),
  })
}

describe('endpoint file', () => {
  it('writes KEY=value lines, owner-only', async () => {
    await writeEndpointFile(dir, { hookPort: 5000, hookToken: 'ab12', googlePort: 6000 })
    expect(await readFile(join(dir, 'holi.env'), 'utf8')).toBe(
      'HOLI_HOOK_PORT=5000\nHOLI_HOOK_TOKEN=ab12\nHOLI_GOOGLE_PORT=6000\n',
    )
    expect((await stat(join(dir, 'holi.env'))).mode & 0o777).toBe(0o600)
  })

  it('refuses a value a shell could run', () => {
    expect(() => endpointText({ hookPort: 1, hookToken: '$(rm -rf ~)' })).toThrow()
  })

  it('is gone after remove, and remove of nothing is fine', async () => {
    await writeFor()
    await removeEndpointFile(dir)
    await removeEndpointFile(dir)
    await expect(stat(join(dir, 'holi.env'))).rejects.toThrow()
  })
})

describe('job-keyed turn route', () => {
  const post = (path: string) =>
    fetch(`http://127.0.0.1:${server.port()}${path}`, { method: 'POST' })

  it('names the vault and the job, and answers an empty 204', async () => {
    const t = server.tokenForVault('syv/vault')
    const res = await post(`/turn/start?t=${t}&job=1234abcd`)
    await post(`/turn/end?t=${t}&job=1234abcd`)
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(turns).toEqual([
      ['syv/vault', '1234abcd', true],
      ['syv/vault', '1234abcd', false],
    ])
  })

  it('drops a signal with no job, or one that is not a job id', async () => {
    const t = server.tokenForVault('syv/vault')
    await post(`/turn/start?t=${t}`)
    await post(`/turn/start?t=${t}&job=../../etc`)
    expect(turns).toEqual([])
  })
})

describe('turn-signal.mjs', () => {
  it('reports its job to Holi through the endpoint file, printing nothing', async () => {
    await writeFor()
    const res = await run(process.execPath, [HOOK, 'start'], sessionEnv('abcd1234'))
    expect(res).toMatchObject({ code: 0, stdout: '' })
    expect(turns).toEqual([['syv/vault', 'abcd1234', true]])
  })

  it('does nothing, silently, when Holi is not there or this is not a background session', async () => {
    // No endpoint file.
    expect(await run(process.execPath, [HOOK, 'start'], sessionEnv())).toMatchObject({
      code: 0,
      stdout: '',
    })
    // A file pointing at a closed port.
    await writeEndpointFile(dir, { hookPort: 1, hookToken: 'ab' })
    expect(await run(process.execPath, [HOOK, 'end'], sessionEnv())).toMatchObject({
      code: 0,
      stdout: '',
    })
    // Not a background session.
    await writeFor()
    const { CLAUDE_JOB_DIR: _j, ...interactive } = sessionEnv()
    expect(await run(process.execPath, [HOOK, 'start'], interactive)).toMatchObject({ code: 0 })
    expect(turns).toEqual([])
  })
})

describe('the seeded status line', () => {
  /** Run as Claude Code runs it: the settings command, through a shell. */
  const command = JSON.parse(SEED_FILES['.claude/settings.json']!).statusLine.command as string
  const status = { model: { display_name: 'Opus 5.5' }, context_window: { used_percentage: 41.6 } }
  const statusLine = (env: NodeJS.ProcessEnv, input: string) =>
    run('/bin/sh', ['-c', command], env, input)

  it('prints the footer and hands the status to Holi under its job', async () => {
    await writeFor()
    const res = await statusLine(sessionEnv('abcd1234'), JSON.stringify(status))
    expect(res).toMatchObject({ code: 0, stdout: 'Opus 5.5 · 42% context' })
    // Detached, so the footer never waits on it.
    await vi.waitFor(() => expect(statuses).toEqual([['syv/vault', 'abcd1234', status]]))
  })

  it('prints the same footer without Holi, and only the model before the first message', async () => {
    const json = JSON.stringify(status)
    // No endpoint file, then a closed port, then not a background session.
    expect(await statusLine(sessionEnv(), json)).toMatchObject({
      code: 0,
      stdout: 'Opus 5.5 · 42% context',
    })
    await writeEndpointFile(dir, { hookPort: 1, hookToken: 'ab' })
    expect(await statusLine(sessionEnv(), json)).toMatchObject({
      code: 0,
      stdout: 'Opus 5.5 · 42% context',
    })
    await writeFor()
    const { CLAUDE_JOB_DIR: _j, ...interactive } = sessionEnv()
    expect(await statusLine(interactive, json)).toMatchObject({
      code: 0,
      stdout: 'Opus 5.5 · 42% context',
    })
    const fresh = { model: { display_name: 'Opus 5.5' }, context_window: { used_percentage: null } }
    expect(await statusLine(interactive, JSON.stringify(fresh))).toMatchObject({
      code: 0,
      stdout: 'Opus 5.5',
    })
    expect(statuses).toEqual([])
  })
})

describe('holi with only CLAUDE_CONFIG_DIR', () => {
  it('reaches Holi through the endpoint file', async () => {
    const bin = await installHoliCli(dir)
    await writeFor()
    const res = await run(bin, ['pdf', 'comments', 'a.pdf', '--json'], sessionEnv())
    expect(res.code).toBe(0)
    expect(pdfComments).toHaveBeenCalledWith('a.pdf')
  })

  it('says Holi is not running when there is no file', async () => {
    const bin = await installHoliCli(dir)
    const res = await run(bin, ['pdf', 'comments', 'a.pdf'], sessionEnv())
    expect(res.code).not.toBe(0)
    expect(res.stderr).toMatch(/not running/)
  })
})
