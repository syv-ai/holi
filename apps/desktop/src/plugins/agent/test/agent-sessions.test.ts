import { ChildProcess } from 'node:child_process'
import { ownedJobLease } from '../../../main/owned-process-broker'
import { describe, expect, it, vi } from 'vitest'
import { fakeClaudeCommand } from './fake-claude-command'
import { UnconfirmedOwnedProgramError, type execProgram } from '../../../main/plugin-api'
import { createClaudeCli, type ClaudeCli } from '../main/claude/cli'
import { SIGN_IN_NOTICE } from '../main/claude/config-dir'
import {
  isLive,
  parseListing,
  readContextPercent,
  readModelName,
  summarise,
} from '../main/claude/listing'
import type { SessionChannel } from '../main/claude/messaging'
import { createAgentSessions, type AgentVault } from '../main/host/sessions'
import type { AgentTerminals, OpenArgs } from '../main/host/terminals'

const ROOT = '/Users/ada/Holi/syv/vault'
const REMOTE = 'syv/vault'

type Row = Record<string, unknown>
const row = (id: string, over: Row = {}): Row => ({
  id,
  cwd: ROOT,
  kind: 'background',
  sessionId: `${id}-uuid`,
  name: `Session ${id}`,
  pid: 100,
  status: 'idle',
  state: 'done',
  ...over,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(
  initial: Row[] = [],
  nativeCli?: ClaudeCli,
  root = ROOT,
  activationSignal?: AbortSignal,
  remote = REMOTE,
  takeFirstSpawn = async () => true,
) {
  let listing: Row[] = initial
  const cli = {
    list: vi.fn(async () => JSON.stringify(listing)),
    stop: vi.fn<ClaudeCli['stop']>(async (_t, id) => {
      listing = listing.map((r) => (r.id === id ? { ...r, pid: undefined, state: 'stopped' } : r))
      return { ok: true }
    }),
    respawn: vi.fn(async () => ({ ok: true as const })),
    rm: vi.fn(async (_t, id: string) => {
      listing = listing.filter((r) => r.id !== id)
      return { ok: true as const }
    }),
    startBg: vi.fn<ClaudeCli['startBg']>(async (_t, opts) => {
      // With a first turn it is working at once; without, it waits for one.
      const id = opts.prompt === undefined ? 'newnew00' : 'launch00'
      listing = [
        ...listing,
        opts.prompt === undefined
          ? row(id, { status: 'idle', state: 'blocked' })
          : row(id, { status: 'busy', state: 'working' }),
      ]
      return { ok: true as const, id }
    }),
    forkBg: vi.fn<ClaudeCli['forkBg']>(async () => {
      listing = [...listing, row('copy0000')]
      return { ok: true as const, id: 'copy0000' }
    }),
  } satisfies ClaudeCli
  const opened: OpenArgs[] = []
  const pastes: Array<[string, string]> = []
  const launched = new Map<string, string>()
  const terminals: AgentTerminals = {
    open: (args) => {
      opened.push(args)
      const id = `term-${opened.length}`
      if (args.attach !== undefined) launched.set(args.attach, id)
      return { ok: true, id }
    },
    attach: async () => '',
    write: () => {},
    resize: () => {},
    setAppearance: () => {},
    paste: (id, text) => {
      pastes.push([id, text])
      return true
    },
    close: async () => {},
    closeAll: vi.fn(async () => {}),
    list: () => [],
    launchedFor: (id) => launched.get(id) ?? null,
    listTerminal: () => null,
  }
  const sent: Array<[string, unknown]> = []
  const message = vi.fn(
    async (_channel: SessionChannel, _text: string, _signal?: AbortSignal) => {},
  )
  const pauses: string[] = []
  let watched!: () => void
  /** The processes still running, for the pid check. */
  const running = new Set<number>()
  const vault: AgentVault = {
    remote,
    root,
    head: () => Promise.resolve('base-sha'),
    commitNow: () => Promise.resolve(null),
    pauseSync: (reason: string) => {
      pauses.push(reason)
      return () => {}
    },
  }
  const sessions = createAgentSessions({
    ...(activationSignal === undefined ? {} : { activationSignal }),
    emit: (_remote: string, name: string, payload: unknown) => sent.push([name, payload]),
    provider: {
      id: 'claude',
      notInstalled: 'not installed',
      configure: async () => ({ dir: remote === REMOTE ? '/cfg/vault' : '/cfg/other' }),
      terminal: () => ({ bin: '/usr/local/bin/claude', args: [], env: {} }),
      firstSpawn: { take: takeFirstSpawn, notice: SIGN_IN_NOTICE },
      capabilities: {
        background: {
          cli: nativeCli ?? cli,
          parseListing,
          isLive,
          summarise,
          watch: (_dir, onChange) => {
            watched = onChange
            return () => {}
          },
          message,
        },
        status: { contextPercent: readContextPercent, model: readModelName },
      },
    },
    terminals,
    binDir: () => '/holi/bin',
    idleRecheckMs: 5,
    idleConfirmMs: 10,
    leaveCapMs: 50,
    alive: (pid) => running.has(pid),
    log: () => {},
  })
  return {
    running,
    sessions,
    cli,
    opened,
    pastes,
    sent,
    message,
    terminals,
    setListing: (rows: Row[]) => {
      listing = rows
    },
    pauses,
    /** The vault opened: what its activation does. */
    attach: () => sessions.ensure(vault),
    notifyWatch: () => watched(),
  }
}

describe('agent sessions', () => {
  it.skipIf(process.platform === 'win32')(
    'propagates a malformed legacy receipt without speculative stop or terminal attach',
    async () => {
      const command = await fakeClaudeCommand('unexpected launch receipt\n')
      const t = setup([], command.cli, command.target.root)
      try {
        await t.attach()
        const result = await t.sessions.start({ name: 'Mail catch-up', prompt: 'Read only' })
        expect(result).toMatchObject({ ok: false, cleanupUnconfirmed: true })
        expect(result).not.toHaveProperty('sessionId')
        expect(t.opened).toEqual([])
        expect((await command.calls()).filter((args) => args[0] === 'stop')).toEqual([])
        const pid = await command.childPid()
        expect(() => process.kill(pid, 0)).not.toThrow()
        const beat = await command.heartbeat()
        await vi.waitFor(async () => expect(await command.heartbeat()).toBeGreaterThan(beat))
      } finally {
        await t.sessions.leave().catch(() => {})
        await command.close()
      }
    },
  )

  it('stops a new terminal session when its vault closes during startup', async () => {
    const t = setup()
    await t.attach()
    const started = t.cli.startBg.getMockImplementation()!
    let release!: () => void
    t.cli.startBg.mockImplementationOnce(async (target, options) => {
      await new Promise<void>((resolve) => (release = resolve))
      return started(target, options)
    })

    const starting = t.sessions.start({ name: 'Catch-up', prompt: 'read mail' })
    await vi.waitFor(() => expect(t.cli.startBg).toHaveBeenCalled())
    let leaveSettled = false
    const leaving = t.sessions.leave().finally(() => {
      leaveSettled = true
    })
    await Promise.resolve()
    expect(leaveSettled).toBe(false)
    release()
    await leaving

    expect(await starting).toEqual({
      ok: false,
      message: 'The vault closed as the session started.',
    })
    expect(t.cli.stop).toHaveBeenCalledWith(expect.anything(), 'launch00')
    expect(t.opened).toEqual([])
  })

  it('reports unconfirmed cleanup when terminal opening throws and stop fails', async () => {
    const t = setup()
    await t.attach()
    t.terminals.open = () => {
      throw new Error('PTY unavailable')
    }
    t.cli.stop.mockRejectedValueOnce(new Error('stop failed'))

    expect(await t.sessions.start({ prompt: 'Catch me up' })).toMatchObject({
      ok: false,
      message: 'Cleanup unconfirmed: session launch00 may still be running.',
      cleanupUnconfirmed: true,
      sessionId: 'launch00',
    })
    expect(t.cli.stop).toHaveBeenCalledWith(expect.anything(), 'launch00')
  })

  it('reports unconfirmed cleanup when stop resolves with a refusal', async () => {
    const t = setup()
    await t.attach()
    t.terminals.open = () => {
      throw new Error('PTY unavailable')
    }
    t.cli.stop.mockResolvedValueOnce({ ok: false, message: 'stop refused' })

    expect(await t.sessions.start({ prompt: 'Catch me up' })).toMatchObject({
      ok: false,
      message: 'Cleanup unconfirmed: session launch00 may still be running.',
      cleanupUnconfirmed: true,
      sessionId: 'launch00',
    })
    expect(t.cli.stop).toHaveBeenCalledWith(expect.anything(), 'launch00')
  })

  it('stops a background conversation when opening its terminal fails', async () => {
    const t = setup()
    await t.attach()
    t.terminals.open = () => ({ ok: false, message: 'terminal unavailable' })

    const result = await t.sessions.start({ prompt: 'Catch me up' })

    expect(result).toEqual({ ok: false, message: 'terminal unavailable' })
    expect(t.cli.stop).toHaveBeenCalledWith(expect.anything(), 'launch00')
    expect(t.sessions.sessions()).toEqual([])
  })
  it('rechecks revocation after attached ensure before native operation admission', async () => {
    const activation = new AbortController()
    const t = setup([row('aaaaaaaa')], undefined, ROOT, activation.signal)
    await t.attach()

    const operations = [
      () => t.sessions.open({ attach: 'aaaaaaaa' }),
      () => t.sessions.start({}),
      () => t.sessions.launch({ name: 'late', prompt: 'late' }),
      () => t.sessions.send({ text: 'late', target: 'new' }),
      () => t.sessions.stop('aaaaaaaa'),
      () => t.sessions.respawn('aaaaaaaa'),
      () => t.sessions.duplicate('aaaaaaaa'),
      () => t.sessions.message('aaaaaaaa', 'late'),
    ]
    const before = [
      t.cli.list,
      t.cli.startBg,
      t.cli.stop,
      t.cli.respawn,
      t.cli.forkBg,
      t.message,
    ].map((mock) => mock.mock.calls.length)
    const pending = operations.map((operation) => operation())
    activation.abort()
    const outcomes = await Promise.allSettled(pending)

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'rejected',
    ])
    expect(
      [t.cli.list, t.cli.startBg, t.cli.stop, t.cli.respawn, t.cli.forkBg, t.message].map(
        (mock) => mock.mock.calls.length,
      ),
    ).toEqual(before)
    expect(t.opened).toEqual([])
    expect(t.pastes).toEqual([])
  })

  it('lists only live sessions', async () => {
    const t = setup([row('aaaaaaaa'), row('bbbbbbbb', { pid: undefined, status: undefined })])
    await t.attach()

    expect(t.sessions.sessions().map((s) => s.id)).toEqual(['aaaaaaaa'])
    expect(t.sent.filter(([name]) => name === 'sessions').at(-1)).toEqual([
      'sessions',
      [
        {
          provider: 'claude',
          id: 'aaaaaaaa',
          name: 'Session aaaaaaaa',
          state: 'idle',
          conversationId: 'aaaaaaaa-uuid',
        },
      ],
    ])
  })

  it('tells the stopped sessions apart, for History', async () => {
    const t = setup([row('aaaaaaaa'), row('bbbbbbbb', { pid: undefined, status: undefined })])
    await t.attach()

    expect(t.sessions.past().map((s) => [s.id, s.state])).toEqual([['bbbbbbbb', 'idle']])
    expect(t.sent.find(([name]) => name === 'history')?.[1]).toEqual([
      expect.objectContaining({ id: 'bbbbbbbb', provider: 'claude', name: 'Session bbbbbbbb' }),
    ])
  })

  it('holds sync for a session found mid-turn when the vault opens', async () => {
    const t = setup([row('aaaaaaaa', { status: 'busy', state: 'working' })])
    await t.attach()
    expect(t.sessions.sessions()[0]?.state).toBe('working')
    expect(t.pauses).toEqual(['the assistant is working'])

    // It finished while nobody was listening: two idle readings let it go.
    t.setListing([row('aaaaaaaa', { status: 'idle' })])
    await t.sessions.refresh()
    await vi.waitFor(() => expect(t.sessions.sessions()[0]?.state).toBe('idle'))
  })

  it('takes the turn bracket from the hook, for this vault only', async () => {
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    t.sessions.noteTurn('someone/else', 'aaaaaaaa', true)
    expect(t.sessions.sessions()[0]?.state).toBe('idle')
    t.sessions.noteTurn(REMOTE, 'aaaaaaaa', true)
    expect(t.sessions.sessions()[0]?.state).toBe('working')
  })

  it("keeps a working session the listing lost while its process runs, by the hook's pid", async () => {
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    t.running.add(4242)
    // A turn from an id the listing does not name, as after a resume.
    t.sessions.noteTurn(REMOTE, 'bbbbbbbb', true, null, 4242)
    await t.sessions.refresh()
    expect(t.pauses).toEqual(['the assistant is working'])
    // Another start would take the pause again had the turn been forgotten.
    t.sessions.noteTurn(REMOTE, 'cccccccc', true)
    expect(t.pauses).toHaveLength(1)

    // Its process dies: the next reread lets it go.
    t.running.delete(4242)
    t.sessions.noteTurn(REMOTE, 'cccccccc', false)
    await t.sessions.refresh()
    t.sessions.noteTurn(REMOTE, 'dddddddd', true)
    expect(t.pauses).toHaveLength(2)
  })

  it("keeps the hook's pid when a listing read finishes with the previous process's row", async () => {
    const t = setup([row('aaaaaaaa', { status: 'busy', state: 'working', pid: 1111 })])
    await t.attach()
    t.running.add(2222)
    t.sessions.noteTurn(REMOTE, 'aaaaaaaa', true, null, 2222)
    await t.sessions.refresh()
    t.setListing([])
    await t.sessions.refresh()
    t.sessions.noteTurn(REMOTE, 'bbbbbbbb', true)
    expect(t.pauses).toHaveLength(1)
  })

  it('holds a turn on the listing pid when the process the hook reported has gone', async () => {
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    t.running.add(2222)
    t.sessions.noteTurn(REMOTE, 'aaaaaaaa', true, null, 1111)
    t.setListing([row('aaaaaaaa', { status: 'busy', state: 'working', pid: 2222 })])
    await t.sessions.refresh()
    t.setListing([])
    await t.sessions.refresh()
    t.sessions.noteTurn(REMOTE, 'bbbbbbbb', true)
    expect(t.pauses).toHaveLength(1)
  })

  it('follows the listing to a new process when no hook has reported one', async () => {
    const t = setup([row('aaaaaaaa', { status: 'busy', state: 'working', pid: 1111 })])
    await t.attach()
    t.running.add(2222)
    t.setListing([row('aaaaaaaa', { status: 'busy', state: 'working', pid: 2222 })])
    await t.sessions.refresh()
    t.setListing([])
    await t.sessions.refresh()
    t.sessions.noteTurn(REMOTE, 'bbbbbbbb', true)
    expect(t.pauses).toHaveLength(1)
  })

  it('forgets a working session the listing no longer names when no process is known', async () => {
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    // A hook older than the pid says none.
    t.sessions.noteTurn(REMOTE, 'bbbbbbbb', true)
    await t.sessions.refresh()
    t.sessions.noteTurn(REMOTE, 'cccccccc', true)
    expect(t.pauses).toHaveLength(2)
  })

  it('checks the process the listing named once the listing loses the session', async () => {
    const t = setup([row('aaaaaaaa', { status: 'busy', state: 'working', pid: 4343 })])
    t.running.add(4343)
    await t.attach()
    t.setListing([])
    await t.sessions.refresh()
    t.sessions.noteTurn(REMOTE, 'bbbbbbbb', true)
    expect(t.pauses).toHaveLength(1)
    t.running.delete(4343)
    t.sessions.noteTurn(REMOTE, 'bbbbbbbb', false)
    await t.sessions.refresh()
    t.sessions.noteTurn(REMOTE, 'cccccccc', true)
    expect(t.pauses).toHaveLength(2)
  })

  it('holds sync for a turn an outside driver brackets, which the listing never forgets', async () => {
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    t.sessions.bracket('p00000000000a', 'begin')
    expect(t.pauses).toEqual(['the assistant is working'])
    // The listing never names a bracketed id: a reread must not drop its
    // turn, or the next turn would take the pause a second time.
    await t.sessions.refresh()
    t.sessions.bracket('p00000000000b', 'begin')
    expect(t.pauses).toHaveLength(1)
    t.sessions.bracket('p00000000000a', 'end')
    t.sessions.bracket('p00000000000b', 'forget')
    t.sessions.bracket('p00000000000c', 'begin')
    expect(t.pauses).toHaveLength(2)
  })

  it("puts a session's context reading on its row, by job id and for this vault only", async () => {
    const t = setup([row('aaaaaaaa'), row('bbbbbbbb')])
    await t.attach()
    const status = (used: number | null) => ({
      model: { display_name: 'Opus 5.5' },
      context_window: { used_percentage: used },
    })

    t.sessions.noteStatus(REMOTE, 'aaaaaaaa', status(41.6))
    t.sessions.noteStatus('someone/else', 'bbbbbbbb', status(90))
    expect(t.sessions.sessions().map((s) => s.contextPercent)).toEqual([42, undefined])
    expect(t.sent.at(-1)?.[1]).toEqual(t.sessions.sessions())

    // `/clear` starts over: nothing to show until its first message.
    t.sessions.noteStatus(REMOTE, 'aaaaaaaa', status(null))
    expect(t.sessions.sessions()[0]?.contextPercent).toBeUndefined()

    // A stopped session's reading goes with it.
    t.sessions.noteStatus(REMOTE, 'bbbbbbbb', status(10))
    await t.sessions.stop('bbbbbbbb')
    t.setListing([row('aaaaaaaa'), row('bbbbbbbb')])
    await t.sessions.refresh()
    expect(t.sessions.sessions()[1]?.contextPercent).toBeUndefined()
  })

  it('messages a session through the inbox its hook reported, until it stops', async () => {
    const inbox = { socket: '/tmp/cc-socks/1.sock', token: 'abc123' }
    // Reported at SessionStart, before the listing shows the session.
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    t.sessions.noteChannel(REMOTE, 'cccccccc', inbox)
    t.sessions.noteChannel('someone/else', 'aaaaaaaa', inbox)
    await expect(t.sessions.message('aaaaaaaa', 'hi')).rejects.toThrow(/not said where/)

    t.setListing([row('aaaaaaaa'), row('cccccccc')])
    await t.sessions.refresh()
    await t.sessions.message('cccccccc', 'change the date')
    expect(t.message).toHaveBeenCalledWith(inbox, 'change the date', expect.any(AbortSignal))

    // Stopped: no longer running, and its inbox is forgotten with it.
    await t.sessions.stop('cccccccc')
    await expect(t.sessions.message('cccccccc', 'hi')).rejects.toThrow(/no running session/)
    t.setListing([row('aaaaaaaa'), row('cccccccc')])
    await t.sessions.refresh()
    await expect(t.sessions.message('cccccccc', 'hi')).rejects.toThrow(/not said where/)

    // A write that fails is not tried again until the session reports anew.
    t.sessions.noteChannel(REMOTE, 'aaaaaaaa', inbox)
    t.message.mockRejectedValueOnce(new Error('gone'))
    await expect(t.sessions.message('aaaaaaaa', 'hi')).rejects.toThrow('gone')
    await expect(t.sessions.message('aaaaaaaa', 'hi')).rejects.toThrow(/not said where/)
    expect(t.message).toHaveBeenCalledTimes(2)
  })

  it('stops a session: it leaves the list', async () => {
    const t = setup([row('aaaaaaaa'), row('bbbbbbbb')])
    await t.attach()
    expect(await t.sessions.stop('aaaaaaaa')).toEqual({ ok: true })
    expect(t.cli.stop).toHaveBeenCalledWith(
      { root: ROOT, configDir: '/cfg/vault', binDir: '/holi/bin' },
      'aaaaaaaa',
    )
    expect(t.sessions.sessions().map((s) => s.id)).toEqual(['bbbbbbbb'])
  })

  it('prints the sign-in notice into the first terminal only', async () => {
    const t = setup()
    await t.attach()
    await t.sessions.open({})
    await t.sessions.open({ attach: 'aaaaaaaa' })
    expect(t.opened[0]?.notice).toBe(SIGN_IN_NOTICE)
    expect(t.opened[1]?.notice).toBeUndefined()
    expect(t.opened[1]?.attach).toBe('aaaaaaaa')
  })

  it('sends an ask into the window Holi already has on that session, unsent', async () => {
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    const first = await t.sessions.send({ text: 'look', target: 'aaaaaaaa' })
    const second = await t.sessions.send({ text: 'again', target: 'aaaaaaaa' })
    expect(first).toEqual({ ok: true, terminalId: 'term-1' })
    expect(second).toEqual({ ok: true, terminalId: 'term-1' })
    expect(t.opened).toHaveLength(1)
    expect(t.pastes).toEqual([
      ['term-1', 'look'],
      ['term-1', 'again'],
    ])
  })

  it('starts a new session named from the ask, and pastes into it', async () => {
    const t = setup()
    await t.attach()
    const res = await t.sessions.send({ text: 'Tidy the inbox\nplease', target: 'new' })
    // The ask is the name; the CLI keeps its first line (`sessionName`).
    expect(t.cli.startBg).toHaveBeenCalledWith(expect.anything(), {
      name: 'Tidy the inbox\nplease',
    })
    expect(res.ok).toBe(true)
    expect(t.opened.at(-1)?.attach).toBe('newnew00')
    expect(t.pastes).toEqual([['term-1', 'Tidy the inbox\nplease']])
  })

  it('refuses an ask to a session that has ended', async () => {
    const t = setup([row('aaaaaaaa', { pid: undefined, status: undefined })])
    await t.attach()
    expect(await t.sessions.send({ text: 'x', target: 'aaaaaaaa' })).toEqual({
      ok: false,
      message: 'That session has ended. Pick another one.',
    })
    expect(t.pastes).toEqual([])
  })

  it('duplicates by the conversation id, named as a copy, and opens it', async () => {
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    const res = await t.sessions.duplicate('aaaaaaaa')
    expect(t.cli.forkBg).toHaveBeenCalledWith(
      expect.anything(),
      'aaaaaaaa-uuid',
      'Session aaaaaaaa (copy)',
    )
    expect(res).toEqual({ ok: true, sessionId: 'copy0000', terminalId: 'term-1' })
  })

  it('joins an established watcher read before leaving', async () => {
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    const list = t.cli.list.getMockImplementation()!
    let release!: () => void
    t.cli.list.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve))
      return list(...args)
    })
    t.notifyWatch()
    await vi.waitFor(() => expect(t.cli.list).toHaveBeenCalledTimes(2))
    let left = false
    const leaving = t.sessions.leave({ stopSessions: false }).then(() => {
      left = true
    })
    await Promise.resolve()
    expect(left).toBe(false)
    release()
    await leaving
    expect(left).toBe(true)
  })

  it('leaves: stops live sessions, closes windows', async () => {
    const t = setup([row('aaaaaaaa'), row('bbbbbbbb')])
    await t.attach()
    await t.sessions.leave()
    expect(t.cli.stop).toHaveBeenCalledTimes(2)
    expect(t.terminals.closeAll).toHaveBeenCalled()
    expect(t.sessions.sessions()).toEqual([])
    expect(t.sessions.past()).toEqual([])
    expect(t.sessions.watched('aaaaaaaa')).toBe(false)
  })

  it('leaving removes only the sessions Holi started empty that never had a turn', async () => {
    const t = setup([row('aaaaaaaa')]) // there before: never Holi's to remove
    await t.attach()
    await t.sessions.start({})
    await t.sessions.leave()
    expect(t.cli.rm).toHaveBeenCalledTimes(1)
    expect(t.cli.rm).toHaveBeenCalledWith(expect.anything(), 'newnew00')
  })

  it('leaving keeps a session Holi started empty once it has had a turn', async () => {
    const t = setup()
    await t.attach()
    await t.sessions.start({})
    t.sessions.noteTurn(REMOTE, 'newnew00', true)
    await t.sessions.leave()
    expect(t.cli.stop).toHaveBeenCalledWith(expect.anything(), 'newnew00')
    expect(t.cli.rm).not.toHaveBeenCalled()
  })

  it('can leave without stopping anything', async () => {
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    await t.sessions.leave({ stopSessions: false })
    expect(t.cli.stop).not.toHaveBeenCalled()
  })

  it('does nothing without a vault', async () => {
    const t = setup()
    expect(await t.sessions.open({})).toEqual({ ok: false, message: 'No vault is open.' })
  })
})

describe('Claude launch admission queue', () => {
  type Receipt = Awaited<ReturnType<ClaudeCli['startBg']>>
  const manualId = '1234abcd'
  const nextId = 'feedabcd'
  const source = 'abcdef12'
  const scheduled = {
    name: 'Inbox catch-up',
    prompt: 'Read mail',
    model: 'opus',
    allow: ['Read'],
    deny: ['WebFetch'],
    appendSystemPrompt: 'Summarise unread mail.',
    mcpConfig: '/cfg/mail.json',
  }

  it.each([
    ['start', true],
    ['fork', true],
    ['launch', true],
    ['start', false],
    ['fork', false],
    ['launch', false],
  ] as const)(
    'admits a queued %s before the first listing completes (retained: %s)',
    async (verb, retained) => {
      const t = setup([row(source, { pid: undefined, state: 'stopped' })])
      await t.attach()
      const firstReceipt = deferred<Receipt>()
      const listing = deferred<string>()
      const listingEntered = deferred<void>()
      const committing = deferred<void>()
      const firstLease = { commit: vi.fn(() => committing.promise), revoke: vi.fn(async () => {}) }
      const nextLease = { commit: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
      t.cli.list.mockImplementation(() => {
        listingEntered.resolve()
        return listing.promise
      })
      t.cli.startBg.mockReturnValueOnce(firstReceipt.promise)
      const nextCommand = verb === 'fork' ? t.cli.forkBg : t.cli.startBg
      nextCommand.mockResolvedValueOnce({
        ok: true,
        id: nextId,
        ...(retained ? { lease: nextLease } : {}),
      })

      const firstSettled = vi.fn((result: unknown) => result)
      const nextSettled = vi.fn((result: unknown) => result)
      const first = t.sessions.start({ name: 'Manual', prompt: 'hello' }).then(firstSettled)
      await vi.waitFor(() => expect(t.cli.startBg).toHaveBeenCalledTimes(1))
      const next = (
        verb === 'fork'
          ? t.sessions.duplicate(source)
          : verb === 'launch'
            ? t.sessions.launch(scheduled)
            : t.sessions.start({ name: 'Next' })
      ).then(nextSettled)
      await t.sessions.ensure()
      expect(nextSettled).not.toHaveBeenCalled()
      expect(t.cli.startBg).toHaveBeenCalledTimes(1)
      expect(t.cli.forkBg).not.toHaveBeenCalled()
      expect(t.cli.list).toHaveBeenCalledTimes(1)

      firstReceipt.resolve({ ok: true, id: manualId, ...(retained ? { lease: firstLease } : {}) })
      if (retained) {
        await vi.waitFor(() => expect(firstLease.commit).toHaveBeenCalledTimes(1))
        expect(t.cli.startBg).toHaveBeenCalledTimes(1)
        expect(t.cli.forkBg).not.toHaveBeenCalled()
        expect(t.cli.list).toHaveBeenCalledTimes(1)
        committing.resolve()
      }
      await listingEntered.promise
      await vi.waitFor(() => {
        expect(nextCommand).toHaveBeenCalledTimes(verb === 'fork' ? 1 : 2)
        expect(nextLease.commit).toHaveBeenCalledTimes(retained ? 1 : 0)
      })
      expect(firstLease.commit).toHaveBeenCalledTimes(retained ? 1 : 0)
      expect(firstSettled).not.toHaveBeenCalled()
      if (verb === 'launch') {
        expect(t.cli.startBg).toHaveBeenLastCalledWith(
          expect.objectContaining({ root: ROOT }),
          scheduled,
        )
      } else if (verb === 'fork') {
        expect(t.cli.forkBg).toHaveBeenCalledWith(
          expect.objectContaining({ root: ROOT }),
          `${source}-uuid`,
          `Session ${source} (copy)`,
        )
      }
      listing.resolve('[]')
      expect(await first).toEqual({ ok: true, sessionId: manualId, terminalId: 'term-1' })
      expect(await next).toEqual({
        ok: true,
        sessionId: nextId,
        ...(verb === 'launch' ? {} : { terminalId: 'term-2' }),
      })
      expect(t.opened.map((args) => args.attach)).toEqual(
        verb === 'launch' ? [manualId] : [manualId, nextId],
      )
      expect(firstLease.revoke).not.toHaveBeenCalled()
      expect(nextLease.revoke).not.toHaveBeenCalled()
      await t.sessions.leave()
      expect(t.cli.stop.mock.calls.map(([, id]) => id)).toEqual([manualId, nextId])
    },
  )

  it('rejects a queued collision with the pending owner before its listing completes', async () => {
    const t = setup()
    await t.attach()
    const firstReceipt = deferred<Receipt>()
    const listing = deferred<string>()
    const listingEntered = deferred<void>()
    const firstLease = { commit: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
    const secondLease = { commit: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
    t.cli.list.mockImplementation(() => {
      listingEntered.resolve()
      return listing.promise
    })
    t.cli.startBg
      .mockReturnValueOnce(firstReceipt.promise)
      .mockResolvedValueOnce({ ok: true, id: manualId, lease: secondLease })
    const first = t.sessions.launch({ name: 'Manual', prompt: 'go' })
    await vi.waitFor(() => expect(t.cli.startBg).toHaveBeenCalledTimes(1))
    const next = t.sessions.start({ name: 'Collision' })
    await t.sessions.ensure()
    expect(t.cli.startBg).toHaveBeenCalledTimes(1)

    firstReceipt.resolve({ ok: true, id: manualId, lease: firstLease })
    await listingEntered.promise
    await expect(next).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('already owned'),
    })
    expect(firstLease.commit).toHaveBeenCalledTimes(1)
    expect(firstLease.revoke).not.toHaveBeenCalled()
    expect(secondLease.commit).not.toHaveBeenCalled()
    expect(secondLease.revoke).toHaveBeenCalledTimes(1)
    expect(t.cli.stop).not.toHaveBeenCalled()
    expect(t.opened).toEqual([])
    listing.resolve('[]')
    await expect(first).resolves.toEqual({ ok: true, sessionId: manualId })
    await t.sessions.leave()
    expect(t.cli.stop).toHaveBeenCalledExactlyOnceWith(expect.anything(), manualId)
  })

  it.each([false, true])('rechecks the first receipt failure (uncertain: %s)', async (unknown) => {
    const t = setup()
    await t.attach()
    const firstReceipt = deferred<Receipt>()
    const lease = { revoke: vi.fn(async () => {}) }
    const error = new UnconfirmedOwnedProgramError(new Error('no proof of exit'), lease)
    const failure: Receipt = unknown
      ? { ok: false, cleanupUnconfirmed: true, message: error.message, error }
      : { ok: false, message: 'command failed after cleanup' }
    t.cli.startBg
      .mockReturnValueOnce(firstReceipt.promise)
      .mockResolvedValueOnce({ ok: true, id: nextId })
    const first = t.sessions.start({})
    await vi.waitFor(() => expect(t.cli.startBg).toHaveBeenCalledTimes(1))
    const next = t.sessions.launch(scheduled)
    await t.sessions.ensure()
    expect(t.cli.startBg).toHaveBeenCalledTimes(1)

    firstReceipt.resolve(failure)
    const result = await first
    expect(result).toEqual(failure)
    if (unknown) {
      expect(await next).toBe(result)
      expect(await t.sessions.launch(scheduled)).toBe(result)
      expect(t.cli.startBg).toHaveBeenCalledTimes(1)
      await expect(t.sessions.leave()).rejects.toMatchObject({ errors: [error] })
      expect(lease.revoke).toHaveBeenCalledTimes(1)
      expect(t.cli.stop).not.toHaveBeenCalled()
    } else {
      expect(await next).toEqual({ ok: true, sessionId: nextId })
      expect(t.cli.startBg).toHaveBeenLastCalledWith(expect.anything(), scheduled)
      await t.sessions.leave()
    }
  })
})

describe('launched sessions', () => {
  it('start with their options and no terminal', async () => {
    const { sessions, cli, opened, attach } = setup()
    await attach()
    const args = { name: 'Tidy', prompt: 'tidy the inbox', model: 'opus', deny: ['WebFetch'] }
    expect(await sessions.launch(args)).toEqual({ ok: true, sessionId: 'launch00' })
    expect(cli.startBg).toHaveBeenCalledWith(expect.anything(), args)
    expect(opened).toEqual([])
    expect(sessions.sessions()).toEqual([expect.objectContaining({ id: 'launch00' })])
  })

  it('latches an unidentifiable late creation receipt as a sticky drain failure', async () => {
    const activation = new AbortController()
    const t = setup([], undefined, ROOT, activation.signal)
    await t.attach()
    type Receipt = Awaited<ReturnType<ClaudeCli['startBg']>>
    const receipt = deferred<Receipt>()
    t.cli.startBg.mockReturnValueOnce(receipt.promise)
    const error = new Error('Could not parse late CLI receipt.')

    const launching = t.sessions.launch({ name: 'Unparsed', prompt: 'run' })
    await vi.waitFor(() => expect(t.cli.startBg).toHaveBeenCalled())
    activation.abort()
    const failure = {
      ok: false,
      message: error.message,
      cleanupUnconfirmed: true,
      missingProviderReceipt: true,
      error,
    } as const
    receipt.resolve(failure)
    expect(await launching).toEqual(failure)
    await expect(t.sessions.leave()).rejects.toThrow(/teardown failed/)
    let repeatedFailure: unknown
    try {
      await t.sessions.leave()
    } catch (error) {
      repeatedFailure = error
    }
    expect(repeatedFailure).toBeDefined()
    await expect(t.sessions.launch({ name: 'replacement', prompt: 'replace' })).rejects.toThrow()
    expect(t.cli.stop).not.toHaveBeenCalled()
    expect(t.cli.startBg).toHaveBeenCalledTimes(1)
  })

  it('retains late-launch cleanup failures through repeated leave', async () => {
    const { sessions, cli, attach } = setup()
    await attach()
    const started = cli.startBg.getMockImplementation()!
    let release!: () => void
    cli.startBg.mockImplementationOnce(async (t, opts) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return started(t, opts)
    })
    const launching = sessions.launch({ name: 'Go', prompt: 'go' })
    await vi.waitFor(() => expect(cli.startBg).toHaveBeenCalled())
    const leaving = sessions.leave()
    cli.stop.mockResolvedValueOnce({ ok: false, message: 'stop refused' })
    release()
    expect(await launching).toMatchObject({
      ok: false,
      message: 'Cleanup unconfirmed: session launch00 may still be running.',
      cleanupUnconfirmed: true,
      sessionId: 'launch00',
    })
    await expect(leaving).rejects.toThrow(/teardown failed/)
    await expect(sessions.leave()).rejects.toThrow(/teardown failed/)
  })

  it('rejects every async operation after leave without invoking adapters', async () => {
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    await t.sessions.leave()
    const calls = [
      t.cli.list,
      t.cli.startBg,
      t.cli.stop,
      t.cli.respawn,
      t.cli.forkBg,
      t.message,
    ].map((mock) => mock.mock.calls.length)
    const outcomes = await Promise.allSettled([
      t.sessions.ensure(),
      t.sessions.refresh(),
      t.sessions.open({}),
      t.sessions.start({}),
      t.sessions.launch({ name: 'late', prompt: 'late' }),
      t.sessions.send({ text: 'late', target: 'new' }),
      t.sessions.stop('aaaaaaaa'),
      t.sessions.respawn('aaaaaaaa'),
      t.sessions.duplicate('aaaaaaaa'),
      t.sessions.noteTurn(REMOTE, 'aaaaaaaa', true),
      t.sessions.message('aaaaaaaa', 'late'),
    ])
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true)
    expect(
      [t.cli.list, t.cli.startBg, t.cli.stop, t.cli.respawn, t.cli.forkBg, t.message].map(
        (mock) => mock.mock.calls.length,
      ),
    ).toEqual(calls)
    expect(t.sessions.sessions()).toEqual([])
    expect(t.sessions.past()).toEqual([])
    expect(t.sessions.watched('aaaaaaaa')).toBe(false)
    expect(() => t.sessions.setFocus({ focusedPath: null, openPaths: [] })).not.toThrow()
    expect(t.sessions.bracket('late', 'begin')).toBeUndefined()
    expect(t.sessions.bracket('late', 'end')).toBeNull()
  })

  it('aborts an admitted message socket and drains it before leave resolves', async () => {
    const inbox = { socket: '/tmp/cc-socks/1.sock', token: 'abc123' }
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    t.sessions.noteChannel(REMOTE, 'aaaaaaaa', inbox)
    let observedSignal: AbortSignal | undefined
    let complete!: () => void
    t.message.mockImplementation((_channel, _text, signal) => {
      observedSignal = signal
      return new Promise<void>((resolve) => {
        complete = resolve
      })
    })
    const sending = t.sessions.message('aaaaaaaa', 'hello')
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    let leaveSettled = false
    const leaving = t.sessions.leave().finally(() => {
      leaveSettled = true
    })
    expect(observedSignal?.aborted).toBe(true)
    await Promise.resolve()
    expect(leaveSettled).toBe(false)
    complete()
    await expect(sending).rejects.toThrow(/vault was left/)
    await leaving
  })

  it('are stopped when the vault closes as they start', async () => {
    const { sessions, cli, attach } = setup()
    await attach()
    const started = cli.startBg.getMockImplementation()!
    let release = () => {}
    cli.startBg.mockImplementationOnce(async (t, opts) => {
      await new Promise<void>((r) => (release = r))
      return started(t, opts)
    })
    const launching = sessions.launch({ name: 'Go', prompt: 'go' })
    await vi.waitFor(() => expect(cli.startBg).toHaveBeenCalled())
    let leaveSettled = false
    const leaving = sessions.leave().finally(() => {
      leaveSettled = true
    })
    await Promise.resolve()
    expect(leaveSettled).toBe(false)
    release()
    await leaving
    expect(await launching).toEqual({
      ok: false,
      message: 'The vault closed as the session started.',
    })
    expect(cli.stop).toHaveBeenCalledWith(expect.anything(), 'launch00')
  })
})

describe('retained Claude ownership across session admission', () => {
  type Callback = Parameters<typeof execProgram>[3]
  type Reply = Parameters<Callback>
  const id = '1234abcd'
  const source = 'abcdef12'
  const receipt = `backgrounded · ${id} · new run\n`
  const proofError = new Error('native proof was lost')
  const commandError = Object.assign(new Error('first command failure'), { cmd: 'claude' })

  function native(
    activation?: AbortSignal,
    root = ROOT,
    remote = REMOTE,
    takeFirstSpawn?: () => Promise<boolean>,
  ) {
    let listing = [row(source, { cwd: root })]
    const jobs = vi.fn<(args: readonly string[], done: Callback, cwd?: string) => void>(
      (args, done) => {
        if (args[0] === 'agents') done(null, JSON.stringify(listing), '', { kind: 'settled' })
        else done(null, '', '', { kind: 'settled' })
      },
    )
    const cli = createClaudeCli({
      platform: 'win32',
      resolveBin: () => 'claude.cmd',
      execProgram: (_bin, args, options, done) => {
        jobs(args, done, options.cwd)
        return new ChildProcess()
      },
    })
    const host = setup([], cli, root, activation, remote, takeFirstSpawn)
    function respond(verb: string, reply: () => Reply | Promise<Reply>) {
      const normal = jobs.getMockImplementation()!
      jobs.mockImplementation((args, done, cwd) => {
        if (args[0] !== verb) normal(args, done, cwd)
        else void Promise.resolve(reply()).then((result) => done(...result))
      })
    }
    return {
      ...host,
      jobs,
      respond,
      listing(rows: Row[]) {
        listing = rows.map((item) => ({ ...item, cwd: root }))
      },
      calls: (verb: string) => jobs.mock.calls.filter(([args]) => args[0] === verb),
    }
  }

  it('keeps verified rows, blocks new probes and starts, and drains the original listing lease', async () => {
    const t = native()
    const probe = deferred<Reply>()
    const drained = deferred<void>()
    const lease = { revoke: vi.fn(() => drained.promise) }
    const error = Object.assign(new UnconfirmedOwnedProgramError(proofError, lease, commandError), {
      cmd: 'claude',
    })
    t.listing([row(source), row(id), row('aaaaaaaa', { pid: undefined })])
    await t.attach()
    const live = t.sessions.sessions()
    const past = t.sessions.past()
    t.respond('agents', () => probe.promise)
    const refresh = t.sessions.refresh()
    const queued = t.sessions.refresh()
    probe.resolve([error, '[]', 'EMPTY', { kind: 'unconfirmed', cause: proofError, lease }])
    await vi.waitFor(() => expect(lease.revoke).toHaveBeenCalledTimes(1))
    expect(t.sessions.sessions()).toEqual(live)
    expect(t.sessions.past()).toEqual(past)
    const blocked = await t.sessions.launch({ name: 'replacement', prompt: 'try again' })
    expect(blocked).toMatchObject({ ok: false, cleanupUnconfirmed: true, error })
    expect(await t.sessions.start({})).toBe(blocked)
    expect(await t.sessions.duplicate(source)).toBe(blocked)
    expect(await t.sessions.respawn(source)).toBe(blocked)
    expect(await t.sessions.stop('bbbbbbbb')).toBe(blocked)
    drained.reject(new Error('later revoke failure'))
    await Promise.all([refresh, queued])
    await t.sessions.refresh()
    t.notifyWatch()
    await expect(t.sessions.stop(id)).resolves.toEqual({ ok: true })
    expect(t.calls('agents')).toHaveLength(2)
    expect(t.calls('--bg')).toHaveLength(0)
    expect(t.calls('respawn')).toHaveLength(0)
    const teardown = await t.sessions.leave().catch((cause: unknown) => cause)
    expect(teardown).toBeInstanceOf(AggregateError)
    expect((teardown as AggregateError).errors[0]).toBe(error)
    expect((teardown as AggregateError).errors).toHaveLength(1)
    await expect(t.sessions.leave()).rejects.toBe(teardown)
    expect(t.calls('stop').map(([args]) => args)).toEqual([
      ['stop', id],
      ['stop', source],
    ])
    expect(lease.revoke).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'retains inventory on settled nonzero, but honors a later verified empty listing: %s',
    async (applyEmpty) => {
      const t = native()
      await t.attach()
      const expected = t.sessions.sessions()
      t.respond('agents', () => [commandError, '[]', 'EMPTY', { kind: 'settled' }])
      await t.sessions.refresh()
      expect(t.sessions.sessions()).toEqual(expected)
      if (applyEmpty) {
        t.respond('agents', () => [null, '[]', '', { kind: 'settled' }])
        await t.sessions.refresh()
        expect(t.sessions.sessions()).toEqual([])
      }
      await expect(t.sessions.leave()).resolves.toBeUndefined()
      expect(t.calls('stop').map(([args]) => args)).toEqual(applyEmpty ? [] : [['stop', source]])
    },
  )

  it.each([
    ['pid', { pid: '100' }],
    ['status', { status: true }],
    ['schema', { kind: undefined }],
  ] as const)(
    'keeps the last verified rows and stops the known owner after malformed %s',
    async (_field, invalid) => {
      const t = native()
      t.listing([row(source), row('aaaaaaaa', { pid: undefined, status: undefined })])
      await t.attach()
      const live = t.sessions.sessions()
      const history = t.sessions.past()
      const events = t.sent.slice()
      // Neither the good row nor the malformed one can replace the snapshot.
      t.respond('agents', () => [
        null,
        JSON.stringify([row(id), row(source, invalid)]),
        'EMPTY',
        { kind: 'settled' },
      ])
      await t.sessions.refresh()
      expect(t.sessions.sessions()).toEqual(live)
      expect(t.sessions.past()).toEqual(history)
      expect(t.sent).toEqual(events)
      await expect(t.sessions.leave()).resolves.toBeUndefined()
      expect(t.calls('stop').map(([args]) => args)).toEqual([['stop', source]])
    },
  )

  it('accepts later valid snapshots and an empty listing without losing a still-pending commit', async () => {
    const t = native()
    const lease = { commit: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
    t.respond('--bg', () => [null, receipt, '', { kind: 'settled', lease }])
    await t.attach()
    t.listing([row(source, { pid: '100' }), row(id)])
    await expect(t.sessions.launch({ name: 'new run', prompt: 'go' })).resolves.toEqual({
      ok: true,
      sessionId: id,
    })
    expect(t.sessions.sessions()).toEqual([expect.objectContaining({ id: source })])
    t.listing([row(source, { name: 'updated' }), row(id, { pid: undefined, status: undefined })])
    await t.sessions.refresh()
    expect(t.sessions.sessions()).toEqual([
      expect.objectContaining({ id: source, name: 'updated' }),
    ])
    expect(t.sessions.past()).toEqual([expect.objectContaining({ id })])
    t.listing([])
    await t.sessions.refresh()
    expect(t.sessions.sessions()).toEqual([])
    expect(t.sessions.past()).toEqual([])
    await t.sessions.leave()
    expect(t.calls('stop').map(([args]) => args)).toEqual([['stop', id]])
    expect(lease.commit).toHaveBeenCalledTimes(1)
    expect(lease.revoke).not.toHaveBeenCalled()
  })

  it('rejects a malformed snapshot supplied by a raw listing adapter', async () => {
    const t = setup([row(source)])
    await t.attach()
    t.setListing([row(source, { pid: null })])
    await t.sessions.refresh()
    expect(t.sessions.sessions()).toEqual([expect.objectContaining({ id: source })])
    expect(t.sessions.past()).toEqual([])
    await expect(t.sessions.leave()).resolves.toBeUndefined()
    expect(t.cli.stop).toHaveBeenCalledExactlyOnceWith(expect.anything(), source)
  })

  it('does not re-add a stopped id from a read that crossed the stop', async () => {
    const t = native()
    await t.attach()
    const stale = deferred<Reply>()
    t.respond('agents', () =>
      t.calls('agents').length === 2
        ? stale.promise
        : [commandError, '[]', 'EMPTY', { kind: 'settled' }],
    )
    const refresh = t.sessions.refresh()
    const stopping = t.sessions.stop(source)
    await vi.waitFor(() => expect(t.calls('stop')).toHaveLength(1))
    stale.resolve([null, JSON.stringify([row(source)]), '', { kind: 'settled' }])
    await refresh
    await expect(stopping).resolves.toEqual({ ok: true })
    expect(t.calls('agents')).toHaveLength(3)
    await t.sessions.leave()
    expect(t.calls('stop')).toHaveLength(1)
  })

  it('includes a committed session in shutdown when its first listing fails', async () => {
    const t = native()
    await t.attach()
    const lease = { commit: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
    t.respond('--bg', () => [null, receipt, '', { kind: 'settled', lease }])
    t.respond('agents', () => [commandError, '[]', 'EMPTY', { kind: 'settled' }])
    await expect(t.sessions.launch({ name: 'new run', prompt: 'go' })).resolves.toEqual({
      ok: true,
      sessionId: id,
    })
    expect(t.sessions.sessions().map(({ id }) => id)).toEqual([source])
    await t.sessions.leave()
    expect(t.calls('stop').map(([args]) => args)).toEqual([
      ['stop', source],
      ['stop', id],
    ])
    expect(lease.commit).toHaveBeenCalledTimes(1)
    expect(lease.revoke).not.toHaveBeenCalled()
  })

  it.each(['start', 'fork', 'respawn'] as const)(
    'stops a successful %s on leave even when the immediate listing is empty',
    async (verb) => {
      const t = native()
      const lease = { commit: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
      t.respond(verb === 'respawn' ? 'respawn' : '--bg', () => {
        t.listing([])
        return verb === 'respawn'
          ? [null, '', '', { kind: 'settled' }]
          : [null, receipt, '', { kind: 'settled', lease }]
      })
      if (verb === 'respawn') t.listing([row(source, { pid: undefined, state: 'stopped' })])
      await t.attach()
      const result = await (verb === 'respawn'
        ? t.sessions.respawn(source)
        : verb === 'fork'
          ? t.sessions.duplicate(source)
          : t.sessions.start({ prompt: 'go' }))
      expect(result).toMatchObject(verb === 'respawn' ? { ok: true } : { ok: true, sessionId: id })
      expect(t.sessions.sessions()).toEqual([])
      expect(t.calls('agents')).toHaveLength(2)
      if (verb !== 'start') {
        await t.sessions.refresh()
        await t.sessions.refresh()
      }
      await t.sessions.leave()
      expect(t.calls('stop').map(([args, , cwd]) => [args, cwd])).toEqual([
        [['stop', verb === 'respawn' ? source : id], ROOT],
      ])
      expect(lease.commit).toHaveBeenCalledTimes(verb === 'respawn' ? 0 : 1)
      expect(lease.revoke).not.toHaveBeenCalled()
    },
  )

  it.each([false, true])(
    'transfers a pending id only after a live listing observation: %s',
    async (observedLive) => {
      const t = native()
      const lease = { commit: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
      t.respond('--bg', () => [null, receipt, '', { kind: 'settled', lease }])
      t.listing([])
      await t.attach()
      expect(await t.sessions.launch({ name: 'owned', prompt: 'go' })).toMatchObject({ ok: true })
      t.listing([row(id, { pid: undefined, state: 'stopped' })])
      await t.sessions.refresh()
      expect(t.sessions.past()).toEqual([expect.objectContaining({ id })])
      if (observedLive) {
        t.listing([row(id)])
        await t.sessions.refresh()
        expect(t.sessions.sessions()).toEqual([expect.objectContaining({ id })])
      }
      t.listing([])
      await t.sessions.refresh()
      expect(t.sessions.sessions()).toEqual([])
      expect(t.sessions.past()).toEqual([])
      await t.sessions.leave()
      expect(t.calls('stop').map(([args]) => args)).toEqual(observedLive ? [] : [['stop', id]])
    },
  )

  it.each(['refused', 'unconfirmed', 'empty'] as const)(
    'uses native stop proof, not empty listings, to evict a pending id: %s',
    async (proof) => {
      const t = native()
      const lease = { commit: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
      const stopLease = { revoke: vi.fn(async () => {}) }
      t.respond('--bg', () => [null, receipt, '', { kind: 'settled', lease }])
      t.respond('stop', () => {
        if (proof === 'unconfirmed')
          return [
            commandError,
            '',
            'EMPTY',
            { kind: 'unconfirmed', cause: proofError, lease: stopLease },
          ]
        if (proof === 'refused' && t.calls('stop').length === 1)
          return [commandError, '', 'refused', { kind: 'settled' }]
        return [null, '', '', { kind: 'settled' }]
      })
      t.listing([])
      await t.attach()
      expect(await t.sessions.launch({ name: 'owned', prompt: 'go' })).toMatchObject({ ok: true })
      const stopped = await t.sessions.stop(id)
      expect(stopped.ok).toBe(proof === 'empty')
      await t.sessions.refresh()
      if (proof === 'unconfirmed') {
        expect(stopped).toMatchObject({
          ok: false,
          cleanupUnconfirmed: true,
          sessionId: id,
          error: { lease: stopLease, cause: proofError },
        })
        expect(await t.sessions.stop(id)).toBe(stopped)
        await expect(t.sessions.leave()).rejects.toMatchObject({
          errors: [!stopped.ok && stopped.error],
        })
      } else await t.sessions.leave()
      expect(t.calls('stop').map(([args]) => args)).toEqual(
        proof === 'refused'
          ? [
              ['stop', id],
              ['stop', id],
            ]
          : [['stop', id]],
      )
      expect(stopLease.revoke).toHaveBeenCalledTimes(proof === 'unconfirmed' ? 1 : 0)
      expect(lease.revoke).not.toHaveBeenCalled()
    },
  )

  it('joins a late listing failure on the revoked activation without changing another vault or a new A', async () => {
    const activation = new AbortController()
    const a = native(activation.signal)
    const b = native(undefined, '/other', 'syv/other')
    const nextA = native()
    const probe = deferred<Reply>()
    const drained = deferred<void>()
    const lease = { revoke: vi.fn(() => drained.promise) }
    const error = Object.assign(new UnconfirmedOwnedProgramError(proofError, lease, commandError), {
      cmd: 'claude',
    })
    await a.attach()
    a.respond('agents', () => probe.promise)
    a.notifyWatch()
    activation.abort()
    const left = vi.fn()
    const leaving = a.sessions.leave().catch((cause: unknown) => {
      left()
      return cause
    })
    b.listing([row(source, { name: 'B' })])
    nextA.listing([row(source, { name: 'new A' })])
    await Promise.all([b.attach(), nextA.attach()])
    const events = a.sent.slice()
    probe.resolve([error, '[]', '', { kind: 'unconfirmed', cause: proofError, lease }])
    await vi.waitFor(() => expect(lease.revoke).toHaveBeenCalledTimes(1))
    expect(left).not.toHaveBeenCalled()
    expect(a.sent).toEqual(events)
    for (const [t, name] of [
      [b, 'B'],
      [nextA, 'new A'],
    ] as const) {
      expect(t.sessions.sessions()).toEqual([expect.objectContaining({ id: source, name })])
      await expect(t.sessions.respawn(source)).resolves.toEqual({ ok: true })
      expect(t.calls('stop')).toHaveLength(0)
    }
    drained.resolve()
    const teardown = await leaving
    expect(teardown).toBeInstanceOf(AggregateError)
    expect((teardown as AggregateError).errors[0]).toBe(error)
    expect(a.calls('stop').map(([args]) => args)).toEqual([['stop', source]])
    expect(lease.revoke).toHaveBeenCalledTimes(1)
    await Promise.all([
      b.sessions.leave({ stopSessions: false }),
      nextA.sessions.leave({ stopSessions: false }),
    ])
  })

  it.each(['start', 'fork'] as const)(
    'does not act on the printed id of an uncertain %s',
    async (verb) => {
      const t = native()
      const lease = {
        revoke: vi.fn(async () => {
          throw new Error('revoke unconfirmed')
        }),
      }
      t.respond('--bg', () => [
        commandError,
        receipt,
        'EMPTY',
        { kind: 'unconfirmed', cause: proofError, lease },
      ])
      await t.attach()
      const result = await (verb === 'start' ? t.sessions.start({}) : t.sessions.duplicate(source))
      expect(result).toMatchObject({ ok: false, cleanupUnconfirmed: true })
      expect(result).not.toHaveProperty('sessionId')
      if (result.ok) throw new Error('Expected an unconfirmed launch')
      const failure = result.error
      expect(failure).toBeInstanceOf(UnconfirmedOwnedProgramError)
      expect(failure?.cause).toBe(proofError)
      expect(failure).toHaveProperty('commandError', commandError)
      expect(failure).toHaveProperty('lease', lease)
      expect(t.opened).toEqual([])
      t.listing([row(source), row(id)])
      await t.sessions.refresh()
      expect(t.sessions.sessions()).toEqual([expect.objectContaining({ id: source })])
      expect(await t.sessions.launch({ name: 'retry', prompt: 'retry' })).toBe(result)
      expect(await t.sessions.duplicate(source)).toBe(result)
      expect(await t.sessions.stop(id)).toBe(result)
      expect(await t.sessions.respawn(id)).toBe(result)
      expect(t.calls('--bg')).toHaveLength(1)
      expect(t.calls('stop')).toHaveLength(0)
      expect(t.calls('respawn')).toHaveLength(0)
      const drain = await t.sessions.leave().catch((error: unknown) => error)
      expect(drain).toMatchObject({ errors: [failure] })
      await expect(t.sessions.leave()).rejects.toBe(drain)
      expect(lease.revoke).toHaveBeenCalledTimes(1)
      expect(t.calls('stop').map(([args]) => args)).toEqual([['stop', source]])
    },
  )

  it.each([source, id])(
    'ignores an uncertain adapter candidate %s without dropping a known owner',
    async (candidate) => {
      const t = setup([row(source)])
      const lease = { revoke: vi.fn(async () => {}) }
      const error = new UnconfirmedOwnedProgramError(proofError, lease, commandError)
      t.cli.startBg.mockImplementation(async () => ({
        ok: false,
        cleanupUnconfirmed: true,
        error,
        message: error.message,
        id: candidate,
      }))
      await t.attach()
      await expect(t.sessions.launch({ name: 'failed', prompt: 'go' })).resolves.toEqual({
        ok: false,
        cleanupUnconfirmed: true,
        error,
        message: error.message,
      })
      t.setListing([row(source), row(id)])
      await t.sessions.refresh()
      expect(t.sessions.sessions()).toEqual([expect.objectContaining({ id: source })])
      await expect(t.sessions.leave()).rejects.toMatchObject({ errors: [error] })
      expect(lease.revoke).toHaveBeenCalledTimes(1)
      expect(t.cli.stop).toHaveBeenCalledExactlyOnceWith(expect.anything(), source)
    },
  )

  it('drains a late failed Windows launch with a partial existing id on its original activation only', async () => {
    const activation = new AbortController()
    const a = native(activation.signal)
    const b = native(undefined, '/other', 'syv/other')
    const entered = deferred<void>()
    const output = deferred<Reply>()
    const draining = deferred<void>()
    const lease = { revoke: vi.fn(() => draining.promise) }
    const error = Object.assign(new UnconfirmedOwnedProgramError(proofError, lease, commandError), {
      cmd: 'claude',
    })
    a.respond('--bg', () => {
      entered.resolve()
      return output.promise
    })
    b.listing([row(source, { name: 'B' })])
    await Promise.all([a.attach(), b.attach()])
    const starting = a.sessions.start({})
    await entered.promise
    activation.abort()
    const finished = vi.fn()
    const leaving = a.sessions.leave().catch((cause: unknown) => {
      finished()
      return cause
    })
    output.resolve([
      error,
      `backgrounded · ${source}`,
      '',
      { kind: 'unconfirmed', cause: proofError, lease },
    ])
    await vi.waitFor(() => expect(lease.revoke).toHaveBeenCalledTimes(1))
    expect(finished).not.toHaveBeenCalled()
    expect(a.calls('stop')).toHaveLength(0)
    expect(a.opened).toEqual([])
    expect(b.sessions.sessions()).toEqual([expect.objectContaining({ id: source, name: 'B' })])
    expect(b.calls('stop')).toHaveLength(0)
    draining.resolve()
    await expect(starting).resolves.toEqual({
      ok: false,
      cleanupUnconfirmed: true,
      error,
      message: error.message,
    })
    expect(await leaving).toMatchObject({ errors: [error] })
    expect(a.calls('stop').map(([args, , cwd]) => [args, cwd])).toEqual([[['stop', source], ROOT]])
    expect(lease.revoke).toHaveBeenCalledTimes(1)
    await b.sessions.leave()
    expect(b.calls('stop').map(([args, , cwd]) => [args, cwd])).toEqual([
      [['stop', source], '/other'],
    ])
  })

  it.each(['stop', 'respawn'] as const)(
    'retains the first uncertain %s without issuing another command',
    async (verb) => {
      const t = native()
      const lease = {
        revoke: vi.fn(async () => {
          throw proofError
        }),
      }
      t.respond(verb, () => [
        commandError,
        '',
        'everything exited',
        { kind: 'unconfirmed', cause: proofError, lease },
      ])
      await t.attach()
      const result = await t.sessions[verb](source)
      expect(result).toMatchObject({ cleanupUnconfirmed: true, sessionId: source })
      expect(await t.sessions.stop(source)).toBe(result)
      expect(await t.sessions.respawn(source)).toBe(result)
      expect(t.calls(verb)).toHaveLength(1)
      await expect(t.sessions.leave()).rejects.toMatchObject({
        errors: [!result.ok && result.error],
      })
      expect(t.calls(verb)).toHaveLength(1)
      expect(lease.revoke).toHaveBeenCalledTimes(1)
    },
  )

  it('joins the exact lease on a stop failure after a cancelled respawn without touching another vault', async () => {
    const activation = new AbortController()
    const t = native(activation.signal)
    const b = native(undefined, '/other', 'syv/other')
    const entered = deferred<void>()
    const respawn = deferred<Reply>()
    const revoke = deferred<void>()
    const lease = { revoke: vi.fn(() => revoke.promise) }
    t.respond('respawn', () => {
      entered.resolve()
      return respawn.promise
    })
    t.respond('stop', () => [
      commandError,
      '',
      'complete',
      { kind: 'unconfirmed', cause: proofError, lease },
    ])
    b.listing([row(source, { name: 'B' })])
    await Promise.all([t.attach(), b.attach()])
    const operating = t.sessions.respawn(source)
    await entered.promise
    activation.abort()
    const untracked = vi.fn()
    const leaving = t.sessions
      .leave()
      .catch((error: unknown) => error)
      .then((outcome) => {
        untracked()
        return outcome
      })
    respawn.resolve([null, '', '', { kind: 'settled' }])
    await vi.waitFor(() => expect(lease.revoke).toHaveBeenCalledTimes(1))
    expect(untracked).not.toHaveBeenCalled()
    revoke.reject(new Error('second failure'))
    const result = await operating
    expect(result).toMatchObject({ ok: false, cleanupUnconfirmed: true, sessionId: source })
    if (result.ok) throw new Error('Expected late stop uncertainty')
    expect(result.error?.cause).toBe(proofError)
    expect(result.error).toHaveProperty('lease', lease)
    expect(await leaving).toMatchObject({ errors: [result.error] })
    expect(t.calls('stop').map(([args, , cwd]) => [args, cwd])).toEqual([[['stop', source], ROOT]])
    expect(b.sessions.sessions()).toEqual([expect.objectContaining({ id: source, name: 'B' })])
    expect(b.calls('stop')).toHaveLength(0)
    await b.sessions.leave()
    expect(b.calls('stop').map(([args, , cwd]) => [args, cwd])).toEqual([
      [['stop', source], '/other'],
    ])
  })

  it.each([false, true])(
    'rejects conflicting retained ids without touching the old owner (unknown: %s)',
    async (unknown) => {
      const t = native()
      const lease = {
        commit: vi.fn(async () => {}),
        revoke: vi.fn(async () => {
          if (unknown) throw proofError
        }),
      }
      t.respond('--bg', () => [
        null,
        `{"prelude":true}\r\nbackgrounded · ${source} · Existing\r\n${receipt}`,
        '',
        { kind: 'settled', lease },
      ])
      await t.attach()
      const result = await t.sessions.start({})
      expect(result).toMatchObject({ ok: false })
      expect(result).not.toHaveProperty('sessionId')
      expect(t.opened).toEqual([])
      expect(t.calls('stop')).toEqual([])
      expect(t.sessions.sessions().map((row) => row.id)).toEqual([source])
      if (unknown) {
        if (result.ok) throw new Error('Expected a revocation failure')
        expect(result.error).toBeInstanceOf(UnconfirmedOwnedProgramError)
        expect(result.error).toMatchObject({
          cause: proofError,
          lease,
          commandError: { message: expect.stringContaining('unambiguous') },
        })
        t.listing([row(id)])
        await t.sessions.refresh()
        expect(t.sessions.sessions().map((row) => row.id)).toEqual([source])
        await expect(t.sessions.leave()).rejects.toMatchObject({ errors: [result.error] })
      } else {
        expect(result).not.toHaveProperty('cleanupUnconfirmed')
        await t.sessions.leave()
      }
      expect(lease.commit).not.toHaveBeenCalled()
      expect(lease.revoke).toHaveBeenCalledTimes(1)
      expect(t.calls('stop').map(([args]) => args)).toEqual([['stop', source]])
    },
  )

  it.each(['listed', 'pending', 'uncertain'] as const)(
    'revokes only the new lease for an injected adapter collision with a %s owner',
    async (owner) => {
      const t = setup(owner === 'listed' ? [row(source)] : [])
      const oldLease = { revoke: vi.fn(async () => {}) }
      const oldError = new UnconfirmedOwnedProgramError(proofError, oldLease)
      const lease = {
        commit: vi.fn(async () => {}),
        revoke: vi.fn(async () => {
          throw proofError
        }),
      }
      await t.attach()
      if (owner === 'pending') await t.sessions.respawn(source)
      if (owner === 'uncertain') {
        t.cli.stop.mockResolvedValueOnce({
          ok: false,
          cleanupUnconfirmed: true,
          message: oldError.message,
          error: oldError,
        })
        await t.sessions.stop(source)
        t.cli.stop.mockClear()
      }
      t.cli.startBg.mockResolvedValueOnce({ ok: true, id: source, lease })
      const result = await t.sessions.start({})
      expect(result).toMatchObject({ ok: false, cleanupUnconfirmed: true })
      expect(result).not.toHaveProperty('sessionId')
      if (result.ok) throw new Error('Expected rejection of the occupied id')
      expect(result.error).toMatchObject({
        cause: proofError,
        lease,
        commandError: { message: expect.stringContaining('already owned') },
      })
      expect(t.opened).toEqual([])
      expect(t.cli.stop).not.toHaveBeenCalled()
      await expect(t.sessions.leave()).rejects.toMatchObject({
        errors: owner === 'uncertain' ? [oldError, result.error] : [result.error],
      })
      if (owner === 'uncertain') {
        expect(oldLease.revoke).toHaveBeenCalledTimes(1)
        expect(t.cli.stop).not.toHaveBeenCalled()
      } else {
        expect(oldLease.revoke).not.toHaveBeenCalled()
        expect(t.cli.stop).toHaveBeenCalledExactlyOnceWith(expect.anything(), source)
      }
      expect(lease.commit).not.toHaveBeenCalled()
      expect(lease.revoke).toHaveBeenCalledTimes(1)
    },
  )

  it('checks for a foreground attachment immediately before opening the new terminal', async () => {
    const entered = deferred<void>()
    const notice = deferred<boolean>()
    const t = setup([], undefined, ROOT, undefined, REMOTE, () => {
      entered.resolve()
      return notice.promise
    })
    const lease = { commit: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
    await t.attach()
    t.cli.startBg.mockResolvedValueOnce({ ok: true, id, lease })
    const starting = t.sessions.start({})
    await entered.promise
    await expect(t.sessions.open({ attach: id })).resolves.toMatchObject({ ok: true })
    notice.resolve(false)
    await expect(starting).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('already owned'),
    })
    expect(t.opened.map((args) => args.attach)).toEqual([id])
    await t.sessions.leave()
    expect(lease.commit).not.toHaveBeenCalled()
    expect(lease.revoke).toHaveBeenCalledTimes(1)
    expect(t.cli.stop).not.toHaveBeenCalled()
  })

  it.each([
    ['start', false],
    ['start', true],
    ['fork', false],
    ['fork', true],
  ] as const)(
    'rejects a %s colliding with stopped history (unknown: %s)',
    async (verb, unknown) => {
      const t = native()
      t.listing([row(source, { pid: undefined, state: 'stopped', name: 'Original conversation' })])
      const lease = {
        commit: vi.fn(async () => {}),
        revoke: vi.fn(async () => {
          if (unknown) throw proofError
        }),
      }
      t.respond('--bg', () => [
        null,
        `backgrounded · ${source} · new run\n`,
        '',
        { kind: 'settled', lease },
      ])
      await t.attach()
      const history = t.sessions.past()
      expect(history).toEqual([
        expect.objectContaining({
          id: source,
          provider: 'claude',
          conversationId: `${source}-uuid`,
          name: 'Original conversation',
        }),
      ])
      const events = t.sent.slice()
      const result = await (verb === 'start' ? t.sessions.start({}) : t.sessions.duplicate(source))
      if (result.ok) throw new Error('Expected a history collision')
      expect(result).not.toHaveProperty('sessionId')
      expect(t.sessions.past()).toEqual(history)
      expect(t.sent).toEqual(events)
      expect(t.opened).toEqual([])
      expect(lease.commit).not.toHaveBeenCalled()
      if (unknown) {
        expect(result).toMatchObject({
          cleanupUnconfirmed: true,
          error: {
            lease,
            cause: proofError,
            commandError: { message: expect.stringContaining('already owned') },
          },
        })
        // The failure owns the new lease, not the old history id.
        await expect(t.sessions.open({ attach: source })).resolves.toMatchObject({ ok: true })
        await expect(t.sessions.leave()).rejects.toMatchObject({ errors: [result.error] })
      } else {
        expect(result).not.toHaveProperty('cleanupUnconfirmed')
        await t.sessions.leave()
      }
      expect(t.calls('stop')).toEqual([])
      expect(t.calls('rm')).toEqual([])
      expect(lease.revoke).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps explicit resume of verified history distinct from a colliding launch', async () => {
    const t = setup([row(source, { pid: undefined, state: 'stopped' })])
    const lease = {
      commit: vi.fn(async () => {}),
      revoke: vi.fn(async () => {
        throw proofError
      }),
    }
    await t.attach()
    t.cli.startBg.mockResolvedValueOnce({ ok: true, id: source, lease })
    const result = await t.sessions.start({})
    if (result.ok) throw new Error('Expected a history collision')
    expect(result).toMatchObject({ cleanupUnconfirmed: true })
    await expect(t.sessions.respawn(source)).resolves.toEqual({ ok: true })
    expect(t.cli.respawn).toHaveBeenCalledExactlyOnceWith(expect.anything(), source)
    await expect(t.sessions.leave({ stopSessions: false })).rejects.toMatchObject({
      errors: [result.error],
    })
    expect(lease.commit).not.toHaveBeenCalled()
    expect(lease.revoke).toHaveBeenCalledTimes(1)
    expect(t.cli.stop).not.toHaveBeenCalled()
  })

  it('does not stop a historical id on a legacy collision', async () => {
    const t = setup([row(source, { pid: undefined, state: 'stopped' })])
    await t.attach()
    t.cli.startBg.mockResolvedValueOnce({ ok: true, id: source })
    const result = await t.sessions.start({ prompt: 'go' })
    if (result.ok) throw new Error('Expected a history collision')
    expect(result).toMatchObject({
      cleanupUnconfirmed: true,
      message: expect.stringContaining('already owned'),
    })
    await expect(t.sessions.leave()).rejects.toMatchObject({ errors: [result.error] })
    expect(t.opened).toEqual([])
    expect(t.cli.stop).not.toHaveBeenCalled()
  })

  it('keeps Windows subdirectory rows in the refreshed shutdown inventory', async () => {
    const root = 'C:\\Vault'
    const t = native(undefined, root)
    await t.attach()
    t.respond('agents', () => [
      null,
      JSON.stringify([
        row(source, { cwd: 'c:\\VAULT/Sub' }),
        row(id, { cwd: 'C:/Vault-sibling/Sub' }),
        row('deadbeef', { cwd: 'D:/Vault/Sub' }),
      ]),
      '',
      { kind: 'settled' },
    ])
    await t.sessions.refresh()
    expect(t.sessions.sessions().map((row) => row.id)).toEqual([source])
    await t.sessions.leave()
    expect(t.calls('stop').map(([args, , cwd]) => [args, cwd])).toEqual([[['stop', source], root]])
  })

  it.each([
    ['start', false],
    ['fork', false],
    ['start', true],
    ['fork', true],
    ['launch', true],
  ] as const)(
    'joins pre-grant cleanup before rejecting a current %s (unknown: %s)',
    async (verb, unknown) => {
      const activation = new AbortController()
      const t = native(activation.signal)
      const release = deferred<void>()
      const draining = deferred<void>()
      const commitError = new Error('release broker failed before authorizing grant')
      const history = row(source, { pid: undefined, state: 'stopped' })
      const ticket = {
        launchId: 'original-launch',
        secret: Buffer.alloc(32),
        parentPid: 10,
        jobId: '11111111-1111-4111-8111-111111111111',
        commitGuardId: '22222222-2222-4222-8222-222222222222',
        parentBirth: '1234',
        jobHandle: 'a4',
        commitGuardHandle: 'b4',
      }
      const broker = vi.fn<NonNullable<Parameters<typeof ownedJobLease>[0]['broker']>>(
        async (_ticket, action, grant, _committed, _fixture, signal) => {
          if (action === 'release') {
            expect(signal?.aborted).toBe(false)
            await release.promise
            // Preparation failed: no release grant or source close was authorized.
            throw commitError
          }
          expect(action).toBe('revoke')
          expect(grant()).toBe(true)
          await draining.promise
        },
      )
      const job = ownedJobLease({ prepared: ticket, broker, joinProducer: async () => {} })
      job.bindForAuth(ticket.parentBirth)
      job.adopt(ticket)
      job.handedOff()
      t.listing([history])
      t.respond('--bg', () => [null, receipt, '', { kind: 'settled', lease: job.lease }])
      await t.attach()
      const past = t.sessions.past()
      const events = t.sent.slice()
      const create = () => {
        if (verb === 'fork') return t.sessions.duplicate(source)
        if (verb === 'launch') return t.sessions.launch({ name: 'owned', prompt: 'go' })
        return t.sessions.start({})
      }
      const settled = vi.fn((value: unknown) => value)
      const outcome = create().then(settled, settled)
      await vi.waitFor(() => expect(broker.mock.calls[0]?.slice(0, 2)).toEqual([ticket, 'release']))
      if (verb === 'fork') expect(t.calls('--bg')[0]?.[0]).toContain('--fork-session')
      release.resolve()
      await vi.waitFor(() => expect(broker.mock.calls[1]?.slice(0, 2)).toEqual([ticket, 'revoke']))
      expect(activation.signal.aborted).toBe(false)
      expect(settled).not.toHaveBeenCalled()
      const nextSettled = vi.fn((value: unknown) => value)
      const next = create().then(nextSettled)
      const changing = { ok: false, message: `Session ${id} is still changing.` }
      await expect(t.sessions.stop(id)).resolves.toEqual(changing)
      await expect(t.sessions.respawn(id)).resolves.toEqual(changing)
      await expect(t.sessions.open({ attach: id })).resolves.toEqual(changing)
      expect(nextSettled).not.toHaveBeenCalled()
      expect(t.calls('--bg')).toHaveLength(1)

      // A listing that began before the drain must not adopt the unpublished run,
      // even if the read returns only after the lease settles.
      const reading = deferred<Reply>()
      const listingEntered = deferred<void>()
      t.respond('agents', () => {
        listingEntered.resolve()
        return reading.promise
      })
      const refresh = t.sessions.refresh()
      await listingEntered.promise
      expect(settled).not.toHaveBeenCalled()
      if (unknown) draining.reject(proofError)
      else {
        t.respond('--bg', () => [commandError, '', '', { kind: 'settled' }])
        draining.resolve()
      }
      expect(await outcome).toBe(commitError)
      const nextResult = await next
      expect(t.calls('--bg')).toHaveLength(unknown ? 1 : 2)
      if (!unknown) expect(nextResult).toMatchObject({ ok: false, error: commandError })
      reading.resolve([null, JSON.stringify([history, row(id)]), '', { kind: 'settled' }])
      await refresh
      expect(t.sessions.sessions()).toEqual([])
      expect(t.sessions.past()).toEqual(past)
      expect(t.sent).toEqual(events)
      expect(t.opened).toEqual([])
      expect(t.calls('stop')).toEqual([])
      expect(t.calls('respawn')).toEqual([])
      expect(t.calls('rm')).toEqual([])

      if (unknown) {
        const failure = await create()
        expect(nextResult).toBe(failure)
        if (failure.ok) throw new Error('Expected the uncertain run to block creation')
        expect(failure).toMatchObject({ cleanupUnconfirmed: true, sessionId: id })
        expect(failure.error?.cause).toBe(commitError)
        expect(failure.error).toHaveProperty('lease', job.lease)
        expect(await t.sessions.stop(id)).toBe(failure)
        expect(await t.sessions.respawn(id)).toBe(failure)
        await expect(t.sessions.open({ attach: id })).resolves.toEqual(changing)
        expect(t.calls('--bg')).toHaveLength(1)
        const teardown = await t.sessions.leave().catch((error: unknown) => error)
        expect(teardown).toBeInstanceOf(AggregateError)
        const { errors } = teardown as AggregateError
        expect(errors).toHaveLength(2)
        expect(errors[0]).toBe(failure.error)
        expect(errors[1]).toHaveProperty('cause', proofError)
        await expect(t.sessions.leave()).rejects.toBe(teardown)
      } else if (verb === 'fork') {
        // Proved cleanup removed both the pending id and its publication fence.
        // A new receipt with the same id is now independent of the first launch.
        const replacement = { commit: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
        t.respond('--bg', () => [null, receipt, '', { kind: 'settled', lease: replacement }])
        t.respond('agents', () => [null, JSON.stringify([history]), '', { kind: 'settled' }])
        await expect(create()).resolves.toMatchObject({ ok: true, sessionId: id })
        expect(replacement.commit).toHaveBeenCalledTimes(1)
        await t.sessions.leave({ stopSessions: false })
      } else await expect(t.sessions.leave()).resolves.toBeUndefined()
      expect(t.calls('stop')).toEqual([])
      expect(t.calls('rm')).toEqual([])
      expect(broker).toHaveBeenCalledTimes(2)
    },
  )

  it.each([false, true])(
    'revokes the original lease if the vault closes before commit, even if drain is unconfirmed: %s',
    async (unconfirmed) => {
      const activation = new AbortController()
      const t = native(activation.signal, ROOT, REMOTE, async () => {
        activation.abort()
        return true
      })
      const lease = {
        commit: vi.fn(async () => {}),
        revoke: vi.fn(async () => {
          if (unconfirmed) throw proofError
        }),
      }
      t.listing([])
      t.respond('--bg', () => [null, receipt, '', { kind: 'settled', lease }])
      await t.attach()
      const result = await t.sessions.start({ prompt: 'go' })
      expect(result.ok).toBe(false)
      if (unconfirmed) {
        expect(result).toMatchObject({
          cleanupUnconfirmed: true,
          sessionId: id,
          error: { lease, cause: proofError },
        })
        await expect(t.sessions.leave()).rejects.toMatchObject({
          errors: [!result.ok && result.error],
        })
      } else await t.sessions.leave()
      expect(lease.commit).not.toHaveBeenCalled()
      expect(lease.revoke).toHaveBeenCalledTimes(1)
      expect(t.calls('stop')).toHaveLength(0)
    },
  )

  it.each([false, true])(
    'joins exact pre-grant cleanup on host close (unknown: %s)',
    async (unknown) => {
      const activation = new AbortController()
      const a = native(activation.signal)
      const grantReady = deferred<void>()
      const entered = deferred<void>()
      const draining = deferred<void>()
      const prepared = {
        launchId: 'original-launch',
        secret: Buffer.alloc(32),
        parentPid: 10,
        jobId: '11111111-1111-4111-8111-111111111111',
        commitGuardId: '22222222-2222-4222-8222-222222222222',
      }
      const ticket = { ...prepared, parentBirth: '1234', jobHandle: 'a4', commitGuardHandle: 'b4' }
      const releaseWrite = vi.fn()
      const broker = vi.fn<NonNullable<Parameters<typeof ownedJobLease>[0]['broker']>>(
        async (_job, action, grant, committed) => {
          if (action === 'release') {
            entered.resolve()
            await grantReady.promise
            if (!grant()) throw new Error('lost admission')
            releaseWrite()
            committed?.()
          } else await draining.promise
        },
      )
      const job = ownedJobLease({ prepared, broker, joinProducer: async () => {} })
      job.bindForAuth(ticket.parentBirth)
      job.adopt(ticket)
      job.handedOff()
      a.listing([])
      a.respond('--bg', () => [null, receipt, '', { kind: 'settled', lease: job.lease }])
      await a.attach()
      const starting = a.sessions.start({})
      await entered.promise
      a.listing([row(id)])
      await a.sessions.refresh()
      expect(a.sessions.sessions()).toEqual([])
      expect(a.opened).toEqual([])
      await expect(a.sessions.open({ attach: id })).resolves.toMatchObject({ ok: false })

      const reason = new Error('original activation revoked')
      activation.abort(reason)
      const left = vi.fn()
      const leaving = a.sessions.leave().then(left, (error: unknown) => error)
      expect(broker).toHaveBeenCalledTimes(1)
      grantReady.resolve()
      await vi.waitFor(() => expect(broker.mock.calls[1]?.slice(0, 2)).toEqual([ticket, 'revoke']))
      expect(releaseWrite).not.toHaveBeenCalled()
      expect(left).not.toHaveBeenCalled()
      if (unknown) draining.reject(proofError)
      else draining.resolve()
      const result = await starting
      if (result.ok) throw new Error('Expected revoked launch')
      if (unknown) {
        expect(result).toMatchObject({
          cleanupUnconfirmed: true,
          error: { lease: job.lease, cause: proofError, commandError: reason },
        })
        expect(await leaving).toMatchObject({ errors: [result.error] })
      } else {
        expect(result).toEqual({ ok: false, message: 'The vault closed as the session started.' })
        await leaving
        expect(left).toHaveBeenCalledTimes(1)
      }
      expect(a.opened).toEqual([])
      expect(a.calls('stop')).toEqual([])
      expect(a.calls('rm')).toEqual([])
      expect(a.sent.filter(([name]) => name === 'sessions')).toEqual([['sessions', []]])
      expect(broker).toHaveBeenCalledTimes(2)
    },
  )

  it('tracks the id during commit and stops a late commit on its original vault only', async () => {
    const activation = new AbortController()
    const a = native(activation.signal)
    const b = native(undefined, '/other', 'syv/other')
    const committing = deferred<void>()
    const commitEntered = deferred<void>()
    const lease = {
      commit: vi.fn((signal?: AbortSignal) => {
        expect(signal?.aborted).toBe(false)
        commitEntered.resolve()
        return committing.promise
      }),
      revoke: vi.fn(async () => {}),
    }
    a.listing([])
    b.listing([row(id, { name: 'B' })])
    a.respond('--bg', () => [null, receipt, '', { kind: 'settled', lease }])
    await Promise.all([a.attach(), b.attach()])
    const launching = a.sessions.start({ name: 'owned', prompt: 'go' })
    await commitEntered.promise
    a.listing([row(id)])
    await a.sessions.refresh()
    expect(a.sessions.sessions()).toEqual([])
    const listingLease = { revoke: vi.fn(async () => {}) }
    const listingError = Object.assign(new UnconfirmedOwnedProgramError(proofError, listingLease), {
      cmd: 'claude',
    })
    a.respond('agents', () => [
      listingError,
      '',
      '',
      { kind: 'unconfirmed', cause: proofError, lease: listingLease },
    ])
    await a.sessions.refresh()
    // With probes blocked, only known ids can reach the in-flight action guard.
    expect(await a.sessions.stop('aaaaaaaa')).toMatchObject({
      cleanupUnconfirmed: true,
      error: listingError,
    })
    expect(await a.sessions.stop(id)).toEqual({
      ok: false,
      message: `Session ${id} is still changing.`,
    })
    expect(a.calls('stop')).toHaveLength(0)

    activation.abort()
    expect(lease.commit.mock.calls[0]?.[0]?.aborted).toBe(true)
    expect(lease.revoke).not.toHaveBeenCalled()
    const left = vi.fn()
    const leaving = a.sessions.leave().catch((error: unknown) => {
      left()
      return error
    })
    expect(left).not.toHaveBeenCalled()
    committing.resolve()
    expect(await launching).toEqual({
      ok: false,
      message: 'The vault closed as the session started.',
    })
    expect(await leaving).toMatchObject({ errors: [listingError] })
    expect(a.calls('stop').map(([args, , cwd]) => [args, cwd])).toEqual([[['stop', id], ROOT]])
    expect(a.opened).toEqual([])
    expect(a.sent.filter(([name]) => name === 'sessions').map(([, sessions]) => sessions)).toEqual([
      [],
    ])
    expect(lease.commit).toHaveBeenCalledTimes(1)
    expect(lease.revoke).not.toHaveBeenCalled()
    expect(b.calls('stop')).toHaveLength(0)
    expect(b.sessions.sessions()).toEqual([expect.objectContaining({ id, name: 'B' })])
    await b.sessions.leave({ stopSessions: false })
  })

  it.each(['live start', 'past start', 'past fork'] as const)(
    'rejects a late %s collision only in the original activation',
    async (variant) => {
      const activation = new AbortController()
      const stopped = variant !== 'live start'
      const a = setup(
        [row(source, stopped ? { pid: undefined, state: 'stopped' } : {})],
        undefined,
        ROOT,
        activation.signal,
      )
      const b = setup([], undefined, '/other', undefined, 'syv/other')
      const nextA = setup([])
      const old = deferred<Awaited<ReturnType<ClaudeCli['startBg']>>>()
      const lease = { commit: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
      await a.attach()
      const command = variant === 'past fork' ? a.cli.forkBg : a.cli.startBg
      command.mockReturnValueOnce(old.promise)
      const starting = variant === 'past fork' ? a.sessions.duplicate(source) : a.sessions.start({})
      await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1))
      activation.abort()
      const leaving = a.sessions.leave()
      for (const t of [b, nextA]) {
        const newLease = { commit: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
        await t.attach()
        t.cli.startBg.mockResolvedValueOnce({ ok: true, id: source, lease: newLease })
        await expect(t.sessions.start({})).resolves.toMatchObject({ ok: true, sessionId: source })
        expect(newLease.commit).toHaveBeenCalledTimes(1)
        expect(newLease.revoke).not.toHaveBeenCalled()
      }
      old.resolve({ ok: true, id: source, lease })
      await expect(starting).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining('already owned'),
      })
      await leaving
      expect(a.opened).toEqual([])
      if (stopped) expect(a.cli.stop).not.toHaveBeenCalled()
      else
        expect(a.cli.stop).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ root: ROOT }),
          source,
        )
      expect(a.cli.rm).not.toHaveBeenCalled()
      expect(lease.commit).not.toHaveBeenCalled()
      expect(lease.revoke).toHaveBeenCalledTimes(1)
      for (const t of [b, nextA]) {
        expect(t.cli.stop).not.toHaveBeenCalled()
        await t.sessions.leave({ stopSessions: false })
      }
    },
  )

  it('drains a late handoff without attaching or touching coincident ids in B or a new A', async () => {
    const activation = new AbortController()
    const a = native(activation.signal)
    const b = native(undefined, '/other', 'syv/other')
    const nextA = native()
    const entered = deferred<void>()
    const output = deferred<Reply>()
    const physicalDrain = deferred<void>()
    const oldLease = { revoke: vi.fn(() => physicalDrain.promise), commit: vi.fn(async () => {}) }
    a.respond('--bg', () => {
      entered.resolve()
      return output.promise
    })
    await a.attach()
    const starting = a.sessions.start({})
    await entered.promise
    const waiting = a.sessions.launch({ name: 'Old activation', prompt: 'go' })
    await a.sessions.ensure()
    expect(a.calls('--bg')).toHaveLength(1)
    activation.abort()
    const doneLeaving = vi.fn()
    const leaving = a.sessions.leave({ stopSessions: false }).then(doneLeaving)
    // The queued request owns no launch and need not wait for the old lease.
    await expect(waiting).resolves.toEqual({
      ok: false,
      message: 'The vault closed as the session started.',
    })
    expect(a.calls('--bg')).toHaveLength(1)
    output.resolve([null, receipt, '', { kind: 'settled', lease: oldLease }])
    await vi.waitFor(() => expect(oldLease.revoke).toHaveBeenCalledTimes(1))
    expect(doneLeaving).not.toHaveBeenCalled()
    for (const t of [b, nextA]) {
      const lease = { commit: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
      t.respond('--bg', () => [null, receipt, '', { kind: 'settled', lease }])
      await t.attach()
      t.listing([row(id)])
      expect(await t.sessions.start({})).toMatchObject({ ok: true, sessionId: id })
      expect(lease.commit).toHaveBeenCalledTimes(1)
      expect(lease.revoke).not.toHaveBeenCalled()
      expect(t.opened).toHaveLength(1)
    }
    physicalDrain.resolve()
    expect(await starting).toMatchObject({ ok: false })
    await leaving
    expect(a.opened).toEqual([])
    expect(oldLease.commit).not.toHaveBeenCalled()
    for (const t of [a, b, nextA]) expect(t.calls('stop')).toHaveLength(0)
  })
})
