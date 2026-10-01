/**
 * How whatever runs inside a vault finds the running Holi: the vault's
 * `.holi/state/bridge.local.env`, the job-keyed turn route, and the readers of
 * the file (the seeded `turn-signal.mjs` hook and the seeded status line), run
 * for real. The `holi` script's reading is in `bridge-cli.test.ts`.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAgentRoutes } from '../src/main/agent/bridge-routes'
import { STATUS_LINE } from '../src/main/agent/seed/seed'
import { BRIDGE_ENV_FILE, createBridgeEnv } from '../src/main/bridge/env-file'
import { createBridgeServer, type BridgeServer } from '../src/main/bridge/server'
import { bridgeLines, writeVaultEnv } from './helpers/bridge-env'

const execFileAsync = promisify(execFile)
const HOOK = join(__dirname, '../src/main/agent/seed/vault/shipped/.claude/hooks/turn-signal.mjs')

async function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input = '',
  cwd = dir,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const child = execFileAsync(file, args, { env, cwd })
    child.child.stdin?.end(input)
    const { stdout, stderr } = await child
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

let dir: string
let server: BridgeServer
let turns: Array<[string, string, boolean]>
let statuses: Array<[string, string, unknown]>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-endpoint-'))
  turns = []
  statuses = []
  server = createBridgeServer({ log: () => {} })
  registerAgentRoutes(server, {
    onJobTurn: (remote, job, active) => turns.push([remote, job, active]),
    onStatus: (remote, job, status) => statuses.push([remote, job, status]),
    log: () => {},
  })
  await server.start()
})

afterEach(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

/** The environment of a background session: its job dir, and none of Holi's
 *  variables. */
function sessionEnv(job = '1234abcd'): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    CLAUDE_JOB_DIR: `/Users/ada/.config/jobs/${job}`,
  }
}

async function writeFor(remote = 'syv/vault'): Promise<void> {
  await writeVaultEnv(dir, bridgeLines(server.port() ?? 0, server.tokenForVault(remote)))
}

describe('the env file', () => {
  const file = () => join(dir, BRIDGE_ENV_FILE)

  it('carries what each part contributes, as KEY=value lines, owner-only', async () => {
    const env = createBridgeEnv(() => {})
    env.contribute('syv/vault', { HOLI_BRIDGE_PORT: '5000', HOLI_BRIDGE_TOKEN: 'ab12' })
    const other = env.contribute('syv/vault', { HOLI_OTHER_PORT: '6000' })
    await env.attach('syv/vault', dir)
    expect(await readFile(file(), 'utf8')).toBe(
      'HOLI_BRIDGE_PORT=5000\nHOLI_BRIDGE_TOKEN=ab12\nHOLI_OTHER_PORT=6000\n',
    )
    expect((await stat(file())).mode & 0o777).toBe(0o600)

    // Withdrawn, it is rewritten without; Holi leaving, it is gone.
    other()
    await env.attach('syv/vault', dir)
    expect(await readFile(file(), 'utf8')).toBe('HOLI_BRIDGE_PORT=5000\nHOLI_BRIDGE_TOKEN=ab12\n')
    await env.detach('syv/vault')
    await env.detach('syv/vault')
    await expect(stat(file())).rejects.toThrow()
  })

  it('refuses a value a shell could run, a key outside HOLI_, and a key twice', () => {
    const env = createBridgeEnv(() => {})
    expect(() => env.contribute('a/b', { HOLI_BRIDGE_TOKEN: '$(rm -rf ~)' })).toThrow()
    expect(() => env.contribute('a/b', { PATH: '0' })).toThrow()
    env.contribute('a/b', { HOLI_BRIDGE_PORT: '1' })
    expect(() => env.contribute('a/b', { HOLI_BRIDGE_PORT: '2' })).toThrow(/already/)
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
  it('reports its job to Holi through the env file, from anywhere in the vault, printing nothing', async () => {
    await writeFor()
    await mkdir(join(dir, 'Notes'), { recursive: true })
    const res = await run(
      process.execPath,
      [HOOK, 'start'],
      sessionEnv('abcd1234'),
      '',
      join(dir, 'Notes'),
    )
    expect(res).toMatchObject({ code: 0, stdout: '' })
    expect(turns).toEqual([['syv/vault', 'abcd1234', true]])
  })

  it('does nothing, silently, when Holi is not there or this is not a background session', async () => {
    // No env file.
    await writeVaultEnv(dir, null)
    expect(await run(process.execPath, [HOOK, 'start'], sessionEnv())).toMatchObject({
      code: 0,
      stdout: '',
    })
    // A file pointing at a closed port.
    await writeVaultEnv(dir, bridgeLines(1, 'ab'))
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
  const command = STATUS_LINE
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
    // No env file, then a closed port, then not a background session.
    await writeVaultEnv(dir, null)
    expect(await statusLine(sessionEnv(), json)).toMatchObject({
      code: 0,
      stdout: 'Opus 5.5 · 42% context',
    })
    await writeVaultEnv(dir, bridgeLines(1, 'ab'))
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
