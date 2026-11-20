import { readFileSync, renameSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as processApi from '../../../main/plugin-api'
import { posixFixtureLedger } from '../../../../test/fixtures/posix-fixture-ledger'
import { readJobEvent } from '../main/codex'
import { createJobs } from '../main/host/jobs'
import type { JobsProvider } from '../main/provider'
import { absent, trackedJobProcesses } from './fixtures/tracked-job-processes'

it.skipIf(process.platform === 'win32')(
  'recovers before retention after native follow-up exec admission is refused',
  async () => {
    const ledger = await posixFixtureLedger('holi-job-followup-recovery-')
    const root = join(ledger.root, 'vault')
    const scratchRoot = join(ledger.root, 'jobs')
    const workspace = join(root, 'workspace')
    const moved = join(root, 'moved')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'user.txt'), 'user content')
    const thread = '123e4567-e89b-42d3-a456-426614174000'
    let followups = 0
    let unlaunched: Promise<void> | undefined
    const nativeSpawn = processApi.spawnOwnedProgram
    const observed = vi.spyOn(processApi, 'spawnOwnedProgram').mockImplementation((...args) => {
      const child = nativeSpawn(...args)
      const lease = child[processApi.ownedProcessDrain]!
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      if (child.pid === undefined) {
        unlaunched = Promise.all([lease.drain(), closed]).then(() => {})
        void unlaunched.catch(() => {})
      } else {
        const pid = ledger.record(child)
        const identify = ledger.retain(pid, lease.drain, closed, 'job control')
        child.once('spawn', identify)
      }
      return child
    })
    const provider: JobsProvider = {
      id: 'codex',
      label: 'Codex',
      notInstalled: 'missing',
      installed: () => true,
      configure: async () => ({ dir: ledger.root }),
      terminal: () => null,
      capabilities: {
        jobs: {
          command: (run) => {
            if (run.resume !== undefined && ++followups === 1) {
              expect(run.resume).toBe(thread)
              // Node cannot exec the lease helper when its cwd has disappeared.
              renameSync(workspace, moved)
            }
            return {
              bin: process.execPath,
              args: [
                '-e',
                `console.log(JSON.stringify({type:'thread.started', thread_id:'${thread}'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5}}))`,
              ],
              env: {},
            }
          },
          event: readJobEvent,
        },
      },
    }
    const open = () =>
      createJobs({
        vault: { remote: 'fixture/vault', root },
        scratchRoot,
        onChange: () => {},
        log: () => {},
        keepMs: 60_000,
      })
    const spec = { provider, name: 'native refusal', prompt: 'go', allow: ['Edit(workspace/**)'] }
    const jobs = open()
    let recovery: ReturnType<typeof open> | undefined
    try {
      const first = await jobs.start(spec)
      if (!first.ok) throw new Error(first.message)
      await vi.waitFor(
        () => expect(jobs.sessions()[0]).toMatchObject({ state: 'idle', outcome: 'completed' }),
        { timeout: 4_000 },
      )
      const id = first.sessionId
      const history = join(scratchRoot, `${id}.agent`, 'history')
      await access(join(scratchRoot, `${id}.pid`))
      await writeFile(history, 'old thread context')
      jobs.message(id, 'resume')
      await vi.waitFor(() =>
        expect(jobs.sessions()[0]).toMatchObject({
          id,
          state: 'idle',
          outcome: 'failed',
          error: expect.stringMatching(/did not start.*ENOENT/),
        }),
      )
      expect(unlaunched).toBeDefined()
      await unlaunched
      expect(jobs.has(id)).toBe(true)
      expect(await readFile(history, 'utf8')).toBe('old thread context')
      renameSync(moved, workspace)
      // Simulate ungraceful shutdown: no leave/expiry removed the retained state.
      // A fresh owner must run the real disk sweep and admit a new native job.
      recovery = open()
      const reopened = await recovery.start(spec)
      if (!reopened.ok) throw new Error(reopened.message)
      await expect(access(join(scratchRoot, `${id}.agent`))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await vi.waitFor(
        () =>
          expect(recovery!.sessions()[0]).toMatchObject({ state: 'idle', outcome: 'completed' }),
        { timeout: 4_000 },
      )
      expect(await readFile(join(workspace, 'user.txt'), 'utf8')).toBe('user content')
    } finally {
      observed.mockRestore()
      await ledger.reap()
      await unlaunched
      if (recovery) await Promise.allSettled([recovery.leave()])
      await jobs.leave()
      await ledger.remove()
    }
  },
)

it
  .skipIf(process.platform !== 'darwin' && process.platform !== 'linux')
  .each(['inherit', 'ignore'] as const)(
  'joins root exit with a TERM-resistant descendant (stdio: %s)',
  async (stdio) => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-job-native-drain-'))
    const root = join(dir, 'vault')
    const scratchRoot = join(dir, 'jobs')
    const descendantFile = join(dir, 'descendant.pid')
    const tracked = trackedJobProcesses(dir)
    await mkdir(root)
    const descendant = [
      "process.on('SIGTERM', () => {})",
      "const fs = require('node:fs'); fs.writeFileSync(process.argv[1] + '.ready', String(process.pid)); fs.renameSync(process.argv[1] + '.ready', process.argv[1])",
      // Fallback if even the test harness dies; not the cleanup under test.
      'setTimeout(() => process.exit(1), 15_000)',
    ].join(';')
    const script = [
      "const fs = require('node:fs')",
      `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, process.argv[1]], { stdio: ${JSON.stringify(stdio)} }).unref()`,
      'const ready = setInterval(() => { if (!fs.existsSync(process.argv[1])) return',
      'clearInterval(ready)',
      "fs.writeFileSync('out.txt', 'done')",
      'console.log(JSON.stringify({ type: "turn.completed" }))',
      '}, 10)',
    ].join(';')
    let exited: Promise<{ alive: boolean; closed: boolean }> | undefined
    let rootPid: number | undefined
    let outputClosed = false
    const releaseProof: Array<{
      groupAbsent: boolean
      childAbsent: boolean
      outputClosed: boolean
    }> = []
    const readPid = async () => Number(await readFile(descendantFile, 'utf8'))
    const provider: JobsProvider = {
      id: 'codex',
      label: 'Codex',
      notInstalled: 'missing',
      installed: () => true,
      configure: async () => ({ dir }),
      terminal: () => null,
      release: async () => {
        releaseProof.push({
          groupAbsent: absent(-rootPid!),
          childAbsent: absent(await readPid()),
          outputClosed,
        })
      },
      capabilities: {
        jobs: {
          command: () => ({ bin: process.execPath, args: ['-e', script, descendantFile], env: {} }),
          event: readJobEvent,
        },
      },
    }
    const jobs = createJobs({
      vault: { remote: 'fixture/vault', root },
      scratchRoot,
      onChange: () => {},
      log: () => {},
      spawn: (...args) => {
        const child = tracked.spawn(...args)
        rootPid = child.pid
        child.once('close', () => {
          outputClosed = true
        })
        exited = new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('exit', () => {
            try {
              const pid = Number(readFileSync(descendantFile, 'utf8'))
              resolve({ alive: !absent(pid), closed: outputClosed })
            } catch (error) {
              reject(error)
            }
          })
        })
        void exited.catch(() => {})
        return child
      },
    })
    try {
      const result = await jobs.start({
        provider,
        name: 'native fixture',
        prompt: 'go',
        scope: { read: [], write: ['out.txt'] },
      })
      if (!result.ok) throw new Error(result.message)
      expect(await exited).toEqual({ alive: true, closed: false })
      expect(releaseProof).toEqual([])
      await expect(access(join(root, 'out.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      if (stdio === 'ignore') {
        await vi.waitFor(() => expect(outputClosed).toBe(true))
        expect(releaseProof).toEqual([])
      }
      await vi.waitFor(() => expect(jobs.sessions()[0]).toMatchObject({ outcome: 'completed' }), {
        timeout: 5_000,
      })
      expect(releaseProof).toEqual([{ groupAbsent: true, childAbsent: true, outputClosed: true }])
      expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('done')
    } finally {
      await tracked.drain()
      const descendantPid = await readPid().catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (descendantPid !== undefined) expect(absent(descendantPid)).toBe(true)
      await jobs.leave()
      await rm(dir, { recursive: true, force: true })
    }
  },
)
