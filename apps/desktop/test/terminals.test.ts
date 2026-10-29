/**
 * The bottom panel's shells (docs/features/status-bar.md), over a fake PTY:
 * which shell runs where, what crosses to the renderer, and that one vault's
 * terminal is never another's.
 */
import { describe, expect, it } from 'vitest'
import type { PtyProcess, SpawnPtyOptions } from '../src/main/terminal/pty'
import {
  createTerminals,
  shellEnv,
  type TerminalEvent,
  type TerminalsDeps,
} from '../src/main/terminal/terminals'

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

function rig(over: Partial<TerminalsDeps> = {}) {
  const ptys: FakePty[] = []
  const events: TerminalEvent[] = []
  const summaries: string[] = []
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
    integrationDir: () => null,
    gitSummary: async (cwd) => {
      summaries.push(cwd)
      return { branch: 'main', files: summaries.length, added: 1, removed: 0 }
    },
    processCwd: async () => null,
    isDirectory: async (path) => !path.includes('missing'),
    home: '/home/me',
    contextDelayMs: 1,
    ...over,
  })
  return { terminals, ptys, events, summaries }
}

const settle = () => new Promise((r) => setTimeout(r, 30))
const contexts = (events: TerminalEvent[]) =>
  events.flatMap((e) => (e.kind === 'context' ? [e.context] : []))

describe('terminals', () => {
  it("starts the login shell in the vault's clone, at the panel's size", () => {
    const { terminals, ptys } = rig()
    const opened = terminals.create({ remote: 'o/r', root: '/vaults/o/r', cols: 100, rows: 30 })
    expect(opened).toEqual({
      ok: true,
      terminal: { id: 't1', title: 'zsh', exitCode: null, context: null },
    })
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

  it('reads the context at the start, then from each OSC 7 prompt, in that terminal only', async () => {
    const { terminals, ptys, events, summaries } = rig()
    terminals.create({ remote: 'o/r', root: '/home/me/vault', cols: 80, rows: 24 })
    await settle()
    expect(contexts(events)).toEqual([
      {
        cwd: '/home/me/vault',
        label: '~/vault',
        git: { branch: 'main', files: 1, added: 1, removed: 0 },
      },
    ])
    // A cd, its prompt split across two chunks.
    ptys[0]!.print('\x1b]7;file://localhost/home/me/va')
    ptys[0]!.print('ult/notes\x07% ')
    await settle()
    expect(events.at(-1)).toMatchObject({
      kind: 'context',
      remote: 'o/r',
      id: 't1',
      context: { cwd: '/home/me/vault/notes', label: '~/vault/notes' },
    })
    // The same cwd again: the git work is read again all the same.
    ptys[0]!.print('\x1b]7;file://localhost/home/me/vault/notes\x1b\\% ')
    await settle()
    expect(summaries).toEqual(['/home/me/vault', '/home/me/vault/notes', '/home/me/vault/notes'])
    expect(terminals.list('o/r')[0]!.context?.git?.files).toBe(3)
  })

  it('ignores an OSC 7 for a folder that is not there, or another machine', async () => {
    const { terminals, ptys, events } = rig()
    terminals.create({ remote: 'o/r', root: '/r', cols: 80, rows: 24 })
    ptys[0]!.print('\x1b]7;file://localhost/r/missing\x07')
    ptys[0]!.print('\x1b]7;file://some.server.example/etc\x07')
    await settle()
    expect(contexts(events).map((c) => c.cwd)).toEqual(['/r'])
  })

  it('asks the OS for the cwd of a shell without the integration', async () => {
    const asked: number[] = []
    const { terminals, ptys, events } = rig({
      processCwd: async (pid) => {
        asked.push(pid)
        return '/r/sub'
      },
    })
    terminals.create({ remote: 'o/r', root: '/r', cols: 80, rows: 24 })
    ptys[0]!.print('$ ')
    await settle()
    expect(asked).toEqual([ptys[0]!.pid])
    expect(contexts(events).at(-1)?.cwd).toBe('/r/sub')
  })

  it('starts zsh through the integration when there is one', () => {
    const { terminals, ptys } = rig({ integrationDir: () => '/tmp/holi-shell' })
    terminals.create({ remote: 'o/r', root: '/r', cols: 80, rows: 24 })
    expect(ptys[0]!.args).toEqual(['-l'])
    expect(ptys[0]!.opts.env).toMatchObject({
      ZDOTDIR: '/tmp/holi-shell/zsh',
      HOLI_USER_ZDOTDIR: '/home/me',
    })
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
