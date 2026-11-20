import { ChildProcess, execFile, spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getSystemErrorName, promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { ownedProcessDrain, spawnOwnedProgram } from '../src/main/owned-process'
import type { ProcessGroupSupervision } from '../src/main/owned-process-supervision'

import { buildLeaseForTests, buildPosixTestHelper } from './fixtures/posix-native-build'

const helper = vi.hoisted(() => ({
  path: '',
  readExec: undefined as (() => 'defer' | 'malformed' | void) | undefined,
  deferPoll: undefined as Promise<void> | undefined,
  receipts: '',
  beforeRemove: undefined as ((directory: string) => void) | undefined,
  afterNativeSpawn: undefined as ((child: ChildProcess) => void) | undefined,
}))
vi.mock('../src/main/launch', async (importOriginal) => {
  const launch = await importOriginal<typeof import('../src/main/launch')>()
  return {
    ...launch,
    spawnProgram: (...args: Parameters<typeof launch.spawnProgram>) => {
      const child = launch.spawnProgram(...args)
      helper.afterNativeSpawn?.(child)
      return child
    },
  }
})
vi.mock('../src/main/posix-lease-executable', () => ({ posixLeaseExecutable: () => helper.path }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const readers = new Map<number, string>()
  return {
    ...fs,
    openSync: (path: string, flags: number) => {
      const fd = fs.openSync(path, flags)
      if (!(flags & fs.constants.O_WRONLY)) readers.set(fd, path)
      return fd
    },
    closeSync: (fd: number) => {
      readers.delete(fd)
      fs.closeSync(fd)
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, pos: null) => {
      const path = readers.get(fd)
      if (path?.endsWith('/exec')) {
        const fault = helper.readExec?.()
        if (fault === 'defer') throw Object.assign(new Error('injected EAGAIN'), { code: 'EAGAIN' })
        if (fault === 'malformed') return buffer.write('invalid\n', offset, length, 'utf8')
      }
      const bytes = fs.readSync(fd, buffer, offset, length, pos)
      if (path?.endsWith('/report'))
        helper.receipts += buffer.toString('utf8', offset, offset + bytes)
      return bytes
    },
    rmSync: (path: string, options: Parameters<typeof fs.rmSync>[1]) => {
      helper.beforeRemove?.(path)
      fs.rmSync(path, options)
    },
  }
})
vi.mock('node:timers/promises', async (importOriginal) => {
  const timers = await importOriginal<typeof import('node:timers/promises')>()
  return {
    ...timers,
    setTimeout: (ms: number) => {
      const deferred = helper.deferPoll
      helper.deferPoll = undefined
      return deferred ?? timers.setTimeout(ms)
    },
  }
})

const windows = process.platform === 'win32'

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 10_000
  while (true) {
    try {
      return await readFile(file, 'utf8')
    } catch {
      if (Date.now() >= deadline) throw new Error(`No handshake at ${file}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

function diagnostics(child: ReturnType<typeof spawnOwnedProgram>): void {
  let lastPhase = 'none'
  child.stderr?.on('data', (chunk: Buffer | string) => {
    const text = String(chunk)
    const phases = [...text.matchAll(/phase=([^\s]+)/g)]
    if (phases.length) lastPhase = phases[phases.length - 1][1]
  })
  onTestFailed(async () => {
    console.error(
      `[owned-process test failure] pid=${child.pid ?? 'none'} exitCode=${child.exitCode} signalCode=${child.signalCode} lastPhase=${lastPhase}`,
    )
    await cleanup(child)
  })
}

async function cleanup(child: ReturnType<typeof spawnOwnedProgram>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await Promise.race([
    completion(child).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ])
  if (child.exitCode === null && child.signalCode === null) {
    ChildProcess.prototype.kill.call(child, 'SIGKILL')
    await Promise.race([
      completion(child).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ])
  }
}

function completion(child: ReturnType<typeof spawnOwnedProgram>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
}

function drain(child: ChildProcess): Promise<void> | undefined {
  return (child as ChildProcess & { [ownedProcessDrain]?: ProcessGroupSupervision })[
    ownedProcessDrain
  ]?.drain()
}

let buildDirectory: string | undefined
let oracle: string
beforeAll(() => {
  if (!windows) {
    const build = buildLeaseForTests()
    buildDirectory = build.directory
    helper.path = build.binary
    oracle = buildPosixTestHelper(
      build.directory,
      new URL('./fixtures/posix-kernel-fixture.c', import.meta.url),
    )
  }
})
afterAll(async () => {
  if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true })
})

describe('spawnOwnedProgram', () => {
  it.skipIf(windows).each(['throw', 'no pid'] as const)(
    'cancels unused POSIX preparation when native spawn fails with %s',
    async (mode) => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-owned-failed-spawn-'))
      const marker = join(dir, 'provider-ran')
      vi.stubEnv('TMPDIR', dir)
      const start = (cwd: string) =>
        spawnOwnedProgram(
          process.execPath,
          ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
          { cwd, stdio: 'ignore', posixGroupLease: true },
        )
      try {
        if (mode === 'throw') {
          expect(() => start(`${dir}\0`)).toThrow(
            expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }),
          )
          await vi.waitFor(async () => expect(await readdir(dir)).toEqual([]))
        } else {
          const child = start(join(dir, 'nonexistent'))
          const closed = new Promise<number | null>((resolve) => child.once('close', resolve))
          const failed = completion(child)
          expect(child.pid).toBeUndefined()
          const cleanup = drain(child)
          expect(cleanup).toBeInstanceOf(Promise)
          expect(drain(child)).toBe(cleanup)
          await expect(failed).rejects.toMatchObject({ code: 'ENOENT' })
          await closed
          await cleanup
          expect(await readdir(dir)).toEqual([])
        }
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        vi.unstubAllEnvs()
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(windows).each([
    ['detached', 'true', 'ERR_INVALID_ARG_TYPE'],
    ['shell', 1, 'ERR_INVALID_ARG_TYPE'],
    ['shell', '/bin/sh\0', 'ERR_INVALID_ARG_VALUE'],
    ['argv0', 17, 'ERR_INVALID_ARG_TYPE'],
    ['argv0', 'x\0', 'ERR_INVALID_ARG_VALUE'],
    ['stdio', 'ipc', 'ERR_INVALID_ARG_VALUE'],
  ])('rejects invalid %s before entering native spawn', async (name, value, code) => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-invalid-option-'))
    vi.stubEnv('TMPDIR', dir)
    const nativeCalled = vi.fn()
    helper.afterNativeSpawn = nativeCalled
    const opts = { [name]: value } as SpawnOptions
    let child: ChildProcess | undefined
    try {
      expect(() => spawn('/bin/true', [], opts)).toThrow(expect.objectContaining({ code }))
      expect(() => {
        child = spawnOwnedProgram('/bin/true', [], { ...opts, posixGroupLease: true })
      }).toThrow(expect.objectContaining({ code }))
      expect(nativeCalled).not.toHaveBeenCalled()
      expect(await readdir(dir)).toEqual([])
    } finally {
      helper.afterNativeSpawn = undefined
      vi.unstubAllEnvs()
      if (child) await drain(child)
      // Do not remove an unconfirmed launch receipt if validation regresses.
      if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true })
    }
  })

  it('preserves exact argv and output', async () => {
    for (const cwd of [undefined, '.', pathToFileURL(process.cwd() + sep)]) {
      const args = ['one two', '', '☃', 'one\r\ntwo', 'q"uote', 'x'.repeat(12_000)]
      const child = spawnOwnedProgram(
        process.execPath,
        [
          '-e',
          'process.stdout.write(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd() }))',
          '--',
          ...args,
        ],
        {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...(windows ? { HOLI_OWNED_PROCESS_TRACE: '1' } : {}) },
        },
      )
      let error = ''
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (error += chunk))
      diagnostics(child)
      const done = completion(child)
      let output = ''
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
      try {
        expect(await done, error).toBe(0)
        expect(JSON.parse(output)).toEqual({ args, cwd: process.cwd() })
      } finally {
        await drain(child)
        await cleanup(child)
      }
    }
  })

  it.skipIf(!windows)('creates a console root without a visible console', async () => {
    const child = spawnOwnedProgram(
      process.execPath,
      ['-e', 'console.log(process.pid);setInterval(()=>0,1000)'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    try {
      const pid = await new Promise<number>((resolve) =>
        child.stdout!.once('data', (data: Buffer) => resolve(Number(String(data).trim()))),
      )
      const probe = [
        'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class HoliConsoleProbe { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid); }\'',
        `[HoliConsoleProbe]::AttachConsole(${pid})`,
      ].join('; ')
      const { stdout } = await promisify(execFile)(
        join(
          process.env.SystemRoot ?? process.env.WINDIR!,
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        ['-NoProfile', '-NonInteractive', '-Command', probe],
        { windowsHide: true, encoding: 'utf8' },
      )
      expect(stdout.trim()).toBe('False')
    } finally {
      await cleanup(child)
    }
  })

  it.skipIf(!windows)('resolves a relative executable against the requested cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-relative-exe-'))
    const bin = join(dir, 'bin')
    await mkdir(bin)
    await copyFile(process.execPath, join(bin, 'tool.exe'))
    const child = spawnOwnedProgram(
      '.\\bin\\tool.exe',
      ['-e', 'process.stdout.write(process.cwd())'],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    try {
      const done = completion(child)
      let output = ''
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
      expect(await done).toBe(0)
      expect(output).toBe(dir)
    } finally {
      await cleanup(child)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!windows)('does not resolve the helper from a poisoned vault cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-poisoned-cwd-'))
    const poison = join(dir, 'powershell.exe')
    let child: ReturnType<typeof spawnOwnedProgram> | undefined
    try {
      await copyFile(process.execPath, poison)
      child = spawnOwnedProgram(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      diagnostics(child)
      const done = completion(child)
      let output = ''
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
      expect(await done).toBe(0)
      expect(output).toBe(dir)
    } finally {
      if (child) await cleanup(child)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!windows)('handles a missing helper without leaking stdin errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-missing-helper-'))
    const previousSystemRoot = process.env.SystemRoot
    process.env.SystemRoot = dir
    let child: ReturnType<typeof spawnOwnedProgram> | undefined
    let childErrors = 0
    let stdinErrors = 0
    try {
      child = spawnOwnedProgram(process.execPath, ['-e', 'process.exit(0)'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      child.on('error', () => childErrors++)
      child.stdin!.on('error', () => stdinErrors++)
      const closed = new Promise<number | null>((resolve) => child!.once('close', resolve))
      await expect(completion(child)).rejects.toMatchObject({ code: 'ENOENT' })
      const code = await closed
      expect(getSystemErrorName(code!)).toBe('ENOENT')
      const previousStdinErrors = stdinErrors
      child.stdin!.emit('error', Object.assign(new Error('test input failure'), { code: 'EPIPE' }))
      expect(stdinErrors).toBe(previousStdinErrors + 1)
      expect(childErrors).toBe(1)
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = previousSystemRoot
      if (child) await cleanup(child)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!windows).each([false, true])(
    'terminates descendants before reporting root exit (pipes: %s)',
    async (pipes) => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-owned-'))
      const pidFile = join(dir, 'descendant-pid')
      let child: ReturnType<typeof spawnOwnedProgram> | undefined
      try {
        const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('ready\\n');setInterval(()=>0,1000)`
        const root = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe',${pipes ? "'inherit'" : "'ignore'"}],windowsHide:true});c.stdout.once('data',()=>process.exit(23))`
        child = spawnOwnedProgram(process.execPath, ['-e', root], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...(windows ? { HOLI_OWNED_PROCESS_TRACE: '1' } : {}) },
        })
        let error = ''
        child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (error += chunk))
        diagnostics(child)
        expect(await completion(child), error).toBe(23)
        const pid = Number(await readFile(pidFile, 'utf8'))
        expect(pid).toBeGreaterThan(1)
        expect(() => process.kill(pid, 0)).toThrow()
      } finally {
        if (child) await cleanup(child)
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!windows).each([false, true])(
    'stops the entire owned job and leaves no stop artifact (stdin failure: %s)',
    async (stdinFailure) => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-owned-stop-'))
      const pidFile = join(dir, 'descendant-pid')
      let child: ReturnType<typeof spawnOwnedProgram> | undefined
      try {
        const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>0,1000)`
        const root = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',windowsHide:true});setInterval(()=>0,1000)`
        child = spawnOwnedProgram(process.execPath, ['-e', root], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...(windows ? { HOLI_OWNED_PROCESS_TRACE: '1' } : {}) },
        })
        diagnostics(child)
        const done = completion(child)
        const pid = Number(await waitForFile(pidFile))
        if (stdinFailure) {
          child.stdin!.emit(
            'error',
            Object.assign(new Error('test input failure'), { code: 'EPIPE' }),
          )
        } else {
          expect(child.kill('SIGTERM')).toBe(true)
          expect(child.kill('SIGKILL')).toBe(true)
        }
        expect(await done).toBe(1)
        expect(() => process.kill(pid, 0)).toThrow()
      } finally {
        if (child) await cleanup(child)
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!windows)('fails closed when its parent is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-parent-'))
    const sentinel = join(dir, 'should-not-run')
    let child: ReturnType<typeof spawnOwnedProgram> | undefined
    try {
      child = spawnOwnedProgram(
        process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'ran')`],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...(windows ? { HOLI_OWNED_PROCESS_TRACE: '1' } : {}) },
        },
        2_000_000_000,
      )
      diagnostics(child)
      expect(await completion(child)).toBe(125)
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (child) await cleanup(child)
      await rm(dir, { recursive: true, force: true })
    }
  })
})

it.skipIf(windows)('keeps default pipes for a non-leased POSIX command', async () => {
  const child = spawnOwnedProgram(
    process.execPath,
    ['-e', 'process.stdin.pipe(process.stdout)'],
    {},
  )
  const done = completion(child)
  const lease = drain(child)
  try {
    expect(lease).toBeUndefined()
    let output = ''
    child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stdin!.end('original bytes')
    expect(await done).toBe(0)
    expect(output).toBe('original bytes')
  } finally {
    if (lease) await lease
    else await cleanup(child)
  }
})

async function observe(child: ChildProcess, input?: string) {
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  const events: string[] = []
  const failure: NodeJS.ErrnoException[] = []
  child.on('spawn', () => events.push('spawn'))
  child.on('error', (error) => {
    events.push('error')
    failure.push(error)
  })
  child.on('exit', () => events.push('exit'))
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => errors.push(chunk))
  if (input !== undefined) child.stdin!.end(input)
  const status = await new Promise((resolve) => child.on('close', (...status) => resolve(status)))
  return {
    status,
    events,
    stdout: Buffer.concat(chunks).toString(),
    stderr: Buffer.concat(errors).toString(),
    failure: failure.map(({ errno, code, syscall, message, ...rest }) => ({
      errno,
      code,
      syscall,
      message,
      ...rest,
    })),
  }
}

async function compareLeased(file: string, args: string[], opts: SpawnOptions, input?: string) {
  const direct = await observe(spawn(file, args, { ...opts, detached: true }), input)
  const child = spawnOwnedProgram(file, args, { ...opts, posixGroupLease: true })
  const pid = child.pid
  try {
    expect(await observe(child, input)).toEqual(direct)
  } finally {
    await drain(child)
    if (pid !== undefined)
      expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  }
}

it.skipIf(windows)(
  'matches original spawn bytes, argv0, cwd, env and default stdio when leased',
  async () => {
    const argv = ['spaces and tab\t', '', 'one\r\ntwo', '☃', 'quote"\\', 'x'.repeat(12_000)]
    const src = `process.stderr.write('stderr'); console.log(JSON.stringify([process.argv0,process.cwd(),process.env,process.argv.slice(1)])); process.stdin.pipe(process.stdout)`
    await compareLeased(
      process.execPath,
      ['-e', src, '--', ...argv],
      {
        argv0: 'original argv zero',
        cwd: pathToFileURL(process.cwd() + sep),
        env: {
          SHLVL: '31',
          PWD: 'preserved',
          _: 'exact',
          SECRET_FIXTURE: 'quotes $x\n\n☃'.repeat(4000),
        },
        uid: process.getuid!(),
        gid: process.getgid!(),
      },
      'original stdin',
    )
  },
)

it.skipIf(windows)('matches native ENOENT and EACCES, not a shell exit code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'holi-exec-errors-'))
  try {
    const blocked = join(dir, 'blocked')
    await writeFile(blocked, '#!/bin/sh\nexit 0\n', { mode: 0o600 })
    await compareLeased('./missing', ['one', 'two'], { cwd: dir, env: {} })
    await compareLeased('./blocked', [], { cwd: dir, env: {} })
    await compareLeased('missing-for-holi-test', [], { cwd: dir, env: { PATH: dir } })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it.skipIf(windows)('keeps real nonzero and signal exits, and the shell option', async () => {
  await compareLeased(process.execPath, ['-e', 'process.exit(7)'], {})
  await compareLeased(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"], {})
  await compareLeased('printf', ["'%s'", "'some bytes'"], { shell: '/bin/sh', env: {} })
})

it.skipIf(windows)(
  'keeps advanced IPC, original extra descriptors and timeout killSignal',
  async () => {
    const child = spawnOwnedProgram(
      process.execPath,
      [
        '-e',
        `process.on('message', b => {
    require('node:fs').writeSync(4, 'fd4'); process.send(b); process.disconnect()
  }); setInterval(() => {}, 1000)`,
      ],
      {
        posixGroupLease: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe'],
        serialization: 'advanced',
        timeout: 500,
        killSignal: 'SIGUSR2',
      },
    )
    const status = once(child, 'exit')
    const message = once(child, 'message')
    const pipe = once(child.stdio[4]!, 'data')
    try {
      expect(child.stdio).toHaveLength(5)
      child.send(Buffer.from('original IPC bytes'))
      expect((await message)[0]).toEqual(Buffer.from('original IPC bytes'))
      expect(await pipe).toEqual([Buffer.from('fd4')])
      expect(await status).toEqual([null, 'SIGUSR2'])
    } finally {
      await drain(child)
    }
  },
)

async function trackedLaunch(
  run: (
    dir: string,
    retain: (p: Promise<void>) => void,
    pid: (id: number) => void,
  ) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'owned-process-review2-'))
  const ids = new Set<number>()
  const cleanups: Promise<void>[] = []
  helper.receipts = ''
  vi.stubEnv('TMPDIR', dir)
  function absent() {
    for (const match of helper.receipts.matchAll(/^(?:ROOT|REAPER|READY) (\d+)(?: (\d+))?$/gm)) {
      ids.add(Number(match[1]))
      if (match[2]) ids.add(Number(match[2]))
    }
    for (const id of ids) {
      expect(id).toBeGreaterThan(1)
      for (const probe of ['probe-pid', 'probe']) {
        const result = spawnSync(oracle, [probe, String(id)], { timeout: 1000 })
        expect(result.error).toBeUndefined()
        expect(result.status, `${probe} ${id}`).toBe(1)
      }
    }
  }
  let removal: unknown
  let removed = false
  helper.beforeRemove = (path) => {
    if (!path.startsWith(join(dir, 'holi-launch-'))) return
    removed = true
    try {
      absent()
    } catch (error) {
      removal = error
    }
  }
  try {
    await run(
      dir,
      (p) => cleanups.push(p),
      (id) => ids.add(id),
    )
    expect(removed).toBe(true)
    if (removal) throw removal
    expect(await readdir(dir)).toEqual([])
  } finally {
    helper.beforeRemove = helper.readExec = helper.deferPoll = helper.afterNativeSpawn = undefined
    vi.unstubAllEnvs()
    await Promise.allSettled(cleanups)
    try {
      await vi.waitFor(absent, { timeout: 4000 })
      await rm(dir, { recursive: true, force: true })
    } catch (error) {
      console.error('Retained test launch ledger', dir, [...ids], error)
      throw error
    }
  }
}

it.skipIf(windows)(
  'joins the real native launch when spawn throws before returning its child',
  () =>
    trackedLaunch(async (dir, retain, track) => {
      // An exception code does not tell us where Node threw.
      const failure = Object.assign(new TypeError('parent setup failed after native spawn'), {
        code: 'ERR_INVALID_ARG_VALUE',
        cleanup: undefined as Promise<void> | undefined,
      })
      let exit: Promise<unknown[]> | undefined
      helper.afterNativeSpawn = (child) => {
        track(child.pid!)
        exit = once(child, 'exit')
        throw failure
      }
      const marker = join(dir, 'provider-ran')
      expect(() =>
        spawnOwnedProgram('/usr/bin/touch', [marker], { stdio: 'ignore', posixGroupLease: true }),
      ).toThrow(failure)
      const cleanup = failure.cleanup!
      expect(cleanup).toBeInstanceOf(Promise)
      retain(cleanup)
      await cleanup
      expect(failure.cleanup).toBe(cleanup)
      await failure.cleanup
      expect(await exit).toEqual([125, null])
      expect(helper.receipts).toMatch(/^ROOT \d+\n$/)
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    }),
)

function deferExecPoll(): () => void {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  helper.readExec = () => {
    helper.readExec = undefined
    helper.deferPoll = held
    return 'defer'
  }
  return release
}

it.skipIf(windows).each(['stdout', 'stderr', 'message'] as const)(
  'emits spawn before immediately ready %s and preserves all tails',
  (first) =>
    trackedLaunch(async (_dir, retain, track) => {
      const release = deferExecPoll()
      const child = spawnOwnedProgram(
        process.execPath,
        [
          '-e',
          `
      const start = { stdout: () => process.stdout.write('first out'),
        stderr: () => process.stderr.write('first err'), message: () => process.send(Buffer.from('first ipc')) };
      start[${JSON.stringify(first)}]();
      process.on('message', () => {
        for (const key of Object.keys(start)) if (key !== ${JSON.stringify(first)}) start[key]();
        process.stdout.write('x'.repeat(256 * 1024) + 'stdout tail');
        process.stderr.write('stderr tail');
        process.send(Buffer.from('ipc tail'), () => process.disconnect());
      });`,
        ],
        {
          posixGroupLease: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          serialization: 'advanced',
        },
      )
      track(child.pid!)
      const timeline: string[] = []
      const done = completion(child)
      const messages: Buffer[] = []
      let out = '',
        err = ''
      let acknowledged = false
      const acknowledge = () => {
        if (acknowledged) return
        acknowledged = true
        release()
        child.send('continue')
      }
      child.on('spawn', () => timeline.push('spawn'))
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
        timeline.push('stdout')
        out += chunk
        acknowledge()
      })
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
        timeline.push('stderr')
        err += chunk
        acknowledge()
      })
      child.on('message', (msg: Buffer) => {
        timeline.push('message')
        messages.push(msg)
        acknowledge()
      })
      child.on('exit', () => timeline.push('exit'))
      child.on('close', () => timeline.push('close'))
      try {
        expect(await done).toBe(0)
        expect(timeline.slice(0, 2)).toEqual(['spawn', first])
        expect(timeline.at(-1)).toBe('close')
        expect(timeline.filter((entry) => entry === 'exit')).toEqual(['exit'])
        expect(out).toBe('first out' + 'x'.repeat(256 * 1024) + 'stdout tail')
        expect(err).toBe('first errstderr tail')
        expect(messages).toEqual([Buffer.from('first ipc'), Buffer.from('ipc tail')])
      } finally {
        release()
        const cleanup = drain(child)!
        retain(cleanup)
        await cleanup
      }
    }),
)

it.skipIf(windows).each(['read', 'protocol'] as const)(
  'retains an exec receipt %s fault inside a native exit callback',
  (kind) =>
    trackedLaunch(async (_dir, retain, track) => {
      const release = deferExecPoll()
      const failure = Object.assign(new Error('exec receipt read failed'), { code: 'EIO' })
      const child = spawnOwnedProgram('/bin/true', [], { posixGroupLease: true, stdio: 'ignore' })
      track(child.pid!)
      const done = completion(child).catch((error: unknown) => error)
      const timeline: string[] = []
      for (const event of ['spawn', 'error', 'exit', 'close'])
        child.on(event, () => timeline.push(event))
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      const nativeEmit = child.emit.bind(child)
      let insideExit: unknown
      let sawNativeExit!: () => void
      const nativeExit = new Promise<void>((resolve) => {
        sawNativeExit = resolve
      })
      child.emit = (event: string | symbol, ...args: unknown[]) => {
        if (event !== 'exit') return nativeEmit(event, ...args)
        helper.readExec = () => {
          if (kind === 'protocol') return 'malformed'
          throw failure
        }
        try {
          return nativeEmit(event, ...args)
        } catch (error) {
          insideExit = error
          return false
        } finally {
          helper.readExec = undefined
          release()
          sawNativeExit()
        }
      }
      try {
        await nativeExit
        expect(insideExit).toBeUndefined()
        const error = await done
        if (kind === 'read') expect(error).toBe(failure)
        else expect(error).toMatchObject({ message: 'Invalid POSIX exec receipt.' })
        await closed
        const cleanup = drain(child)!
        expect(drain(child)).toBe(cleanup)
        await expect(cleanup).rejects.toBe(error)
        await expect(drain(child)).rejects.toBe(error)
        expect(timeline).toEqual(['error', 'close'])
        expect(helper.receipts).toMatch(/^READY \d+ \d+$/m)
      } finally {
        release()
        const cleanup = drain(child)!
        retain(cleanup)
        await cleanup.catch(() => {})
      }
    }),
)
