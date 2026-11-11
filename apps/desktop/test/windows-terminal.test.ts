/**
 * The bottom panel on Windows (docs/features/status-bar.md): which shell gets
 * the integration, what an OSC 7 from a Windows shell names, and that no `lsof`
 * is asked. The cases inject the platform, so they run the same on any OS; the ones that run
 * a real shell are for Windows only.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultShell, shellTitle } from '../src/main/terminal/default-shell'
import { shellLaunch, writeShellIntegration } from '../src/main/terminal/shell-integration'
import { createTerminals } from '../src/main/terminal/terminals'
import { homeLabel, parseOsc7, processCwd } from '../src/main/terminal/terminal-context'

const HOST = 'LAPTOP-1A2B'
const DIR = String.raw`C:\Users\ada\AppData\Local\Temp\holi-shell-x`

describe('shellLaunch', () => {
  it('matches a shell by its name with or without .exe', () => {
    for (const shell of [
      String.raw`C:\Program Files\Git\bin\bash.exe`,
      String.raw`C:\Program Files\Git\usr\bin\BASH.EXE`,
    ]) {
      const launch = shellLaunch(shell, {}, DIR, 'win32')
      expect(launch.args[0]).toBe('--init-file')
      expect(launch.args[1]).toMatch(/bash-init-win\.sh$/)
    }
  })

  it('hands Git Bash the init file with forward slashes', () => {
    const { args } = shellLaunch(String.raw`C:\Git\bin\bash.exe`, {}, DIR, 'win32')
    expect(args[1]).toBe('C:/Users/ada/AppData/Local/Temp/holi-shell-x/bash-init-win.sh')
  })

  it('starts PowerShell without -l, after the profile, with the integration', () => {
    for (const shell of [
      'pwsh.exe',
      String.raw`C:\Program Files\PowerShell\7\pwsh.exe`,
      String.raw`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`,
    ]) {
      const { args, env } = shellLaunch(shell, {}, DIR, 'win32')
      expect(args).not.toContain('-l')
      expect(args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command'])
      expect(args[3]).toContain('pwsh-init.ps1')
      expect(env).toEqual({})
    }
  })

  it('reads the integration as text, which no execution policy refuses', () => {
    const { args } = shellLaunch('pwsh.exe', {}, DIR, 'win32')
    expect(args[3]).toMatch(/^Invoke-Expression \(\[System\.IO\.File\]::ReadAllText\('/)
    const quoted = shellLaunch('pwsh', {}, String.raw`C:\Users\o'neil\t`, 'win32').args[3]
    expect(quoted).toContain(String.raw`C:\Users\o''neil\t\pwsh-init.ps1`)
  })

  it('starts PowerShell with no integration when there is no directory', () => {
    expect(shellLaunch('pwsh.exe', {}, null, 'win32').args).toEqual(['-NoLogo'])
  })

  it('gives cmd no arguments, since it has no login mode', () => {
    expect(shellLaunch(String.raw`C:\WINDOWS\system32\cmd.exe`, {}, DIR, 'win32').args).toEqual([])
  })

  it('leaves the WSL bash.exe in System32 a plain login shell', () => {
    const wsl = String.raw`C:\Windows\System32\bash.exe`
    expect(shellLaunch(wsl, {}, DIR, 'win32')).toEqual({ args: ['-l'], env: {} })
    expect(shellLaunch('C:\\Windows\\sysnative\\BASH.EXE', {}, DIR, 'win32').args).toEqual(['-l'])
  })

  it('gives MSYS zsh no shim, which could not report a Windows path', () => {
    const zsh = String.raw`C:\msys64\usr\bin\zsh.exe`
    expect(shellLaunch(zsh, {}, DIR, 'win32')).toEqual({ args: ['-l'], env: {} })
  })

  it('keeps the POSIX launches as they were', () => {
    expect(shellLaunch('/bin/bash', {}, '/tmp/h', 'linux')).toEqual({
      args: ['--init-file', '/tmp/h/bash-init.sh'],
      env: {},
    })
    expect(shellLaunch('/bin/zsh', { HOME: '/home/a' }, '/tmp/h', 'darwin')).toEqual({
      args: ['-l'],
      env: { HOLI_USER_ZDOTDIR: '/home/a', ZDOTDIR: '/tmp/h/zsh' },
    })
    // A POSIX shell named like a Windows one is not one.
    expect(shellLaunch('/usr/bin/bash.exe', {}, '/tmp/h', 'linux').args).toEqual(['-l'])
    expect(shellLaunch('/usr/bin/pwsh', {}, '/tmp/h', 'linux').args).toEqual(['-l'])
  })
})

describe('the PowerShell integration script', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is written beside the other shims and wraps the person’s own prompt', () => {
    dir = mkdtempSync(join(tmpdir(), 'holi-shell-test-'))
    writeShellIntegration(dir)
    expect(existsSync(join(dir, 'zsh', '.zshrc'))).toBe(true)
    const script = readFileSync(join(dir, 'pwsh-init.ps1'), 'utf8')
    expect(script).toContain('function global:prompt')
    expect(script).toContain(']7;')
    expect(script).toContain('AbsoluteUri')
    // Their prompt runs, and their $LASTEXITCODE survives it.
    expect(script).toContain('LASTEXITCODE')
    // Handing back a failed status must not write to their $Error.
    expect(script).toContain('-ErrorAction Ignore')
    // Windows PowerShell 5.1 has no `e escape.
    expect(script).not.toContain('`e')
    // Git Bash reports Windows paths; the script the others run does not.
    expect(readFileSync(join(dir, 'bash-init-win.sh'), 'utf8')).toContain('cygpath -m')
    expect(readFileSync(join(dir, 'bash-init.sh'), 'utf8')).not.toContain('cygpath')
    expect(script).toMatch(/^[\x20-\x7e\r\n\t]*$/)
  })
})

describe.runIf(process.platform === 'win32')(
  'the PowerShell script, run by Windows PowerShell',
  () => {
    it('prints the folder before their own prompt and leaves $? and $LASTEXITCODE as they were', () => {
      const dir = mkdtempSync(join(tmpdir(), 'holi-shell-run-'))
      try {
        writeShellIntegration(dir)
        const script = join(dir, 'pwsh-init.ps1')
        const powershell = join(
          process.env.SystemRoot!,
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        )
        const command = [
          'function prompt { "[ok=$($?) code=$($LASTEXITCODE)] PS> " }',
          `Invoke-Expression ([System.IO.File]::ReadAllText('${script}'))`,
          'cmd /c exit 7',
          '$a = prompt',
          'Get-Item C:\\Windows | Out-Null',
          '$b = prompt',
          '$a; $b',
        ].join('; ')
        const out = execFileSync(powershell, ['-NoProfile', '-NoLogo', '-Command', command], {
          encoding: 'utf8',
        })
        const [first, second] = out.split('\r\n')
        expect(first).toMatch(/^\x1b\]7;file:\/\/\/[A-Z]:\/.*\x07\[ok=False code=7\] PS> $/)
        expect(second).toMatch(/\[ok=True code=7\] PS> $/)
        const folder = /^\x1b\]7;(.*)\x07/.exec(first!)![1]!
        expect(parseOsc7(folder, 'any-host', 'win32')?.toLowerCase()).toBe(
          process.cwd().toLowerCase(),
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  },
)

describe.runIf(process.platform === 'win32')('under Set-StrictMode', () => {
  it('still wraps the prompt when the profile turned strict mode on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'holi-shell-strict-'))
    try {
      writeShellIntegration(dir)
      const script = join(dir, 'pwsh-init.ps1')
      const powershell = join(
        process.env.SystemRoot!,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      )
      const command = [
        'Set-StrictMode -Version Latest',
        'function prompt { "PS> " }',
        `Invoke-Expression ([System.IO.File]::ReadAllText('${script}'))`,
        'prompt',
      ].join('; ')
      const out = execFileSync(powershell, ['-NoProfile', '-NoLogo', '-Command', command], {
        encoding: 'utf8',
      })
      expect(out).toMatch(/^\x1b\]7;file:\/\/\/.*\x07PS> /)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
describe.runIf(process.platform === 'win32' && existsSync(GIT_BASH))(
  'the Git Bash script, run by Git Bash',
  () => {
    it('reports a folder under an MSYS-only root as a Windows folder', () => {
      const dir = mkdtempSync(join(tmpdir(), 'holi-shell-bash-'))
      try {
        writeShellIntegration(dir)
        const init = join(dir, 'bash-init-win.sh').replaceAll('\\', '/')
        const out = execFileSync(GIT_BASH, ['--init-file', init, '-i'], {
          input: 'cd /tmp\n__holi_osc7\ncd /c/Windows\n__holi_osc7\nexit\n',
          encoding: 'utf8',
          // Not the developer's own startup files: a temp HOME has none.
          env: { ...process.env, HOME: dir, USERPROFILE: dir },
        })
        const found = [...out.matchAll(/\x1b\]7;([^\x07]*)\x07/g)].map((m) =>
          parseOsc7(m[1]!, hostname(), 'win32'),
        )
        expect(found.length).toBeGreaterThanOrEqual(2)
        expect(found.every((path) => path !== null && existsSync(path))).toBe(true)
        expect(found.at(-1)?.toLowerCase()).toBe('c:\\windows')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  },
)

describe('parseOsc7 on Windows', () => {
  const parse = (payload: string) => parseOsc7(payload, HOST, 'win32')

  it('reads a drive-letter path, whatever the host spelling', () => {
    expect(parse(`file://${HOST}/C:/Users/ada`)).toBe(String.raw`C:\Users\ada`)
    expect(parse('file:///C:/Users/ada/My%20Docs')).toBe(String.raw`C:\Users\ada\My Docs`)
    expect(parse(`file://${HOST}/C%3A/Users/ada`)).toBe(String.raw`C:\Users\ada`)
    expect(parse(String.raw`file://${HOST}/C:\Users\ada`)).toBe(String.raw`C:\Users\ada`)
    expect(parse(`file://${HOST.toLowerCase()}/D:/`)).toBe('D:\\')
  })

  it('reads the MSYS form Git Bash prints', () => {
    expect(parse(`file://${HOST}/c/Users/ada`)).toBe(String.raw`C:\Users\ada`)
    expect(parse(`file://${HOST}/c/`)).toBe('C:\\')
    expect(parse(`file://${HOST}/c`)).toBe('C:\\')
  })

  it('refuses what is not a folder on this machine', () => {
    expect(parse(`file://${HOST}/Users/ada`)).toBeNull()
    expect(parse(`file://${HOST}/usr/bin`)).toBeNull()
    expect(parse('file://other-host/C:/Users/ada')).toBeNull()
    expect(parse(`file://${HOST}/C:/a%00b`)).toBeNull()
    expect(parse('http://x/C:/a')).toBeNull()
  })

  it('does not change what a POSIX shell reports', () => {
    expect(parseOsc7('file://MacBook.local/Users/me/a%20b', 'MacBook.local', 'darwin')).toBe(
      '/Users/me/a b',
    )
    expect(parseOsc7('file://h/C:/Users/ada', 'h', 'linux')).toBe('/C:/Users/ada')
    expect(parseOsc7('file://h/c/Users/ada', 'h', 'linux')).toBe('/c/Users/ada')
  })
})

describe('homeLabel on Windows', () => {
  it('abbreviates the home folder with the OS separator and case rules', () => {
    const home = String.raw`C:\Users\ada`
    expect(homeLabel(String.raw`C:\Users\ada\Holi`, home, 'win32')).toBe(String.raw`~\Holi`)
    expect(homeLabel(String.raw`c:\users\ada`, home, 'win32')).toBe('~')
    expect(homeLabel(String.raw`C:\Users\adam`, home, 'win32')).toBe(String.raw`C:\Users\adam`)
    expect(homeLabel('/Users/ada/x', '/Users/ada', 'darwin')).toBe('~/x')
  })
})

describe('processCwd', () => {
  it('never runs lsof on Windows', async () => {
    const asked: string[] = []
    const run = async (file: string) => {
      asked.push(file)
      return 'n/tmp\n'
    }
    expect(await processCwd(42, run, 'win32')).toBeNull()
    expect(asked).toEqual([])
    expect(await processCwd(42, run, 'linux')).toBe('/tmp')
    expect(asked).toEqual(['lsof'])
  })
})

describe('the panel’s shell on Windows', () => {
  const WIN = { SystemRoot: 'C:\\Windows' } as NodeJS.ProcessEnv
  const GIT_BASH = 'C:\\Git\\bin\\bash.exe'

  it('falls back to Windows PowerShell, not /bin/zsh, when SHELL is unset', () => {
    expect(defaultShell(WIN, 'win32')).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(defaultShell({}, 'win32')).toMatch(/^C:\\Windows\\System32\\/)
    expect(defaultShell({}, 'win32')).toMatch(/WindowsPowerShell.v1\.0.powershell\.exe$/)
  })

  it('keeps SHELL where the person set it, and /bin/zsh off Windows', () => {
    expect(defaultShell({ SHELL: GIT_BASH }, 'win32')).toBe(GIT_BASH)
    expect(defaultShell({ SHELL: '/bin/fish' }, 'linux')).toBe('/bin/fish')
    expect(defaultShell({}, 'darwin')).toBe('/bin/zsh')
    expect(defaultShell({}, 'linux')).toBe('/bin/zsh')
  })

  it('titles a tab by the shell’s name without .exe', () => {
    expect(shellTitle(GIT_BASH, 'win32')).toBe('bash')
    expect(shellTitle(String.raw`C:\Git\bin\BASH.EXE`, 'win32')).toBe('BASH')
    expect(shellTitle('/bin/zsh', 'darwin')).toBe('zsh')
  })

  function open(platform: NodeJS.Platform, shell: string, dir: string | null) {
    const spawned: { file: string; args: string[]; env: Record<string, string> }[] = []
    const dataCbs: ((d: string) => void)[] = []
    const events: { kind: string; context?: { cwd: string; label: string } }[] = []
    const terminals = createTerminals({
      send: (e) => events.push(e),
      platform,
      shell: () => shell,
      baseEnv: () => ({ PATH: 'C:\\bin' }),
      integrationDir: () => dir,
      gitSummary: async () => null,
      isDirectory: async () => true,
      home: 'C:\\Users\\ada',
      contextDelayMs: 1,
      spawnPty: (file, args, opts) => {
        spawned.push({ file, args, env: opts.env })
        return {
          pid: 4242,
          onData: (cb) => dataCbs.push(cb),
          onExit: () => {},
          write: () => {},
          resize: () => {},
          kill: () => {},
        }
      },
    })
    return { terminals, spawned, print: (d: string) => dataCbs.forEach((cb) => cb(d)), events }
  }

  it('starts PowerShell with its own arguments and the integration', () => {
    const { terminals, spawned } = open('win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', DIR)
    const res = terminals.create({ remote: 'o/r', root: 'C:\\v', cols: 80, rows: 24 })
    expect(res).toMatchObject({ ok: true, terminal: { title: 'pwsh' } })
    expect(spawned[0]!.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command'])
  })

  it('follows the folder a Windows shell reports, and shows the home as ~', async () => {
    const { terminals, print, events } = open('win32', GIT_BASH, DIR)
    terminals.create({ remote: 'o/r', root: 'C:\\v', cols: 80, rows: 24 })
    print('\x1b]7;file:///c/Users/ada/Holi\x07')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const last = events.filter((e) => e.kind === 'context').pop()
    expect(last?.context).toMatchObject({ cwd: 'C:\\Users\\ada\\Holi', label: '~\\Holi' })
    await terminals.closeAll()
  })
})
