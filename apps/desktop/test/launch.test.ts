import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import { commandLine, launchPlan, spawnProgram } from '../src/main/launch'
import { defaultProbePid, killChildTree, killTree } from '../src/main/process-group'

const WIN = { platform: 'win32' } as const
const npmShim = () => readFile(join(import.meta.dirname, 'fixtures/npm-node-shim.cmd'), 'utf8')

describe('launchPlan', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'rejects NUL before native launch on %s',
    (platform) => {
      expect(() => launchPlan('tool\0', [], { platform })).toThrow('NUL')
      expect(() => launchPlan('tool', ['before\0after'], { platform })).toThrow('NUL')
    },
  )

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

  it('runs an opaque .cmd through cmd.exe only for safely representable arguments', () => {
    const plan = launchPlan('C:\\Users\\Ada Lovelace\\npm\\claude.cmd', ['agents', '--json'], {
      ...WIN,
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    })
    expect(plan.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(plan.verbatim).toBe(true)
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    const line = ['C:\\Users\\Ada Lovelace\\npm\\claude.cmd', 'agents', '--json']
    // The file once, then each ordinary argument is quoted for the batch call.
    const [file, ...rest] = line
    expect(plan.args[3]).toBe(`"${[`"${file}"`, ...rest.map((arg) => `"${arg}"`)].join(' ')}"`)
    for (const unsafe of [
      '%PATH%',
      '!expanded!',
      'a^b',
      'a&b',
      'a|b',
      'a<b',
      'a>b',
      'a"b',
      'line\r\nfeed',
    ]) {
      expect(() => launchPlan('x.BAT', [unsafe], { ...WIN, env: {} })).toThrow(/safely/)
    }
    expect(() => launchPlan('x.cmd', ['path\\'], { ...WIN, env: {} })).toThrow(/safely/)
    expect(launchPlan('x.BAT', [], { ...WIN, env: {} }).file).toBe('cmd.exe')
  })

  it('bypasses recognizable npm shims so argv never passes through cmd.exe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-npm-shim-'))
    dirs.push(dir)
    const packageDir = join(dir, 'node_modules', 'fixture')
    await mkdir(packageDir, { recursive: true })
    const script = join(packageDir, 'cli.js')
    await writeFile(script, 'process.exit(0)')
    const shim = join(dir, 'fixture.cmd')
    await writeFile(shim, await npmShim())
    expect(
      launchPlan(shim, ['line one\r\nline two', '%PATH%', ''], { ...WIN, resolve: () => null }),
    ).toEqual({
      file: process.execPath,
      args: [script, 'line one\r\nline two', '%PATH%', ''],
      verbatim: false,
    })
  })

  it('uses the bundled Windows runtime after the local and PATH Node choices', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-windows-runtime-'))
    dirs.push(dir)
    await mkdir(join(dir, 'node_modules', 'fixture'), { recursive: true })
    const script = join(dir, 'node_modules', 'fixture', 'cli.js')
    await writeFile(script, '')
    const shim = join(dir, 'fixture.cmd')
    await writeFile(shim, await npmShim())
    const bundled = join(
      dir,
      'app.asar.unpacked',
      'node_modules',
      'node-win-x64',
      'bin',
      'node.exe',
    )
    await mkdir(join(dir, 'app.asar.unpacked', 'node_modules', 'node-win-x64', 'bin'), {
      recursive: true,
    })
    await writeFile(bundled, '')
    const resolve = () => null
    expect(
      launchPlan(shim, ['x'], {
        ...WIN,
        resolve,
        bundledWindowsNode: () => bundled,
        electronRuntime: true,
      }),
    ).toEqual({
      file: bundled,
      args: [script, 'x'],
      verbatim: false,
    })
    expect(() =>
      launchPlan(shim, [], {
        ...WIN,
        resolve,
        bundledWindowsNode: () => null,
        electronRuntime: true,
      }),
    ).toThrow(/bundled Windows Node runtime is missing/)
  })

  it('does not bypass custom batch work surrounding an npm entrypoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-custom-shim-'))
    dirs.push(dir)
    await mkdir(join(dir, 'node_modules', 'fixture'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'fixture', 'cli.js'), 'process.exit(0)')
    const shim = join(dir, 'fixture.cmd')
    await writeFile(shim, (await npmShim()) + '\r\necho custom-work\r\n')
    expect(() => launchPlan(shim, ['line one\nline two'], WIN)).toThrow(/safely/)
  })

  it('carries Unicode through an opaque batch argument without rewriting it', () => {
    const plan = launchPlan('x.cmd', ['snowman ☃'], { ...WIN, env: {} })
    expect(plan.verbatim).toBe(true)
    expect(plan.args[3]).toContain('snowman ☃')
  })

  it('resolves filename-only Windows commands, including node.exe', () => {
    const resolve = vi.fn((name: string) => `C:\\tools\\${name}`)
    expect(launchPlan('node.exe', ['-v'], { ...WIN, env: {}, resolve }).file).toBe(
      'C:\\tools\\node.exe',
    )
    expect(resolve).toHaveBeenCalledWith('node.exe', {})
  })

  it('resolves relative executables from the requested cwd', () => {
    expect(
      launchPlan('.\\bin\\tool.exe', [], {
        ...WIN,
        cwd: 'C:\\vault\\project',
      }).file,
    ).toBe('C:\\vault\\project\\bin\\tool.exe')
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
    expect(commandLine(plan)).toBe(`/d /s /c ""C:\\n\\claude.cmd" \"a\""`)
    const posix = launchPlan('/n/claude', ['a'], { platform: 'linux' })
    expect(commandLine(posix)).toEqual(['a'])
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
    ['line one\r\nline two', 'x'.repeat(12_000), 'snowman ☃'],
  ]

  it.runIf(process.platform === 'win32')(
    'receives every argument exactly as given',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-launch-'))
      dirs.push(dir)
      // A folder with a space in it, as a Windows account name can have.
      const packageDir = join(dir, 'Ada Lovelace', 'node_modules', 'fixture')
      await mkdir(packageDir, { recursive: true })
      await writeFile(
        join(packageDir, 'cli.js'),
        'console.log(JSON.stringify(process.argv.slice(2)))\n',
      )
      const shim = join(dir, 'Ada Lovelace', 'tool.cmd')
      await writeFile(shim, await npmShim())
      for (const args of NASTY) {
        const plan = launchPlan(shim, args, WIN)
        const out = await new Promise<string>((resolve, reject) => {
          const child = execFile(
            plan.file,
            plan.args,
            { cwd: dir, windowsVerbatimArguments: plan.verbatim, windowsHide: true },
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
  it('reports rejected batch planning through the expected error event', async () => {
    const child = spawnProgram('opaque.cmd', ['%PATH%'], { stdio: 'pipe' }, WIN)
    const writes = child.stdin!.write('queued prompt')
    child.stdin!.end('queued tail')
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    const error = await new Promise<Error>((resolve) => child.once('error', resolve))
    await closed
    expect(writes).toBe(true)
    expect(error.message).toContain('safely')
  })

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

  it.runIf(process.platform === 'win32')('resolves node.exe from PATH on Windows', async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'),
    )
    env.PATH = dirname(process.execPath)
    const child = spawnProgram(
      'node.exe',
      [
        '-e',
        'process.stdout.write(JSON.stringify({version:process.version,execPath:process.execPath}))',
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
    })
    expect(JSON.parse(output)).toEqual({ version: process.version, execPath: process.execPath })
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
    'reports cold-start timeout using the actual root state',
    async () => {
      const { execProgram } = await import('../src/main/launch')
      const script =
        'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>0,1000)"],{stdio:"ignore",windowsHide:true,detached:true});console.log(c.pid);setInterval(()=>0,1000)'
      const result = await new Promise<{ err: Error | null; out: string }>((resolve) => {
        const child = execProgram(
          process.execPath,
          ['-e', script],
          {
            env: { ...process.env, HOLI_OWNED_PROCESS_TRACE: '1' },
            timeoutMs: 3000,
            maxBuffer: 65536,
            encoding: 'utf8',
          },
          (err, out) => resolve({ err, out }),
        )
        child.stdin?.end()
      })
      const metadata = result.err as
        | (Error & {
            code?: string
            helperLastPhase?: string
            helperStarted?: boolean
            rootStarted?: boolean
            helperPid?: number | null
            rootPid?: number | null
            rootState?: string
          })
        | null
      onTestFailed(() => {
        console.error(
          `[launch timeout diagnostic] code=${metadata?.code ?? 'none'} helperLastPhase=${metadata?.helperLastPhase ?? 'none'} helperStarted=${metadata?.helperStarted ?? false} rootStarted=${metadata?.rootStarted ?? false} helperPid=${metadata?.helperPid ?? 'none'} rootPid=${metadata?.rootPid ?? 'none'} rootState=${metadata?.rootState ?? 'none'}`,
        )
      })
      expect(result.err).not.toBeNull()
      expect(result.err?.code).toBe('ETIMEDOUT')
      expect(metadata?.helperStarted).toBe(true)
      if (metadata?.rootStarted) {
        expect(metadata.rootPid).toBeGreaterThan(1)
        expect(defaultProbePid(metadata.rootPid!, 'win32')).toBe('gone')
        const descendantPid = Number(result.out.trim())
        if (descendantPid > 1) expect(defaultProbePid(descendantPid, 'win32')).toBe('gone')
      } else {
        expect(metadata?.rootPid).toBeNull()
        expect(result.out).toBe('')
      }
    },
    30_000,
  )

  it.runIf(process.platform === 'win32')(
    'times out a running root and grandchild within the original execution budget',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-exec-running-timeout-'))
      const pidFile = join(dir, 'grandchild')
      const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>0,1000)`
      const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',windowsHide:true,detached:true});setInterval(()=>0,1000)`
      const { execProgram } = await import('../src/main/launch')
      try {
        const result = await new Promise<{ err: Error | null }>((resolve) => {
          execProgram(
            process.execPath,
            ['-e', script],
            { env: process.env, timeoutMs: 3000, maxBuffer: 65536, encoding: 'utf8' },
            (err) => resolve({ err }),
          )
        })
        expect(result.err?.code).toBe('ETIMEDOUT')
        await vi.waitFor(async () =>
          expect(Number(await readFile(pidFile, 'utf8'))).toBeGreaterThan(1),
        )
        expect(defaultProbePid(Number(await readFile(pidFile, 'utf8')), 'win32')).toBe('gone')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  it.runIf(process.platform === 'win32')(
    'completes after natural root exit and drains its output-holding descendant',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-exec-drain-'))
      const pidFile = join(dir, 'pid')
      const readyFile = join(dir, 'ready')
      const releaseFile = join(dir, 'release')
      const descendant = `require('node:fs').writeFileSync(${JSON.stringify(readyFile)},'ready');process.stdout.write('descendant output');setInterval(()=>0,1000)`
      const script = `const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','ignore'],windowsHide:true,detached:true});c.on('spawn',()=>fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid)));const wait=()=>fs.existsSync(${JSON.stringify(releaseFile)})?process.exit(0):setTimeout(wait,10);wait()`
      const { execProgram } = await import('../src/main/launch')
      let reported = false
      let pid = 0
      let releaseWritten = false
      let result: Promise<{ err: Error | null; out: string }> | undefined
      try {
        result = new Promise<{ err: Error | null; out: string }>((resolve) => {
          execProgram(
            process.execPath,
            ['-e', script],
            { env: process.env, timeoutMs: 10_000, maxBuffer: 65536, encoding: 'utf8' },
            (err, out) => {
              reported = true
              resolve({ err, out })
            },
          )
        })
        await vi.waitFor(
          async () => {
            expect(await readFile(readyFile, 'utf8')).toBe('ready')
            pid = Number(await readFile(pidFile, 'utf8'))
            expect(pid).toBeGreaterThan(1)
          },
          { timeout: 10_000 },
        )
        expect(reported).toBe(false)
        expect(defaultProbePid(pid, 'win32')).not.toBe('gone')

        await writeFile(releaseFile, 'release')
        releaseWritten = true
        const { err, out } = await result
        expect(err).toBeNull()
        expect(out).toContain('descendant output')
        expect(reported).toBe(true)
        expect(defaultProbePid(pid, 'win32')).toBe('gone')
      } finally {
        if (!releaseWritten) await writeFile(releaseFile, 'release')
        if (result) await result
        if (pid > 1) {
          await vi.waitFor(() => expect(defaultProbePid(pid, 'win32')).toBe('gone'), {
            timeout: 10_000,
          })
        }
        await rm(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  it.runIf(process.platform === 'win32')(
    'keeps a successful explicitly detached Claude background child alive',
    async () => {
      const { execProgram } = await import('../src/main/launch')
      for (const tracing of [false, true]) {
        const dir = await mkdtemp(join(tmpdir(), 'holi-exec-detach-'))
        const pidFile = join(dir, 'pid')
        const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>0,1000)'],{stdio:'ignore',windowsHide:true,detached:true});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();process.stdout.write('backgrounded · 12345678 · test');process.stderr.write('detached stderr payload')`
        let pid = 0
        let hostDiagnostic = ''
        onTestFailed(() => {
          for (const xml of hostDiagnostic.match(/<Objs[\s\S]*?<\/Objs>/g) ?? []) {
            console.error('[synthetic fixture PowerShell host diagnostic]', xml)
          }
        })
        try {
          const result = await new Promise<{ err: Error | null; out: string; stderr: string }>(
            (resolve) => {
              const child = execProgram(
                process.execPath,
                ['-e', script],
                {
                  env: { ...process.env, HOLI_OWNED_PROCESS_TRACE: tracing ? '1' : '0' },
                  timeoutMs: 10_000,
                  maxBuffer: 65536,
                  encoding: 'utf8',
                  retainDescendantsOnSuccess: true,
                },
                (err, out, stderr) => resolve({ err, out, stderr }),
              )
              child.stdio[2]?.on('data', (chunk: Buffer) => {
                hostDiagnostic = (hostDiagnostic + chunk.toString('utf8')).slice(-8192)
              })
            },
          )
          pid = Number(await readFile(pidFile, 'utf8'))
          expect(result.err).toBeNull()
          expect(result.out).toBe('backgrounded · 12345678 · test')
          if (tracing) {
            expect(result.stderr).toContain('detached stderr payload')
            expect(result.stderr).toContain('[holi-owned-process] phase=')
          } else {
            expect(result.stderr).toBe('detached stderr payload')
          }
          expect(result.stderr).not.toContain('[holi-complete-')
          expect(pid).toBeGreaterThan(1)
          expect(defaultProbePid(pid, 'win32')).toBe('group-leader')
        } finally {
          if (pid > 1) killTree(pid, 'SIGKILL', 'win32')
          await rm(dir, { recursive: true, force: true })
        }
      }
    },
    30_000,
  )

  it.runIf(process.platform === 'win32')(
    'times out and drains a root-exited descendant holding root stdout',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-exec-detach-pipe-timeout-'))
      const pidFile = join(dir, 'pid')
      const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>0,1000)'],{stdio:['ignore','inherit','ignore'],windowsHide:true,detached:true});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();process.exit(0)`
      const { execProgram } = await import('../src/main/launch')
      try {
        const result = await new Promise<Error | null>((resolve) => {
          execProgram(
            process.execPath,
            ['-e', script],
            {
              env: process.env,
              timeoutMs: 3_000,
              maxBuffer: 65536,
              encoding: 'utf8',
              retainDescendantsOnSuccess: true,
            },
            (err) => {
              const pid = Number(readFileSync(pidFile, 'utf8'))
              expect(defaultProbePid(pid, 'win32')).toBe('gone')
              resolve(err)
            },
          )
        })
        expect(result).not.toBeNull()
        expect(result?.message).toContain('timed out')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  it.runIf(process.platform === 'win32')(
    'drains failed detached background launches before callback',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-exec-detach-fail-'))
      const pidFile = join(dir, 'pid')
      const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>0,1000)'],{stdio:['ignore','ignore','ignore'],windowsHide:true,detached:true});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.exit(7)`
      const { execProgram } = await import('../src/main/launch')
      try {
        const result = await new Promise<{ err: Error | null }>((resolve) => {
          execProgram(
            process.execPath,
            ['-e', script],
            {
              env: process.env,
              timeoutMs: 10_000,
              maxBuffer: 65536,
              encoding: 'utf8',
              retainDescendantsOnSuccess: true,
            },
            (err) => {
              expect(err).not.toBeNull()
              const pid = Number(readFileSync(pidFile, 'utf8'))
              expect(pid).toBeGreaterThan(1)
              expect(defaultProbePid(pid, 'win32')).toBe('gone')
              resolve({ err })
            },
          )
        })
        expect(result.err).not.toBeNull()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  it.runIf(process.platform === 'win32')(
    'drains timed-out detached background launches before callback',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-exec-detach-timeout-'))
      const pidFile = join(dir, 'pid')
      const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>0,1000)`
      const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',windowsHide:true,detached:true});setInterval(()=>0,1000)`
      const { execProgram } = await import('../src/main/launch')
      try {
        const result = await new Promise<Error | null>((resolve) => {
          execProgram(
            process.execPath,
            ['-e', script],
            {
              env: process.env,
              timeoutMs: 500,
              maxBuffer: 65536,
              encoding: 'utf8',
              retainDescendantsOnSuccess: true,
            },
            (err) => resolve(err),
          )
        })
        expect(result).not.toBeNull()
        await vi.waitFor(async () =>
          expect(Number(await readFile(pidFile, 'utf8'))).toBeGreaterThan(1),
        )
        const pid = Number(await readFile(pidFile, 'utf8'))
        expect(defaultProbePid(pid, 'win32')).toBe('gone')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  it.runIf(process.platform === 'win32').each(['maxBuffer', 'stdin error'] as const)(
    'stops descendants after %s cleanup',
    async (failureKind) => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-exec-error-'))
      const pidFile = join(dir, 'pid')
      const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>0,1000)`
      const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',windowsHide:true,detached:true});${failureKind === 'maxBuffer' ? "process.stdout.write('x'.repeat(100000));" : ''}setInterval(()=>0,1000)`
      const { execProgram } = await import('../src/main/launch')
      let child: ReturnType<typeof execProgram> | undefined
      try {
        const result = new Promise<Error | null>((resolve) => {
          child = execProgram(
            process.execPath,
            ['-e', script],
            {
              env: process.env,
              timeoutMs: 10_000,
              maxBuffer: failureKind === 'maxBuffer' ? 100 : 65536,
              encoding: 'utf8',
              retainDescendantsOnSuccess: true,
            },
            (err) => resolve(err),
          )
        })
        if (failureKind === 'stdin error') {
          await vi.waitFor(async () =>
            expect(Number(await readFile(pidFile, 'utf8'))).toBeGreaterThan(1),
          )
          child!.stdin!.emit(
            'error',
            Object.assign(new Error('test input failure'), { code: 'EPIPE' }),
          )
        }
        expect(await result).not.toBeNull()
        const pid = Number(await readFile(pidFile, 'utf8'))
        expect(defaultProbePid(pid, 'win32')).toBe('gone')
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await rm(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )

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
