import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync } from 'node:fs'
import { inspectPosixOwnership, preparePosixLaunch } from '../../../main/plugin-api'

import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createJobs } from '../main/host/jobs'
import { activationOwnership } from '../main/host/ownership'

const transport = vi.hoisted(() => ({ parent: '', fds: new Set<number>() }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      if (transport.parent && String(args[0]).startsWith(transport.parent + '/holi-launch-'))
        transport.fds.add(fd)
      return fd
    },
    closeSync: (fd: number) => {
      transport.fds.delete(fd)
      fs.closeSync(fd)
    },
  }
})

const id = 'j0123456789ab'
const rootPid = 940001
const reaper = 940002
const anchor = 940003

it
  .skipIf(process.platform === 'win32')
  .each(['reaper', 'protocol', 'finalizing', 'missing', 'partial', 'legacy'])(
  'keeps cold jobs with %s evidence even when the root and its group are gone',
  async (kind) => {
    const data = await realpath(await mkdtemp(join(tmpdir(), 'holi-jobs-cold-')))
    const vault = { remote: 'fixture/vault', root: join(data, 'vault') }
    const scratchRoot = join(data, 'jobs')
    await mkdir(vault.root)
    await writeFile(join(vault.root, 'note'), 'vault contents')
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(signal).toBe(0)
      expect([rootPid, -rootPid, reaper, -reaper, anchor]).toContain(pid)
      if (kind === 'reaper' && (pid === reaper || pid === -reaper)) return true
      throw Object.assign(new Error('fixture absence'), { code: 'ESRCH' })
    })
    try {
      const old = new AbortController()
      const registry = activationOwnership(data, vault, old.signal)!
      registry.recover('jobs', { root: scratchRoot, consumerId: () => undefined })
      if (kind !== 'legacy') {
        const record = registry.allocate('jobs', id)
        const path = record.ownershipRecordPath!
        await mkdir(path, { mode: 0o700 })
        const header = `HOLI-POSIX-1 ${basename(path)}\n`
        if (kind !== 'missing') {
          const identities =
            kind === 'partial'
              ? `ROOT ${rootPid}\n`
              : `ROOT ${rootPid}\nREAPER ${reaper}\nANCHOR ${anchor}\nCOMPLETE\n`
          await writeFile(join(path, 'journal'), header + identities, { mode: 0o600 })
        }
        if (kind === 'protocol' || kind === 'finalizing') {
          await writeFile(
            join(path, kind === 'protocol' ? 'failed' : 'settled'),
            header + (kind === 'protocol' ? 'FAILED protocol\n' : 'SETTLED\n'),
            { mode: 0o600 },
          )
        }
      }
      const state = join(scratchRoot, `${id}.agent`, 'history')
      await mkdir(dirname(state), { recursive: true })
      await writeFile(state, 'thread history')
      await writeFile(join(scratchRoot, `${id}.pid`), `${rootPid}\n${vault.root}\n`)
      if (kind !== 'legacy')
        await writeFile(
          join(scratchRoot, `${id}.turn`),
          `HOLI-JOB-1 ${id}\n${kind === 'finalizing' ? 'FINALIZING' : 'ACTIVE'}\n`,
          { mode: 0o600 },
        )
      old.abort()
      const open = () =>
        createJobs({
          vault,
          scratchRoot,
          ownership: activationOwnership(data, vault, new AbortController().signal)!,
          onChange: () => {},
        })
      await expect(open().leave()).rejects.toThrow('Retaining')
      expect(await readFile(state, 'utf8')).toBe('thread history')
      expect(await readFile(join(vault.root, 'note'), 'utf8')).toBe('vault contents')
      if (kind === 'legacy') expect(kill).not.toHaveBeenCalled()
      if (kind === 'reaper') {
        kill.mockImplementation((pid, signal) => {
          expect(signal).toBe(0)
          expect([rootPid, -rootPid, reaper, -reaper, anchor]).toContain(pid)
          throw Object.assign(new Error('fixture absence'), { code: 'ESRCH' })
        })
        kill.mockClear()
        await open().leave()
        expect(new Set(kill.mock.calls.map(([pid]) => pid))).toEqual(
          new Set([rootPid, -rootPid, reaper, -reaper, anchor]),
        )
      }
    } finally {
      kill.mockRestore()
      // These identities are entirely synthetic; no native process was started.
      await rm(data, { recursive: true, force: true })
    }
  },
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'retains real scoped and vault scratch through controller EOF and the native grace',
  async () => {
    const data = await realpath(await mkdtemp(join(tmpdir(), 'holi-jobs-native-eof-')))
    transport.parent = data
    const vault = { remote: 'fixture/vault', root: join(data, 'vault') }
    const scratchRoot = join(data, 'jobs')
    const old = new AbortController()
    const scoped = join(scratchRoot, id)
    const vaultId = 'j0123456789ac'
    const state = join(scratchRoot, `${vaultId}.agent`, 'history')
    const ready = join(data, 'ready')
    const term = join(data, 'term')
    const released = join(data, 'released')
    let recordPath: string | undefined
    let exited: Promise<unknown> | undefined
    let root: number | undefined
    const loseController = () => {
      old.abort()
      for (const fd of transport.fds) closeSync(fd)
    }
    const journalIdentities = async () => {
      const journal = await readFile(join(recordPath!, 'journal'), 'utf8')
      return [...journal.matchAll(/^(ROOT|REAPER|ANCHOR) (\d+)$/gm)].flatMap(([, role, value]) => {
        const pid = Number(value)
        return role === 'ANCHOR' ? [pid] : [pid, -pid]
      })
    }
    const waitAbsent = (ids: number[]) =>
      vi.waitFor(
        () => {
          for (const pid of ids)
            expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        },
        { timeout: 6500 },
      )
    try {
      await mkdir(vault.root)
      await writeFile(join(vault.root, 'note'), 'vault contents')
      const registry = activationOwnership(data, vault, old.signal)!
      registry.recover('jobs', { root: scratchRoot, consumerId: () => undefined })
      const idleVault = registry.allocate('jobs', vaultId, 'explicit')
      idleVault.nonLaunch() // No provider was invoked for this synthetic idle vault job.
      const record = registry.allocate('jobs', id)
      recordPath = record.ownershipRecordPath!
      await mkdir(scoped, { recursive: true, mode: 0o700 })
      await mkdir(dirname(state))
      await writeFile(state, 'thread contents')
      await writeFile(join(scratchRoot, `${vaultId}.turn`), `HOLI-JOB-1 ${vaultId}\nSETTLED\n`, {
        mode: 0o600,
      })
      const writer = `
        const fs = require('node:fs');
        process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(term)}, 'resisted'));
        fs.writeFileSync('output', 'scratch output');
        fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
        setInterval(() => { if (fs.existsSync(${JSON.stringify(released)})) process.exit(0) }, 20);
        setTimeout(() => process.exit(0), 7000);
      `
      const parent = `
        process.on('SIGTERM', () => {});
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], {stdio: 'ignore'}).once('exit', () => process.exit(0));
      `
      const launch = preparePosixLaunch(process.execPath, ['-e', parent], {
        cwd: scoped,
        directory: data,
        ownershipRecordPath: recordPath,
        stdio: 'ignore',
        graceMs: 2500,
      })
      const child = spawn(launch.executable, launch.args, launch.options)
      root = child.pid!
      exited = once(child, 'exit')
      void exited.catch(() => {})
      await launch.bind(root)
      const writerPid = await vi.waitFor(async () => {
        const value = Number(await readFile(ready, 'utf8'))
        expect(value).toBeGreaterThan(1)
        return value
      })
      await writeFile(join(scratchRoot, `${id}.turn`), `HOLI-JOB-1 ${id}\nACTIVE\n`, {
        mode: 0o600,
      })
      await writeFile(join(scratchRoot, `${id}.pid`), `${root}\n${scoped}\n`)
      const identities = await journalIdentities()
      expect(identities).toHaveLength(5)
      const reaperGroup = identities[3]!
      expect(reaperGroup).toBeLessThan(0)
      const fresh = () =>
        createJobs({
          vault,
          scratchRoot,
          onChange: () => {},
          log: () => {},
          ownership: activationOwnership(data, vault, new AbortController().signal)!,
        })
      loseController()
      await vi.waitFor(() => expect(readFile(term, 'utf8')).resolves.toBe('resisted'))
      expect(() => process.kill(writerPid, 0)).not.toThrow()
      expect(() => process.kill(reaperGroup, 0)).not.toThrow()
      await expect(fresh().leave()).rejects.toThrow('still has a PID or group')
      expect(await readFile(join(scoped, 'output'), 'utf8')).toBe('scratch output')
      expect(await readFile(state, 'utf8')).toBe('thread contents')
      await writeFile(released, '')
      await exited
      await waitAbsent([...identities, writerPid])
      expect(inspectPosixOwnership(recordPath)).toEqual({
        state: 'confirmed',
        proof: 'kernel-absence',
      })
      await fresh().leave()
      await expect(access(scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(recordPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(vault.root, 'note'), 'utf8')).toBe('vault contents')
      recordPath = undefined
    } finally {
      loseController()
      if (recordPath && root) {
        await writeFile(released, '')
        await exited?.catch(() => {})
        const ids = await journalIdentities()
        const writer = Number(await readFile(ready, 'utf8').catch(() => '0'))
        await waitAbsent([root, -root, ...ids, ...(writer > 1 ? [writer] : [])])
      }
      transport.parent = ''
      await rm(data, { recursive: true, force: true })
      await expect(access(data)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  },
  15000,
)
