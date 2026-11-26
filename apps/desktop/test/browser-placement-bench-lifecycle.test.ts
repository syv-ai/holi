import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createOwnedProcesses } from '../scripts/owned-processes.mjs'

const supervisors: ReturnType<typeof createOwnedProcesses>[] = []

const createSupervisor = () => {
  const supervisor = createOwnedProcesses()
  supervisors.push(supervisor)
  return supervisor
}

const waitFor = async (condition: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  return condition()
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stopAll()))
})

describe('browser placement benchmark process lifecycle', () => {
  it.skipIf(process.platform === 'win32')(
    'drains a TERM-resistant descendant after its leader exits',
    async () => {
      const supervisor = createSupervisor()
      const record = supervisor.start(process.execPath, [
        '-e',
        `const { spawn } = require('node:child_process');
         const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send?.('READY'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
         descendant.on('message', (message) => {
           if (message === 'READY') {
             process.stdout.write(JSON.stringify({ ready: true, pid: descendant.pid }) + '\\n');
             process.exit(0);
           }
         });`,
      ])

      try {
        const leaderExited = new Promise<void>((resolve) =>
          record.child.once('exit', () => resolve()),
        )
        const ready = await waitFor(() => record.output.includes('{"ready":true'), 5000)
        expect(ready).toBe(true)
        await leaderExited
        const readiness = record.output
          .split('\n')
          .map((line) => {
            try {
              return JSON.parse(line) as { ready?: boolean; pid?: number }
            } catch {
              return undefined
            }
          })
          .find((line) => line?.ready)
        expect(readiness?.pid).toBeGreaterThan(0)

        const groupExists = () => {
          try {
            process.kill(-record.child.pid!, 0)
            return true
          } catch (error) {
            return (error as NodeJS.ErrnoException).code !== 'ESRCH'
          }
        }
        expect(groupExists()).toBe(true)

        await supervisor.stopAll()
        expect(await waitFor(() => !groupExists(), 3000)).toBe(true)
      } finally {
        await supervisor.stopAll()
      }
    },
    10000,
  )
})
