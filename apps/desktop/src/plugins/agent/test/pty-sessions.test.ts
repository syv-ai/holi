import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_ID,
  createPtySessions,
  nameOf,
  parsePastFile,
  PTY_SESSION_ID,
} from '../main/host/pty-sessions'
import type { OpenArgs } from '../main/host/terminals'
import type { AgentProvider, TerminalOpts } from '../main/provider'

const VAULT = { remote: 'syv/vault', root: '/Users/ada/Holi/syv/vault' }

afterEach(() => {
  vi.useRealTimers()
})

function setup(
  providerId: 'codex' | 'pi' = 'codex',
  past?: {
    read(): Promise<import('../main/claude/listing').SessionSummary[]>
    write(rows: import('../main/claude/listing').SessionSummary[]): Promise<void>
  },
) {
  vi.useFakeTimers()
  const asked: TerminalOpts[] = []
  const provider: AgentProvider = {
    id: providerId,
    label: providerId === 'pi' ? 'Pi' : 'Codex',
    ...(providerId === 'pi' ? { namesConversation: true } : {}),
    notInstalled: 'Codex is not installed',
    installed: () => true,
    configure: async () => ({ dir: '/home/.codex' }),
    terminal: (_target, opts = {}) => {
      asked.push(opts)
      return { bin: '/bin/codex', args: [], env: {} }
    },
    capabilities: {},
  }
  const opened: OpenArgs[] = []
  const closed: string[] = []
  const pastes: Array<[string, string]> = []
  const edges: string[] = []
  const lists: unknown[] = []
  const sessions = createPtySessions({
    vault: VAULT,
    providers: [provider],
    ...(past === undefined ? {} : { past }),
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
  return { sessions, opened, closed, pastes, edges, asked, lists }
}

describe('nameOf', () => {
  it('is the first line, cut short', () => {
    expect(nameOf('  fix the build\nand more')).toBe('fix the build')
    expect(nameOf('   ')).toBeNull()
    expect(nameOf('x'.repeat(200))).toHaveLength(80)
  })
})

describe('sessions Holi runs', () => {
  it('rejects invalid past ids and providers', () => {
    const rows = parsePastFile({
      'syv/vault': [
        {
          id: 'p0123456789ab',
          provider: 'pi',
          name: 'Valid',
          state: 'idle',
          startedAt: 1,
          conversationId: '123e4567-e89b-42d3-a456-426614174000',
        },
        {
          id: 'not-an-id',
          provider: 'pi',
          name: 'Bad id',
          state: 'idle',
          startedAt: 1,
          conversationId: '123e4567-e89b-42d3-a456-426614174000',
        },
        {
          id: 'p0123456789ab',
          provider: 'unknown',
          name: 'Bad provider',
          state: 'idle',
          startedAt: 1,
          conversationId: '123e4567-e89b-42d3-a456-426614174000',
        },
        {
          id: 'p0123456789ab',
          provider: 'pi',
          name: 'Bad conversation',
          state: 'idle',
          startedAt: 1,
          conversationId: 'not-a-uuid',
        },
      ],
    })
    expect(rows['syv/vault']).toHaveLength(1)
  })

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
    t.sessions.noteConversation(res.sessionId, {
      name: 'Plan the week',
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
    })
    t.sessions.noteConversation(res.sessionId, { name: 'Something else' })
    expect(t.sessions.sessions()[0]).toMatchObject({
      name: 'Plan the week',
      conversationId: '123e4567-e89b-42d3-a456-426614174000',
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

  it('keeps Pi conversation UUIDs separate from Holi PTY ids', async () => {
    const t = setup('pi')
    const result = await t.sessions.start('pi', {})
    if (!result.ok) throw new Error(result.message)
    expect(result.sessionId).toMatch(PTY_SESSION_ID)
    expect(t.asked[0]?.session).toBe(result.sessionId)
    expect(t.asked[0]?.conversation).toMatch(CONVERSATION_ID)
    expect(t.asked[0]?.conversation).not.toBe(result.sessionId)
  })

  it('persists closed sessions locally and reopens the same conversation and PTY id', async () => {
    let history: import('../main/claude/listing').SessionSummary[] = []
    const store = {
      read: async () => history,
      write: async (rows: typeof history) => {
        history = rows
      },
    }
    const first = setup('pi', store)
    const started = await first.sessions.start('pi', {})
    if (!started.ok) throw new Error(started.message)
    first.opened[0]!.onExit?.()
    await first.sessions.past()
    expect(history[0]).toMatchObject({ id: started.sessionId, provider: 'pi' })
    const conversationId = history[0]?.conversationId
    const reopened = setup('pi', store)
    expect(await reopened.sessions.hasPast(started.sessionId)).toBe(true)
    const result = await reopened.sessions.reopen(started.sessionId, {})
    expect(result).toMatchObject({ ok: true, sessionId: started.sessionId })
    expect(reopened.asked[0]).toMatchObject({ session: started.sessionId, resume: conversationId })
    expect(reopened.sessions.sessions()[0]?.id).toBe(started.sessionId)
  })

  it('keeps a quickly exited reopened conversation in History', async () => {
    let history: import('../main/claude/listing').SessionSummary[] = []
    const store = {
      read: async () => history,
      write: async (rows: typeof history) => {
        history = rows
      },
    }
    const first = setup('pi', store)
    const started = await first.sessions.start('pi', { name: 'Original' })
    if (!started.ok) throw new Error(started.message)
    first.opened[0]!.onExit?.()
    await first.sessions.past()

    const reopened = setup('pi', store)
    const opening = reopened.sessions.reopen(started.sessionId, {})
    for (let i = 0; i < 10 && reopened.opened.length === 0; i++) await Promise.resolve()
    expect(reopened.opened).toHaveLength(1)
    reopened.opened[0]!.onExit?.()
    expect(await opening).toMatchObject({ ok: true })
    expect(await reopened.sessions.past()).toEqual([
      expect.objectContaining({ id: started.sessionId, name: 'Original' }),
    ])
  })

  it('keeps an unnamed session’s last terminal title in History', async () => {
    const t = setup('pi')
    const started = await t.sessions.start('pi', {})
    if (!started.ok) throw new Error(started.message)
    t.opened[0]!.onExit?.('Pi plan')
    expect(await t.sessions.past()).toEqual([
      expect.objectContaining({ id: started.sessionId, name: 'Pi plan' }),
    ])
  })

  it('forks a live Pi conversation under a new UUID and does not persist native picker sessions', async () => {
    const t = setup('pi')
    const original = await t.sessions.start('pi', {})
    if (!original.ok) throw new Error(original.message)
    const fork = await t.sessions.duplicate(original.sessionId, {})
    if (!fork.ok) throw new Error(fork.message)
    expect(fork.sessionId).not.toBe(original.sessionId)
    expect(t.asked[1]).toMatchObject({ fork: t.asked[0]?.conversation })
    expect(t.asked[1]?.conversation).toMatch(CONVERSATION_ID)

    const picker = await t.sessions.start('pi', { resume: 'pick' })
    if (!picker.ok) throw new Error(picker.message)
    expect(t.asked[2]?.session).toMatch(PTY_SESSION_ID)
    expect(t.asked[2]?.conversation).toBeUndefined()
    t.opened[2]!.onExit?.()
    expect(await t.sessions.past()).toEqual([])
  })

  it('resumes a native UUID under a new PTY id and rejects invalid conversation identifiers', async () => {
    const t = setup('pi')
    const conversationId = '123e4567-e89b-42d3-a456-426614174000'
    const resumed = await t.sessions.start('pi', { resume: conversationId })
    if (!resumed.ok) throw new Error(resumed.message)
    expect(resumed.sessionId).toMatch(PTY_SESSION_ID)
    expect(resumed.sessionId).not.toBe(conversationId)
    expect(t.asked[0]).toMatchObject({ session: resumed.sessionId, resume: conversationId })
    expect(t.sessions.sessions()[0]?.conversationId).toBe(conversationId)
    expect(await t.sessions.start('pi', { resume: 'not-a-uuid' })).toMatchObject({ ok: false })
    expect(await t.sessions.start('pi', { fork: 'not-a-uuid' })).toMatchObject({ ok: false })
  })

  it('refuses a provider it does not run', async () => {
    const t = setup()
    expect((await t.sessions.start('claude', {})).ok).toBe(false)
  })
})
