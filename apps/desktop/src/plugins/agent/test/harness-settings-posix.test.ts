import { randomUUID } from 'node:crypto'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  kernelGroupAbsent,
  posixFixtureLedger,
} from '../../../../test/fixtures/posix-fixture-ledger'
import { createAgentProbeOwner } from '../main/probe-owner'
import { harnessCapabilities } from '../main/harness/capabilities'
import type { HarnessRegistry } from '../main/harness/registry'

let ledger: Awaited<ReturnType<typeof posixFixtureLedger>>
let group: number
vi.mock('../../../main/plugin-api', async (actual) => {
  const api = await actual<typeof import('../../../main/plugin-api')>()
  return {
    ...api,
    spawnOwnedProgram: (...args: Parameters<typeof api.spawnOwnedProgram>) => {
      const control = join(ledger.root, randomUUID())
      const child = api.spawnOwnedProgram(args[0], args[1], {
        ...args[2],
        ownershipRecordPath: control,
      })
      group = ledger.record(child)
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      const ancestry = ledger.retain(
        group,
        () => child[api.ownedProcessDrain]!.drain(),
        closed,
        control,
      )
      child.once('spawn', ancestry)
      return child
    },
  }
})

async function waitReady(path: string) {
  await vi.waitFor(
    async () => {
      const ready = JSON.parse(await readFile(path, 'utf8')) as { child: number }
      expect(ready.child).toBeGreaterThan(1)
    },
    { timeout: 3000 },
  )
}

describe.skipIf(process.platform === 'win32')('Settings Test physical POSIX drainage', () => {
  test.each(['cancel', 'timeout', 'output', 'zero', 'nonzero'] as const)(
    '%s joins resistant descendant drainage',
    async (mode) => {
      ledger = await posixFixtureLedger('holi-harness-drain-')
      const controller = new AbortController()
      const probes = createAgentProbeOwner(controller.signal)
      let answer: Promise<unknown> | undefined
      const failures: unknown[] = []
      try {
        const script = join(ledger.root, 'fixture.cjs')
        const ready = join(ledger.root, 'ready.json')
        const trigger = join(ledger.root, 'continue')
        await writeFile(
          script,
          `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({child:process.pid})); setInterval(()=>{},1000);`)}], {stdio:['ignore','inherit','inherit']});
const timer=setInterval(()=>{
 if (!fs.existsSync(${JSON.stringify(trigger)})) return;
 clearInterval(timer);
 if (${JSON.stringify(mode)}==='output') { process.stdout.write('x'.repeat(270*1024)); setInterval(()=>{},1000); }
 else process.exit(${mode === 'nonzero' ? 7 : 0});
},10);
`,
        )
        const caps = harnessCapabilities({
          registry: {
            get: () => ({ env: {}, test: [script] }),
            resolve: () => process.execPath,
          } as unknown as HarnessRegistry,
          probes,
          file: 'fixture.json',
          root: () => ledger.root,
          changed() {},
        })
        const run = caps['agent.harnessTest'].run(
          { remote: 'fixture/vault', root: ledger.root } as never,
          { id: 'fixture' },
        )
        answer = run
        void run.catch(() => {})
        // The descendant publishes only after installing SIGTERM resistance.
        await waitReady(ready)
        if (mode === 'cancel') controller.abort()
        else if (mode !== 'timeout') await writeFile(trigger, '')
        const result = await run
        kernelGroupAbsent(group)
        expect(result.ok).toBe(mode === 'zero')
        expect(result.output.length).toBeLessThanOrEqual(4000)
        if (mode === 'cancel')
          expect(result).toMatchObject({ message: expect.stringMatching(/cancel/i) })
        if (mode === 'timeout')
          expect(result).toMatchObject({ message: expect.stringMatching(/5 seconds/) })
      } catch (error) {
        failures.push(error)
      } finally {
        controller.abort()
        const stopped = await Promise.allSettled([probes.stop(), answer ?? Promise.resolve()])
        for (const result of stopped) if (result.status === 'rejected') failures.push(result.reason)
        // Always attempt retained cleanup even when activation teardown failed.
        // A failed physical proof preserves the directory and diagnostic receipts.
        let reaped = false
        try {
          await ledger.reap()
          reaped = true
        } catch (error) {
          failures.push(error)
        }
        if (reaped) {
          try {
            await ledger.remove()
          } catch (error) {
            failures.push(error)
          }
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Native harness fixture failed')
    },
    15000,
  )
})
