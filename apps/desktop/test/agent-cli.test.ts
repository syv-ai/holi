/**
 * `holi`, for real: the generated script run against a live ops server.
 *
 * Generated shell is the one thing in this codebase no other test would cover —
 * a quoting bug in it does not fail loudly, it sends a different argument.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOLI_CLI_SCRIPT, installHoliCli } from '../src/main/agent/cli'
import { createHookServer, type HookServer } from '../src/main/agent/hook-server'
import { createAgentOps, type AgentOpsDeps } from '../src/main/agent/ops'

const execFileAsync = promisify(execFile)

async function run(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { env })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

let dir: string
let bin: string
let server: HookServer
let env: NodeJS.ProcessEnv
let deps: AgentOpsDeps

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-cli-'))
  bin = await installHoliCli(dir)
  deps = {
    openApp: vi.fn((id: string) => Promise.resolve({ ok: true as const, id } as { ok: true })),
    initApp: vi.fn((id: string) => Promise.resolve({ ok: true as const, created: [id] })),
    refreshSeed: vi.fn((input: { path?: string; force?: boolean }) =>
      Promise.resolve({ refreshed: [input.path ?? 'all'], skipped: [], force: input.force === true }),
    ),
  }
  server = createHookServer({
    onTurnStart: () => {},
    onTurnEnd: () => {},
    log: () => {},
    ops: createAgentOps(deps),
  })
  await server.start()
  env = {
    PATH: process.env.PATH ?? '',
    HOLI_HOOK_PORT: String(server.port()),
    HOLI_HOOK_TOKEN: server.token(),
  }
})

afterEach(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

describe('the installed script', () => {
  it('is executable', async () => {
    expect((await stat(bin)).mode & 0o777).toBe(0o755)
  })

  it('re-reads the port and token from the environment at every invocation', () => {
    // The port is ephemeral and moves across restarts, so baking either in
    // would make the CLI work exactly until the app was restarted once.
    expect(HOLI_CLI_SCRIPT).toContain('$HOLI_HOOK_PORT')
    expect(HOLI_CLI_SCRIPT).toContain('$HOLI_HOOK_TOKEN')
  })
})

describe('when Holi is not running', () => {
  it('exits non-zero with a sentence a human can read', async () => {
    const res = await run(bin, ['app', 'open', 'retro'], { PATH: env.PATH })
    expect(res.code).not.toBe(0)
    expect(res.stderr).toMatch(/holi: Holi is not running/)
  })
})

describe('usage', () => {
  it('names exactly the three subcommands when called with none', async () => {
    const res = await run(bin, [], env)
    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain('app open')
    expect(res.stderr).toContain('app init')
    expect(res.stderr).toContain('seed refresh')
  })

  it('refuses an unknown subcommand rather than doing something adjacent', async () => {
    const res = await run(bin, ['app', 'delete', 'retro'], env)
    expect(res.code).not.toBe(0)
    expect(await (deps.openApp as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })
})

describe('app open', () => {
  it('reaches the ops route and prints the answer', async () => {
    const res = await run(bin, ['app', 'open', 'retro-board'], env)
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true })
    expect(deps.openApp).toHaveBeenCalledWith('retro-board')
  })

  it('passes an id through verbatim, spaces and all', async () => {
    // Not a valid id — but the CLI must not be the thing that mangles it, or
    // the refusal names an argument the user never typed.
    await run(bin, ['app', 'open', 'my app'], env)
    expect(deps.openApp).toHaveBeenCalledWith('my app')
  })

  it('needs an id', async () => {
    const res = await run(bin, ['app', 'open'], env)
    expect(res.code).not.toBe(0)
  })
})

describe('app init', () => {
  it('reaches the ops route', async () => {
    const res = await run(bin, ['app', 'init', 'retro-board'], env)
    expect(res.code).toBe(0)
    expect(deps.initApp).toHaveBeenCalledWith('retro-board')
  })
})

describe('seed refresh', () => {
  it('with no path refreshes everything', async () => {
    const res = await run(bin, ['seed', 'refresh'], env)
    expect(res.code).toBe(0)
    expect(deps.refreshSeed).toHaveBeenCalledWith({ path: undefined, force: false })
  })

  it('takes a path', async () => {
    await run(bin, ['seed', 'refresh', '.claude/skills/vault-apps/SKILL.md'], env)
    expect(deps.refreshSeed).toHaveBeenCalledWith({
      path: '.claude/skills/vault-apps/SKILL.md',
      force: false,
    })
  })

  it('takes --force', async () => {
    await run(bin, ['seed', 'refresh', 'AGENTS.md', '--force'], env)
    expect(deps.refreshSeed).toHaveBeenCalledWith({ path: 'AGENTS.md', force: true })
  })

  it('takes --force with no path', async () => {
    await run(bin, ['seed', 'refresh', '--force'], env)
    expect(deps.refreshSeed).toHaveBeenCalledWith({ path: undefined, force: true })
  })
})
