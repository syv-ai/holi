/**
 * The bottom panel's shells (docs/features/status-bar.md), over a fake PTY:
 * which shell runs where, what crosses to the renderer, and that one vault's
 * terminal is never another's.
 */
import { describe, expect, it } from 'vitest'
import type { PtyProcess, SpawnPtyOptions } from '../src/main/terminal/pty'
import { createTerminals, shellEnv, type TerminalEvent } from '../src/main/terminal/terminals'

class FakePty implements PtyProcess {
  static nextPid = 1000
  readonly pid = FakePty.nextPid++
  written: string[] = []
  size: [number, number] | null = null
  signals: string[] = []
  private dataCbs: ((d: string) => void)[] = []
  private exitCbs: ((e: { exitCode: number }) => void)[] = []
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly opts: SpawnPtyOptions,
  ) {}
  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb)
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb)
  }
  write(d: string) {
    this.written.push(d)
  }
  resize(cols: number, rows: number) {
    this.size = [cols, rows]
  }
  kill(signal?: string) {
    this.signals.push(signal ?? 'SIGHUP')
    this.exit(129)
  }
  print(d: string) {
    for (const cb of this.dataCbs) cb(d)
  }
  exit(code: number) {
    for (const cb of this.exitCbs) cb({ exitCode: code })
  }
}

function rig() {
  const ptys: FakePty[] = []
  const events: TerminalEvent[] = []
  const terminals = createTerminals({
    send: (e) => events.push(e),
    spawnPty: (file, args, opts) => {
      const p = new FakePty(file, args, opts)
      ptys.push(p)
      return p
    },
    // 'alive': signalled through node-pty itself, never a process group.
    probePid: () => 'alive',
    shell: () => '/bin/zsh',
    baseEnv: () => ({ PATH: '/usr/bin', HOME: '/home/me', ELECTRON_RUN_AS_NODE: '1' }),
    binDir: () => '/app/bin',
    killGraceMs: 20,
  })
  return { terminals, ptys, events }
}

describe('terminals', () => {
  it("starts the login shell in the vault's clone, at the panel's size", () => {
    const { terminals, ptys } = rig()
    const opened = terminals.create({ remote: 'o/r', root: '/vaults/o/r', cols: 100, rows: 30 })
    expect(opened).toEqual({ ok: true, terminal: { id: 't1', title: 'zsh', exitCode: null } })
    const pty = ptys[0]!
    expect(pty.file).toBe('/bin/zsh')
    expect(pty.args).toEqual(['-l'])
    expect(pty.opts).toMatchObject({ cwd: '/vaults/o/r', cols: 100, rows: 30 })
    expect(pty.opts.env).toMatchObject({
      TERM: 'xterm-256color',
      HOME: '/home/me',
      PATH: '/app/bin:/usr/bin',
    })
    expect(pty.opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('numbers the second shell, and reuses a freed name', async () => {
    const { terminals } = rig()
    terminals.create({ remote: 'o/r', root: '/r', cols: 80, rows: 24 })
    terminals.create({ remote: 'o/r', root: '/r', cols: 80, rows: 24 })
    expect(terminals.list('o/r').map((t) => t.title)).toEqual(['zsh', 'zsh 2'])
    await terminals.kill('o/r', 't1')
    terminals.create({ remote: 'o/r', root: '/r', cols: 80, rows: 24 })
    expect(terminals.list('o/r').map((t) => t.title)).toEqual(['zsh 2', 'zsh'])
  })

  it('pushes output and exit, and keeps output for a replay', () => {
    const { terminals, ptys, events } = rig()
    terminals.create({ remote: 'o/r', root: '/r', cols: 80, rows: 24 })
    ptys[0]!.print('$ ')
    ptys[0]!.print('git log\r\n')
    ptys[0]!.exit(0)
    expect(events).toEqual([
      { kind: 'data', remote: 'o/r', id: 't1', data: '$ ' },
      { kind: 'data', remote: 'o/r', id: 't1', data: 'git log\r\n' },
      { kind: 'exit', remote: 'o/r', id: 't1', exitCode: 0 },
    ])
    expect(terminals.replay('o/r', 't1')).toBe('$ git log\r\n')
    expect(terminals.list('o/r')[0]!.exitCode).toBe(0)
  })

  it("writes and resizes only the named vault's terminal", () => {
    const { terminals, ptys } = rig()
    terminals.create({ remote: 'o/r', root: '/r', cols: 80, rows: 24 })
    terminals.write('o/r', 't1', 'ls\r')
    terminals.write('someone/else', 't1', 'rm -rf ~\r')
    terminals.resize('o/r', 't1', 120.7, 40)
    terminals.resize('someone/else', 't1', 10, 10)
    expect(ptys[0]!.written).toEqual(['ls\r'])
    expect(ptys[0]!.size).toEqual([120, 40])
    expect(terminals.list('someone/else')).toEqual([])
    expect(terminals.replay('someone/else', 't1')).toBe('')
  })

  it('kill hangs up the shell and forgets it', async () => {
    const { terminals, ptys, events } = rig()
    terminals.create({ remote: 'o/r', root: '/r', cols: 80, rows: 24 })
    await terminals.kill('o/r', 't1')
    expect(ptys[0]!.signals).toEqual(['SIGHUP'])
    expect(terminals.list('o/r')).toEqual([])
    // A terminal the panel closed says nothing more.
    expect(events.filter((e) => e.kind === 'exit')).toEqual([])
  })

  it('closeAll stops every shell, in every vault', async () => {
    const { terminals, ptys } = rig()
    terminals.create({ remote: 'o/r', root: '/r', cols: 80, rows: 24 })
    terminals.create({ remote: 'o/r', root: '/r', cols: 80, rows: 24 })
    await terminals.closeAll()
    expect(ptys.map((p) => p.signals)).toEqual([['SIGHUP'], ['SIGHUP']])
    expect(terminals.list('o/r')).toEqual([])
  })

  it('a node-pty that will not load is an answer with the rebuild hint, not a throw', () => {
    const terminals = createTerminals({
      send: () => {},
      spawnPty: () => {
        throw new Error(
          "The module 'pty.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127",
        )
      },
    })
    const opened = terminals.create({ remote: 'o/r', root: '/r', cols: 80, rows: 24 })
    expect(opened.ok).toBe(false)
    expect(!opened.ok && opened.message).toMatch(/rebuild:natives/)
  })
})

describe('shellEnv', () => {
  it('works without a bin directory or a PATH', () => {
    expect(shellEnv({}, null)).toEqual({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Holi',
    })
    expect(shellEnv({}, '/b').PATH).toBe('/b')
  })
})
