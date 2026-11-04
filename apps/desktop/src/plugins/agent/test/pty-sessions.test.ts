import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_ID,
  createPtySessions,
  nameOf,
  parsePastFile,
  PTY_SESSION_ID,
  type FenceCopy,
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
  capabilities: AgentProvider['capabilities'] = {},
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
    providers: () => [provider],
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
  return { sessions, opened, closed, pastes, edges, asked, lists, targets, provider }
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
          // Any harness slug is an agent's id; this is none.
          provider: 'Not an agent!',
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

  it('clears an exited Pi turn without leaving a working state or bracket', async () => {
    const t = setup('pi')
    const started = await t.sessions.start('pi', { prompt: 'Do work' })
    if (!started.ok) throw new Error(started.message)
    expect(t.sessions.sessions()[0]?.state).toBe('working')
    expect(t.edges).toEqual([`begin:${started.sessionId}`])

    t.opened[0]?.onExit?.()
    expect(t.sessions.sessions()[0]?.state).toBe('idle')
    expect(t.edges).toEqual([`begin:${started.sessionId}`, `forget:${started.sessionId}`])
    t.opened[0]?.onInput?.('\r')
    expect(t.sessions.sessions()[0]?.state).toBe('idle')
    expect(t.edges).toEqual([`begin:${started.sessionId}`, `forget:${started.sessionId}`])
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
    await first.sessions.stop(started.sessionId)
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
    await first.sessions.stop(started.sessionId)
    await first.sessions.past()

    const reopened = setup('pi', store)
    const opening = reopened.sessions.reopen(started.sessionId, {})
    for (let i = 0; i < 10 && reopened.opened.length === 0; i++) await Promise.resolve()
    expect(reopened.opened).toHaveLength(1)
    await reopened.sessions.stop(started.sessionId)
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
    expect(t.sessions.has(started.sessionId)).toBe(true)
    await t.sessions.stop(started.sessionId)
    expect(await t.sessions.past()).toEqual([
      expect.objectContaining({ id: started.sessionId, name: 'Pi plan' }),
    ])
  })

  it('keeps an exited Pi session open with its terminal attached until explicitly stopped', async () => {
    const t = setup('pi')
    const started = await t.sessions.start('pi', {})
    if (!started.ok) throw new Error(started.message)

    t.opened[0]!.onExit?.('Pi terminal title')

    expect(t.sessions.has(started.sessionId)).toBe(true)
    expect(t.sessions.terminalOf(started.sessionId)).toBe(started.terminalId)
    expect(t.sessions.sessions()).toEqual([
      expect.objectContaining({ id: started.sessionId, provider: 'pi', name: 'Pi terminal title' }),
    ])
    expect(await t.sessions.past()).toEqual([])

    await t.sessions.stop(started.sessionId)
    expect(t.sessions.has(started.sessionId)).toBe(false)
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

  it('runs a background provider only for its sign-in, which reads no turns off its terminal', async () => {
    const background = {} as NonNullable<AgentProvider['capabilities']['background']>
    const t = setup('codex', undefined, { background })
    expect((await t.sessions.start('codex', {})).ok).toBe(false)

    const res = await t.sessions.start('codex', { login: true })
    if (!res.ok) throw new Error(res.message)
    expect(t.asked[0]?.login).toBe(true)
    // One sign-in at a time.
    expect(await t.sessions.start('codex', { login: true })).toEqual(res)
    t.opened[0]!.onInput?.('/login\r')
    expect(t.sessions.sessions()).toEqual([
      expect.objectContaining({ id: res.sessionId, state: 'idle' }),
    ])
    expect(t.edges).toEqual([])

    await t.sessions.stop(res.sessionId)
    expect(t.sessions.sessions()).toEqual([])
  })

  it('does not create a sign-in terminal when the vault is left during configuration', async () => {
    const t = setup('codex', undefined, {
      background: {} as NonNullable<AgentProvider['capabilities']['background']>,
    })
    let finish!: (value: { dir: string }) => void
    t.provider.configure = () => new Promise((resolve) => (finish = resolve))

    const starting = t.sessions.start('codex', { login: true })
    const leaving = t.sessions.leave()
    finish({ dir: '/home/.codex' })

    await leaving
    expect(await starting).toMatchObject({ ok: false })
    expect(t.opened).toEqual([])
    expect(t.sessions.sessions()).toEqual([])
  })

  it('does not create a sign-in terminal when the vault is left during the first-spawn notice', async () => {
    const t = setup('codex', undefined, {
      background: {} as NonNullable<AgentProvider['capabilities']['background']>,
    })
    let finish!: (value: boolean) => void
    t.provider.firstSpawn = {
      take: () => new Promise((resolve) => (finish = resolve)),
      notice: 'Sign in',
    }

    const starting = t.sessions.start('codex', { login: true })
    for (let i = 0; i < 10 && finish === undefined; i++) await Promise.resolve()
    const leaving = t.sessions.leave()
    finish(true)

    await leaving
    expect(await starting).toMatchObject({ ok: false })
    expect(t.opened).toEqual([])
    expect(t.sessions.sessions()).toEqual([])
  })

  it('runs a fenced one in its folder, copying back before its turn closes, and says when that failed', async () => {
    const t = setup('codex', undefined, { fenced: 'sandbox' })
    let copied!: (copy: FenceCopy) => void
    const fence = {
      dir: '/scratch/abc',
      state: '/scratch/abc.agent',
      turnEnded: vi.fn(() => {
        return new Promise<FenceCopy>((resolve) => (copied = resolve))
      }),
      exited: vi.fn(async () => ({})),
    }
    const res = await t.sessions.start('codex', { prompt: 'Make the app', fence })
    if (!res.ok) throw new Error(res.message)
    expect(t.opened[0]?.cwd).toBe('/scratch/abc')
    expect(t.asked[0]?.fence).toEqual({ dir: '/scratch/abc', state: '/scratch/abc.agent' })
    // Holi's commands reach the vault: none on a fenced session's PATH.
    expect(t.targets[0]?.binDir).toBeNull()

    t.sessions.noteTurn(res.sessionId, false)
    expect(fence.turnEnded).toHaveBeenCalledOnce()
    expect(t.edges).toEqual([`begin:${res.sessionId}`])
    const error = 'Holi did not copy back notes/Plan.app/app.yaml: something else put it there.'
    copied({ error, leftOut: 'Holi left out what it may not write: notes/Plan.app/.env.' })
    await vi.waitFor(() =>
      expect(t.edges).toEqual([`begin:${res.sessionId}`, `end:${res.sessionId}`]),
    )
    // Its row says why its writes did not reach the vault.
    expect(t.sessions.sessions()[0]).toMatchObject({
      outcome: 'failed',
      error,
      message: 'Holi left out what it may not write: notes/Plan.app/.env.',
    })

    await t.sessions.stop(res.sessionId)
    expect(fence.exited).toHaveBeenCalledOnce()
  })

  it('keeps the final copy error after the terminal exits until the vault is left', async () => {
    const t = setup('codex', undefined, { fenced: 'sandbox' })
    let finish!: (result: FenceCopy) => void
    const fence = {
      dir: '/scratch/abc',
      state: '/scratch/abc.agent',
      turnEnded: async () => ({}),
      exited: () => new Promise<FenceCopy>((resolve) => (finish = resolve)),
    }
    const started = await t.sessions.start('codex', { prompt: 'Make the app', fence })
    if (!started.ok) throw new Error(started.message)
    t.opened[0]?.onExit?.()
    expect(t.sessions.sessions()[0]).toMatchObject({ id: started.sessionId, copying: true })
    expect(t.sessions.has(started.sessionId)).toBe(true)
    finish({ error: 'Holi could not copy back app.yaml.' })
    await vi.waitFor(() =>
      expect(t.sessions.sessions()[0]).toMatchObject({
        id: started.sessionId,
        closed: true,
        outcome: 'failed',
        error: 'Holi could not copy back app.yaml.',
      }),
    )
    expect(t.sessions.has(started.sessionId)).toBe(false)
    expect(t.edges).toEqual([`begin:${started.sessionId}`, `forget:${started.sessionId}`])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(t.sessions.sessions()[0]).toMatchObject({
      id: started.sessionId,
      error: 'Holi could not copy back app.yaml.',
    })
    await t.sessions.leave()
    expect(t.sessions.sessions()).toEqual([])
  })

  it('does not stop a fenced session before its final copy resolves', async () => {
    const t = setup('codex', undefined, { fenced: 'sandbox' })
    let finish!: (result: FenceCopy) => void
    const fence = {
      dir: '/scratch/abc',
      state: '/scratch/abc.agent',
      turnEnded: async () => ({}),
      exited: () => new Promise<FenceCopy>((resolve) => (finish = resolve)),
    }
    const started = await t.sessions.start('codex', { prompt: 'Make the app', fence })
    if (!started.ok) throw new Error(started.message)
    t.opened[0]?.onInput?.('\r')

    const stopping = t.sessions.stop(started.sessionId)
    await stopping
    expect(t.sessions.has(started.sessionId)).toBe(true)
    expect(t.sessions.sessions()[0]).toMatchObject({ id: started.sessionId, copying: true })
    expect(t.edges).toEqual([`begin:${started.sessionId}`])

    finish({ error: 'Final copy failed.' })
    await vi.waitFor(() =>
      expect(t.sessions.sessions()[0]).toMatchObject({
        id: started.sessionId,
        closed: true,
        error: 'Final copy failed.',
      }),
    )
    expect(t.sessions.has(started.sessionId)).toBe(false)
    expect(t.edges).toEqual([`begin:${started.sessionId}`, `forget:${started.sessionId}`])
  })

  it('persists active and already-exited Pi sessions when leaving the vault', async () => {
    let history: import('../main/claude/listing').SessionSummary[] = []
    const store = {
      read: async () => history,
      write: async (rows: typeof history) => {
        history = rows
      },
    }
    const t = setup('pi', store)
    const active = await t.sessions.start('pi', { prompt: 'Still working' })
    const exited = await t.sessions.start('pi', { name: 'Already finished' })
    if (!active.ok || !exited.ok) throw new Error('Pi session did not start')
    t.opened[1]?.onExit?.()
    await t.sessions.leave()

    expect(history).toHaveLength(2)
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: active.sessionId, name: 'Still working' }),
        expect.objectContaining({ id: exited.sessionId, name: 'Already finished' }),
      ]),
    )
    expect(t.sessions.sessions()).toEqual([])
    expect(t.edges).toContain(`forget:${active.sessionId}`)
  })

  it('retains final omissions but expires a clean final copy', async () => {
    const t = setup('codex', undefined, { fenced: 'sandbox' })
    const fenced = (copy: FenceCopy) => ({
      dir: '/scratch/abc',
      state: '/scratch/abc.agent',
      turnEnded: async () => ({}),
      exited: async () => copy,
    })
    const partial = await t.sessions.start('codex', {
      fence: fenced({ leftOut: 'Holi left out app.local.yaml.' }),
    })
    const clean = await t.sessions.start('codex', { fence: fenced({}) })
    if (!partial.ok || !clean.ok) throw new Error('fenced session did not start')
    t.opened[0]?.onExit?.()
    t.opened[1]?.onExit?.()
    await vi.waitFor(() => expect(t.sessions.sessions()).toHaveLength(2))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(t.sessions.sessions()).toEqual([
      expect.objectContaining({
        id: partial.sessionId,
        message: 'Holi left out app.local.yaml.',
      }),
    ])
  })

  it('refuses a fence its provider cannot keep', async () => {
    const t = setup()
    const fence = {
      dir: '/scratch/abc',
      state: '/scratch/abc.agent',
      turnEnded: async () => ({}),
      exited: async () => ({}),
    }
    expect(await t.sessions.start('codex', { prompt: 'x', fence })).toEqual({
      ok: false,
      message: 'Codex cannot run fenced to a folder.',
    })
    expect(t.opened).toEqual([])
  })
})
