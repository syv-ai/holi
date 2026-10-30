import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtySessions, nameOf, PTY_SESSION_ID } from '../main/host/pty-sessions'
import type { OpenArgs } from '../main/host/terminals'
import type { AgentProvider, TerminalOpts } from '../main/provider'

const VAULT = { remote: 'syv/vault', root: '/Users/ada/Holi/syv/vault' }

afterEach(() => {
  vi.useRealTimers()
})

function setup(capabilities: AgentProvider['capabilities'] = {}) {
  vi.useFakeTimers()
  const asked: TerminalOpts[] = []
  const provider: AgentProvider = {
    id: 'codex',
    label: 'Codex',
    notInstalled: 'Codex is not installed',
    installed: () => true,
    configure: async () => ({ dir: '/home/.codex' }),
    terminal: (target, opts = {}) => {
      targets.push(target)
      asked.push(opts)
      return { bin: '/bin/codex', args: [], env: {} }
    },
    capabilities,
  }
  const opened: OpenArgs[] = []
  const closed: string[] = []
  const pastes: Array<[string, string]> = []
  const edges: string[] = []
  const lists: unknown[] = []
  const targets: { binDir: string | null }[] = []
  const sessions = createPtySessions({
    vault: VAULT,
    providers: [provider],
    terminals: {
      open: (args) => {
        opened.push(args)
        return { ok: true, id: `term-${opened.length}` }
      },
      close: async (id) => {
        closed.push(id)
        opened[Number(id.slice(5)) - 1]?.onExit?.()
      },
      paste: (id, text) => {
        pastes.push([id, text])
        return true
      },
      list: () => [],
    },
    bracket: (id, edge) => edges.push(`${edge}:${id}`),
    binDir: () => '/holi/bin',
    onChange: (list) => lists.push(list),
    idleMs: 100,
    log: () => {},
  })
  return { sessions, opened, closed, pastes, edges, asked, lists, targets }
}

describe('nameOf', () => {
  it('is the first line, cut short', () => {
    expect(nameOf('  fix the build\nand more')).toBe('fix the build')
    expect(nameOf('   ')).toBeNull()
    expect(nameOf('x'.repeat(200))).toHaveLength(80)
  })
})

describe('sessions Holi runs', () => {
  it('starts one in a terminal of its own, named by its id', async () => {
    const t = setup()
    const res = await t.sessions.start('codex', { cols: 100, rows: 30 })
    if (!res.ok) throw new Error(res.message)

    expect(res.sessionId).toMatch(PTY_SESSION_ID)
    expect(t.asked[0]?.session).toBe(res.sessionId)
    expect(t.opened[0]).toMatchObject({
      remote: VAULT.remote,
      cwd: VAULT.root,
      attach: res.sessionId,
      cols: 100,
      rows: 30,
    })
    expect(t.sessions.terminalOf(res.sessionId)).toBe(res.terminalId)
    expect(t.sessions.ownsTerminal(res.terminalId)).toBe(true)
    expect(t.sessions.sessions()).toEqual([
      expect.objectContaining({
        id: res.sessionId,
        provider: 'codex',
        name: 'New session',
        state: 'idle',
      }),
    ])
  })

  it('is working from a first prompt, and through the vault bracket', async () => {
    const t = setup()
    const res = await t.sessions.start('codex', { prompt: 'Tidy the inbox\nplease' })
    if (!res.ok) throw new Error(res.message)
    expect(t.asked[0]?.prompt).toBe('Tidy the inbox\nplease')
    expect(t.sessions.sessions()[0]).toMatchObject({ name: 'Tidy the inbox', state: 'working' })
    expect(t.edges).toEqual([`begin:${res.sessionId}`])

    // Its hook says the turn ended.
    t.sessions.noteTurn(res.sessionId, false)
    expect(t.sessions.sessions()[0]?.state).toBe('idle')
    expect(t.edges).toEqual([`begin:${res.sessionId}`, `end:${res.sessionId}`])
  })

  it('reads a turn off its terminal, and asks for the person on a notification', async () => {
    const t = setup()
    const res = await t.sessions.start('codex', {})
    if (!res.ok) throw new Error(res.message)
    const term = t.opened[0]!

    term.onInput?.('do it\r')
    expect(t.sessions.sessions()[0]?.state).toBe('working')
    term.onOutput?.('\x1b]9;Approve this command?\x07')
    expect(t.sessions.sessions()[0]).toMatchObject({ state: 'needs-you' })

    // Quiet while it waits: the turn is over, the question is not.
    vi.advanceTimersByTime(150)
    expect(t.sessions.sessions()[0]?.state).toBe('needs-you')

    // The answer goes on with the turn.
    term.onInput?.('y')
    expect(t.sessions.sessions()[0]?.state).toBe('working')
  })

  it('is named by what its hook reports, unless it has a name', async () => {
    const t = setup()
    const res = await t.sessions.start('codex', {})
    if (!res.ok) throw new Error(res.message)
    t.sessions.noteConversation(res.sessionId, { name: 'Plan the week', conversationId: 'th-1' })
    t.sessions.noteConversation(res.sessionId, { name: 'Something else' })
    expect(t.sessions.sessions()[0]).toMatchObject({
      name: 'Plan the week',
      conversationId: 'th-1',
    })
  })

  it('pastes an ask unsent, and stops by ending its terminal', async () => {
    const t = setup()
    const res = await t.sessions.start('codex', {})
    if (!res.ok) throw new Error(res.message)
    t.opened[0]!.onInput?.('\r')

    expect(t.sessions.send(res.sessionId, 'look at Q4.md')).toEqual({
      ok: true,
      terminalId: res.terminalId,
    })
    expect(t.pastes).toEqual([[res.terminalId, 'look at Q4.md']])

    await t.sessions.stop(res.sessionId)
    expect(t.closed).toEqual([res.terminalId])
    expect(t.sessions.has(res.sessionId)).toBe(false)
    // Gone mid-turn: nothing recorded.
    expect(t.edges.at(-1)).toBe(`forget:${res.sessionId}`)
    expect(t.sessions.send(res.sessionId, 'hello').ok).toBe(false)
  })

  it('refuses a provider it does not run', async () => {
    const t = setup()
    expect((await t.sessions.start('claude', {})).ok).toBe(false)
  })

  it('runs a fenced one in its folder, copying back before its turn closes', async () => {
    const t = setup({ fenced: true })
    let copied!: () => void
    const fence = {
      dir: '/scratch/abc',
      turnEnded: vi.fn(() => {
        return new Promise<void>((resolve) => (copied = resolve))
      }),
      exited: vi.fn(),
    }
    const res = await t.sessions.start('codex', { prompt: 'Make the app', fence })
    if (!res.ok) throw new Error(res.message)
    expect(t.opened[0]?.cwd).toBe('/scratch/abc')
    expect(t.asked[0]?.fence).toBe('/scratch/abc')
    // Holi's commands reach the vault: none on a fenced session's PATH.
    expect(t.targets[0]?.binDir).toBeNull()

    t.sessions.noteTurn(res.sessionId, false)
    expect(fence.turnEnded).toHaveBeenCalledOnce()
    expect(t.edges).toEqual([`begin:${res.sessionId}`])
    copied()
    await vi.waitFor(() =>
      expect(t.edges).toEqual([`begin:${res.sessionId}`, `end:${res.sessionId}`]),
    )

    await t.sessions.stop(res.sessionId)
    expect(fence.exited).toHaveBeenCalledOnce()
  })

  it('refuses a fence its provider cannot keep', async () => {
    const t = setup()
    const fence = { dir: '/scratch/abc', turnEnded: async () => {}, exited: () => {} }
    expect(await t.sessions.start('codex', { prompt: 'x', fence })).toEqual({
      ok: false,
      message: 'Codex cannot run fenced to a folder.',
    })
    expect(t.opened).toEqual([])
  })
})
