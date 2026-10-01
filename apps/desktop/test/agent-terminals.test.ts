import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyProcess } from '../src/main/agent/agent-runtime'
import { createAgentTerminals } from '../src/main/agent/agent-terminals'

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

const TARGET = { root: '/Users/ada/Holi/syv/vault', configDir: '/cfg/vault', binDir: '/holi/bin' }

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
    resolveBin: () => '/usr/local/bin/claude',
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
  it('opens the list, or one session, in the vault on its config dir', () => {
    const { terminals, spawns } = setup()
    terminals.open({ remote: 'syv/vault', target: TARGET })
    terminals.open({ remote: 'syv/vault', target: TARGET, attach: '1234abcd' })

    expect(spawns.map((s) => s.args)).toEqual([['agents'], ['attach', '1234abcd']])
    for (const { opts } of spawns) {
      expect(opts.cwd).toBe(TARGET.root)
      expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/cfg/vault')
      expect(opts.env.PATH.split(':')[0]).toBe('/holi/bin')
    }
    expect(terminals.list().map((t) => t.launchedFor)).toEqual([null, '1234abcd'])
  })

  it('finds the window it opened for a session, and the one on the list', () => {
    const { terminals } = setup()
    const list = terminals.open({ remote: 'syv/vault', target: TARGET })
    const one = terminals.open({ remote: 'syv/vault', target: TARGET, attach: '1234abcd' })
    expect(terminals.listTerminal()).toBe(list.ok ? list.id : null)
    expect(terminals.launchedFor('1234abcd')).toBe(one.ok ? one.id : null)
    expect(terminals.launchedFor('ffffffff')).toBeNull()
  })

  it('labels a terminal with the title its program sets', async () => {
    const { terminals, spawns, sent } = setup()
    terminals.open({ remote: 'syv/vault', target: TARGET })
    spawns[0]!.pty.emit('\x1b]0;claude agents\x07')
    await vi.waitFor(() => expect(terminals.list()[0]?.title).toBe('claude agents'))
    expect(sent.filter(([c]) => c === 'terminals').length).toBeGreaterThan(0)
  })

  it('holds a paste until the TUI has printed and settled, then sends it unsent', async () => {
    const { terminals, spawns } = setup()
    const res = terminals.open({ remote: 'syv/vault', target: TARGET, attach: '1234abcd' })
    const id = res.ok ? res.id : ''
    expect(terminals.paste(id, 'look at this')).toBe(true)
    expect(spawns[0]!.pty.writes).toEqual([])

    spawns[0]!.pty.emit('hello')
    await vi.waitFor(() =>
      expect(spawns[0]!.pty.writes).toEqual(['\x1b[200~look at this\x1b[201~']),
    )
    terminals.paste(id, 'again')
    expect(spawns[0]!.pty.writes.at(-1)).toBe('\x1b[200~again\x1b[201~')
    expect(spawns[0]!.pty.writes.join('')).not.toContain('\r')
  })

  it('gives up waiting on a terminal that never prints', async () => {
    const { terminals, spawns } = setup()
    const res = terminals.open({ remote: 'syv/vault', target: TARGET })
    terminals.paste(res.ok ? res.id : '', 'x')
    await vi.waitFor(() => expect(spawns[0]!.pty.writes).toHaveLength(1), { timeout: 1_000 })
  })

  it('streams output only once attached, after replaying the record', async () => {
    const { terminals, spawns, sent } = setup()
    const res = terminals.open({ remote: 'syv/vault', target: TARGET, notice: 'sign in\r\n' })
    const id = res.ok ? res.id : ''
    spawns[0]!.pty.emit('before')
    expect(sent.some(([c]) => c === 'pty-data')).toBe(false)

    const state = await terminals.attach(id)
    expect(state).toContain('sign in')
    expect(state).toContain('before')
    spawns[0]!.pty.emit('after')
    expect(sent).toContainEqual(['pty-data', { id, data: 'after' }])
  })

  it('drops a terminal whose client exits, and says so', () => {
    const { terminals, spawns, sent } = setup()
    const res = terminals.open({ remote: 'syv/vault', target: TARGET, attach: '1234abcd' })
    const id = res.ok ? res.id : ''
    spawns[0]!.pty.exit(0)
    expect(terminals.list()).toEqual([])
    expect(sent).toContainEqual(['pty-exit', { id, code: 0 }])
    expect(terminals.paste(id, 'x')).toBe(false)
  })

  it('closes a terminal even when its client never reports the exit', async () => {
    const { terminals, sent } = setup()
    const res = terminals.open({ remote: 'syv/vault', target: TARGET })
    const id = res.ok ? res.id : ''
    await terminals.close(id)
    expect(terminals.list()).toEqual([])
    expect(sent.some(([c, p]) => c === 'pty-exit' && (p as { id: string }).id === id)).toBe(true)
  })

  it('refuses without a binary', () => {
    const terminals = createAgentTerminals({
      emit: () => {},
      resolveBin: () => null,
      log: () => {},
    })
    expect(terminals.open({ remote: 'syv/vault', target: TARGET }).ok).toBe(false)
  })
})
