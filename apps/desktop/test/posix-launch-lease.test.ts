import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { preparePosixLaunch, type PosixLaunch } from '../src/main/posix-launch-lease'
import { inspectPosixOwnership } from '../src/main/posix-ownership-journal'
import { buildLeaseForTests, buildPosixTestHelper } from './fixtures/posix-native-build'

const { nativePath, fault } = vi.hoisted(() => ({
  nativePath: { value: '' },
  fault: {
    command: false,
    prepare: false,
    observe: undefined as ((text: string) => void) | undefined,
    rewrite: undefined as ((text: string) => string) | undefined,
    io: undefined as (() => void) | undefined,
    rack: undefined as (() => 'block' | 'reject') | undefined,
    beforeRemove: undefined as ((path: string) => void) | undefined,
    beforeCreate: undefined as ((path: string) => void) | undefined,
    beforeWrite: undefined as ((command: string) => void) | undefined,
  },
}))
vi.mock('../src/main/posix-lease-executable', () => ({
  posixLeaseExecutable: () => nativePath.value,
}))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (typeof args[1] === 'number' && args[1] & fs.constants.O_CREAT)
        fault.beforeCreate?.(String(args[0]))
      if (fault.prepare && String(args[0]).endsWith('/exec'))
        throw new Error('injected preparation failure')
      return fs.openSync(...args)
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, pos: null) => {
      fault.io?.()
      const bytes = fs.readSync(fd, buffer, offset, length, pos)
      if (!bytes || (!fault.observe && !fault.rewrite)) return bytes
      const text = buffer.toString('utf8', offset, offset + bytes)
      fault.observe?.(text)
      return fault.rewrite ? buffer.write(fault.rewrite(text), offset, length, 'utf8') : bytes
    },
    writeSync: (fd: number, payload: Buffer, offset: number, length: number) => {
      fault.io?.()
      const command = payload.length === 1 ? payload.toString() : ''
      if (command) fault.beforeWrite?.(command)
      if (fault.command && command === 'S') return fs.writeSync(fd, Buffer.from('X'))
      if (fault.rack && command === 'A') {
        if (fault.rack() === 'block') return 0
        return fs.writeSync(fd, Buffer.from('X'))
      }
      return fs.writeSync(fd, payload, offset, length)
    },
    closeSync: (fd: number) => {
      fault.io?.()
      fs.closeSync(fd)
    },
    rmSync: (path: string, options: Parameters<typeof fs.rmSync>[1]) => {
      fault.io?.()
      fault.beforeRemove?.(path)
      fs.rmSync(path, options)
    },
  }
})

let binaries = ''
let oracle = ''

function kernelProbe(...args: (string | number)[]) {
  const { status, error } = spawnSync(oracle, args.map(String), { timeout: 1000 })
  if (error) throw error
  expect([0, 1]).toContain(status)
  return status === 0
}

const groupExists = (group: number) => kernelProbe('probe', group)
const pidExists = (pid: number) => kernelProbe('probe-pid', pid)

function observeHelpers() {
  let receipts = ''
  fault.observe = (text) => (receipts += text)
  return {
    reaper: () =>
      Number(/^REAPER (\d+)$/m.exec(receipts)?.[1] ?? /^READY \d+ (\d+)$/m.exec(receipts)?.[1]),
    anchor: () => Number(/^READY (\d+) \d+$/m.exec(receipts)?.[1]),
  }
}

function helpersAbsent(root: number, reaper: number, anchor?: number) {
  for (const pid of [root, reaper, ...(anchor === undefined ? [] : [anchor])]) {
    expect(pid).toBeGreaterThan(1)
    expect(pidExists(pid), `process ${pid}`).toBe(false)
  }
  expect(groupExists(root), `root group ${root}`).toBe(false)
  expect(groupExists(reaper), `reaper group ${reaper}`).toBe(false)
}

async function kernelGone(group: number) {
  await vi.waitFor(() => expect(groupExists(group)).toBe(false), { timeout: 4000 })
}

async function tracked<T>(run: (directory: string, track: (group: number) => void) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'holi-native-lease-test-'))
  const groups = new Set<number>()
  let failed = false
  try {
    return await run(directory, (pid) => groups.add(pid))
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      for (const group of groups) {
        await kernelGone(group)
        await vi.waitFor(() => expect(pidExists(group), `process ${group}`).toBe(false), {
          timeout: 4000,
        })
      }
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      if (!failed) throw error
      console.error('Fixture cleanup failed; retained evidence in', directory, error)
    }
  }
}

function launch(prepared: PosixLaunch) {
  const child = spawn(prepared.executable, prepared.args, prepared.options)
  return { pid: child.pid!, exit: once(child, 'exit') }
}

async function paths(directory: string) {
  return (await readdir(directory)).filter((name) => name.startsWith('holi-launch-'))
}

describe.runIf(process.platform !== 'win32')('POSIX launch lease', () => {
  beforeAll(() => {
    const build = buildLeaseForTests()
    binaries = build.directory
    nativePath.value = build.binary
    oracle = buildPosixTestHelper(
      binaries,
      new URL('./fixtures/posix-kernel-fixture.c', import.meta.url),
    )
  })
  afterAll(async () => {
    if (binaries) await rm(binaries, { recursive: true, force: true })
  })

  it('rolls back partially prepared FIFOs and distinguishes definite cancellation', () =>
    tracked(async (directory) => {
      fault.prepare = true
      try {
        expect(() => preparePosixLaunch('/bin/false', [], { directory })).toThrow(
          'injected preparation failure',
        )
      } finally {
        fault.prepare = false
      }
      expect(await paths(directory)).toEqual([])
      const unlaunched = preparePosixLaunch('/bin/false', [], { directory })
      const cancellation = unlaunched.cancel('unlaunched')
      expect(unlaunched.cancel('unlaunched')).toBe(cancellation)
      await cancellation
      expect(await paths(directory)).toEqual([])
    }))

  it('retains evidence if the possible launch has no receipt', () =>
    tracked(async (directory) => {
      const prepared = preparePosixLaunch('/bin/false', [], { directory, timeoutMs: 80 })
      await expect(prepared.cancel('possibly-launched')).rejects.toThrow(
        'proving the POSIX launch absent',
      )
      const [evidence] = await paths(directory)
      expect(await readFile(join(directory, evidence!, 'failure'), 'utf8')).toContain('Timed out')
      // The test knows it never called its native launcher.
    }))

  it.each([false, true])(
    'joins a spawn without its returned object (let startup expire: %s)',
    (expire) =>
      tracked(async (directory, track) => {
        const prepared = preparePosixLaunch('/bin/false', [], {
          directory,
          startupTimeoutMs: 150,
          timeoutMs: 1000,
          stdio: 'ignore',
        })
        const root = launch(prepared)
        track(root.pid)
        if (expire) {
          expect(await root.exit).toEqual([125, null])
          await expect(prepared.cancel('possibly-launched')).rejects.toThrow('environment failed')
        } else {
          const cleanup = prepared.cancel('possibly-launched')
          expect(prepared.cancel('possibly-launched')).toBe(cleanup)
          await cleanup
          expect(await root.exit).toEqual([125, null])
        }
        expect(groupExists(root.pid)).toBe(false)
        expect(await paths(directory)).toEqual([])
      }),
  )

  it('joins a node-pty startup throw after its native fork', () =>
    tracked(async (directory, track) => {
      const require = createRequire(import.meta.url)
      const pty = require('node-pty') as typeof import('node-pty')
      const tty = require('node:tty') as typeof import('node:tty')
      const utilsPath = require.resolve('node-pty/lib/utils')
      const native = require(utilsPath).loadNativeModule('pty') as {
        dir: string
        module: { fork: (...args: unknown[]) => { pid: number; fd: number } }
      }
      const binding = native.module
      const localHelper = join(directory, 'spawn-helper')
      if (process.platform === 'darwin') {
        // The npm prebuild may lack its execute bit. Do not alter node_modules.
        await copyFile(join(dirname(utilsPath), native.dir, 'spawn-helper'), localHelper)
        await chmod(localHelper, 0o700)
      }
      const fork = binding.fork
      const ReadStream = tty.ReadStream
      let master: InstanceType<typeof tty.ReadStream> | undefined
      const capture = vi.spyOn(binding, 'fork').mockImplementation((...args) => {
        if (process.platform === 'darwin') args[args.length - 2] = localHelper
        const term = fork(...args)
        track(term.pid)
        return term
      })
      const fail = vi.spyOn(tty, 'ReadStream').mockImplementation(function (fd: number) {
        master = new ReadStream(fd)
        master.setEncoding = () => {
          throw new Error('PTY listener setup failed')
        }
        return master
      })
      const marker = join(directory, 'provider-ran')
      const prepared = preparePosixLaunch('/usr/bin/touch', [marker], {
        directory,
        cwd: directory,
        timeoutMs: 1200,
      })
      try {
        expect(() =>
          pty.spawn(prepared.executable, prepared.args, {
            cwd: directory,
            env: prepared.options.env,
          }),
        ).toThrow('PTY listener setup failed')
        expect(capture).toHaveBeenCalledOnce()
        // The retained lease must work without the PID/PTY object returned to its owner.
        await prepared.cancel('possibly-launched')
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await paths(directory)).toEqual([])
      } finally {
        capture.mockRestore()
        fail.mockRestore()
        await prepared.cancel('possibly-launched').catch(() => {})
        master?.destroy()
      }
    }))

  it('retains missing, stale, malformed, partial and failed evidence without PID probes', () =>
    tracked(async (directory) => {
      const path = join(directory, randomUUID())
      const kernel = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('Untrusted evidence must not reach the kernel')
      })
      const header = `HOLI-POSIX-1 ${basename(path)}\n`
      const write = (name: string, data: string) =>
        writeFile(join(path, name), data, { mode: 0o600 })
      const retains = () => expect(inspectPosixOwnership(path)).toMatchObject({ state: 'retain' })
      try {
        retains()
        await mkdir(path, { mode: 0o700 })
        retains()
        for (const body of ['WRONG\n', 'COMPLETE\n', 'ROOT 1\n', 'ROOT 2']) {
          await write('journal', header + body)
          retains()
        }
        await write('journal', header)
        retains()
        await write('settled', `HOLI-POSIX-1 ${randomUUID()}\nSETTLED\n`)
        retains()
        await write('settled', header + 'SETTLED\n')
        expect(inspectPosixOwnership(path)).toEqual({ state: 'confirmed', proof: 'settled' })
        await write('failed.tmp', '')
        retains()
        await rm(join(path, 'failed.tmp'))
        await write('failed', header + 'FAILED protocol\n')
        expect(inspectPosixOwnership(path)).toEqual({
          state: 'retain',
          reason: 'POSIX ownership cleanup failed (protocol).',
        })
        expect(kernel).not.toHaveBeenCalled()
      } finally {
        kernel.mockRestore()
      }
    }))

  it('records the native root before any bind or ROOT read', () =>
    tracked(async (directory, track) => {
      const ownershipRecordPath = join(directory, randomUUID())
      const prepared = preparePosixLaunch('/bin/false', [], {
        directory,
        ownershipRecordPath,
        stdio: 'ignore',
      })
      const root = launch(prepared)
      track(root.pid)
      try {
        await vi.waitFor(async () => {
          expect(await readFile(join(ownershipRecordPath, 'journal'), 'utf8')).toBe(
            `HOLI-POSIX-1 ${basename(ownershipRecordPath)}\nROOT ${root.pid}\n`,
          )
        })
        expect(inspectPosixOwnership(ownershipRecordPath)).toMatchObject({ state: 'retain' })
      } finally {
        await prepared.cancel('possibly-launched')
        await root.exit
        expect(pidExists(root.pid)).toBe(false)
      }
      expect(inspectPosixOwnership(ownershipRecordPath)).toEqual({
        state: 'confirmed',
        proof: 'settled',
      })
    }))

  it(
    'requires durable RACK/GO identities and cold-probes the whole EOF grace',
    () =>
      tracked(async (directory, track) => {
        const ownershipRecordPath = join(directory, randomUUID())
        const journal = join(ownershipRecordPath, 'journal')
        const ready = join(directory, 'descendant-pid')
        const release = join(directory, 'release')
        const term = join(directory, 'descendant-term')
        const descendantScript = `
        const fs = require('node:fs');
        process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(term)}, 'resisting'));
        fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
        setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0) }, 10);
        setTimeout(() => process.exit(0), 2200);
      `
        const rootScript = `
        process.on('SIGTERM', () => {});
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], {stdio:'ignore'})
          .once('exit', () => process.exit(0));
      `
        const prepared = preparePosixLaunch(process.execPath, ['-e', rootScript], {
          directory,
          ownershipRecordPath,
          stdio: 'ignore',
          graceMs: 2800,
          timeoutMs: 4500,
        })
        const helpers = observeHelpers()
        const root = launch(prepared)
        track(root.pid)
        const beforeGate = new Map<string, string>()
        fault.beforeWrite = (command) => {
          if (command === 'A' || command === 'G')
            beforeGate.set(command, readFileSync(journal, 'utf8'))
        }
        let cold: ReturnType<typeof inspectPosixOwnership> | undefined
        let beforeRemove: ReturnType<typeof inspectPosixOwnership> | undefined
        // Capture kernel-only proof before publishing the final record, then make
        // sure its publication precedes deletion of the private channel directory.
        fault.beforeCreate = (path) => {
          if (path !== join(ownershipRecordPath, 'settled.tmp')) return
          cold = inspectPosixOwnership(ownershipRecordPath)
        }
        fault.beforeRemove = (path) => {
          if (dirname(path) === directory && basename(path).startsWith('holi-launch-'))
            beforeRemove = inspectPosixOwnership(ownershipRecordPath)
        }
        let descendant: number | undefined
        try {
          await prepared.bind(root.pid)
          const prefix = `HOLI-POSIX-1 ${basename(ownershipRecordPath)}\nROOT ${root.pid}\nREAPER ${helpers.reaper()}\n`
          expect(beforeGate.get('A')).toBe(prefix)
          expect(beforeGate.get('G')).toBe(prefix + `ANCHOR ${helpers.anchor()}\nCOMPLETE\n`)
          await vi.waitFor(async () => {
            const pid = Number(await readFile(ready, 'utf8'))
            expect(pid).toBeGreaterThan(1)
            descendant = pid
          })
          const drained = prepared.cancel('possibly-launched') // Same EOF as controller loss.
          void drained.catch(() => {})
          await vi.waitFor(async () => expect(await readFile(term, 'utf8')).toBe('resisting'))
          expect(pidExists(descendant!)).toBe(true)
          expect(pidExists(helpers.reaper())).toBe(true)
          expect(inspectPosixOwnership(ownershipRecordPath)).toMatchObject({
            state: 'retain',
            reason: expect.stringContaining('kernel'),
          })
          await writeFile(release, '')
          await drained
          expect(cold).toEqual({ state: 'confirmed', proof: 'kernel-absence' })
          expect(beforeRemove).toEqual({ state: 'confirmed', proof: 'settled' })
        } finally {
          fault.beforeWrite = fault.beforeCreate = fault.beforeRemove = undefined
          await writeFile(release, '')
          await prepared.cancel('possibly-launched').catch(() => {})
          await root.exit
          if (helpers.reaper() > 1) track(helpers.reaper())
          if (helpers.anchor() > 1) track(helpers.anchor())
          if (descendant === undefined)
            descendant = Number(await readFile(ready, 'utf8').catch(() => ''))
          if (descendant > 1) track(descendant)
          fault.observe = undefined
        }
      }),
    7000,
  )

  it('never signals the wrong group even with a hostile provider PATH', () =>
    tracked(async (directory, track) => {
      const marker = join(directory, 'called-ps')
      await writeFile(
        join(directory, 'ps'),
        `#!/bin/sh\necho bad > '${marker}'\n/bin/sleep 0.2\n`,
        { mode: 0o700 },
      )
      const prepared = preparePosixLaunch('/bin/false', [], {
        directory,
        cwd: directory,
        env: { PATH: directory },
      })
      const script = `const c = require('node:child_process').spawn(process.argv[1], process.argv.slice(2), {stdio:'ignore'}); c.on('exit', code => process.exit(code === 125 ? 0 : 1))`
      const harness = spawn(
        process.execPath,
        ['-e', script, prepared.executable, ...prepared.args],
        { detached: true, stdio: 'ignore' },
      )
      track(harness.pid!)
      try {
        expect(await once(harness, 'exit')).toEqual([0, null])
        await expect(prepared.cancel('possibly-launched')).rejects.toThrow('private session/group')
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await prepared.cancel('possibly-launched').catch(() => {})
      }
    }))

  it('waits for the native START acknowledgement instead of believing a write', () =>
    tracked(async (directory, track) => {
      const marker = join(directory, 'provider-ran')
      const ownershipRecordPath = join(directory, randomUUID())
      const prepared = preparePosixLaunch('/usr/bin/touch', [marker], {
        directory,
        ownershipRecordPath,
        graceMs: 15,
        timeoutMs: 1000,
        stdio: 'ignore',
      })
      fault.command = true
      let failureBeforeFallback = ''
      fault.observe = (text) => {
        if (text.includes('ERROR start-command')) {
          failureBeforeFallback = readFileSync(join(ownershipRecordPath, 'journal'), 'utf8')
        }
      }
      const root = launch(prepared)
      track(root.pid)
      try {
        await expect(prepared.bind(root.pid)).rejects.toThrow('start-command failed')
        const failure = prepared.drain()
        expect(prepared.drain()).toBe(failure)
        await expect(failure).rejects.toThrow('start-command failed')
        expect(failureBeforeFallback).toMatch(/^ERROR start-command \d+$/m)
        expect(inspectPosixOwnership(ownershipRecordPath)).toMatchObject({
          state: 'retain',
          reason: expect.stringContaining('native start-command'),
        })
        await root.exit
        expect(groupExists(root.pid)).toBe(false)
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        fault.command = false
        fault.observe = undefined
        await prepared.drain().catch(() => {})
      }
    }))

  it.each(['pid', 'group'] as const)(
    'waits for the recorded reaper %s after the root group is gone',
    (gate) =>
      tracked(async (directory, track) => {
        const prepared = preparePosixLaunch('/bin/true', [], {
          directory,
          graceMs: 20,
          timeoutMs: 2500,
          stdio: 'ignore',
        })
        const helpers = observeHelpers()
        const root = launch(prepared)
        track(root.pid)
        const kill = process.kill
        let held = true
        let blocked = 0
        const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          expect(signal).toBe(0)
          if (held && pid === helpers.reaper() * (gate === 'pid' ? 1 : -1)) {
            blocked++
            return true
          }
          return kill(pid, signal)
        })
        let removed = false
        try {
          await prepared.bind(root.pid)
          track(helpers.reaper())
          expect(helpers.anchor()).toBeGreaterThan(1)
          expect(kernelProbe('in-group', helpers.reaper(), helpers.reaper())).toBe(true)
          expect(kernelProbe('in-group', helpers.anchor(), root.pid)).toBe(true)
          // Even if the provider already exited, the anchor keeps the report open.
          const [lease] = await paths(directory)
          fault.beforeRemove = (path) => {
            if (path !== join(directory, lease!)) return
            helpersAbsent(root.pid, helpers.reaper(), helpers.anchor())
            removed = true
          }
          const drain = prepared.drain()
          let settled = false
          void drain.then(
            () => (settled = true),
            () => (settled = true),
          )
          await root.exit
          await kernelGone(root.pid)
          const previous = blocked
          await vi.waitFor(() => expect(settled || blocked > previous).toBe(true), {
            timeout: 1000,
          })
          expect(settled).toBe(false)
          expect(await paths(directory)).toEqual([lease])
          held = false
          await drain
          expect(removed).toBe(true)
          expect(await paths(directory)).toEqual([])
          const calls = probe.mock.calls.length
          const io = (fault.io = vi.fn())
          expect(prepared.drain()).toBe(drain)
          await prepared.drain()
          expect(probe.mock.calls).toHaveLength(calls)
          expect(io).not.toHaveBeenCalled()
        } finally {
          fault.io = undefined
          held = false
          fault.beforeRemove = undefined
          probe.mockRestore()
          await prepared.drain().catch(() => {})
          if (helpers.reaper() > 1 && helpers.anchor() > 1)
            await vi.waitFor(() => helpersAbsent(root.pid, helpers.reaper(), helpers.anchor()), {
              timeout: 4000,
            })
          fault.observe = undefined
        }
      }),
  )

  it('keeps an unacknowledged reaper in the root group through controller EOF', () =>
    tracked(async (directory, track) => {
      const marker = join(directory, 'provider-ran')
      const prepared = preparePosixLaunch('/usr/bin/touch', [marker], {
        directory,
        stdio: 'ignore',
      })
      const helpers = observeHelpers()
      const root = launch(prepared)
      track(root.pid)
      let rackAttempts = 0
      fault.rack = () => {
        rackAttempts++
        return 'block'
      }
      try {
        const binding = prepared.bind(root.pid)
        void binding.catch(() => {})
        await vi.waitFor(() => expect(rackAttempts).toBeGreaterThan(0), { timeout: 1000 })
        expect(helpers.reaper()).toBeGreaterThan(1)
        expect(kernelProbe('in-group', helpers.reaper(), root.pid)).toBe(true)
        const [lease] = await paths(directory)
        let removed = false
        fault.beforeRemove = (path) => {
          if (path !== join(directory, lease!)) return
          helpersAbsent(root.pid, helpers.reaper())
          removed = true
        }
        await prepared.cancel('possibly-launched')
        expect(removed).toBe(true)
        await expect(binding).rejects.toThrow('cancelled before start')
        expect(await root.exit).toEqual([125, null])
        expect(helpers.anchor()).toBeNaN()
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await paths(directory)).toEqual([])
      } finally {
        fault.rack = undefined
        fault.beforeRemove = undefined
        await prepared.cancel('possibly-launched').catch(() => {})
        if (helpers.reaper() > 1)
          await vi.waitFor(() => helpersAbsent(root.pid, helpers.reaper()), { timeout: 4000 })
        fault.observe = undefined
      }
    }))

  it.each(['bad RACK', 'oversized READY'] as const)(
    'keeps the startup error from %s when the reaper cannot be proved absent',
    (failure) =>
      tracked(async (directory, track) => {
        const marker = join(directory, 'provider-ran')
        const prepared = preparePosixLaunch('/usr/bin/touch', [marker], {
          directory,
          graceMs: 20,
          timeoutMs: 350,
          stdio: 'ignore',
        })
        const helpers = observeHelpers()
        const root = launch(prepared)
        track(root.pid)
        const badAck = failure === 'bad RACK'
        let transferred = false
        if (badAck) fault.rack = () => 'reject'
        else
          fault.rewrite = (text) =>
            text.replace(/^READY [^\n]+$/m, (line) => {
              transferred = kernelProbe('in-group', helpers.reaper(), helpers.reaper())
              return line + ' ' + '0'.repeat(128)
            })
        const expected = badAck ? 'reaper-ack failed' : 'Oversized POSIX launch receipt'
        const kill = process.kill
        const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          expect(signal).toBe(0)
          if (pid === helpers.reaper()) return true
          return kill(pid, signal)
        })
        try {
          const bindingError = await prepared.bind(root.pid).catch((error: unknown) => error)
          expect(bindingError).toMatchObject({ message: expect.stringContaining(expected) })
          if (badAck) expect(helpers.anchor()).toBeNaN()
          else {
            expect(helpers.anchor()).toBeGreaterThan(1)
            expect(transferred).toBe(true)
          }
          const drain = prepared.drain()
          await expect(drain).rejects.toBe(bindingError)
          expect(prepared.drain()).toBe(drain)
          const exit = await root.exit
          if (badAck) expect(exit).toEqual([125, null])
          await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
          const [lease] = await paths(directory)
          expect(bindingError).toMatchObject({ evidenceDirectory: join(directory, lease!) })
          const evidence = await readFile(join(directory, lease!, 'failure'), 'utf8')
          expect(evidence).toContain(`REAPER ${helpers.reaper()}\n`)
          expect(evidence).toContain(expected)
        } finally {
          fault.rack = undefined
          fault.rewrite = undefined
          probe.mockRestore()
          await prepared.drain().catch(() => {})
          if (helpers.reaper() > 1)
            await vi.waitFor(
              () =>
                helpersAbsent(root.pid, helpers.reaper(), badAck ? undefined : helpers.anchor()),
              { timeout: 4000 },
            )
          fault.observe = undefined
        }
      }),
  )

  it('keeps the first probe error and joins EOF fallback with the owned channel', () =>
    tracked(async (directory, track) => {
      const prepared = preparePosixLaunch(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        directory,
        graceMs: 20,
        stdio: 'ignore',
      })
      const root = launch(prepared)
      track(root.pid)
      const kill = process.kill
      const first = new Error('first probe error')
      const fallback = new Error('fallback probe error')
      const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -root.pid) {
          expect(signal).toBe(0)
          throw probe.mock.calls.length === 1 ? first : fallback
        }
        return kill(pid, signal)
      })
      try {
        await prepared.bind(root.pid)
        await expect(prepared.drain()).rejects.toBe(first)
        await root.exit
        await kernelGone(root.pid)
        expect(await paths(directory)).toHaveLength(1)
      } finally {
        probe.mockRestore()
        await prepared.drain().catch(() => {})
      }
    }))

  it('rejects a real zombie despite false-empty ps and KILL intent', () =>
    tracked(async (directory, track) => {
      const marker = join(directory, 'zombie')
      const release = join(directory, 'reap')
      const bin = join(directory, 'bin')
      await mkdir(bin)
      await writeFile(join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      expect(execFileSync(join(bin, 'ps')).length).toBe(0)
      const prepared = preparePosixLaunch(oracle, [marker, release], {
        directory,
        env: { PATH: bin },
        graceMs: 20,
        timeoutMs: 220,
        stdio: 'ignore',
      })
      const root = launch(prepared)
      track(root.pid)
      try {
        await prepared.bind(root.pid)
        expect(await root.exit).toEqual([0, null])
        const [parent, zombie] = (await readFile(marker, 'utf8')).trim().split(' ').map(Number)
        expect(parent).toBeGreaterThan(1)
        expect(zombie).toBeGreaterThan(1)
        expect(groupExists(root.pid)).toBe(true)
        vi.stubEnv('PATH', bin)
        const first = prepared.drain()
        await expect(first).rejects.toThrow('proving the POSIX launch absent')
        expect(prepared.drain()).toBe(first)
        expect(groupExists(root.pid)).toBe(true)
        const [evidence] = await paths(directory)
        expect(await readFile(join(directory, evidence!, 'failure'), 'utf8')).toContain(
          'TERM\nKILL\n',
        )
      } finally {
        vi.unstubAllEnvs()
        await writeFile(release, '')
        await prepared.drain().catch(() => {})
      }
    }))
})
