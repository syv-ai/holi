import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAgentManager,
  type AgentManager,
  type AgentManagerDeps,
} from '../src/main/agent/agent-manager'
import { CONTEXT_FILE } from '../src/main/agent/context-snapshot'
import type { PtyProcess } from '../src/main/agent/agent-runtime'
import type { ActiveVault, VaultHost } from '../src/main/vault/active-vault'

const VAULT = 'owner/repo'
const NOTE_PATH = 'notes/plan.md'

class FakePty implements PtyProcess {
  readonly writes: string[] = []
  readonly resizes: Array<[number, number]> = []
  private dataCb: ((d: string) => void) | null = null
  private exitCb: ((e: { exitCode: number }) => void) | null = null
  constructor(readonly pid = 999_999) {}
  onData(cb: (d: string) => void) {
    this.dataCb = cb
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb
  }
  write(d: string) {
    this.writes.push(d)
  }
  resize(c: number, r: number) {
    this.resizes.push([c, r])
  }
  kill() {
    this.exitCb?.({ exitCode: 0 })
  }
  emit(d: string) {
    this.dataCb?.(d)
  }
  exit(code = 0) {
    this.exitCb?.({ exitCode: code })
  }
}

interface Rig {
  manager: AgentManager
  workRoot: string
  sent: Array<{ channel: string; payload: any }>
  spawns: Array<{ file: string; args: string[]; opts: { cwd: string; env: Record<string, string> } }>
  host: { setActive(v: string | null): void }
  pty(): FakePty
  paused: string[]
  resumes(): number
  warmed(): number
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function rig(
  opts: {
    bin?: string | null
    active?: string | null
    turnSafetyMs?: number
    /** Per spawn now (D86). Returns the vault's own directory + sign-in state. */
    resolveConfigDir?: AgentManagerDeps['resolveConfigDir']
  } = {},
): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-am-'))
  const workRoot = join(dir, 'work')
  await mkdir(workRoot, { recursive: true })
  await mkdir(join(workRoot, '.holi'), { recursive: true })

  const sent: Rig['sent'] = []
  const spawns: Rig['spawns'] = []
  const ptys: FakePty[] = []

  const paused: string[] = []
  let resumes = 0
  let warmed = 0
  let activeRemote: string | null = opts.active === undefined ? VAULT : opts.active
  const host = {
    active: (): ActiveVault | null =>
      activeRemote === null
        ? null
        : ({
            remote: activeRemote,
            root: workRoot,
            pause: (reason: string) => paused.push(reason),
            resume: () => {
              resumes += 1
            },
          } as unknown as ActiveVault),
    open: async () => {
      throw new Error('not used in these tests')
    },
    close: async () => {},
    setActive: (v: string | null) => (activeRemote = v),
  } as unknown as VaultHost & { setActive(v: string | null): void }

  const manager = createAgentManager({
    host,
    getWindow: () =>
      ({ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }) as never,
    spawnPty: (file, args, o) => {
      const pty = new FakePty()
      ptys.push(pty)
      spawns.push({ file, args, opts: o as never })
      return pty
    },
    resolveBin: () => (opts.bin === undefined ? '/bin/fake-claude' : opts.bin),
    killGraceMs: 20,
    hookPort: () => 4242,
    hookToken: () => 'tkn',
    turnSafetyMs: opts.turnSafetyMs,
    resolveTypstBin: () => Promise.resolve('/fake/typst'),
    resolveConfigDir: opts.resolveConfigDir,
    warmTypst: () => {
      warmed += 1
    },
    log: () => {},
  })

  cleanups.push(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  return {
    manager,
    workRoot,
    sent,
    spawns,
    host,
    pty: () => ptys.at(-1)!,
    paused,
    resumes: () => resumes,
    warmed: () => warmed,
  }
}

describe('AgentManager', () => {
  it('spawns claude in the working dir with no system prompt and no skip-permissions', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })

    const spawn = r.spawns[0]!
    expect(spawn.file).toBe('/bin/fake-claude')
    expect(spawn.opts.cwd).toBe(r.workRoot)
    expect(spawn.args).not.toContain('--dangerously-skip-permissions')
    expect(spawn.args).not.toContain('--append-system-prompt') // pure Claude Code
    expect(r.manager.status().running).toBe(true)
  })

  it('declares no MCP surface and hands the child no bearer (D60)', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })

    const spawn = r.spawns[0]!
    expect(spawn.args).not.toContain('--mcp-config')
    expect(spawn.args).not.toContain('--strict-mcp-config')
    expect(spawn.opts.env.HOLI_AGENT_ENDPOINT).toBeUndefined()
    expect(spawn.opts.env.HOLI_AGENT_TOKEN).toBeUndefined()
  })

  it('holds PTY output in the mirror until a renderer attaches, then streams', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })

    r.pty().emit('before the panel mounted\r\n')
    expect(r.sent.filter((s) => s.channel === 'agent-pty:data')).toEqual([])

    const replayed = await r.manager.attach()
    expect(replayed).toContain('before the panel mounted')

    r.pty().emit('after attach')
    expect(r.sent.filter((s) => s.channel === 'agent-pty:data')).toEqual([
      { channel: 'agent-pty:data', payload: 'after attach' },
    ])
  })

  it('attach on a dead session is empty, and a restart starts a fresh mirror', async () => {
    const r = await rig()
    expect(await r.manager.attach()).toBe('')

    await r.manager.start({ vaultId: VAULT })
    r.pty().emit('first session\r\n')
    expect(await r.manager.attach()).toContain('first session')

    await r.manager.start({ vaultId: VAULT }) // restart
    r.pty().emit('second session\r\n')
    const replayed = await r.manager.attach()
    expect(replayed).toContain('second session')
    expect(replayed).not.toContain('first session') // the old mirror died with the PTY
  })

  it('forwards PTY data and exit to the renderer, and tears the session down on exit', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    await r.manager.attach()

    r.pty().emit('hello from claude')
    expect(r.sent).toContainEqual({ channel: 'agent-pty:data', payload: 'hello from claude' })

    r.pty().exit(3)
    expect(r.sent).toContainEqual({ channel: 'agent-pty:exit', payload: { code: 3 } })
    await new Promise((res) => setTimeout(res, 50))
    expect(r.manager.status().running).toBe(false)
  })

  it('write and resize reach the PTY; a restart kills the prior session', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    const first = r.pty()
    r.manager.write('hi\r')
    r.manager.resize(100, 30)
    expect(first.writes).toEqual(['hi\r'])
    expect(first.resizes).toEqual([[100, 30]])

    await r.manager.start({ vaultId: VAULT })
    expect(r.spawns).toHaveLength(2)
    expect(r.pty()).not.toBe(first)
    expect(r.manager.status().running).toBe(true)
  })

  it('kill tears the session down and reports not running', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    expect(r.manager.status().running).toBe(true)

    await r.manager.kill()
    expect(r.manager.status().running).toBe(false)
    expect(r.sent.filter((s) => s.channel === 'agent:status').at(-1)!.payload.running).toBe(false)
  })

  it('setFocus writes the focus file the hook reads — focused path only', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    r.manager.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH] })

    await new Promise((res) => setTimeout(res, 300))
    const raw = await readFile(join(r.workRoot, CONTEXT_FILE), 'utf8')
    const ctx = JSON.parse(raw)
    expect(ctx.focusedPath).toBe(NOTE_PATH)
    expect(ctx.openPaths).toEqual([NOTE_PATH])
    // the D60 writer carries no server-derived context
    expect(raw).not.toContain('relatedTasks')
    expect(raw).not.toContain('backrefPaths')
  })

  it('setFocus before a session is a no-op (no throw, no file)', async () => {
    const r = await rig()
    r.manager.setFocus({ focusedPath: NOTE_PATH, openPaths: [] })
    await new Promise((res) => setTimeout(res, 200))
    await expect(readFile(join(r.workRoot, CONTEXT_FILE), 'utf8')).rejects.toThrow()
  })

  it('fails readably when the CLI is missing', async () => {
    const r = await rig({ bin: null })
    await expect(r.manager.start({ vaultId: VAULT })).rejects.toThrow(/Claude CLI not found on PATH/)
    expect(r.manager.status().running).toBe(false)
  })

  it('refuses to start against a vault that is not active', async () => {
    const r = await rig()
    await expect(r.manager.start({ vaultId: 'someone/else' })).rejects.toThrow(/not active/)
    r.host.setActive(null)
    await expect(r.manager.start({ vaultId: VAULT })).rejects.toThrow(/not active/)
  })

  it('setTurnActive pauses the vault on turn start and resumes on turn end', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })

    r.manager.setTurnActive(true)
    expect(r.manager.status().working).toBe(true)
    expect(r.paused.length).toBe(1)
    expect(r.sent.filter((s) => s.channel === 'agent:status').at(-1)!.payload.working).toBe(true)

    r.manager.setTurnActive(false)
    expect(r.manager.status().working).toBe(false)
    expect(r.resumes()).toBe(1)
  })

  it('setTurnActive is idempotent — a repeated start pauses only once', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    r.manager.setTurnActive(true)
    r.manager.setTurnActive(true)
    expect(r.paused.length).toBe(1)
  })

  it('force-resumes at the safety cap when a turn never ends (Stop not guaranteed)', async () => {
    const r = await rig({ turnSafetyMs: 30 })
    await r.manager.start({ vaultId: VAULT })
    r.manager.setTurnActive(true)
    expect(r.manager.status().working).toBe(true)

    await new Promise((res) => setTimeout(res, 60))
    expect(r.manager.status().working).toBe(false)
    expect(r.resumes()).toBeGreaterThan(0)
  })

  it('setTurnActive is a no-op with no live session — a stray hook cannot pause a vault', async () => {
    const r = await rig()
    r.manager.setTurnActive(true)
    expect(r.paused.length).toBe(0)
    expect(r.manager.status().working).toBe(false)
  })

  it('resumes the vault if the session dies mid-turn — never strand a paused vault', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    r.manager.setTurnActive(true)
    const before = r.resumes()

    await r.manager.kill()
    expect(r.manager.status().working).toBe(false)
    expect(r.resumes()).toBe(before + 1)
  })

  it('spawns the child with the hook port and token in its env', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    const spawn = r.spawns[0]!
    expect(spawn.opts.env.HOLI_HOOK_PORT).toBe('4242')
    expect(spawn.opts.env.HOLI_HOOK_TOKEN).toBe('tkn')
  })

  it("spawns the child on the vault's own config directory (D86)", async () => {
    const asked: Array<{ remote: string; root: string }> = []
    const r = await rig({
      resolveConfigDir: (v) => {
        asked.push(v)
        return Promise.resolve({ dir: '/data/agent-config/owner-repo-abc', firstSpawn: false })
      },
    })
    await r.manager.start({ vaultId: VAULT })

    expect(asked).toEqual([{ remote: VAULT, root: r.workRoot }])
    expect(r.spawns[0]!.opts.env.CLAUDE_CONFIG_DIR).toBe('/data/agent-config/owner-repo-abc')
  })

  it('resolves the directory per SPAWN, because the active vault moves under it', async () => {
    // The bug this replaced: the path was resolved once per app launch, so every
    // vault opened afterwards ran on the first one's config.
    const r = await rig({
      resolveConfigDir: ({ remote }) =>
        Promise.resolve({ dir: `/data/agent-config/${remote.replace('/', '-')}`, firstSpawn: false }),
    })
    await r.manager.start({ vaultId: VAULT })
    r.host.setActive('owner/second')
    await r.manager.start({ vaultId: 'owner/second' })

    expect(r.spawns[0]!.opts.env.CLAUDE_CONFIG_DIR).toBe('/data/agent-config/owner-repo')
    expect(r.spawns[1]!.opts.env.CLAUDE_CONFIG_DIR).toBe('/data/agent-config/owner-second')
  })

  it('tells the user this vault needs its own sign-in, in the terminal', async () => {
    // §6, never built before this: an unauthenticated agent printed a bare
    // `Not logged in` and the user was left to infer `/login`. Survivable once
    // per install, not once per vault.
    const r = await rig({
      resolveConfigDir: () => Promise.resolve({ dir: '/data/fresh', firstSpawn: true }),
    })
    await r.manager.start({ vaultId: VAULT })

    const replayed = await r.manager.attach()
    expect(replayed).toContain('/login')
  })

  it('says nothing on a vault Holi has spawned in before', async () => {
    const r = await rig({
      resolveConfigDir: () => Promise.resolve({ dir: '/data/known', firstSpawn: false }),
    })
    await r.manager.start({ vaultId: VAULT })
    expect(await r.manager.attach()).not.toContain('/login')
  })

  it('still spawns when the config cannot be resolved', async () => {
    // An unreadable settings file must not cost the user their agent.
    const r = await rig({ resolveConfigDir: () => Promise.reject(new Error('disk on fire')) })
    await r.manager.start({ vaultId: VAULT })

    expect(r.manager.status().running).toBe(true)
    expect(r.spawns[0]!.opts.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  /**
   * There is no `authenticated` flag, and that is the decision rather than an
   * omission (D72): Claude Code asks for the login in the terminal the panel
   * already shows, and a second copy of that state in Holi's chrome goes stale
   * the moment `/login` is typed — which fires no spawn, no turn and no exit.
   */
  it('reports no login state at all — the terminal below says it', async () => {
    const r = await rig({
      resolveConfigDir: () => Promise.resolve({ dir: '/data/agent-config', firstSpawn: true }),
    })
    await r.manager.start({ vaultId: VAULT })
    expect(r.manager.status()).not.toHaveProperty('authenticated')
  })

  it('seeds the session with a prompt (reconcile) as the last spawn arg', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT, prompt: 'resolve the merge conflict' })
    expect(r.spawns[0]!.args).toContain('resolve the merge conflict')
  })

  it('puts the resolved typst path in the child env and warms the cache', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    expect(r.spawns[0]!.opts.env.TYPST_BIN).toBe('/fake/typst')
    expect(r.warmed()).toBe(1)
  })

  it('flips configStale when a synced agent-config file changes under a live session', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    expect(r.manager.status().configStale).toBe(false)

    // A collaborator's pull (or the agent itself) rewrites the shared memory the
    // running session loaded at launch.
    await writeFile(join(r.workRoot, 'CLAUDE.md'), '<rules>\nnew\n</rules>\n', 'utf8')
    await r.manager.notifyVaultChanged()

    expect(r.manager.status().configStale).toBe(true)
    expect(r.sent.filter((s) => s.channel === 'agent:status').at(-1)!.payload.configStale).toBe(true)
  })

  it('leaves configStale false when an ordinary note changes', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    await mkdir(join(r.workRoot, 'notes'), { recursive: true })
    await writeFile(join(r.workRoot, 'notes', 'plan.md'), '# plan\n', 'utf8')
    await r.manager.notifyVaultChanged()
    expect(r.manager.status().configStale).toBe(false)
  })

  it('restart clears configStale — the fresh session loaded the current config', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    await writeFile(join(r.workRoot, 'AGENTS.md'), 'changed\n', 'utf8')
    await r.manager.notifyVaultChanged()
    expect(r.manager.status().configStale).toBe(true)

    await r.manager.start({ vaultId: VAULT }) // restart
    expect(r.manager.status().configStale).toBe(false)
  })

  it('notifyVaultChanged is a no-op with no live session', async () => {
    const r = await rig()
    await r.manager.notifyVaultChanged()
    expect(r.manager.status().configStale).toBe(false)
  })

  it('configStale is sticky — it stays set even if the config reverts, until a restart', async () => {
    const r = await rig()
    await writeFile(join(r.workRoot, 'CLAUDE.md'), 'original\n', 'utf8')
    await r.manager.start({ vaultId: VAULT })

    await writeFile(join(r.workRoot, 'CLAUDE.md'), 'changed\n', 'utf8')
    await r.manager.notifyVaultChanged()
    expect(r.manager.status().configStale).toBe(true)

    // Reverting the content does not un-stale it — only relaunching the session,
    // which is the thing that actually re-reads config, resets the nudge.
    await writeFile(join(r.workRoot, 'CLAUDE.md'), 'original\n', 'utf8')
    await r.manager.notifyVaultChanged()
    expect(r.manager.status().configStale).toBe(true)
  })
})
