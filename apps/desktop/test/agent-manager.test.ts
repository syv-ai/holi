import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAgentManager,
  type AgentManager,
  type AgentManagerDeps,
  type SessionSummary,
} from '../src/main/agent/agent-manager'
import { CONTEXT_FILE } from '../src/main/agent/context-snapshot'
import type { PtyProcess } from '../src/main/agent/agent-runtime'
import type { SessionRegistry, SessionRow } from '../src/main/agent/session-registry'
import type { ActiveVault, VaultHost } from '../src/main/vault/active-vault'

const VAULT = 'owner/repo'
const NOTE_PATH = 'notes/plan.md'
const CONFIG_DIR = '/data/agent-config/owner-repo'

class FakePty implements PtyProcess {
  readonly writes: string[] = []
  readonly resizes: Array<[number, number]> = []
  private dataCb: ((d: string) => void) | null = null
  private exitCb: ((e: { exitCode: number }) => void) | null = null
  constructor(readonly pid: number) {}
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

/** Claude Code's listing, under test control. */
function fakeRegistry() {
  let rows: SessionRow[] = []
  let edge: (() => void) | null = null
  const reads: Array<{ configDir: string; vaultRoot: string }> = []
  return {
    reads,
    setRows: (next: SessionRow[]) => (rows = next),
    /** What the fs.watch edge does: tell the manager to re-read. */
    fire: () => edge?.(),
    registry: {
      readRows: (args) => {
        reads.push(args)
        return Promise.resolve(new Map(rows.map((row) => [row.pid, row])))
      },
      watch: (_dir, onChange) => {
        edge = onChange
        return () => {
          edge = null
        }
      },
    } satisfies SessionRegistry,
  }
}

interface Rig {
  manager: AgentManager
  workRoot: string
  sent: Array<{ channel: string; payload: any }>
  spawns: Array<{
    file: string
    args: string[]
    opts: { cwd: string; env: Record<string, string> }
  }>
  host: { setActive(v: string | null): void }
  pty(): FakePty
  ptys: FakePty[]
  paused: string[]
  resumes(): number
  warmed(): number
  /** Start a session in the active vault and hand back its id. */
  start(args?: {
    vaultId?: string
    name?: string
    prompt?: string
    paste?: string
  }): Promise<string>
  /** Its summary now. */
  session(id: string): SessionSummary
  /** The last `agent:sessions` push. */
  pushed(): SessionSummary[]
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

/** Let the fire-and-forget listing read and its push run. */
const tick = () => new Promise((res) => setTimeout(res, 10))

async function rig(
  opts: {
    bin?: string | null
    active?: string | null
    turnSafetyMs?: number
    pasteBackstopMs?: number
    /** Per spawn now (D86). Returns the vault's own directory + sign-in state. */
    resolveConfigDir?: AgentManagerDeps['resolveConfigDir']
    sessionRegistry?: SessionRegistry
    mintGoogleToken?: AgentManagerDeps['mintGoogleToken']
    revokeGoogleToken?: AgentManagerDeps['revokeGoogleToken']
    mintHookToken?: AgentManagerDeps['mintHookToken']
    revokeHookToken?: AgentManagerDeps['revokeHookToken']
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
            repo: { head: () => Promise.resolve('base-sha') },
            commitNow: () => Promise.resolve('end-sha'),
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
      ({
        webContents: {
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
      }) as never,
    spawnPty: (file, args, o) => {
      // Distinct pids: the listing is joined to a session by its pid, so two
      // sessions sharing one would be the bug this can no longer have.
      const pty = new FakePty(1000 + ptys.length)
      ptys.push(pty)
      spawns.push({ file, args, opts: o as never })
      return pty
    },
    resolveBin: () => (opts.bin === undefined ? '/bin/fake-claude' : opts.bin),
    killGraceMs: 20,
    // Both, not just the grace. The backstop is what a kill actually WAITS on
    // when the fake PTY never emits an exit, and at its 5s default it was 53%
    // of the whole node suite.
    killBackstopMs: 20,
    hookPort: () => 4242,
    turnSafetyMs: opts.turnSafetyMs,
    pasteBackstopMs: opts.pasteBackstopMs,
    resolveTypstBin: () => Promise.resolve('/fake/typst'),
    resolveConfigDir: opts.resolveConfigDir,
    sessionRegistry: opts.sessionRegistry,
    mintGoogleToken: opts.mintGoogleToken,
    revokeGoogleToken: opts.revokeGoogleToken,
    mintHookToken: opts.mintHookToken,
    revokeHookToken: opts.revokeHookToken,
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
    ptys,
    paused,
    resumes: () => resumes,
    warmed: () => warmed,
    start: async (args = {}) =>
      (
        await manager.start({
          vaultId: args.vaultId ?? VAULT,
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
          ...(args.paste === undefined ? {} : { paste: args.paste }),
        })
      ).id,
    session: (id) => manager.sessions().find((s) => s.id === id)!,
    pushed: () =>
      (sent.filter((s) => s.channel === 'agent:sessions').at(-1)?.payload ??
        []) as SessionSummary[],
  }
}

describe('AgentManager', () => {
  it('spawns claude in the working dir with no system prompt and no skip-permissions', async () => {
    const r = await rig()
    await r.start()

    const spawn = r.spawns[0]!
    expect(spawn.file).toBe('/bin/fake-claude')
    expect(spawn.opts.cwd).toBe(r.workRoot)
    expect(spawn.args).not.toContain('--dangerously-skip-permissions')
    expect(spawn.args).not.toContain('--append-system-prompt') // pure Claude Code
    expect(r.manager.sessions()).toHaveLength(1)
  })

  it('declares no MCP surface and hands the child no bearer (D60)', async () => {
    const r = await rig()
    await r.start()

    const spawn = r.spawns[0]!
    expect(spawn.args).not.toContain('--mcp-config')
    expect(spawn.args).not.toContain('--strict-mcp-config')
    expect(spawn.opts.env.HOLI_AGENT_ENDPOINT).toBeUndefined()
    expect(spawn.opts.env.HOLI_AGENT_TOKEN).toBeUndefined()
  })

  it('holds PTY output in the mirror until a renderer attaches, then streams', async () => {
    const r = await rig()
    const id = await r.start()

    r.pty().emit('before the panel mounted\r\n')
    expect(r.sent.filter((s) => s.channel === 'agent-pty:data')).toEqual([])

    const replayed = await r.manager.attach(id)
    expect(replayed).toContain('before the panel mounted')

    r.pty().emit('after attach')
    expect(r.sent.filter((s) => s.channel === 'agent-pty:data')).toEqual([
      { channel: 'agent-pty:data', payload: { id, data: 'after attach' } },
    ])
  })

  it('attach on a session that does not exist is empty', async () => {
    const r = await rig()
    expect(await r.manager.attach('nobody')).toBe('')
  })
})

/**
 * A vault runs several sessions (D100). The questions here are the ones a map
 * asks and a single slot never had to: does a route reach the session it names,
 * and only that one.
 */
describe('several sessions in one vault', () => {
  it('runs two at once, each with its own PTY and its own mirror', async () => {
    const r = await rig()
    const first = await r.start()
    r.ptys[0]!.emit('first session\r\n')
    const second = await r.start()
    r.ptys[1]!.emit('second session\r\n')

    expect(r.manager.sessions().map((s) => s.id)).toEqual([first, second])
    expect(await r.manager.attach(first)).toContain('first session')
    const replayed = await r.manager.attach(second)
    expect(replayed).toContain('second session')
    expect(replayed).not.toContain('first session')
  })

  it('kills only the session it is given', async () => {
    const r = await rig()
    const first = await r.start()
    const second = await r.start()

    await r.manager.kill(first)
    expect(r.manager.sessions().map((s) => s.id)).toEqual([second])
    // And an id that is not there is a no-op rather than a throw.
    await r.manager.kill('nobody')
    expect(r.manager.sessions()).toHaveLength(1)
  })

  it('routes write and resize to the named session only', async () => {
    const r = await rig()
    const first = await r.start()
    const second = await r.start()

    r.manager.write(second, 'hi\r')
    r.manager.resize(second, 100, 30)

    expect(r.ptys[0]!.writes).toEqual([])
    expect(r.ptys[0]!.resizes).toEqual([])
    expect(r.ptys[1]!.writes).toEqual(['hi\r'])
    expect(r.ptys[1]!.resizes).toEqual([[100, 30]])
    // A write to a session that is gone goes nowhere rather than to the survivor.
    await r.manager.kill(second)
    r.manager.write(second, 'lost')
    expect(r.ptys[0]!.writes).toEqual([])
    expect(first).not.toBe(second)
  })

  it('names the session on every pushed data and exit event', async () => {
    const r = await rig()
    const first = await r.start()
    const second = await r.start()
    await r.manager.attach(first)
    await r.manager.attach(second)

    r.ptys[0]!.emit('from one')
    r.ptys[1]!.exit(3)

    expect(r.sent).toContainEqual({
      channel: 'agent-pty:data',
      payload: { id: first, data: 'from one' },
    })
    expect(r.sent).toContainEqual({ channel: 'agent-pty:exit', payload: { id: second, code: 3 } })
  })

  it('keeps an exited session in the list, with its scrollback, until it is closed', async () => {
    // An exit is something to read, not a tab that vanishes from under the
    // reader. Slice 2 draws the close that finally removes it.
    const r = await rig()
    const id = await r.start()
    r.pty().emit('last words\r\n')
    r.pty().exit(1)
    await tick()

    expect(r.session(id).exited).toBe(true)
    expect(await r.manager.attach(id)).toContain('last words')

    await r.manager.kill(id)
    expect(r.manager.sessions()).toEqual([])
  })

  it('serialises two concurrent starts, because the config directory is written unlocked', async () => {
    // `ensureAgentConfigDir` read-modify-writes `settings.json` and
    // `takeFirstSpawn` is stat-then-write. Two spawns inside either one at the
    // same time lose a setting and print the sign-in notice twice.
    let inside = 0
    let mostAtOnce = 0
    const r = await rig({
      resolveConfigDir: async () => {
        inside += 1
        mostAtOnce = Math.max(mostAtOnce, inside)
        await new Promise((res) => setTimeout(res, 10))
        inside -= 1
        return { dir: CONFIG_DIR, firstSpawn: false }
      },
    })
    await Promise.all([r.manager.start({ vaultId: VAULT }), r.manager.start({ vaultId: VAULT })])

    expect(mostAtOnce).toBe(1)
    expect(r.manager.sessions()).toHaveLength(2)
  })

  it('shows the sign-in notice to the first session in a fresh directory only', async () => {
    let spawnsSoFar = 0
    const r = await rig({
      resolveConfigDir: () =>
        Promise.resolve({ dir: '/data/fresh', firstSpawn: spawnsSoFar++ === 0 }),
    })
    const first = await r.start()
    const second = await r.start()

    expect(await r.manager.attach(first)).toContain('/login')
    expect(await r.manager.attach(second)).not.toContain('/login')
  })
})

/**
 * The join to Claude Code's own listing (D100). Holi spawns the processes, so it
 * knows which sessions exist; what they are doing and what they are called are
 * facts Claude Code publishes.
 */
describe('session state', () => {
  const withRegistry = async (rows: SessionRow[] = []) => {
    const fake = fakeRegistry()
    fake.setRows(rows)
    const r = await rig({
      sessionRegistry: fake.registry,
      resolveConfigDir: () => Promise.resolve({ dir: CONFIG_DIR, firstSpawn: false }),
    })
    return { ...r, fake }
  }

  it("reads the listing for the session's own config directory and vault root", async () => {
    const r = await withRegistry()
    await r.start()
    await tick()
    expect(r.fake.reads).toContainEqual({ configDir: CONFIG_DIR, vaultRoot: r.workRoot })
  })

  it('says needs-you with the reason when the listing is waiting on you', async () => {
    const r = await withRegistry()
    const id = await r.start()
    r.fake.setRows([{ pid: 1000, name: 'x', status: 'waiting', waitingFor: 'permission prompt' }])
    r.fake.fire()
    await tick()

    expect(r.session(id)).toMatchObject({ state: 'needs-you', waitingFor: 'permission prompt' })
  })

  it('lets a waiting row outrank an open hook bracket', async () => {
    // The bracket is open for the whole turn, prompt included. The listing is
    // the only one of the two that can say the turn is now waiting on a person.
    const r = await withRegistry()
    const id = await r.start()
    r.manager.setTurnActive(id, true)
    expect(r.session(id).state).toBe('working')

    r.fake.setRows([{ pid: 1000, name: 'x', status: 'waiting', waitingFor: 'input needed' }])
    r.fake.fire()
    await tick()
    expect(r.session(id).state).toBe('needs-you')
  })

  it('still reports working from the bracket alone when the listing answers nothing', async () => {
    // Every registry failure is an empty map, so this is what a missing, too old
    // or too slow CLI looks like. The bracket is the floor under the join.
    const r = await withRegistry()
    const id = await r.start()
    r.manager.setTurnActive(id, true)
    await tick()
    expect(r.session(id).state).toBe('working')
  })

  it('reads a busy or shell row as working with no bracket at all', async () => {
    const r = await withRegistry()
    const id = await r.start()
    r.fake.setRows([{ pid: 1000, name: 'x', status: 'shell' }])
    r.fake.fire()
    await tick()
    expect(r.session(id).state).toBe('working')
  })

  it('is idle when neither the listing nor the bracket says otherwise', async () => {
    const r = await withRegistry()
    const id = await r.start()
    r.fake.setRows([{ pid: 1000, name: 'x', status: 'idle' }])
    r.fake.fire()
    await tick()
    expect(r.session(id).state).toBe('idle')
    expect(r.session(id)).not.toHaveProperty('waitingFor')
  })
})

describe('what a session is called', () => {
  const named = async (name?: string) => {
    const fake = fakeRegistry()
    const r = await rig({
      sessionRegistry: fake.registry,
      resolveConfigDir: () => Promise.resolve({ dir: CONFIG_DIR, firstSpawn: false }),
    })
    const id = await r.start(name === undefined ? {} : { name })
    return { ...r, fake, id }
  }

  it("takes the row's name for a session Holi named at spawn", async () => {
    const r = await named('Fix the merge')
    expect(r.spawns[0]!.args.slice(0, 2)).toEqual(['--name', 'Fix the merge'])
    r.fake.setRows([{ pid: 1000, name: 'Fix the merge', status: 'idle' }])
    r.fake.fire()
    await tick()
    expect(r.session(r.id).name).toBe('Fix the merge')
  })

  it('says New session for an unnamed one, whatever placeholder the listing carries', async () => {
    // The placeholder is built from the cwd and is the SAME string for every
    // session in one vault, so showing it would label three tabs identically.
    const r = await named()
    expect(r.spawns[0]!.args).not.toContain('--name')
    r.fake.setRows([{ pid: 1000, name: 'repo', status: 'idle' }])
    r.fake.fire()
    await tick()
    expect(r.session(r.id).name).toBe('New session')
  })

  it('takes the name the moment it changes, which is what /name looks like', async () => {
    const r = await named()
    r.fake.setRows([{ pid: 1000, name: 'repo', status: 'idle' }])
    r.fake.fire()
    await tick()
    expect(r.session(r.id).name).toBe('New session')

    r.fake.setRows([{ pid: 1000, name: 'Drafting the PRD', status: 'idle' }])
    r.fake.fire()
    await tick()
    expect(r.session(r.id).name).toBe('Drafting the PRD')
  })

  it('believes nameSource outright, the day the listing starts emitting it', async () => {
    const r = await named()
    r.fake.setRows([{ pid: 1000, name: 'Chosen', nameSource: 'user', status: 'idle' }])
    r.fake.fire()
    await tick()
    expect(r.session(r.id).name).toBe('Chosen')
  })

  it('keeps the name it had when the session exits', async () => {
    // The row goes with the process, but the tab stays until it is closed. A
    // label that flipped to 'New session' on exit would lose the only thing
    // telling two dead tabs apart.
    const r = await named()
    r.fake.setRows([{ pid: 1000, name: 'repo', status: 'idle' }])
    r.fake.fire()
    await tick()
    r.fake.setRows([{ pid: 1000, name: 'Drafting the PRD', status: 'idle' }])
    r.fake.fire()
    await tick()
    expect(r.session(r.id).name).toBe('Drafting the PRD')

    r.pty().exit(0)
    await tick()
    expect(r.session(r.id)).toMatchObject({ exited: true, name: 'Drafting the PRD' })
  })

  it('says New session before any listing has seen it', async () => {
    const r = await named()
    expect(r.session(r.id).name).toBe('New session')
  })
})

describe('the pushed list', () => {
  it('pushes on a change and stays quiet on a heartbeat that moves nothing', async () => {
    const fake = fakeRegistry()
    const r = await rig({
      sessionRegistry: fake.registry,
      resolveConfigDir: () => Promise.resolve({ dir: CONFIG_DIR, firstSpawn: false }),
    })
    const id = await r.start()
    fake.setRows([{ pid: 1000, name: 'repo', status: 'idle' }])
    fake.fire()
    await tick()
    const before = r.sent.filter((s) => s.channel === 'agent:sessions').length

    fake.fire() // the same rows again: the listing carries heartbeat fields
    await tick()
    expect(r.sent.filter((s) => s.channel === 'agent:sessions').length).toBe(before)

    r.manager.setTurnActive(id, true)
    expect(r.pushed()).toHaveLength(1)
    expect(r.pushed()[0]!.state).toBe('working')
  })
})

describe('the turn bracket', () => {
  it('pauses the vault on turn start and resumes on turn end', async () => {
    const r = await rig()
    const id = await r.start()

    r.manager.setTurnActive(id, true)
    expect(r.session(id).state).toBe('working')
    expect(r.paused.length).toBe(1)

    r.manager.setTurnActive(id, false)
    expect(r.session(id).state).toBe('idle')
    expect(r.resumes()).toBe(1)
  })

  it('pauses the vault once for two sessions and resumes after the second', async () => {
    const r = await rig()
    const first = await r.start()
    const second = await r.start()

    r.manager.setTurnActive(first, true)
    r.manager.setTurnActive(second, true)
    expect(r.paused.length).toBe(1)

    r.manager.setTurnActive(first, false)
    expect(r.resumes()).toBe(0)
    expect(r.session(second).state).toBe('working')

    r.manager.setTurnActive(second, false)
    expect(r.resumes()).toBe(1)
  })

  it('is idempotent — a repeated start pauses only once', async () => {
    const r = await rig()
    const id = await r.start()
    r.manager.setTurnActive(id, true)
    r.manager.setTurnActive(id, true)
    expect(r.paused.length).toBe(1)
  })

  it('force-resumes at the safety cap when a turn never ends (Stop not guaranteed)', async () => {
    const r = await rig({ turnSafetyMs: 30 })
    const id = await r.start()
    r.manager.setTurnActive(id, true)
    expect(r.session(id).state).toBe('working')

    await new Promise((res) => setTimeout(res, 60))
    expect(r.session(id).state).toBe('idle')
    expect(r.resumes()).toBeGreaterThan(0)
  })

  it('is a no-op for a session that does not exist — a stray hook cannot pause a vault', async () => {
    const r = await rig()
    r.manager.setTurnActive('nobody', true)
    expect(r.paused.length).toBe(0)
  })

  it('resumes the vault if the session dies mid-turn — never strand a paused vault', async () => {
    const r = await rig()
    const id = await r.start()
    r.manager.setTurnActive(id, true)
    const before = r.resumes()

    r.pty().exit(1)
    await tick()
    expect(r.session(id).state).toBe('idle')
    expect(r.resumes()).toBe(before + 1)
  })

  it('releases a session the listing confirms is idle, without waiting out the cap', async () => {
    // Escaping a permission prompt fires no Stop hook at all. Before the listing,
    // only the ten-minute cap ended that turn, with the vault paused behind it.
    const fake = fakeRegistry()
    const r = await rig({
      sessionRegistry: fake.registry,
      resolveConfigDir: () => Promise.resolve({ dir: CONFIG_DIR, firstSpawn: false }),
      turnSafetyMs: 600_000,
    })
    const id = await r.start()
    r.manager.setTurnActive(id, true)
    fake.setRows([{ pid: 1000, name: 'repo', status: 'idle' }])
    fake.fire()
    await tick()
    // One reading is not enough; the manager asks for the second itself.
    expect(r.session(id).state).toBe('working')

    await new Promise((res) => setTimeout(res, 1_300))
    expect(r.session(id).state).toBe('idle')
    expect(r.resumes()).toBe(1)
  }, 10_000)
})

describe('the focus file', () => {
  it('is written for the vault, and says the focused path', async () => {
    const r = await rig()
    await r.start()
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

  it('is written before the vault has ever had a session', async () => {
    // It belongs to the vault, not to a session: focus set while the drawer is
    // shut is focus the first turn should still see.
    const r = await rig()
    r.manager.setFocus({ focusedPath: NOTE_PATH, openPaths: [] })
    await new Promise((res) => setTimeout(res, 300))
    const ctx = JSON.parse(await readFile(join(r.workRoot, CONTEXT_FILE), 'utf8'))
    expect(ctx.focusedPath).toBe(NOTE_PATH)
  })

  it('is a no-op with no vault open', async () => {
    const r = await rig({ active: null })
    r.manager.setFocus({ focusedPath: NOTE_PATH, openPaths: [] })
    await new Promise((res) => setTimeout(res, 200))
    await expect(readFile(join(r.workRoot, CONTEXT_FILE), 'utf8')).rejects.toThrow()
  })

  it('takes any number of sessions without changing what it writes', async () => {
    // One writer per vault (`ensureFocusWriter`), because the file is a single
    // path in the clone and N sessions would be N debounced writers racing to
    // say the same thing.
    const r = await rig()
    await r.start()
    await r.start()
    await r.start()
    r.manager.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH] })
    await new Promise((res) => setTimeout(res, 300))
    const ctx = JSON.parse(await readFile(join(r.workRoot, CONTEXT_FILE), 'utf8'))
    expect(ctx.focusedPath).toBe(NOTE_PATH)
  })
})

describe('starting', () => {
  it('fails readably when the CLI is missing', async () => {
    const r = await rig({ bin: null })
    await expect(r.manager.start({ vaultId: VAULT })).rejects.toThrow(
      /Claude CLI not found on PATH/,
    )
    expect(r.manager.sessions()).toEqual([])
  })

  it('refuses to start against a vault that is not active', async () => {
    const r = await rig()
    await expect(r.manager.start({ vaultId: 'someone/else' })).rejects.toThrow(/not active/)
    r.host.setActive(null)
    await expect(r.manager.start({ vaultId: VAULT })).rejects.toThrow(/not active/)
  })

  it('keeps taking starts after one has failed', async () => {
    // The spawn chain is about the config directory's unlocked writes, not about
    // success: a rejected start must not wedge every later one behind it.
    const r = await rig()
    await expect(r.manager.start({ vaultId: 'someone/else' })).rejects.toThrow(/not active/)
    await r.start()
    expect(r.manager.sessions()).toHaveLength(1)
  })

  it('spawns the child with the hook port and token in its env', async () => {
    const r = await rig({ mintHookToken: () => 'tkn' })
    await r.start()
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
    await r.start()

    expect(asked).toEqual([{ remote: VAULT, root: r.workRoot }])
    expect(r.spawns[0]!.opts.env.CLAUDE_CONFIG_DIR).toBe('/data/agent-config/owner-repo-abc')
  })

  it('resolves the directory per SPAWN, because the active vault moves under it', async () => {
    // The bug this replaced: the path was resolved once per app launch, so every
    // vault opened afterwards ran on the first one's config.
    const r = await rig({
      resolveConfigDir: ({ remote }) =>
        Promise.resolve({
          dir: `/data/agent-config/${remote.replace('/', '-')}`,
          firstSpawn: false,
        }),
    })
    await r.start()
    r.host.setActive('owner/second')
    await r.start({ vaultId: 'owner/second' })

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
    const id = await r.start()
    expect(await r.manager.attach(id)).toContain('/login')
  })

  it('says nothing on a vault Holi has spawned in before', async () => {
    const r = await rig({
      resolveConfigDir: () => Promise.resolve({ dir: '/data/known', firstSpawn: false }),
    })
    const id = await r.start()
    expect(await r.manager.attach(id)).not.toContain('/login')
  })

  it('still spawns when the config cannot be resolved', async () => {
    // An unreadable settings file must not cost the user their agent.
    const r = await rig({ resolveConfigDir: () => Promise.reject(new Error('disk on fire')) })
    await r.start()

    expect(r.manager.sessions()).toHaveLength(1)
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
    const id = await r.start()
    expect(r.session(id)).not.toHaveProperty('authenticated')
  })

  it('seeds the session with a prompt (reconcile) as the last spawn arg', async () => {
    const r = await rig()
    await r.start({ prompt: 'resolve the merge conflict' })
    expect(r.spawns[0]!.args).toContain('resolve the merge conflict')
  })

  it('puts the resolved typst path in the child env and warms the cache', async () => {
    const r = await rig()
    await r.start()
    expect(r.spawns[0]!.opts.env.TYPST_BIN).toBe('/fake/typst')
    expect(r.warmed()).toBe(1)
  })
})

describe('pasting an ask', () => {
  /** The framing, spelled out here rather than imported: a test that took the
   *  constant from the code under test would pass if the code pasted nothing. */
  const paste = (text: string) => `\x1b[200~${text}\x1b[201~`

  it('puts text in a session that is up unsent, as one bracketed paste', async () => {
    const r = await rig({ pasteBackstopMs: 20 })
    const id = await r.start()
    await new Promise((res) => setTimeout(res, 60)) // it is up

    expect(r.manager.paste(id, 'summarise this thread')).toEqual({ ok: true })
    // Exactly one write, and no `\r`: an ask lands in the composer and the
    // person sends it. Appending a submit could send a half-typed draft with it.
    expect(r.pty().writes).toEqual([paste('summarise this thread')])
  })

  it('refuses a session that has ended, rather than dropping the text', async () => {
    const r = await rig({ pasteBackstopMs: 20 })
    const id = await r.start()
    r.pty().exit(0)
    await tick()

    const res = r.manager.paste(id, 'summarise this thread')
    expect(res.ok).toBe(false)
    expect(res.message).toBeTruthy()
    expect(r.pty().writes).toEqual([])
  })

  it('refuses an id it has never heard of', async () => {
    const r = await rig()
    expect(r.manager.paste('nobody', 'hello').ok).toBe(false)
  })

  it("holds a new session's paste until the listing has seen it", async () => {
    // The listing carries a session because Claude Code wrote its file at
    // SessionStart, measured 0.94 s after the spawn — so the first sighting is
    // the moment its TUI is up and a paste lands in the composer.
    const fake = fakeRegistry()
    const r = await rig({
      sessionRegistry: fake.registry,
      resolveConfigDir: () => Promise.resolve({ dir: CONFIG_DIR, firstSpawn: false }),
      pasteBackstopMs: 60_000,
    })
    await r.start({ paste: 'look at this' })
    await tick()
    expect(r.pty().writes).toEqual([])

    fake.setRows([{ pid: 1000, name: 'repo', status: 'idle' }])
    fake.fire()
    await tick()
    expect(r.pty().writes).toEqual([paste('look at this')])

    // A later reading is not a second sighting.
    fake.fire()
    await tick()
    expect(r.pty().writes).toEqual([paste('look at this')])
  })

  it('delivers it anyway when the listing never answers', async () => {
    // The registry degrades honestly everywhere else; text the user has already
    // written is not the thing to lose to a CLI that cannot list.
    const r = await rig({ pasteBackstopMs: 20 })
    await r.start({ paste: 'look at this' })

    await new Promise((res) => setTimeout(res, 60))
    expect(r.pty().writes).toEqual([paste('look at this')])
  })

  it('holds an ask for a session the listing has not seen yet', async () => {
    // The new tab is in the drawer and is what an ask defaults to from the
    // moment it appears, so this is reachable in a second of real use: ask for a
    // new session, then ask it something before its TUI has started reading.
    const fake = fakeRegistry()
    const r = await rig({
      sessionRegistry: fake.registry,
      resolveConfigDir: () => Promise.resolve({ dir: CONFIG_DIR, firstSpawn: false }),
      pasteBackstopMs: 60_000,
    })
    const id = await r.start({ paste: 'the first ask' })
    await tick()

    expect(r.manager.paste(id, 'and a second')).toEqual({ ok: true })
    expect(r.pty().writes).toEqual([])

    fake.setRows([{ pid: 1000, name: 'repo', status: 'idle' }])
    fake.fire()
    await tick()
    // Two asks are two things somebody typed, delivered in order rather than
    // glued into one.
    expect(r.pty().writes).toEqual([paste('the first ask'), paste('and a second')])
  })

  it('stops holding once the session is up', async () => {
    const fake = fakeRegistry()
    const r = await rig({
      sessionRegistry: fake.registry,
      resolveConfigDir: () => Promise.resolve({ dir: CONFIG_DIR, firstSpawn: false }),
      pasteBackstopMs: 60_000,
    })
    const id = await r.start()
    fake.setRows([{ pid: 1000, name: 'repo', status: 'idle' }])
    fake.fire()
    await tick()

    r.manager.paste(id, 'have a look')
    expect(r.pty().writes).toEqual([paste('have a look')])
  })

  it('stops holding once the backstop has given up, so no ask waits twice', async () => {
    // A machine whose CLI cannot list never sights anything. Holding every ask
    // for five seconds because of that would be the registry's failure charged
    // to the user over and over.
    const r = await rig({ pasteBackstopMs: 20 })
    const id = await r.start()
    await new Promise((res) => setTimeout(res, 60))

    r.manager.paste(id, 'have a look')
    expect(r.pty().writes).toEqual([paste('have a look')])
  })

  it('drops a pending paste when the session exits before it lands', async () => {
    const r = await rig({ pasteBackstopMs: 20 })
    await r.start({ paste: 'look at this' })
    r.pty().exit(0)

    await new Promise((res) => setTimeout(res, 60))
    expect(r.pty().writes).toEqual([])
  })
})

describe('stale config', () => {
  it('flips when a synced agent-config file changes under a live session', async () => {
    const r = await rig()
    const id = await r.start()
    expect(r.session(id).configStale).toBe(false)

    // A collaborator's pull (or the agent itself) rewrites the shared memory the
    // running session loaded at launch.
    await writeFile(join(r.workRoot, 'CLAUDE.md'), '<rules>\nnew\n</rules>\n', 'utf8')
    await r.manager.notifyVaultChanged()

    expect(r.session(id).configStale).toBe(true)
    expect(r.pushed()[0]!.configStale).toBe(true)
  })

  it('leaves it false when an ordinary note changes', async () => {
    const r = await rig()
    const id = await r.start()
    await mkdir(join(r.workRoot, 'notes'), { recursive: true })
    await writeFile(join(r.workRoot, 'notes', 'plan.md'), '# plan\n', 'utf8')
    await r.manager.notifyVaultChanged()
    expect(r.session(id).configStale).toBe(false)
  })

  it('is per session — a new one loaded the current config and is not stale', async () => {
    const r = await rig()
    const first = await r.start()
    await writeFile(join(r.workRoot, 'AGENTS.md'), 'changed\n', 'utf8')
    await r.manager.notifyVaultChanged()
    expect(r.session(first).configStale).toBe(true)

    const second = await r.start()
    expect(r.session(second).configStale).toBe(false)
    expect(r.session(first).configStale).toBe(true) // the old one is still stale
  })

  it('notifyVaultChanged is a no-op with no live session', async () => {
    const r = await rig()
    await expect(r.manager.notifyVaultChanged()).resolves.toBeUndefined()
    expect(r.manager.sessions()).toEqual([])
  })

  it('is sticky — it stays set even if the config reverts, until a restart', async () => {
    const r = await rig()
    await writeFile(join(r.workRoot, 'CLAUDE.md'), 'original\n', 'utf8')
    const id = await r.start()

    await writeFile(join(r.workRoot, 'CLAUDE.md'), 'changed\n', 'utf8')
    await r.manager.notifyVaultChanged()
    expect(r.session(id).configStale).toBe(true)

    // Reverting the content does not un-stale it — only relaunching the session,
    // which is the thing that actually re-reads config, resets the nudge.
    await writeFile(join(r.workRoot, 'CLAUDE.md'), 'original\n', 'utf8')
    await r.manager.notifyVaultChanged()
    expect(r.session(id).configStale).toBe(true)
  })
})

describe("the agent's Google bearer", () => {
  /** A minter that records what it was asked for and what was handed back. */
  function bearers() {
    const minted: Array<{ remote: string; token: string }> = []
    const revoked: string[] = []
    let n = 0
    return {
      minted,
      revoked,
      mintGoogleToken: (remote: string) => {
        const token = `tok-${++n}`
        minted.push({ remote, token })
        return token
      },
      revokeGoogleToken: (token: string) => revoked.push(token),
    }
  }

  it('is minted for the vault the session spawned in', async () => {
    const b = bearers()
    const r = await rig(b)
    await r.start()

    expect(b.minted).toEqual([{ remote: VAULT, token: 'tok-1' }])
    expect(r.spawns[0]!.opts.env.HOLI_GOOGLE_TOKEN).toBe('tok-1')
  })

  it('names the SECOND vault on a second spawn', async () => {
    // Per session, not per app run: an agent session outlives a vault switch, so
    // a bearer that meant "whatever is active" would read another vault's mail.
    const b = bearers()
    const r = await rig(b)
    await r.start()
    r.host.setActive('owner/second')
    await r.start({ vaultId: 'owner/second' })

    expect(b.minted.map((m) => m.remote)).toEqual([VAULT, 'owner/second'])
    expect(r.spawns[1]!.opts.env.HOLI_GOOGLE_TOKEN).toBe('tok-2')
  })

  it("revokes only the killed session's bearer, not its neighbour's", async () => {
    const b = bearers()
    const r = await rig(b)
    const first = await r.start()
    await r.start()

    await r.manager.kill(first)
    expect(b.revoked).toEqual(['tok-1'])
  })

  it('revokes it when the session exits on its own', async () => {
    const b = bearers()
    const r = await rig(b)
    await r.start()
    r.pty().exit(0)
    await tick()
    expect(b.revoked).toEqual(['tok-1'])
  })

  it('spawns without one when no minter is supplied', async () => {
    const r = await rig()
    await r.start()

    expect(r.spawns[0]!.opts.env.HOLI_GOOGLE_TOKEN).toBeUndefined()
    expect(r.manager.sessions()).toHaveLength(1)
  })
})

describe("the agent's hook bearer", () => {
  // Same shape and same reason as the Google bearer: an agent session outlives a
  // vault switch, and the ops behind this token (`openApp`, `initApp`,
  // `refreshSeed`) act on a vault's files.
  it('is minted for the vault AND the session, and revoked with it', async () => {
    const minted: Array<{ remote: string; sessionId: string }> = []
    const revoked: string[] = []
    const r = await rig({
      mintHookToken: (remote: string, sessionId: string) => {
        minted.push({ remote, sessionId })
        return `hook-${minted.length}`
      },
      revokeHookToken: (token: string) => revoked.push(token),
    })
    const id = await r.start()
    // The session id rides on the token: it is what a turn signal reports back,
    // and it is the only way two sessions in one vault stay apart.
    expect(minted).toEqual([{ remote: VAULT, sessionId: id }])
    expect(r.spawns[0]!.opts.env.HOLI_HOOK_TOKEN).toBe('hook-1')

    await r.manager.kill(id)
    expect(revoked).toEqual(['hook-1'])
  })

  it('spawns without one when no minter is supplied', async () => {
    const r = await rig()
    await r.start()
    expect(r.spawns[0]!.opts.env.HOLI_HOOK_TOKEN).toBeUndefined()
    expect(r.manager.sessions()).toHaveLength(1)
  })
})
