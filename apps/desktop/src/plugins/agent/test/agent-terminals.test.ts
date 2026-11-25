import { afterEach, describe, expect, it, vi } from 'vitest'
import { withPtyOwnership, type PtyProcess } from '../main/host/pty'
import { terminalCommand } from '../main/claude/cli'
import { createAgentTerminals } from '../main/host/terminals'
import { delimiter } from 'node:path'

class FakePty implements PtyProcess {
  readonly writes: string[] = []
  readonly kills: Array<string | undefined> = []
  private dataCb: ((d: string) => void) | null = null
  private exitCb: ((e: { exitCode: number }) => void) | null = null
  constructor(readonly pid = 4242) {}
  onData(cb: (d: string) => void) {
    this.dataCb = cb
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb
  }
  write(data: string) {
    this.writes.push(data)
  }
  resize() {}
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

const lease = () => true

const TARGET = { root: '/Users/ada/Holi/syv/vault', configDir: '/cfg/vault', binDir: '/holi/bin' }

/** What a background session's terminal is opened with: Claude Code's list,
 *  or one session. */
const on = (attach?: string, bin: string | null = '/usr/local/bin/claude') => ({
  lease,
  remote: 'syv/vault',
  cwd: TARGET.root,
  command: terminalCommand(TARGET, attach, () => bin),
  notInstalled: 'Claude CLI not found',
  ...(attach === undefined ? {} : { attach }),
})

function setup() {
  const spawns: Array<{ pty: FakePty; file: string; args: string[]; opts: any }> = []
  const sent: Array<[string, unknown]> = []
  const terminals = createAgentTerminals({
    emit: (_remote: string, name: string, payload: unknown) => sent.push([name, payload]),
    spawnPty: (file, args, opts) => {
      const pty = new FakePty()
      spawns.push({ pty, file, args, opts })
      return pty
    },
    // Never probe the real OS for a fake pid: it may be someone else's.
    probePid: () => 'alive',
    killGraceMs: 5,
    killBackstopMs: 10,
    pasteSettleMs: 20,
    pasteBackstopMs: 200,
    log: () => {},
  })
  return { terminals, spawns, sent }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('agent terminals', () => {
  it('joins repeat close with a rejecting natural-exit callback', async () => {
    const pty = new FakePty()
    const proof = vi.fn(async () => {})
    const cause = new Error('exit callback failed')
    let finish!: () => void
    const callback = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      throw cause
    })
    const terminals = createAgentTerminals({
      emit: () => {},
      spawnPty: () => pty,
      superviseGroup: () => ({ drain: proof }),
    })
    const terminal = terminals.open({ ...on('same-session'), onExit: callback })
    if (!terminal.ok) throw new Error(terminal.message)
    pty.exit(7)
    const first = terminals.close(terminal.id)
    const again = terminals.close(terminal.id)
    const closing = Promise.allSettled([first, again])
    try {
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
      expect(terminals.launchedFor('same-session')).toBe(terminal.id)
      finish()
      expect(await closing).toEqual([
        { status: 'rejected', reason: cause },
        { status: 'rejected', reason: cause },
      ])
      await expect(terminals.close(terminal.id)).rejects.toBe(cause)
      await expect(terminals.closeAll()).rejects.toBe(cause)
      expect(proof).toHaveBeenCalledTimes(1)
      expect(pty.kills).toEqual([])
    } finally {
      finish?.()
      await closing
    }
  })

  it.skipIf(process.platform === 'win32').each(['success', 'failure'] as const)(
    'keeps the terminal indexed through ownership retirement: %s',
    async (mode) => {
      const pty = new FakePty()
      const activation = new AbortController()
      const cause = new Error('ownership retirement failed')
      const proof = vi.fn(async () => {})
      const spawnPty = vi.fn(() => pty)
      const terminals = createAgentTerminals({
        emit: () => {},
        activationSignal: activation.signal,
        spawnPty,
        superviseGroup: () => ({ drain: proof }),
        log: () => {},
      })
      let finishCallback!: () => void
      let enterCallback!: () => void
      const callback = new Promise<void>((resolve) => {
        finishCallback = resolve
      })
      const entered = new Promise<void>((resolve) => {
        enterCallback = resolve
      })
      const onExit = vi.fn(() => {
        enterCallback()
        return callback
      })
      const slot = 'same-session'
      const atRetirement = vi.fn()
      const ownership = {
        ownershipRecordPath: undefined,
        nonLaunch: vi.fn(),
        fail: vi.fn(),
        retire: vi.fn(() => {
          atRetirement(terminals.launchedFor(slot))
          if (mode === 'failure') throw cause
        }),
      }
      const allocate = vi.fn(() => ownership)
      const opened = withPtyOwnership({ cwd: TARGET.root, allocate }, () =>
        terminals.open({ ...on(slot), onExit }),
      )
      if (!opened.ok) throw new Error(opened.message)
      pty.exit()
      try {
        await entered
        expect(allocate).toHaveBeenCalledExactlyOnceWith('explicit')
        expect(terminals.launchedFor(slot)).toBe(opened.id)
        expect(terminals.open(on(slot)).ok).toBe(false)
        expect(ownership.retire).not.toHaveBeenCalled()
      } finally {
        finishCallback()
      }
      // Let natural exit finish before Stop or the activation disposer joins it.
      await new Promise((resolve) => setImmediate(resolve))
      expect(onExit).toHaveBeenCalledOnce()
      expect(atRetirement).toHaveBeenCalledExactlyOnceWith(opened.id)
      expect(proof).toHaveBeenCalledOnce()
      expect(pty.kills).toEqual([])
      if (mode === 'failure') {
        expect(ownership.fail).toHaveBeenCalledWith(cause)
        expect(terminals.launchedFor(slot)).toBe(opened.id)
        expect(terminals.open(on(slot)).ok).toBe(false)
        expect(spawnPty).toHaveBeenCalledOnce()
        await expect(terminals.close(opened.id)).rejects.toBe(cause)
        await expect(terminals.close(opened.id)).rejects.toBe(cause)
        activation.abort()
        await expect(terminals.closeAll()).rejects.toBe(cause)
        await expect(terminals.closeAll()).rejects.toBe(cause)
      } else {
        expect(ownership.fail).not.toHaveBeenCalled()
        expect(terminals.launchedFor(slot)).toBeNull()
        expect(terminals.open(on(slot)).ok).toBe(true)
        pty.exit()
        await terminals.closeAll()
        expect(terminals.list()).toEqual([])
      }
    },
  )

  it('retains the terminal and original failure when exit notification throws', async () => {
    const pty = new FakePty()
    const cause = new Error('exit notification failed')
    const emit = vi.fn((_remote: string, name: string) => {
      if (name === 'pty-exit') throw cause
    })
    const terminals = createAgentTerminals({ emit, spawnPty: () => pty })
    const opened = terminals.open(on('same-session'))
    if (!opened.ok) throw new Error(opened.message)
    pty.exit()
    expect(terminals.launchedFor('same-session')).toBe(opened.id)
    await expect(terminals.close(opened.id)).rejects.toBe(cause)
    await expect(terminals.closeAll()).rejects.toBe(cause)
    expect(terminals.open(on('same-session')).ok).toBe(false)
    expect(emit.mock.calls.filter(([, name]) => name === 'pty-exit')).toHaveLength(1)
  })

  it('opens the list, or one session, in the vault on its config dir', () => {
    const { terminals, spawns } = setup()
    terminals.open(on())
    terminals.open(on('1234abcd'))

    expect(spawns.map((s) => s.args)).toEqual([['agents'], ['attach', '1234abcd']])
    for (const { opts } of spawns) {
      expect(opts.cwd).toBe(TARGET.root)
      expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/cfg/vault')
      expect(opts.env.PATH.split(delimiter)[0]).toBe('/holi/bin')
    }
    expect(terminals.list().map((t) => t.launchedFor)).toEqual([null, '1234abcd'])
  })

  it('finds the window it opened for a session, and the one on the list', () => {
    const { terminals } = setup()
    const list = terminals.open(on())
    const one = terminals.open(on('1234abcd'))
    expect(terminals.listTerminal()).toBe(list.ok ? list.id : null)
    expect(terminals.launchedFor('1234abcd')).toBe(one.ok ? one.id : null)
    expect(terminals.launchedFor('ffffffff')).toBeNull()
  })

  it('labels a terminal with the title its program sets', async () => {
    const { terminals, spawns, sent } = setup()
    terminals.open(on())
    spawns[0]!.pty.emit('\x1b]0;claude agents\x07')
    await vi.waitFor(() => expect(terminals.list()[0]?.title).toBe('claude agents'))
    expect(sent.filter(([c]) => c === 'terminals').length).toBeGreaterThan(0)
  })

  it('holds a paste until the TUI has printed and settled, then sends it unsent', async () => {
    const { terminals, spawns } = setup()
    const res = terminals.open(on('1234abcd'))
    const id = res.ok ? res.id : ''
    expect(terminals.paste(id, 'look at this', lease)).toBe(true)
    expect(spawns[0]!.pty.writes).toEqual([])

    spawns[0]!.pty.emit('hello')
    await vi.waitFor(() =>
      expect(spawns[0]!.pty.writes).toEqual(['\x1b[200~look at this\x1b[201~']),
    )
    terminals.paste(id, 'again', lease)
    expect(spawns[0]!.pty.writes.at(-1)).toBe('\x1b[200~again\x1b[201~')
    expect(spawns[0]!.pty.writes.join('')).not.toContain('\r')
  })

  it('gives up waiting on a terminal that never prints', async () => {
    const { terminals, spawns } = setup()
    const res = terminals.open(on())
    terminals.paste(res.ok ? res.id : '', 'x', lease)
    await vi.waitFor(() => expect(spawns[0]!.pty.writes).toHaveLength(1), { timeout: 1_000 })
  })

  it('answers native color queries directly to the PTY and not as user input', () => {
    const { terminals, spawns } = setup()
    const onInput = vi.fn()
    const res = terminals.open({ ...on(), onInput })
    if (!res.ok) throw new Error(res.message)
    terminals.setAppearance(
      res.id,
      {
        foreground: '#d0d0d0',
        background: '#14283c00',
        red: '#c80000',
      },
      lease,
    )
    spawns[0]!.pty.emit('\x1b[?2031h\x1b]10;?\x07\x1b]11;?\x07\x1b]4;1;?\x07')
    expect(spawns[0]!.pty.writes).toEqual([
      '\x1b]10;rgb:d0/d0/d0\x07',
      '\x1b]11;rgb:14/28/3c\x07',
      '\x1b]4;1;rgb:c8/00/00\x07',
    ])
    expect(onInput).not.toHaveBeenCalled()

    terminals.setAppearance(
      res.id,
      {
        foreground: '#d0d0d0',
        background: '#ffffff00',
        red: '#c80000',
      },
      lease,
    )
    expect(spawns[0]!.pty.writes.at(-1)).toBe('\x1b[?997;2n')
  })

  it('streams output only once attached, after replaying the record', async () => {
    const { terminals, spawns, sent } = setup()
    const res = terminals.open({ ...on(), notice: 'sign in\r\n' })
    const id = res.ok ? res.id : ''
    spawns[0]!.pty.emit('before')
    expect(sent.some(([c]) => c === 'pty-data')).toBe(false)

    const state = await terminals.attach(id, lease)
    expect(state).toContain('sign in')
    expect(state).toContain('before')
    spawns[0]!.pty.emit('after')
    expect(sent).toContainEqual(['pty-data', { id, data: 'after' }])
  })

  it('passes the final title before retiring terminal ownership', async () => {
    const { terminals, spawns } = setup()
    const onExit = vi.fn(() => {
      expect(terminals.launchedFor('1234abcd')).not.toBeNull()
    })
    const opened = terminals.open({ ...on('1234abcd'), onExit })
    if (!opened.ok) throw new Error(opened.message)
    spawns[0]!.pty.emit('\x1b]0;Pi plan\x07')
    spawns[0]!.pty.exit()
    await terminals.close(opened.id)
    expect(onExit).toHaveBeenCalledWith('Pi plan', expect.any(AbortSignal))
    expect(terminals.list()).toEqual([])
  })

  it('retains an exited Pi transcript until close and rejects further input', async () => {
    const { terminals, spawns } = setup()
    const onExit = vi.fn()
    const res = terminals.open({ ...on('pi-session'), retainOnExit: true, onExit })
    if (!res.ok) throw new Error(res.message)
    spawns[0]!.pty.emit('final transcript')
    spawns[0]!.pty.exit(0)

    expect(terminals.list()).toEqual([
      expect.objectContaining({ id: res.id, launchedFor: 'pi-session' }),
    ])
    expect(await terminals.attach(res.id, lease)).toContain('final transcript')
    terminals.write(res.id, 'ignored', lease)
    expect(terminals.paste(res.id, 'ignored', lease)).toBe(false)
    expect(spawns[0]!.pty.writes).toEqual([])
    expect(onExit).toHaveBeenCalledOnce()

    await terminals.close(res.id)
    expect(terminals.list()).toEqual([])
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('does not retain a terminal whose spawn fails', () => {
    const terminals = createAgentTerminals({
      emit: () => {},
      spawnPty: () => {
        throw new Error('spawn failed')
      },
      probePid: () => 'gone',
      log: () => {},
    })
    expect(terminals.open({ ...on('pi-session'), retainOnExit: true })).toEqual({
      ok: false,
      message: 'spawn failed',
    })
    expect(terminals.list()).toEqual([])
  })

  it('drops a terminal whose client exits, and says so', () => {
    const { terminals, spawns, sent } = setup()
    const res = terminals.open(on('1234abcd'))
    const id = res.ok ? res.id : ''
    spawns[0]!.pty.exit(0)
    expect(terminals.list()).toEqual([])
    expect(sent).toContainEqual(['pty-exit', { id, code: 0 }])
    expect(terminals.paste(id, 'x', lease)).toBe(false)
  })

  it('reports an unconfirmed exit instead of fabricating terminal closure', async () => {
    const { terminals, spawns, sent } = setup()
    const res = terminals.open(on())
    const id = res.ok ? res.id : ''
    await expect(terminals.close(id)).rejects.toThrow(/did not report process exit/)
    expect(terminals.list()).toHaveLength(1)
    expect(sent.some(([c, p]) => c === 'pty-exit' && (p as { id: string }).id === id)).toBe(false)
    spawns[0]!.pty.exit(-1)
    expect(terminals.list()).toEqual([])
  })

  it('refuses without a binary', () => {
    const terminals = createAgentTerminals({
      emit: () => {},
      log: () => {},
    })
    expect(terminals.open(on(undefined, null)).ok).toBe(false)
  })
})

it('keeps stale pastes and deferred output fenced while a fresh claimant adopts the terminal', async () => {
  vi.useFakeTimers()
  const pty = new FakePty()
  let epoch = 0
  const capture = () => {
    const at = epoch
    return () => epoch === at
  }
  const queued: Array<{ payload: unknown; guard?: () => boolean }> = []
  const terminals = createAgentTerminals({
    spawnPty: () => pty,
    probePid: () => 'alive',
    superviseGroup: () => ({
      drain: async () => {
        pty.exit()
      },
    }),
    emit: (_remote, name, payload, guard) => {
      if (name === 'pty-data') queued.push({ payload, guard })
    },
    pasteBackstopMs: 20,
    log: () => {},
  })
  const old = capture()
  const opened = terminals.open({ ...on(), lease: old })
  if (!opened.ok) throw new Error(opened.message)
  expect(terminals.claim(opened.id, old)).toBe(true)
  const staleReplay = terminals.attach(opened.id, old)
  pty.emit('recorded before switching')
  epoch++
  epoch++
  await vi.advanceTimersByTimeAsync(0)
  expect(await staleReplay).toBe('')
  terminals.write(opened.id, 'stale', old)
  terminals.resize(opened.id, 120, 50, old)
  expect(terminals.paste(opened.id, 'stale draft', old)).toBe(false)
  const fresh = capture()
  expect(terminals.claim(opened.id, fresh)).toBe(true)
  expect(await terminals.discard(opened.id, old)).toBe(false)
  const freshReplay = terminals.attach(opened.id, fresh)
  await vi.advanceTimersByTimeAsync(0)
  expect(await freshReplay).toContain('recorded before switching')
  pty.emit('fresh output')
  expect(queued.filter((event) => event.guard?.())).toEqual([
    expect.objectContaining({ payload: { id: opened.id, data: 'fresh output' } }),
  ])
  terminals.write(opened.id, 'fresh', fresh)
  expect(terminals.paste(opened.id, 'revoked while settling', fresh)).toBe(true)
  epoch++
  await vi.advanceTimersByTimeAsync(300)
  expect(pty.writes).toEqual(['fresh'])
  expect(queued.every((event) => event.guard?.() === false)).toBe(true)
  const current = capture()
  expect(terminals.paste(opened.id, 'current draft', current)).toBe(true)
  expect(pty.writes.at(-1)).toBe('\x1b[200~current draft\x1b[201~')
  const closing = terminals.closeAll()
  await vi.advanceTimersByTimeAsync(0)
  await closing
  expect(terminals.list()).toEqual([])
})

it('allows a revoked creator to discard an unadopted terminal without an extra claim', async () => {
  const pty = new FakePty()
  let displayed = true
  const origin = () => displayed
  const terminals = createAgentTerminals({
    spawnPty: () => pty,
    probePid: () => 'alive',
    superviseGroup: () => ({
      drain: async () => {
        pty.exit()
      },
    }),
    emit: () => {},
    log: () => {},
  })
  const opened = terminals.open({ ...on(), lease: origin })
  if (!opened.ok) throw new Error(opened.message)
  displayed = false
  expect(await terminals.discard(opened.id, origin)).toBe(true)
  expect(terminals.list()).toEqual([])
})

it('delivers each byte once across a replay whose parser barrier precedes live output', async () => {
  const { terminals, spawns, sent } = setup()
  const opened = terminals.open(on())
  if (!opened.ok) throw new Error(opened.message)
  const pty = spawns[0]!.pty
  pty.emit('replay-prefix')
  const replay = terminals.attach(opened.id, lease)
  pty.emit('stream-tail')
  const state = await replay
  const live = sent
    .filter(([name]) => name === 'pty-data')
    .map(([, payload]) => (payload as { data: string }).data)
    .join('')
  const combined = state + live
  expect(combined.match(/replay-prefix/g)).toHaveLength(1)
  expect(combined.match(/stream-tail/g)).toHaveLength(1)
  expect(combined.indexOf('replay-prefix')).toBeLessThan(combined.indexOf('stream-tail'))
  pty.exit()
  await terminals.closeAll()
})

it('settles pending replay when the terminal closes before its parser barrier', async () => {
  const pty = new FakePty()
  const terminals = createAgentTerminals({
    spawnPty: () => pty,
    probePid: () => 'alive',
    superviseGroup: () => ({
      drain: async () => {
        pty.exit()
      },
    }),
    emit: () => {},
    log: () => {},
  })
  const opened = terminals.open(on())
  if (!opened.ok) throw new Error(opened.message)
  const replay = terminals.attach(opened.id, lease)
  await terminals.close(opened.id)
  expect(await replay).toBe('')
  expect(terminals.list()).toEqual([])
})
