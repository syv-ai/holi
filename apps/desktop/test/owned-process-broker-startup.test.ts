import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'
import { brokerHostPlan } from '../src/main/owned-process-broker-host'
import { win32Adapter } from '../src/main/owned-process-win32'

it.skipIf(process.platform !== 'win32')(
  'starts the native Job broker and joins its pipes',
  async () => {
    const adapter = win32Adapter('RunBroker', process.env)
    const plan = brokerHostPlan(process.execPath, adapter)
    const child = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      env: adapter.env,
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const pipes = [child.stdin, child.stdout, child.stderr]
    let transportFailed = pipes.some((pipe) => !pipe)
    child.on('error', () => (transportFailed = true))
    const closed = new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const pipeCloses = pipes.filter(Boolean).map(
      (pipe) =>
        new Promise<void>((resolve) => {
          pipe.on('error', () => (transportFailed = true))
          pipe.once('close', resolve)
        }),
    )
    let sawStdout = false
    child.stdout?.on('data', () => (sawStdout = true))
    const stderr = Buffer.alloc(80)
    let bytes = 0
    child.stderr?.on('data', (chunk: Buffer) => {
      bytes += chunk.copy(stderr, bytes)
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // No valid spec or grant was sent, so there is no owned Job or Root.
      try {
        child.kill('SIGKILL')
      } catch {
        transportFailed = true
      } finally {
        for (const pipe of pipes) pipe?.destroy()
      }
    }, 10_000)
    try {
      // The unmodified C# entry must reject the missing launchId before opening
      // any process or Job. A silent exit (including zero) cannot pass.
      child.stdin?.end('{}\n')
      const [status] = await Promise.all([closed, ...pipeCloses])
      expect(timedOut).toBe(false)
      expect(transportFailed).toBe(false)
      expect(status).toEqual({ code: 125, signal: null })
      expect(child.stdout.readableEnded && child.stderr.readableEnded).toBe(true)
      expect(sawStdout).toBe(false)
      expect(stderr.toString('latin1', 0, bytes)).toBe('HOLI_BROKER_FAILURE read-spec 0\n')
    } finally {
      clearTimeout(timer)
    }
  },
)
