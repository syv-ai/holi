import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { createOwnedProcesses } from '../scripts/owned-processes.mjs'

const supervisors: ReturnType<typeof createOwnedProcesses>[] = []
const create = (signal?: AbortSignal) => {
  const supervisor = createOwnedProcesses({ signal })
  supervisors.push(supervisor)
  return supervisor
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stopAll()))
})

describe('owned process lifecycle', () => {
  it('runs successfully without an abort signal and preserves output', async () => {
    const processes = create()
    const result = await processes.run(process.execPath, ['-e', "process.stdout.write('complete')"])
    expect(result).toMatchObject({ code: 0, output: 'complete' })
    expect(processes.size).toBe(0)
  })

  it('rejects nonzero exits and preserves stdout and stderr', async () => {
    const processes = create()
    const error = await processes
      .run(process.execPath, [
        '-e',
        "process.stdout.write('stdout marker'); process.stderr.write('stderr marker'); process.exit(7)",
      ])
      .catch((error) => error)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ exitCode: 7 })
    expect(error.message).toContain('stdout marker')
    expect(error.message).toContain('stderr marker')
    expect(processes.size).toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL after the child reports readiness',
    async () => {
      const processes = create()
      const record = processes.start(process.execPath, [
        '-e',
        "process.on('SIGTERM', () => { process.stdout.write('TERM\\n') }); process.stdout.write('READY\\n'); setInterval(() => {}, 1000)",
      ])
      const deadline = Date.now() + 5000
      while (!record.output.includes('READY') && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(record.output).toContain('READY')
      const started = Date.now()
      await processes.stop(record, 50, 1000)
      expect(Date.now() - started).toBeGreaterThanOrEqual(50)
      expect(record.output).toContain('TERM')
      expect(processes.size).toBe(0)
    },
    5000,
  )

  it.skipIf(process.platform === 'win32')(
    'kills surviving group members after the leader exits',
    async () => {
      const processes = create()
      const record = processes.start(process.execPath, [
        '-e',
        `const { spawn } = require('node:child_process');
         const child = spawn(process.execPath, ['-e', "const fs = require('node:fs'); process.on('SIGTERM', () => { process.stdout.write('DESCENDANT_TERM\\\\n') }); fs.writeSync(3, 'DESCENDANT_READY'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'ignore', 'pipe'] });
         child.stdio[3].on('data', (chunk) => {
           if (chunk.toString().includes('DESCENDANT_READY')) {
             process.stdout.write('DESCENDANT_READY\\\\nLEADER_EXITING\\\\n', () => process.exit(0));
           }
         });`,
      ])
      const leaderExited = new Promise((resolve) => record.child.once('exit', resolve))
      const deadline = Date.now() + 5000
      while (!record.output.includes('LEADER_EXITING') && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(record.output).toContain('DESCENDANT_READY')
      expect(record.output).toContain('LEADER_EXITING')
      await leaderExited
      expect(processes.size).toBe(1)
      await processes.stop(record, 50, 1000)
      expect(record.output).toContain('DESCENDANT_TERM')
      expect(processes.size).toBe(0)
    },
    10000,
  )

  it.skipIf(process.platform === 'win32')(
    'lets an inner supervisor reap its TERM-resistant group before outer escalation',
    async () => {
      const processes = create()
      const record = processes.start(process.execPath, [
        '-e',
        `const { spawn } = require('node:child_process');
         const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('CHILD_READY'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
         process.on('SIGTERM', () => {
           child.kill('SIGTERM');
           setTimeout(() => child.kill('SIGKILL'), 1100);
           child.once('exit', (_code, signal) => {
             process.stdout.write('INNER_GROUP_REAPED:' + signal);
             process.exit(0);
           });
         });
         child.stdout.on('data', (chunk) => {
           if (chunk.toString().includes('CHILD_READY')) process.stdout.write('INNER_READY');
         });
         setInterval(() => {}, 1000);`,
      ])
      const deadline = Date.now() + 5000
      while (!record.output.includes('INNER_READY') && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(record.output).toContain('INNER_READY')
      await processes.stop(record, 1500, 1000)
      expect(record.output).toContain('INNER_GROUP_REAPED:SIGKILL')
      expect(processes.size).toBe(0)
    },
    10000,
  )

  it('supervises stdin EPIPE and awaits child cleanup', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: { end: () => void; on: (event: string, listener: (error: Error) => void) => void }
      stdout: EventEmitter
      stderr: EventEmitter
      pid: undefined
    }
    const stdin = new EventEmitter() as EventEmitter & { end: () => void }
    stdin.end = () => {
      queueMicrotask(() => {
        const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
        stdin.emit('error', error)
      })
    }
    child.stdin = stdin
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = undefined
    const processes = createOwnedProcesses({ spawn: () => child as never })
    await expect(
      processes.run('keyring-daemon', [], { input: 'password', label: 'keyring daemon' }),
    ).rejects.toThrow(/broken pipe/)
    expect(processes.size).toBe(0)
  })

  it('prevents spawning after run-wide cancellation', async () => {
    const controller = new AbortController()
    let spawns = 0
    const processes = create(controller.signal)
    const guarded = createOwnedProcesses({
      signal: controller.signal,
      spawn: (...args) => {
        spawns += 1
        return spawn(...args)
      },
    })
    controller.abort()
    expect(() => guarded.start(process.execPath, ['-e', 'process.exit(0)'])).toThrow(
      /aborted before spawn/,
    )
    expect(spawns).toBe(0)
    await processes.stopAll()
    await guarded.stopAll()
  })

  it('cancels an active run, reaps it, and prevents later launches', async () => {
    const controller = new AbortController()
    const processes = create(controller.signal)
    const running = processes.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      label: 'active child',
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort()
    await expect(running).rejects.toThrow(/active child aborted/)
    expect(processes.size).toBe(0)
    expect(() => processes.start(process.execPath, ['-e', 'process.exit(0)'])).toThrow(
      /aborted before spawn/,
    )
  })
})
