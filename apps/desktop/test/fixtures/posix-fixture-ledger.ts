import { execFileSync, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'

export function kernelGroupAbsent(group: number) {
  expect(() => process.kill(-group, 0), `fixture group ${group}`).toThrow(
    expect.objectContaining({ code: 'ESRCH' }),
  )
}

/** Record ancestry only for diagnostics; neither these PIDs nor the receipt convey authority. */
function leaseAncestry(root: number) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], {
    encoding: 'utf8',
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    timeout: 1000,
  })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
  // A fast provider may already have exited by the synthetic spawn event.
  // Its anchor still holds the root group and the reaper is in its own group.
  const pair = rows.find(
    ([pid, parent, group]) =>
      pid !== root &&
      group === root &&
      parent !== root &&
      rows.some(([candidate, , reaperGroup]) => candidate === parent && candidate === reaperGroup),
  )
  if (!pair) throw new Error(`Missing owned lease ancestry for root ${root}`)
  return { anchor: pair[0]!, reaper: pair[1]! }
}

/** Diagnostic only; a process-table scan is not an absence proof. */
export function groupMembers(group: number): number[] {
  return execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    timeout: 1000,
    killSignal: 'SIGKILL',
  })
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, pgid]) => pgid === group)
    .map(([pid]) => pid!)
}

export async function posixFixtureLedger(prefix = 'holi-posix-proof-') {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const groups = new Set<number>()
  const owners = new Set<number>()
  const leases: Array<{ drain: () => Promise<void>; outputClosed: Promise<unknown> }> = []
  const receipt = (pid: number, values: object) =>
    writeFileSync(
      join(root, `lease-${pid}.json`),
      JSON.stringify({ owner: process.pid, root: pid, ...values }),
    )
  writeFileSync(join(root, 'fixture-owner'), `${process.pid}\n`)
  return {
    root,
    record(child: ChildProcess) {
      const pid = child.pid
      if (pid === undefined || pid <= 1 || pid === process.pid)
        throw new Error('Missing detached fixture PID')
      groups.add(pid)
      writeFileSync(join(root, `group-${pid}.receipt`), `${pid}\n`)
      return pid
    },
    retain(
      pid: number,
      drain: () => Promise<void>,
      outputClosed: Promise<unknown>,
      control: string,
    ) {
      leases.push({ drain, outputClosed })
      receipt(pid, { control })
      return () => {
        const { anchor, reaper } = leaseAncestry(pid)
        owners.add(anchor)
        owners.add(reaper)
        receipt(pid, { control, anchor, reaper })
      }
    },
    async reap() {
      const results = await Promise.allSettled(
        leases.map(async ({ drain, outputClosed }) => {
          await drain()
          await outputClosed
        }),
      )
      const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
      if (failures.length) throw new AggregateError(failures, `Failed to reap fixtures in ${root}`)
    },
    async remove() {
      // The fixture caller closes its retained ownership channel first. Never
      // try to recover authority from a process-table snapshot or PID receipt.
      await vi.waitFor(
        () => {
          for (const group of groups) kernelGroupAbsent(group)
          for (const pid of owners)
            expect(() => process.kill(pid, 0), `fixture owner ${pid}`).toThrow(
              expect.objectContaining({ code: 'ESRCH' }),
            )
        },
        { timeout: 4000 },
      )
      await rm(root, { recursive: true, force: true })
      await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  }
}
