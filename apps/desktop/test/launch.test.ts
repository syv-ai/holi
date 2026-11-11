import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commandLine, launchPlan, quoteForCmd, spawnProgram } from '../src/main/launch'
import { defaultProbePid, killChildTree, killTree } from '../src/main/process-group'

const WIN = { platform: 'win32' } as const

describe('launchPlan', () => {
  it('leaves every program alone on macOS and Linux, a .cmd by name included', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(launchPlan('/x/claude.cmd', ['a b', '--c'], { platform })).toEqual({
        file: '/x/claude.cmd',
        args: ['a b', '--c'],
        verbatim: false,
      })
    }
  })

  it('leaves an .exe alone on Windows', () => {
    expect(launchPlan('C:\\x\\claude.exe', ['a b'], WIN)).toEqual({
      file: 'C:\\x\\claude.exe',
      args: ['a b'],
      verbatim: false,
    })
  })

  it('runs a .cmd or .bat through cmd.exe /d /s /c, as one verbatim line', () => {
    const plan = launchPlan('C:\\Users\\Ada Lovelace\\npm\\claude.cmd', ['agents', '--json'], {
      ...WIN,
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    })
    expect(plan.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(plan.verbatim).toBe(true)
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    const line = ['C:\\Users\\Ada Lovelace\\npm\\claude.cmd', 'agents', '--json']
    // The file once, its arguments twice: a .cmd hands them on through %*.
    const [file, ...rest] = line
    expect(plan.args[3]).toBe(
      `"${[`"${file}"`, ...rest.map((arg) => quoteForCmd(arg, true))].join(' ')}"`,
    )
    expect(launchPlan('x.BAT', [], { ...WIN, env: {} }).file).toBe('cmd.exe')
  })

  it('looks a bare name up first, and runs what it finds the way its file needs', () => {
    const resolve = vi.fn(() => 'C:\\npm\\pnpm.cmd')
    const plan = launchPlan('pnpm', ['install'], { ...WIN, env: {}, resolve })
    expect(resolve).toHaveBeenCalledWith('pnpm', {})
    expect(plan.verbatim).toBe(true)
    expect(plan.args[3]).toContain('pnpm.cmd')
    // Not found: the name goes to spawn as it is, which says why.
    expect(launchPlan('nope', [], { ...WIN, resolve: () => null }).file).toBe('nope')
  })

  it('hands node-pty the line as one string, where an array would be quoted again', () => {
    const plan = launchPlan('C:\\n\\claude.cmd', ['a'], { ...WIN, env: { ComSpec: 'cmd.exe' } })
    expect(commandLine(plan)).toBe(`/d /s /c ""C:\\n\\claude.cmd" ${quoteForCmd('a', true)}"`)
    const posix = launchPlan('/n/claude', ['a'], { platform: 'linux' })
    expect(commandLine(posix)).toEqual(['a'])
  })
})

describe('quoteForCmd', () => {
  it('quotes for the program and escapes what cmd.exe itself acts on', () => {
    expect(quoteForCmd('plain')).toBe('^"plain^"')
    expect(quoteForCmd('a b')).toBe('^"a b^"')
    expect(quoteForCmd('a&b|c')).toBe('^"a^&b^|c^"')
    expect(quoteForCmd('%PATH%')).toBe('^"^%PATH^%^"')
    expect(quoteForCmd('say "hi"')).toBe(String.raw`^"say \^"hi\^"^"`)
    expect(quoteForCmd('')).toBe('^"^"')
  })

  it('doubles the backslashes that would otherwise escape a closing quote', () => {
    expect(quoteForCmd('C:\\dir\\')).toBe('^"C:\\dir\\\\^"')
  })

  it('turns a line break into a space, since cmd.exe cannot carry one', () => {
    expect(quoteForCmd('one\r\ntwo\nthree')).toBe('^"one two three^"')
  })
})

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('a real .cmd on Windows', () => {
  const NASTY = [
    ['plain'],
    ['say "hi & echo INJECTED'],
    ['x " > injected.txt'],
    ['a "b" & c'],
    ['approval_policy="never"', 'writable_roots=["C:\\x"]'],
    ['two words'],
    ['a&b', 'c|d', '>x', '<y'],
    ['%PATH%', '%NOPE%', '!x!'],
    ['q"uote', 'back\\', 'back\\"x'],
    ['--', '- tidy (list) ^ caret'],
    ['--allowedTools=Bash(git:*)'],
    [''],
    ["it's `tick`"],
    ['C:\\Program Files\\x y\\'],
  ]

  it.runIf(process.platform === 'win32')(
    'receives every argument exactly as given',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-launch-'))
      dirs.push(dir)
      // The shape of an npm shim: a batch file that passes %* to node.
      await writeFile(join(dir, 'show.js'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
      // A folder with a space in it, as a Windows account name can have.
      await mkdir(join(dir, 'Ada Lovelace'))
      await writeFile(
        join(dir, 'Ada Lovelace', 'show.js'),
        'console.log(JSON.stringify(process.argv.slice(2)))\n',
      )
      const shim = join(dir, 'Ada Lovelace', 'tool.cmd')
      await writeFile(shim, `@ECHO off\r\n"${process.execPath}" "%~dp0show.js" %*\r\n`)
      for (const args of NASTY) {
        const plan = launchPlan(shim, args, WIN)
        const out = await new Promise<string>((resolve, reject) => {
          const child = execFile(
            plan.file,
            plan.args,
            { cwd: dir, windowsVerbatimArguments: true, windowsHide: true },
            (err, stdout) => (err ? reject(err) : resolve(stdout)),
          )
          child.stdin?.end()
        })
        expect(JSON.parse(out)).toEqual(args)
      }
      // A quote followed by a metacharacter must not run anything.
      expect(existsSync(join(dir, 'injected.txt'))).toBe(false)
    },
    30_000,
  )
})

describe('spawnProgram', () => {
  it('reports a start that throws as the error event every caller handles', async () => {
    // A NUL cannot be in an argument: spawn throws synchronously, as it does
    // for a .cmd it refuses (EINVAL).
    const child = spawnProgram(
      process.execPath,
      ['a\0b'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
      { platform: 'win32' },
    )
    const error = await new Promise<Error>((resolve) => child.once('error', resolve))
    expect(error).toBeInstanceOf(Error)
    expect(child.stdout).not.toBeNull()
  })

  it('leaves the throw as it is on macOS and Linux, where callers have always had it', () => {
    expect(() =>
      spawnProgram(process.execPath, ['a\0b'], { stdio: 'ignore' }, { platform: 'linux' }),
    ).toThrow()
  })

  it('starts a program and hides its console window on Windows only', async () => {
    const child = spawnProgram(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout!.on('data', (d: Buffer) => (out += d))
    await new Promise((resolve) => child.once('close', resolve))
    expect(out).toBe('ok')
  })
})

describe('killTree', () => {
  it('signals the process group on macOS and Linux', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      expect(killTree(4242, 'SIGTERM', 'linux')).toBe(true)
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
      kill.mockImplementation(() => {
        throw new Error('ESRCH')
      })
      expect(killTree(4242, 'SIGKILL', 'darwin')).toBe(false)
    } finally {
      kill.mockRestore()
    }
  })

  it('stops the tree by taskkill on Windows and never uses a negative pid', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const taskkill = vi.fn()
    try {
      expect(killTree(4242, 'SIGTERM', 'win32', taskkill)).toBe(true)
      expect(taskkill).toHaveBeenCalledWith(4242, undefined)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it('refuses a pid that is not a process Holi started', () => {
    const taskkill = vi.fn()
    for (const pid of [0, 1, -3, 1.5, Number.NaN]) {
      expect(killTree(pid, 'SIGKILL', 'win32', taskkill)).toBe(false)
    }
    expect(taskkill).not.toHaveBeenCalled()
  })

  it('stops an exited child nowhere on Windows, where its pid may be another program’s', () => {
    const taskkill = vi.fn()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const exited = { pid: 4242, exitCode: 0, signalCode: null }
      expect(killChildTree(exited, 'SIGKILL', 'win32', taskkill)).toBe(false)
      expect(taskkill).not.toHaveBeenCalled()
      // A group outlives its leader elsewhere, so what it left is still stopped.
      expect(killChildTree(exited, 'SIGKILL', 'linux')).toBe(true)
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
      const running = { pid: 4242, exitCode: null, signalCode: null }
      expect(killChildTree(running, 'SIGKILL', 'win32', taskkill)).toBe(true)
      expect(killChildTree({ ...running, pid: undefined }, 'SIGKILL', 'win32', taskkill)).toBe(
        false,
      )
    } finally {
      kill.mockRestore()
    }
  })

  it.runIf(process.platform === 'win32')(
    'really stops a program and what it started',
    async () => {
      // A parent that starts a child of its own and prints its pid.
      const script =
        'const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(()=>0,1000)"], {stdio:"ignore"});' +
        'console.log(c.pid); setInterval(()=>0,1000)'
      const parent = spawn(process.execPath, ['-e', script], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      const grandchild = await new Promise<number>((resolve) =>
        parent.stdout.once('data', (d: Buffer) => resolve(Number(String(d).trim()))),
      )
      const gone = new Promise((resolve) => parent.once('exit', resolve))
      expect(defaultProbePid(parent.pid!, 'win32')).toBe('group-leader')
      expect(defaultProbePid(grandchild, 'win32')).toBe('group-leader')
      killTree(parent.pid!, 'SIGKILL', 'win32')
      await gone
      await vi.waitFor(() => expect(defaultProbePid(grandchild, 'win32')).toBe('gone'), {
        timeout: 10_000,
      })
    },
    30_000,
  )
})

describe('execProgram', () => {
  it.runIf(process.platform === 'win32')(
    'stops a .cmd and the program behind it at the timeout',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-exec-'))
      dirs.push(dir)
      await writeFile(
        join(dir, 'hang.js'),
        'console.log(process.pid); setInterval(() => 0, 1000)\n',
      )
      const shim = join(dir, 'tool.cmd')
      await writeFile(shim, `@ECHO off\r\n"${process.execPath}" "%~dp0hang.js" %*\r\n`)
      const { execProgram } = await import('../src/main/launch')
      const result = await new Promise<{ err: Error | null; out: string }>((resolve) => {
        const child = execProgram(
          shim,
          [],
          { env: process.env, timeoutMs: 1500, maxBuffer: 65536, encoding: 'utf8' },
          (err, out) => resolve({ err, out }),
        )
        child.stdin?.end()
      })
      expect(result.err).not.toBeNull()
      const behind = Number(result.out.trim())
      expect(behind).toBeGreaterThan(1)
      await vi.waitFor(() => expect(defaultProbePid(behind, 'win32')).toBe('gone'), {
        timeout: 10_000,
      })
    },
    30_000,
  )
})

describe('defaultProbePid on Windows', () => {
  it('says gone for a pid that is no process and for pids that are never ours', () => {
    expect(defaultProbePid(999_999, 'win32')).toBe('gone')
    expect(defaultProbePid(0, 'win32')).toBe('gone')
    expect(defaultProbePid(1, 'win32')).toBe('gone')
  })

  it('says a live process is a tree root to stop whole', () => {
    expect(defaultProbePid(process.pid, 'win32')).toBe('group-leader')
  })
})
