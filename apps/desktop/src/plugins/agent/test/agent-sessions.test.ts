import { describe, expect, it, vi } from 'vitest'
import type { ClaudeCli } from '../main/claude/cli'
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

function setup(initial: Row[] = []) {
  let listing: Row[] = initial
  const cli = {
    list: vi.fn(async () => JSON.stringify(listing)),
    stop: vi.fn(async (_t, id: string) => {
      listing = listing.map((r) => (r.id === id ? { ...r, pid: undefined, state: 'stopped' } : r))
      return { ok: true as const }
    }),
    respawn: vi.fn(async () => ({ ok: true as const })),
    rm: vi.fn(async (_t, id: string) => {
      listing = listing.filter((r) => r.id !== id)
      return { ok: true as const }
    }),
    startBg: vi.fn(async (_t, opts: { prompt?: string }) => {
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
    forkBg: vi.fn(async () => {
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
  const message = vi.fn(async (_channel: SessionChannel, _text: string) => {})
  const pauses: string[] = []
  const vault: AgentVault = {
    remote: REMOTE,
    root: ROOT,
    head: () => Promise.resolve('base-sha'),
    commitNow: () => Promise.resolve(null),
    pauseSync: (reason: string) => {
      pauses.push(reason)
      return () => {}
    },
  }
  const sessions = createAgentSessions({
    emit: (_remote: string, name: string, payload: unknown) => sent.push([name, payload]),
    provider: {
      id: 'claude',
      notInstalled: 'not installed',
      configure: async () => ({ dir: '/cfg/vault' }),
      terminal: () => ({ bin: '/usr/local/bin/claude', args: [], env: {} }),
      firstSpawn: { take: async () => true, notice: SIGN_IN_NOTICE },
      capabilities: {
        background: { cli, parseListing, isLive, summarise, watch: () => () => {}, message },
        status: { contextPercent: readContextPercent, model: readModelName },
      },
    },
    terminals,
    binDir: () => '/holi/bin',
    idleRecheckMs: 5,
    idleConfirmMs: 10,
    leaveCapMs: 50,
    log: () => {},
  })
  return {
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
  }
}

describe('agent sessions', () => {
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
    expect(t.message).toHaveBeenCalledWith(inbox, 'change the date')

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

  it('leaves: stops live sessions, closes windows', async () => {
    const t = setup([row('aaaaaaaa'), row('bbbbbbbb')])
    await t.attach()
    await t.sessions.leave()
    expect(t.cli.stop).toHaveBeenCalledTimes(2)
    expect(t.terminals.closeAll).toHaveBeenCalled()
    expect(t.sessions.sessions()).toEqual([])
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

describe('launched sessions', () => {
  it('start with their options and no terminal', async () => {
    const { sessions, cli, opened, attach } = setup()
    await attach()
    const args = { name: 'Tidy', prompt: 'tidy the inbox', model: 'opus' }
    expect(await sessions.launch(args)).toEqual({ ok: true, sessionId: 'launch00' })
    expect(cli.startBg).toHaveBeenCalledWith(expect.anything(), args)
    expect(opened).toEqual([])
    expect(sessions.sessions()).toEqual([expect.objectContaining({ id: 'launch00' })])
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
    await sessions.leave()
    release()
    expect(await launching).toEqual({
      ok: false,
      message: 'The vault closed as the session started.',
    })
    expect(cli.stop).toHaveBeenCalledWith(expect.anything(), 'launch00')
  })
})
