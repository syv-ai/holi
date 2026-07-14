import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentManager, type AgentManager } from '../src/main/agent/agent-manager'
import { CONTEXT_FILE } from '../src/main/agent/context-snapshot'
import type { PtyProcess } from '../src/main/agent/agent-runtime'
import type { ServerClient } from '../src/main/server-client'
import type { VaultManager } from '../src/main/vault/vault-manager'
import type { VaultMirror } from '../src/main/vault/vault-mirror'

const VAULT = 'v-1'
const NOTE_ID = 'doc-1'
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
  pty(): FakePty
  mirror: {
    signalled: string[]
    endOpenTurnsCalls: number
  }
  calls: Array<{ path: string; input: any }>
  fakeMirror: VaultMirror
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function rig(opts: { bin?: string | null } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-am-'))
  const workRoot = join(dir, 'work')
  await mkdir(workRoot, { recursive: true })

  const sent: Array<{ channel: string; payload: any }> = []
  const spawns: Rig['spawns'] = []
  const ptys: FakePty[] = []
  const signalled: string[] = []
  let endOpenTurnsCalls = 0
  const calls: Array<{ path: string; input: any }> = []

  const fakeMirror = {
    docIdForPath: (rel: string) => (rel === NOTE_PATH ? NOTE_ID : null),
    pathForDocId: (id: string) => (id === NOTE_ID ? NOTE_PATH : null),
    knownPaths: () => [NOTE_PATH],
    bridgeForPath: (rel: string) =>
      rel === NOTE_PATH ? { signalTurnOpen: () => void signalled.push(rel) } : null,
    endOpenTurns: () => void (endOpenTurnsCalls += 1),
  } as unknown as VaultMirror

  let active: string | null = VAULT
  const vaultManager = {
    workRootFor: () => workRoot,
    activeVaultId: () => active,
    activeMirror: () => (active ? fakeMirror : null),
    setActive: (v: string | null) => (active = v),
  } as unknown as VaultManager & { setActive(v: string | null): void }

  const taskShaped = { id: 't1', vaultId: VAULT, title: 'x', status: 'todo', tags: [], related: [] }
  const proc = (path: string) => ({
    query: async (input: unknown) => (calls.push({ path, input }), []),
    mutate: async (input: unknown) => (calls.push({ path, input }), taskShaped),
  })
  const client = {
    tasks: {
      list: proc('tasks.list'),
      get: proc('tasks.get'),
      create: proc('tasks.create'),
      update: proc('tasks.update'),
      complete: proc('tasks.complete'),
      link: proc('tasks.link'),
      unlink: proc('tasks.unlink'),
      delete: proc('tasks.delete'),
    },
    notes: { rename: proc('notes.rename'), backrefs: proc('notes.backrefs') },
  } as unknown as ServerClient

  const manager = createAgentManager({
    client,
    vaultManager,
    getWindow: () =>
      ({ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }) as never,
    spawnPty: (file, args, o) => {
      const pty = new FakePty()
      ptys.push(pty)
      spawns.push({ file, args, opts: o as never })
      return pty
    },
    resolveBin: () => (opts.bin === undefined ? '/bin/fake-claude' : opts.bin),
    settleMs: 20,
    killGraceMs: 20,
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
    calls,
    fakeMirror,
    pty: () => ptys.at(-1)!,
    mirror: {
      signalled,
      get endOpenTurnsCalls() {
        return endOpenTurnsCalls
      },
    },
    // @ts-expect-error test-only handle for the inactive-vault case
    vaultManager,
  } as Rig & { vaultManager: { setActive(v: string | null): void } }
}

/** Read the --mcp-config blob the CLI was spawned with. */
function mcpConfigFrom(args: string[]): any {
  return JSON.parse(args[args.indexOf('--mcp-config') + 1]!)
}

async function mcpCall(endpoint: string, token: string, method: string, params?: unknown) {
  const res = await fetch(`${endpoint}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return res.json() as Promise<any>
}

describe('AgentManager', () => {
  it('spawns claude in the working dir with the prompt, the MCP blob, and no skip-permissions', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })

    const spawn = r.spawns[0]!
    expect(spawn.file).toBe('/bin/fake-claude')
    expect(spawn.opts.cwd).toBe(r.workRoot)
    expect(spawn.args).not.toContain('--dangerously-skip-permissions')
    expect(spawn.args).toContain('--strict-mcp-config')

    const prompt = spawn.args[spawn.args.indexOf('--append-system-prompt') + 1]!
    expect(prompt).toContain('## Tools')
    expect(prompt).toContain('## Vault top-level layout')

    // the blob's url + bearer are exactly what the hook scripts get in env
    const blob = mcpConfigFrom(spawn.args)
    const server = blob.mcpServers.holi
    expect(server.type).toBe('http')
    expect(server.alwaysLoad).toBe(true)
    expect(server.url).toBe(`${spawn.opts.env.HOLI_AGENT_ENDPOINT}/mcp`)
    expect(server.headers.Authorization).toBe(`Bearer ${spawn.opts.env.HOLI_AGENT_TOKEN}`)
    expect(r.manager.status().running).toBe(true)
  })

  it('picks up IDENTITY.md and SOUL.md from the working copy', async () => {
    const r = await rig()
    await mkdir(join(r.workRoot, '.claude'), { recursive: true })
    await writeFile(join(r.workRoot, '.claude/IDENTITY.md'), '# IDENTITY\n\nPairing on Holi.')
    await writeFile(join(r.workRoot, '.claude/SOUL.md'), '# SOUL\n\nCurious.')

    await r.manager.start({ vaultId: VAULT })
    const prompt = r.spawns[0]!.args[r.spawns[0]!.args.indexOf('--append-system-prompt') + 1]!
    expect(prompt.indexOf('# IDENTITY')).toBeGreaterThanOrEqual(0)
    expect(prompt.indexOf('# SOUL')).toBeGreaterThan(prompt.indexOf('# IDENTITY'))
  })

  it('serves the 3 ops over the live MCP server, bearer-gated', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    const { HOLI_AGENT_ENDPOINT: endpoint, HOLI_AGENT_TOKEN: token } = r.spawns[0]!.opts.env

    const unauthorized = await fetch(`${endpoint}/mcp`, { method: 'POST', body: '{}' })
    expect(unauthorized.status).toBe(401)

    const listed = await mcpCall(endpoint!, token!, 'tools/list')
    expect(listed.result.tools.map((t: any) => t.name)).toEqual([
      'note_rename',
      'task_list',
      'task_set',
    ])

    // an op reaches the server client with the vault injected
    const called = await mcpCall(endpoint!, token!, 'tools/call', {
      name: 'task_set',
      arguments: { task_id: 't1', status: 'done' },
    })
    expect(called.result.isError).toBeUndefined()
    expect(r.calls).toContainEqual({
      path: 'tasks.complete',
      input: { vaultId: VAULT, taskId: 't1' },
    })
  })

  it('routes the PreToolUse hook to the bridge for that path, ignoring paths outside the vault', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    const { HOLI_AGENT_ENDPOINT: endpoint, HOLI_AGENT_TOKEN: token } = r.spawns[0]!.opts.env

    const post = (filePath: string) =>
      fetch(`${endpoint}/hook/pre-tool-use`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ filePath }),
      })

    await post(join(r.workRoot, NOTE_PATH))
    expect(r.mirror.signalled).toEqual([NOTE_PATH])

    await post('/etc/passwd') // outside the vault — path safety
    await post(join(r.workRoot, 'unknown.md')) // inside, but not a doc
    expect(r.mirror.signalled).toEqual([NOTE_PATH])
  })

  it('the Stop hook ends open turns after the settle delay', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    const { HOLI_AGENT_ENDPOINT: endpoint, HOLI_AGENT_TOKEN: token } = r.spawns[0]!.opts.env

    await fetch(`${endpoint}/hook/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(r.mirror.endOpenTurnsCalls).toBe(0) // still settling — the last write may be in flight
    await new Promise((res) => setTimeout(res, 60))
    expect(r.mirror.endOpenTurnsCalls).toBe(1)
  })

  it('holds PTY output in the mirror until a renderer attaches, then streams', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })

    // nothing is attached yet: output must not be streamed at a window that
    // cannot show it — but it must not be lost either
    r.pty().emit('before the panel mounted\r\n')
    expect(r.sent.filter((s) => s.channel === 'agent-pty:data')).toEqual([])

    const replayed = await r.manager.attach()
    expect(replayed).toContain('before the panel mounted')

    // and from here it streams live, without re-sending what was replayed
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

  it('forwards PTY data and exit to the renderer, and tears the MCP server down on exit', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    await r.manager.attach()
    const { HOLI_AGENT_ENDPOINT: endpoint, HOLI_AGENT_TOKEN: token } = r.spawns[0]!.opts.env

    r.pty().emit('hello from claude')
    expect(r.sent).toContainEqual({ channel: 'agent-pty:data', payload: 'hello from claude' })

    r.pty().exit(3)
    expect(r.sent).toContainEqual({ channel: 'agent-pty:exit', payload: { code: 3 } })
    await new Promise((res) => setTimeout(res, 50))
    expect(r.manager.status().running).toBe(false)
    await expect(mcpCall(endpoint!, token!, 'ping')).rejects.toThrow() // port is closed
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

  it('onDeactivating kills the session before the mirror goes down', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    expect(r.manager.status().running).toBe(true)

    await r.manager.observer.onDeactivating(VAULT)
    expect(r.manager.status().running).toBe(false)
  })

  it('tracks the working flag from turn activity', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })
    r.manager.observer.onTurnActivity(1)
    expect(r.manager.status().working).toBe(true)
    expect(r.sent.filter((s) => s.channel === 'agent:status').at(-1)!.payload.working).toBe(true)

    r.manager.observer.onTurnActivity(0)
    expect(r.manager.status().working).toBe(false)
  })

  it('flags configStale only for synced agent config, and clears it on restart', async () => {
    const r = await rig()
    await r.manager.start({ vaultId: VAULT })

    r.manager.observer.onMaterialize('notes/plan.md')
    expect(r.manager.status().configStale).toBe(false)

    r.manager.observer.onMaterialize('.claude/settings.json')
    expect(r.manager.status().configStale).toBe(true)

    await r.manager.start({ vaultId: VAULT })
    expect(r.manager.status().configStale).toBe(false)
  })

  it('does not flag configStale when no session is running', async () => {
    const r = await rig()
    r.manager.observer.onMaterialize('AGENTS.md')
    expect(r.manager.status().configStale).toBe(false)
  })

  it('setFocus writes the context file the hook reads', async () => {
    const r = await rig()
    await r.manager.observer.onActivated(VAULT, r.fakeMirror)
    r.manager.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH] })

    await new Promise((res) => setTimeout(res, 300))
    const ctx = JSON.parse(await readFile(join(r.workRoot, CONTEXT_FILE), 'utf8'))
    expect(ctx.focusedPath).toBe(NOTE_PATH)
    expect(r.calls.some((c) => c.path === 'tasks.list')).toBe(true)
    expect(r.calls.some((c) => c.path === 'notes.backrefs')).toBe(true)
  })

  it('a tasks SSE event refreshes the snapshot', async () => {
    const r = await rig()
    await r.manager.observer.onActivated(VAULT, r.fakeMirror)
    r.manager.setFocus({ focusedPath: NOTE_PATH, openPaths: [] })
    await new Promise((res) => setTimeout(res, 300))
    const before = r.calls.filter((c) => c.path === 'tasks.list').length

    r.manager.observer.onTasksEvent({ type: 'deleted', taskId: 'gone' })
    await new Promise((res) => setTimeout(res, 300))
    expect(r.calls.filter((c) => c.path === 'tasks.list').length).toBe(before + 1)
  })

  it('fails readably when the CLI is missing', async () => {
    const r = await rig({ bin: null })
    await expect(r.manager.start({ vaultId: VAULT })).rejects.toThrow(/Claude CLI not found on PATH/)
    expect(r.manager.status().running).toBe(false)
  })

  it('refuses to start against a vault that is not active', async () => {
    const r = (await rig()) as Rig & { vaultManager: { setActive(v: string | null): void } }
    await expect(r.manager.start({ vaultId: 'other-vault' })).rejects.toThrow(/not active/)
    r.vaultManager.setActive(null)
    await expect(r.manager.start({ vaultId: VAULT })).rejects.toThrow(/not active/)
  })
})
