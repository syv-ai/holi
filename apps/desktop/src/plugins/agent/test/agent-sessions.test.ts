import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARCHIVE_FILE, readArchive } from '../main/host/archive'
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeCli } from '../main/claude/cli'
import { SIGN_IN_NOTICE } from '../main/claude/config-dir'
import {
  isLive,
  parseListing,
  readContextPercent,
  summarise,
  summarisePast,
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

function setup(initial: Row[] = [], root = ROOT, held: ReadonlySet<string> = new Set()) {
  let listing: Row[] = initial
  /** What `claude agents --json` printed instead of the listing: null is a
   *  call that failed (a timeout, a missing binary). */
  let broken: { stdout: string | null } | null = null
  const cli = {
    list: vi.fn(async () => (broken !== null ? broken.stdout : JSON.stringify(listing))),
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
  const presses: Array<[string, string[]]> = []
  /** The terminals let go of (`release`). */
  const releasedTerminals: string[] = []
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
    press: (id, runs) => {
      presses.push([id, [...runs]])
      return launched.size > 0 && [...launched.values()].includes(id)
    },
    release: (id) => void releasedTerminals.push(id),
    close: async () => {},
    closeAll: vi.fn(async () => {}),
    list: () => [],
    launchedFor: (id) => launched.get(id) ?? null,
    listTerminal: () => null,
  }
  const sent: Array<[string, unknown]> = []
  const configure = vi.fn(async () => ({ dir: '/cfg/vault' }))
  const message = vi.fn(async (_channel: SessionChannel, _text: string) => {})
  const pauses: string[] = []
  const released: string[] = []
  const vault: AgentVault = {
    remote: REMOTE,
    root,
    head: () => Promise.resolve('base-sha'),
    commitNow: () => Promise.resolve(null),
    pauseSync: (reason: string) => {
      pauses.push(reason)
      return () => {
        released.push(reason)
      }
    },
  }
  const sessions = createAgentSessions({
    emit: (_remote: string, name: string, payload: unknown) => sent.push([name, payload]),
    provider: {
      cli,
      parseListing,
      isLive,
      summarise,
      summarisePast,
      readContextPercent,
      watch: () => () => {},
      configure,
      transcript: async () => null,
      blockedQuestion: async () => null,
      takeFirstSpawn: async () => true,
      signInNotice: SIGN_IN_NOTICE,
      message,
    },
    terminals,
    binDir: () => '/holi/bin',
    pendingQuestion: (job) => held.has(job),
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
    presses,
    releasedTerminals,
    sent,
    message,
    configure,
    terminals,
    setListing: (rows: Row[]) => {
      listing = rows
    },
    pauses,
    /** The sync holds given back. */
    released,
    /** The next listings fail, as `claude agents` printing `stdout` (null:
     *  not at all) rather than the listing. */
    breakListing: (stdout: string | null) => {
      broken = { stdout }
    },
    mendListing: () => {
      broken = null
    },
    /** The vault opened: what its activation does. */
    attach: () => sessions.ensure(vault),
  }
}

describe('agent sessions', () => {
  describe('the chat and its terminals', () => {
    it('is watched only while its chat is the one showing, not for a terminal behind it', async () => {
      const t = setup([row('aaaaaaaa')])
      await t.attach()
      await t.sessions.say({ id: 'aaaaaaaa', text: 'hello' })
      // A terminal was opened to type into; nobody is looking at it.
      expect(t.sessions.watched('aaaaaaaa')).toBe(false)
      t.sessions.watching('aaaaaaaa')
      expect(t.sessions.watched('aaaaaaaa')).toBe(true)
      t.sessions.watching(null)
      expect(t.sessions.watched('aaaaaaaa')).toBe(false)
    })

    it('lets go of the terminal a message went through when nobody watches', async () => {
      const t = setup([row('aaaaaaaa')])
      await t.attach()
      const res = await t.sessions.say({ id: 'aaaaaaaa', text: 'hello' })
      expect(res).toEqual({ ok: true, terminalId: 'term-1' })
      expect(t.releasedTerminals).toEqual(['term-1'])
    })

    it('keeps the terminal of the chat showing, and lets it go when the chat is left', async () => {
      const t = setup([row('aaaaaaaa'), row('bbbbbbbb')])
      await t.attach()
      t.sessions.watching('aaaaaaaa')
      await t.sessions.say({ id: 'aaaaaaaa', text: 'hello' })
      expect(t.releasedTerminals).toEqual([])
      t.sessions.watching('bbbbbbbb')
      expect(t.releasedTerminals).toEqual(['term-1'])
    })

    it('presses keys in the session’s terminal, opening one, and says when it cannot', async () => {
      const t = setup([row('aaaaaaaa')])
      await t.attach()
      t.sessions.watching('aaaaaaaa')
      expect(await t.sessions.press({ id: 'aaaaaaaa', keys: ['\x1b[B', '\r'] })).toEqual({
        ok: true,
        terminalId: 'term-1',
      })
      expect(t.opened.map((o) => o.attach)).toEqual(['aaaaaaaa'])
      expect(t.presses).toEqual([['term-1', ['\x1b[B', '\r']]])
      expect(await t.sessions.press({ id: 'zzzzzzzz', keys: ['\r'] })).toEqual({
        ok: false,
        message: 'That session has ended.',
      })
    })
  })

  it('stamps the config directory again before each session process starts', async () => {
    // What it carries follows settings a person can change while the vault is
    // open (the theme, bypass permissions), and only a new process reads it.
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    expect(t.configure).toHaveBeenCalledTimes(1)
    await t.sessions.start({})
    await t.sessions.launch({ prompt: 'go' })
    await t.sessions.respawn('aaaaaaaa')
    await t.sessions.duplicate('aaaaaaaa')
    expect(t.configure).toHaveBeenCalledTimes(5)
  })

  it('lists only live sessions', async () => {
    const t = setup([row('aaaaaaaa'), row('bbbbbbbb', { pid: undefined, status: undefined })])
    await t.attach()

    expect(t.sessions.sessions().map((s) => s.id)).toEqual(['aaaaaaaa'])
    expect(t.sent.filter(([name]) => name === 'sessions').at(-1)).toEqual([
      'sessions',
      // Idle, and finished: the listing's `state: done` is passed on.
      [{ id: 'aaaaaaaa', name: 'Session aaaaaaaa', state: 'idle', phase: 'done' }],
    ])
  })

  it('tells the finished sessions apart as the history, and only when it changes', async () => {
    const t = setup([
      row('aaaaaaaa'),
      row('bbbbbbbb', { pid: undefined, status: undefined, startedAt: 7 }),
      row('cccccccc', { pid: undefined, status: undefined, state: 'failed' }),
    ])
    await t.attach()

    expect(t.sessions.history()).toEqual([
      { id: 'bbbbbbbb', name: 'Session bbbbbbbb', phase: 'done', startedAt: 7 },
      { id: 'cccccccc', name: 'Session cccccccc', phase: 'failed' },
    ])
    const told = () => t.sent.filter(([name]) => name === 'history').length
    expect(told()).toBe(1)
    // A read that finds the same past says nothing more.
    await t.sessions.refresh()
    expect(told()).toBe(1)
  })

  it('archives a chat, keeps it across a restart, and tells the renderer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-archive-'))
    try {
      const gone = { pid: undefined, status: undefined, cwd: root }
      const t = setup([row('aaaaaaaa', gone)], root)
      await t.attach()
      expect(t.sessions.archived()).toEqual([])

      expect(await t.sessions.archive('aaaaaaaa', true)).toEqual({ ok: true })
      expect(t.sessions.archived()).toEqual(['aaaaaaaa'])
      expect(t.sent.filter(([name]) => name === 'archive').at(-1)).toEqual([
        'archive',
        ['aaaaaaaa'],
      ])
      // Kept in the vault's machine state, a `.local.` file.
      expect(await readArchive(root)).toEqual(['aaaaaaaa'])
      expect(ARCHIVE_FILE).toContain('.local.')

      // A new run of Holi reads it back.
      const again = setup([row('aaaaaaaa', gone)], root)
      await again.attach()
      expect(again.sessions.archived()).toEqual(['aaaaaaaa'])

      expect(await t.sessions.archive('aaaaaaaa', false)).toEqual({ ok: true })
      expect(await readArchive(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('deletes a finished chat for good, and refuses a running one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-remove-'))
    try {
      const t = setup(
        [
          row('aaaaaaaa', { cwd: root }),
          row('bbbbbbbb', { pid: undefined, status: undefined, cwd: root }),
        ],
        root,
      )
      await t.attach()
      expect(await t.sessions.remove('aaaaaaaa')).toEqual({
        ok: false,
        message: 'That session is still running. Stop it first.',
      })
      await t.sessions.archive('bbbbbbbb', true)
      expect(await t.sessions.remove('bbbbbbbb')).toEqual({ ok: true })
      expect(t.cli.rm).toHaveBeenCalledWith(expect.anything(), 'bbbbbbbb')
      expect(t.sessions.history()).toEqual([])
      expect(t.sessions.archived()).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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

  // The rules of a failed read are `session-state.test.ts`'s; this is the
  // wiring: a listing the CLI could not print reaches the state as one.
  it('keeps its sessions when the CLI fails to print the listing', async () => {
    const t = setup([row('aaaaaaaa', { status: 'busy', state: 'working' })])
    await t.attach()
    t.breakListing(null)
    await t.sessions.refresh()
    expect(t.sessions.sessions().map((s) => [s.id, s.state])).toEqual([['aaaaaaaa', 'working']])
    expect(t.released).toEqual([])
  })

  it('takes the turn bracket from the hook, for this vault only', async () => {
    const t = setup([row('aaaaaaaa')])
    await t.attach()
    t.sessions.noteTurn('someone/else', 'aaaaaaaa', true)
    expect(t.sessions.sessions()[0]?.state).toBe('idle')
    t.sessions.noteTurn(REMOTE, 'aaaaaaaa', true)
    expect(t.sessions.sessions()[0]?.state).toBe('working')
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
    const args = { name: 'Tidy', prompt: 'tidy the inbox', settings: '{}' }
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
    const launching = sessions.launch({ prompt: 'go' })
    await vi.waitFor(() => expect(cli.startBg).toHaveBeenCalled())
    await sessions.leave()
    release()
    expect(await launching).toEqual({
      ok: false,
      message: 'The vault closed as the session started.',
    })
    expect(cli.stop).toHaveBeenCalledWith(expect.anything(), 'launch00')
  })

  it('needs you while Holi holds its question, though the listing says busy', async () => {
    const { sessions, attach } = setup(
      [row('aaaa0001', { status: 'busy', state: 'working' })],
      ROOT,
      new Set(['aaaa0001']),
    )
    await attach()
    expect(sessions.sessions()).toEqual([
      expect.objectContaining({ id: 'aaaa0001', state: 'needs-you', waitingFor: 'input needed' }),
    ])
  })

  it('tells its listeners about every read', async () => {
    const { sessions, attach } = setup()
    await attach()
    const heard = vi.fn()
    sessions.onRows(heard)
    await sessions.launch({ prompt: 'go' })
    expect(heard).toHaveBeenCalled()
    expect(sessions.row('launch00')?.status).toBe('busy')
  })
})
