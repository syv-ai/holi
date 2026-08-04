import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentRuntime,
  buildAgentArgs,
  buildAgentEnv,
  isClaudeAuthenticated,
  resolveClaudeBin,
  type PtyProcess,
} from '../src/main/agent/agent-runtime'

/** Above the OS pid ceiling: the group kill fails, exposing the pty.kill path. */
const NO_SUCH_PID = 999_999

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-runtime-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** Fake PTY: records writes/resizes/kills, exits on command. */
class FakePty implements PtyProcess {
  readonly writes: string[] = []
  readonly resizes: Array<[number, number]> = []
  readonly kills: Array<string | undefined> = []
  private dataCb: ((d: string) => void) | null = null
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null

  constructor(readonly pid = 4242) {}

  onData(cb: (d: string) => void) {
    this.dataCb = cb
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exitCb = cb
  }
  write(data: string) {
    this.writes.push(data)
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows])
  }
  kill(signal?: string) {
    this.kills.push(signal)
  }

  emit(data: string) {
    this.dataCb?.(data)
  }
  exit(code = 0) {
    this.exitCb?.({ exitCode: code })
  }
}

interface Spawned {
  pty: FakePty
  file: string
  args: string[]
  opts: { cwd: string; env: Record<string, string> }
}

function fakeSpawn(pid?: number) {
  const spawns: Spawned[] = []
  const spawn = (file: string, args: string[], opts: any) => {
    const pty = new FakePty(pid)
    spawns.push({ pty, file, args, opts })
    return pty
  }
  return { spawn, spawns }
}

describe('buildAgentEnv', () => {
  it('strips the nested-session guards and sets TERM', () => {
    const env = buildAgentEnv({
      PATH: '/usr/bin',
      HOME: '/Users/nic',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      TERM: 'dumb',
      UNDEFINED_VAR: undefined,
    })
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.UNDEFINED_VAR).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/Users/nic')
    expect(env.TERM).toBe('xterm-256color')
    // the user's own ~/.claude stays in play (PRD) — we never redirect it
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('hands the child no endpoint or bearer — there is no MCP server (D60)', () => {
    const env = buildAgentEnv({ PATH: '/usr/bin' })
    expect(env.HOLI_AGENT_ENDPOINT).toBeUndefined()
    expect(env.HOLI_AGENT_TOKEN).toBeUndefined()
  })

  it('forces NO_FLICKER on — the embedded xterm flickers under the full-redraw renderer', () => {
    expect(buildAgentEnv({ PATH: '/usr/bin' }).CLAUDE_CODE_NO_FLICKER).toBe('1')
  })

  it('injects the hook port and token when given', () => {
    const env = buildAgentEnv({ PATH: '/usr/bin' }, { hookPort: 5000, hookToken: 'abc123' })
    expect(env.HOLI_HOOK_PORT).toBe('5000')
    expect(env.HOLI_HOOK_TOKEN).toBe('abc123')
  })

  it('omits the hook keys when absent or null', () => {
    expect(buildAgentEnv({ PATH: '/usr/bin' }).HOLI_HOOK_PORT).toBeUndefined()
    const env = buildAgentEnv({ PATH: '/usr/bin' }, { hookPort: null, hookToken: null })
    expect(env.HOLI_HOOK_PORT).toBeUndefined()
    expect(env.HOLI_HOOK_TOKEN).toBeUndefined()
  })

  it('strips inherited hook keys so a vault cannot spoof them (reserved)', () => {
    const env = buildAgentEnv({ PATH: '/usr/bin', HOLI_HOOK_PORT: '9', HOLI_HOOK_TOKEN: 'evil' })
    expect(env.HOLI_HOOK_PORT).toBeUndefined()
    expect(env.HOLI_HOOK_TOKEN).toBeUndefined()
  })

  it('sets TYPST_BIN when the typst path is given, omits it otherwise', () => {
    expect(buildAgentEnv({ PATH: '/usr/bin' }, { typstBin: '/opt/typst' }).TYPST_BIN).toBe('/opt/typst')
    expect(buildAgentEnv({ PATH: '/usr/bin' }).TYPST_BIN).toBeUndefined()
    expect(buildAgentEnv({ PATH: '/usr/bin' }, { typstBin: null }).TYPST_BIN).toBeUndefined()
  })

  it('passes the Google ops channel and the holi-google path (D67)', () => {
    const env = buildAgentEnv(
      { PATH: '/usr/bin' },
      { googlePort: 6001, googleToken: 'tok', googleBin: '/data/bin/holi-google' },
    )
    expect(env.HOLI_GOOGLE_PORT).toBe('6001')
    expect(env.HOLI_GOOGLE_TOKEN).toBe('tok')
    expect(env.HOLI_GOOGLE_BIN).toBe('/data/bin/holi-google')
  })

  it('omits the Google keys when the channel is not running', () => {
    const env = buildAgentEnv({ PATH: '/usr/bin' }, { googlePort: null, googleToken: null })
    expect(env.HOLI_GOOGLE_PORT).toBeUndefined()
    expect(env.HOLI_GOOGLE_TOKEN).toBeUndefined()
    expect(env.HOLI_GOOGLE_BIN).toBeUndefined()
  })

  it('strips inherited Google keys so a vault cannot point the agent elsewhere', () => {
    // The agent asks this channel for the user's mail; letting a committed
    // `.env` redirect it would be a vault stealing another vault's inbox.
    const env = buildAgentEnv({
      PATH: '/usr/bin',
      HOLI_GOOGLE_PORT: '9',
      HOLI_GOOGLE_TOKEN: 'evil',
      HOLI_GOOGLE_BIN: '/tmp/evil',
    })
    expect(env.HOLI_GOOGLE_PORT).toBeUndefined()
    expect(env.HOLI_GOOGLE_TOKEN).toBeUndefined()
    expect(env.HOLI_GOOGLE_BIN).toBeUndefined()
  })
})

describe('buildAgentArgs', () => {
  it('is bare by default — no prompt, no flags (interactive Claude Code)', () => {
    expect(buildAgentArgs()).toEqual([])
  })

  it('never passes --append-system-prompt (Holi builds no prompt content)', () => {
    expect(buildAgentArgs()).not.toContain('--append-system-prompt')
    expect(buildAgentArgs({ resume: true })).not.toContain('--append-system-prompt')
  })

  it('declares no MCP config, and does not suppress the vault own (D60)', () => {
    const args = buildAgentArgs({ resume: true })
    expect(args).not.toContain('--mcp-config')
    // --strict-mcp-config would also disable MCP servers the VAULT configures
    // natively in .claude/, which it is entitled to do.
    expect(args).not.toContain('--strict-mcp-config')
  })

  it('adds a bare --resume when asked (the CLI shows its native picker)', () => {
    expect(buildAgentArgs({ resume: true })).toEqual(['--resume'])
  })

  it('appends a prompt as the last positional arg (seeds the interactive turn)', () => {
    // `claude "<prompt>"` starts interactive and auto-submits it — the reconcile seed.
    expect(buildAgentArgs({ prompt: 'resolve the merge' })).toEqual(['resolve the merge'])
    expect(buildAgentArgs({})).toEqual([])
  })

  it('never passes --dangerously-skip-permissions', () => {
    for (const resume of [true, false]) {
      expect(buildAgentArgs({ resume })).not.toContain('--dangerously-skip-permissions')
    }
  })
})

describe('resolveClaudeBin', () => {
  it('honours the HOLI_CLAUDE_BIN override', async () => {
    const dir = await tempDir()
    const bin = join(dir, 'fake-claude.mjs')
    await writeFile(bin, '#!/usr/bin/env node\n')
    await chmod(bin, 0o755)
    expect(resolveClaudeBin({ HOLI_CLAUDE_BIN: bin })).toBe(bin)
  })

  it('scans PATH for an executable claude', async () => {
    const dir = await tempDir()
    const bin = join(dir, 'claude')
    await writeFile(bin, '#!/bin/sh\n')
    await chmod(bin, 0o755)
    expect(resolveClaudeBin({ PATH: `/nonexistent:${dir}` })).toBe(bin)
  })

  it('returns null when claude is nowhere to be found', () => {
    expect(resolveClaudeBin({ PATH: '/nonexistent', HOME: '/nonexistent' })).toBeNull()
  })
})

describe('isClaudeAuthenticated', () => {
  it('is true when ~/.claude.json carries a non-null oauthAccount', async () => {
    const home = await tempDir()
    await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }))
    expect(isClaudeAuthenticated(home)).toBe(true)
  })

  it('falls back to ~/.claude/.claude.json', async () => {
    const home = await tempDir()
    await mkdir(join(home, '.claude'))
    await writeFile(join(home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { id: 'x' } }))
    expect(isClaudeAuthenticated(home)).toBe(true)
  })

  it('is false for a null oauthAccount, a missing file, or garbage', async () => {
    const home = await tempDir()
    expect(isClaudeAuthenticated(home)).toBe(false)
    await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: null }))
    expect(isClaudeAuthenticated(home)).toBe(false)
    await writeFile(join(home, '.claude.json'), 'not json')
    expect(isClaudeAuthenticated(home)).toBe(false)
  })
})

describe('AgentRuntime', () => {
  const spawnArgs = { bin: '/bin/claude', args: ['--x'], cwd: '/work', env: { PATH: '/usr/bin' } }

  it('forwards data and exit, clearing state before it emits exit', async () => {
    const { spawn, spawns } = fakeSpawn()
    const data: string[] = []
    const exits: Array<{ exitCode: number; running: boolean }> = []
    const runtime = new AgentRuntime({ spawnPty: spawn })
    runtime.onData((d) => data.push(d))
    // the old child-wait rule: session state is gone by the time exit lands
    runtime.onExit((e) => exits.push({ exitCode: e.exitCode, running: runtime.isRunning }))

    runtime.start(spawnArgs)
    expect(runtime.isRunning).toBe(true)
    expect(spawns[0]!.file).toBe('/bin/claude')
    expect(spawns[0]!.opts.cwd).toBe('/work')
    expect(spawns[0]!.opts.env).toEqual({ PATH: '/usr/bin' })

    spawns[0]!.pty.emit('hello')
    expect(data).toEqual(['hello'])

    spawns[0]!.pty.exit(3)
    expect(exits).toEqual([{ exitCode: 3, running: false }])
    expect(runtime.isRunning).toBe(false)
  })

  it('rejects a second start while running, and forwards writes/resizes', () => {
    const { spawn, spawns } = fakeSpawn()
    const runtime = new AgentRuntime({ spawnPty: spawn })
    runtime.start(spawnArgs)
    expect(() => runtime.start(spawnArgs)).toThrow(/already running/i)

    runtime.write('hi\r')
    runtime.resize(120, 40)
    runtime.resize(0, -5) // clamps to >= 1
    expect(spawns[0]!.pty.writes).toEqual(['hi\r'])
    expect(spawns[0]!.pty.resizes).toEqual([
      [120, 40],
      [1, 1],
    ])
  })

  it('a cooperative child dies on SIGTERM alone', async () => {
    const { spawn, spawns } = fakeSpawn(NO_SUCH_PID) // group kill ESRCHes → observable pty.kill
    const runtime = new AgentRuntime({ spawnPty: spawn, killGraceMs: 50 })
    runtime.start(spawnArgs)
    const pty = spawns[0]!.pty
    const killed = runtime.kill()
    pty.exit(0) // exits during the grace window
    await killed
    expect(pty.kills).toEqual(['SIGTERM'])
    expect(runtime.isRunning).toBe(false)
  })

  it('a stubborn child escalates to SIGKILL after the grace period', async () => {
    const { spawn, spawns } = fakeSpawn(NO_SUCH_PID)
    const runtime = new AgentRuntime({ spawnPty: spawn, killGraceMs: 30, killBackstopMs: 200 })
    runtime.start(spawnArgs)
    const pty = spawns[0]!.pty
    const killed = runtime.kill()
    await new Promise((r) => setTimeout(r, 80)) // outlast the grace period
    expect(pty.kills).toEqual(['SIGTERM', 'SIGKILL'])
    pty.exit(137)
    await killed
    expect(runtime.isRunning).toBe(false)
  })

  it('killing a dead runtime is a no-op (before start and after exit)', async () => {
    const { spawn, spawns } = fakeSpawn(NO_SUCH_PID)
    const runtime = new AgentRuntime({ spawnPty: spawn, killGraceMs: 30 })
    await runtime.kill() // never started — resolves immediately
    expect(spawns).toHaveLength(0)

    runtime.start(spawnArgs)
    spawns[0]!.pty.exit(0) // the child died on its own
    expect(runtime.isRunning).toBe(false)
    await runtime.kill() // resolves immediately, sends nothing
    expect(spawns[0]!.pty.kills).toEqual([])
  })
})
