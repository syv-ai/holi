import { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobsProvider } from '../main/provider'

import { describe, expect, it, vi } from 'vitest'
import { buildAgentEnv, notInstalledText } from '../main/claude/cli'
import { notInstalledText as codexNotInstalled } from '../main/codex'
import { createJobs } from '../main/host/jobs'
import { AgentRuntime, type PidState, type PtyProcess } from '../main/host/pty'
import { isFullPath, notFound, presetOf, readHarness } from '../main/harness/record'
import { shellEnv } from '../../../main/terminal/terminals'
import { signalPty } from '../../../main/terminal/pty'

/** The Windows environment an Explorer or Start-menu launch hands Holi: the
 *  key is `Path`, and there is no `PATH`. */
const EXPLORER = {
  Path: 'C:\\Windows\\system32;C:\\Users\\ada\\AppData\\Roaming\\npm',
  USERPROFILE: 'C:\\Users\\ada',
  APPDATA: 'C:\\Users\\ada\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local',
}

const pathKeys = (env: Record<string, string>) =>
  Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')

describe('the agent environment on Windows', () => {
  const env = buildAgentEnv(EXPLORER, {
    platform: 'win32',
    binDir: 'C:\\holi\\bin',
    commandsDir: 'C:\\vault\\.holi\\commands',
  })

  it('has one PATH key, the one the launch had', () => {
    expect(pathKeys(env)).toEqual(['Path'])
  })

  it('joins with a semicolon: Holi’s bin first, the machine’s folders, then the fallbacks', () => {
    const dirs = env.Path!.split(';')
    expect(dirs[0]).toBe('C:\\holi\\bin')
    expect(dirs).toContain('C:\\Users\\ada\\AppData\\Roaming\\npm')
    expect(dirs.indexOf('C:\\Windows\\system32')).toBe(1)
    expect(dirs.slice(-2)).toEqual(['C:\\holi\\bin\\fallback', 'C:\\vault\\.holi\\commands'])
    // The npm folder is on the inherited PATH and in the fallbacks: listed once.
    expect(dirs.filter((dir) => dir === 'C:\\Users\\ada\\AppData\\Roaming\\npm')).toHaveLength(1)
  })

  it('still strips the nested-session guards', () => {
    const guarded = buildAgentEnv({ ...EXPLORER, CLAUDECODE: '1' }, { platform: 'win32' })
    expect(guarded.CLAUDECODE).toBeUndefined()
    expect(guarded.TERM).toBe('xterm-256color')
  })

  it('is the colon-joined PATH it always was on macOS and Linux', () => {
    const posix = buildAgentEnv(
      { PATH: '/usr/bin', HOME: '/h' },
      { platform: 'darwin', binDir: '/holi/bin' },
    )
    expect(pathKeys(posix)).toEqual(['PATH'])
    expect(posix.PATH!.startsWith('/holi/bin:/usr/bin:/opt/homebrew/bin')).toBe(true)
    expect(posix.PATH!.endsWith('/holi/bin/fallback')).toBe(true)
  })
})

describe('a panel shell’s environment', () => {
  it('prepends Holi’s bin to the Path a Windows launch has, under that one key', () => {
    const env = shellEnv(EXPLORER, 'C:\\holi\\bin', 'win32')
    expect(pathKeys(env)).toEqual(['Path'])
    expect(env.Path!.startsWith('C:\\holi\\bin;C:\\Windows\\system32')).toBe(true)
  })

  it('prepends with a colon elsewhere', () => {
    expect(shellEnv({ PATH: '/usr/bin' }, '/holi/bin', 'linux').PATH).toBe('/holi/bin:/usr/bin')
  })
})

describe('when an agent is not installed', () => {
  it('gives Windows each agent’s install command, and every other OS the text it has had', () => {
    expect(notInstalledText('win32')).toContain('irm https://claude.ai/install.ps1 | iex')
    expect(codexNotInstalled('win32')).toContain('npm install -g @openai/codex')
    for (const platform of ['darwin', 'linux'] as const) {
      expect(notInstalledText(platform)).toBe(
        'Claude CLI not found on PATH. Install it (https://claude.com/claude-code) and restart Holi.',
      )
      expect(codexNotInstalled(platform)).toBe(
        'Codex CLI not found on PATH. Install it (https://developers.openai.com/codex/cli) and restart Holi.',
      )
    }
  })
})

describe('a harness’s program on Windows', () => {
  it('is a full path with a drive letter or a share, as well as one that starts with /', () => {
    for (const bin of [
      'C:\\Program Files\\x\\a.exe',
      'D:/tools/a.cmd',
      '\\\\server\\share\\a.exe',
    ]) {
      expect(isFullPath(bin, 'win32')).toBe(true)
      expect(isFullPath(bin, 'linux')).toBe(false)
    }
    expect(isFullPath('/usr/bin/a', 'win32')).toBe(true)
    expect(isFullPath('claude', 'win32')).toBe(false)
    expect(isFullPath('..\\a.exe', 'win32')).toBe(false)
  })

  it('says a full path is not an executable file, rather than not on PATH', () => {
    const harness = readHarness({
      ...presetOf('claude'),
      id: 'mine',
      integration: undefined,
      command: { bin: process.platform === 'win32' ? 'C:\\nope\\a.exe' : '/nope/a', args: [] },
    })
    expect(harness.ok).toBe(true)
    if (harness.ok) expect(notFound(harness.harness)).toContain('is not an executable file')
  })
})

/** A PTY that records how it was stopped. */
class FakePty implements PtyProcess {
  kills: Array<string | undefined> = []
  private exitCb: ((e: { exitCode: number }) => void) | null = null
  constructor(readonly pid = 4242) {}
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb
  }
  write() {}
  resize() {}
  kill(signal?: string) {
    this.kills.push(signal)
  }
  exit() {
    this.exitCb?.({ exitCode: 0 })
  }
}

const probe = (state: PidState) => () => state

describe('stopping an agent on Windows', () => {
  it('stops the tree by taskkill, closes the PTY without a signal, and never uses a negative pid', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const pty = new FakePty(4242)
      const taskkill = vi.fn((_pid: number, done?: () => void) => done?.())
      const runtime = new AgentRuntime({
        spawnPty: () => pty,
        platform: 'win32',
        probePid: probe('group-leader'),
        taskkill,
        killGraceMs: 30,
        killBackstopMs: 200,
      })
      runtime.start({ bin: 'C:\\x\\claude.exe', args: [], cwd: 'C:\\v', env: {} })
      const killed = runtime.kill()
      pty.exit()
      await killed
      expect(taskkill).toHaveBeenCalledWith(4242, expect.any(Function))
      expect(pty.kills).toEqual([undefined])
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it('closes a child that is alive but not a tree root without a signal, and a gone one not at all', () => {
    const taskkill = vi.fn()
    const alive = new FakePty()
    signalPty(alive, 'SIGTERM', probe('alive'), 'win32', taskkill)
    expect(alive.kills).toEqual([undefined])
    const gone = new FakePty()
    signalPty(gone, 'SIGKILL', probe('gone'), 'win32', taskkill)
    expect(gone.kills).toEqual([])
    expect(taskkill).not.toHaveBeenCalled()
  })

  it('leaves macOS and Linux signalling the group and the child by name', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const leader = new FakePty(4242)
      signalPty(leader, 'SIGTERM', probe('group-leader'), 'linux')
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
      expect(leader.kills).toEqual([])
      const alive = new FakePty()
      signalPty(alive, 'SIGHUP', probe('alive'), 'darwin')
      expect(alive.kills).toEqual(['SIGHUP'])
    } finally {
      kill.mockRestore()
    }
  })
})

it.each(['reused PID', 'matching live PID', 'missing receipt', 'unexpected entry'])(
  'admits a Windows job with %s after restart',
  async (kind) => {
    const data = await mkdtemp(join(tmpdir(), 'holi-jobs-windows-fake-'))
    const scratchRoot = join(data, 'jobs')
    await mkdir(scratchRoot)
    await writeFile(join(data, 'note'), 'vault contents')
    const hasReceipt = kind === 'reused PID' || kind === 'matching live PID'
    if (hasReceipt)
      await writeFile(join(scratchRoot, 'j0123456789ab.pid'), `4242\n${scratchRoot}\n`)
    else
      await mkdir(
        join(scratchRoot, kind === 'missing receipt' ? 'j0123456789ab.agent' : 'unexpected'),
      )
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    try {
      const child = new ChildProcess()
      child.kill = vi.fn()
      const spawn = vi.fn(() => child)
      const provider: JobsProvider = {
        id: 'codex',
        label: 'Codex',
        notInstalled: 'missing',
        installed: () => true,
        configure: async () => ({ dir: data }),
        terminal: () => null,
        capabilities: {
          jobs: { command: () => ({ bin: 'fake', args: [], env: {} }), event: () => null },
        },
      }
      const recovery = {
        probePid: vi.fn(() => 'group-leader' as const),
        commandOf: vi.fn(() =>
          kind === 'matching live PID' ? `fixture ${scratchRoot}` : 'some other application',
        ),
        stopTree: vi.fn(),
      }
      const jobs = createJobs({
        vault: { remote: 'fixture/windows', root: data },
        scratchRoot,
        spawn,
        windowsRecovery: recovery,
        onChange: () => {},
      })
      expect(await jobs.start({ provider, name: 'fake', prompt: 'go', allow: [] })).toMatchObject({
        ok: true,
      })
      child.emit('close', 0, null)
      await jobs.leave()
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(recovery.probePid).toHaveBeenCalledTimes(hasReceipt ? 1 : 0)
      expect(recovery.stopTree.mock.calls).toEqual(kind === 'matching live PID' ? [[4242]] : [])
      expect(kill).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
      expect(await readFile(join(data, 'note'), 'utf8')).toBe('vault contents')
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
      kill.mockRestore()
      await rm(data, { recursive: true, force: true })
    }
  },
)
