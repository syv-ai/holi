import { randomUUID } from 'node:crypto'

import { readFileSync } from 'node:fs'
import { access, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { bounded } from '../main/host/bounded'
import {
  kernelGroupAbsent,
  posixFixtureLedger,
} from '../../../../test/fixtures/posix-fixture-ledger'
import { ownedProcessDrain, spawnOwnedProgram } from '../../../main/plugin-api'
import { readJobEvent } from '../main/codex'
import { createJobs } from '../main/host/jobs'
import type { JobsProvider } from '../main/provider'

const gates = vi.hoisted(() => ({
  root: '',
  descriptors: new Map<number, string>(),
  hold: undefined as 'S' | 'G' | undefined,
  reached: undefined as (() => void) | undefined,
  sweep: undefined as Promise<void> | undefined,
}))
vi.mock('../main/host/bounded', async (original) => {
  const { bounded } = await original<typeof import('../main/host/bounded')>()
  return {
    bounded: <T>(work: Promise<T>, label: string, timeout?: number) =>
      bounded(
        gates.sweep && label === 'Agent job state sweep'
          ? Promise.all([work, gates.sweep]).then(([result]) => result)
          : work,
        label,
        timeout,
      ),
  }
})
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      const path = String(args[0])
      if (gates.root && path.startsWith(`${gates.root}/`)) gates.descriptors.set(fd, path)
      return fd
    },
    closeSync: (fd: number) => {
      fs.closeSync(fd)
      gates.descriptors.delete(fd)
    },
    writeSync: (fd: number, bytes: Buffer, offset: number, length: number) => {
      if (
        gates.hold &&
        gates.descriptors.get(fd)?.endsWith('/control') &&
        length === 1 &&
        bytes.toString('utf8', offset, offset + length) === gates.hold
      ) {
        gates.reached?.()
        return 0
      }
      return fs.writeSync(fd, bytes, offset, length)
    },
  }
})

it.skipIf(process.platform === 'win32').each(['S', 'G', 'after GO', 'registering'] as const)(
  'direct jobs leave closes native admission with the sweep join held: %s',
  async (phase) => {
    const ledger = await posixFixtureLedger('holi-job-leave-')
    gates.root = ledger.root
    const vault = { remote: 'fixture/vault', root: join(ledger.root, 'vault') }
    const scratchRoot = join(ledger.root, 'jobs')
    const marker = join(vault.root, 'body-entered')
    const receipt = join(ledger.root, randomUUID())
    await mkdir(vault.root)
    const leaseModule = await import('../../../main/posix-launch-lease')
    const prepare = leaseModule.preparePosixSpawn
    const local = vi
      .spyOn(leaseModule, 'preparePosixSpawn')
      .mockImplementation((bin, args, opts, stdio) =>
        prepare(
          bin,
          args,
          { ...opts, directory: ledger.root, ownershipRecordPath: receipt, graceMs: 75 },
          stdio,
        ),
      )
    const drain = vi.fn()
    let releaseSweep!: () => void
    const sweep = new Promise<void>((resolve) => {
      releaseSweep = resolve
    })
    let reached!: () => void
    const atGate = new Promise<void>((resolve) => {
      reached = resolve
    })
    gates.reached = reached
    if (phase === 'S' || phase === 'G') gates.hold = phase
    let leaving: Promise<void> | undefined
    const provider: JobsProvider = {
      id: 'codex',
      label: 'Codex',
      notInstalled: 'missing',
      installed: () => true,
      configure: async () => ({ dir: ledger.root }),
      terminal: () => null,
      capabilities: {
        jobs: {
          command: () => ({
            bin: process.execPath,
            args: [
              '-e',
              `require('node:fs').writeFileSync(process.argv[1], 'entered'); setInterval(() => {}, 1000)`,
              marker,
            ],
            env: {},
          }),
          event: readJobEvent,
        },
      },
    }
    let rootPid: number | undefined
    const ids = new Set<number>()
    const capture = () => {
      const journal = readFileSync(join(receipt, 'journal'), 'utf8')
      for (const [, pid] of journal.matchAll(/^(?:ROOT|REAPER|ANCHOR) (\d+)$/gm))
        ids.add(Number(pid))
    }
    const jobs = createJobs({
      vault,
      scratchRoot,
      onChange: () => {},
      log: () => {},
      spawn: (bin, args, opts) => {
        const child = spawnOwnedProgram(bin, args, { ...opts, posixGroupLease: true })
        const lease = child[ownedProcessDrain]!
        const original = lease.drain
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
        rootPid = ledger.record(child)
        ledger.retain(
          rootPid,
          async () => {
            await original()
            capture()
          },
          closed,
          'job leave control',
        )
        lease.drain = drain.mockImplementation(original)
        if (phase === 'registering') {
          gates.sweep = sweep
          leaving = jobs.leave()
          void leaving.catch(() => {})
        }
        return child
      },
    })
    try {
      const started = await jobs.start({ provider, name: 'direct leave', prompt: 'go', allow: [] })
      if (!started.ok) throw new Error(started.message)
      if (phase === 'after GO') await vi.waitFor(() => access(marker))
      else if (phase !== 'registering') await bounded(atGate, 'queued native command', 2000)

      if (phase !== 'registering') {
        capture()
        expect(ids.has(rootPid!)).toBe(true)
      }
      gates.sweep = sweep
      leaving ??= jobs.leave()
      void leaving.catch(() => {})
      expect(drain).toHaveBeenCalledOnce()
      if (phase !== 'after GO') {
        expect([...gates.descriptors.values()].some((path) => path.endsWith('/control'))).toBe(
          false,
        )
        gates.hold = undefined
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(jobs.sessions()).toHaveLength(1)
      const joined = jobs.leave()
      void joined.catch(() => {})
      releaseSweep()
      await Promise.all([leaving, joined])
      expect(drain).toHaveBeenCalledOnce()
      if (phase !== 'after GO')
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(jobs.sessions()).toEqual([])
      await expect(access(scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      gates.hold = undefined
      releaseSweep()
      await Promise.allSettled([leaving ?? jobs.leave()])
      await ledger.reap()
      for (const id of ids) {
        expect(() => process.kill(id, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        kernelGroupAbsent(id)
      }
      expect(gates.descriptors.size).toBe(0)
      expect(
        (await readdir(ledger.root)).filter((name) => name.startsWith('holi-launch-')),
      ).toEqual([])
      local.mockRestore()
      gates.sweep = undefined
      gates.root = ''
      gates.reached = undefined
      await ledger.remove()
    }
  },
)
