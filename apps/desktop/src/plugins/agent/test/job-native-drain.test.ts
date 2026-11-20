import { execFileSync } from 'node:child_process'
import { activationOwnership } from '../main/host/ownership'
import { agentScratchRoots } from '../main/host/scratch-roots'
import { PRESETS } from '../main/harness/record'
import { activationHosts } from './fixtures/activation-hosts'

import { readFileSync, renameSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
    const vault = { remote: 'fixture/vault', root }
    const open = () =>
      createJobs({
        vault,
        scratchRoot,
        ownership: activationOwnership(ledger.root, vault, new AbortController().signal)!,
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
      // The crashed owner has no authority over files the next one recovered.
      // Join its test-only disposal to clear the idle timer, not as recovery.
      await Promise.allSettled([jobs.leave()])
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

vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  nativeTheme: { shouldUseDarkColors: false },
}))
vi.mock('../main/claude/cli', async (original) => ({
  ...(await original<typeof import('../main/claude/cli')>()),
  resolveClaudeBin: () => null,
}))

it.skipIf(process.platform === 'win32')(
  'reopens an actual host after Core refuses a NUL follow-up before retention',
  async () => {
    const ledger = await posixFixtureLedger('holi-job-host-refusal-')
    const data = ledger.root
    const old = activationHosts(data)
    const fresh = activationHosts(data)
    const { A } = old
    const root = old.roots[A]
    const home = join(data, 'codex-home')
    const program = join(data, 'fixture-codex')
    const script = join(data, 'fixture.cjs')
    const thread = '123e4567-e89b-42d3-a456-426614174000'
    const spec = { provider: 'codex', name: 'fixture', prompt: 'go', allow: [] }
    const original = processApi.spawnOwnedProgram
    const refusal = vi.fn()
    const identities = new Set<number>()
    const spy = vi.spyOn(processApi, 'spawnOwnedProgram').mockImplementation((...args) => {
      try {
        const child = original(...args)
        const pid = ledger.record(child)
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
        const identify = ledger.retain(
          pid,
          child[processApi.ownedProcessDrain]!.drain,
          closed,
          'job lease',
        )
        child.once('spawn', () => {
          identify()
          const record = args[2].ownershipRecordPath
          if (!record) return
          const journal = readFileSync(join(record, 'journal'), 'utf8')
          for (const [, role, value] of journal.matchAll(/^(ROOT|REAPER|ANCHOR) (\d+)$/gm)) {
            const pid = Number(value)
            identities.add(pid)
            if (role !== 'ANCHOR') identities.add(-pid)
          }
        })
        return child
      } catch (error) {
        refusal(error, processApi.posixLaunchNonAdmission(error))
        throw error
      }
    })
    vi.stubEnv('TMPDIR', data)
    try {
      await mkdir(root)
      await mkdir(home)
      await writeFile(join(home, 'auth.json'), '{"fixture":"not a credential"}')
      await writeFile(join(root, 'note.md'), 'vault history')
      execFileSync('git', ['init', '--template=', '-q', root])
      execFileSync('git', ['-C', root, 'add', 'note.md'])
      execFileSync('git', [
        '-C',
        root,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ])
      await writeFile(program, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
        mode: 0o700,
      })
      await writeFile(
        script,
        `
      const fs = require('node:fs');
      fs.writeFileSync(process.env.CODEX_HOME + '/history', 'thread contents');
      console.log(JSON.stringify({type:'thread.started', thread_id:'${thread}'}));
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5}}));
    `,
      )
      await old.enter(A)
      await old.call(A, 'agent.harnessSave', {
        harness: {
          ...PRESETS.find(({ id }) => id === 'codex')!,
          command: { bin: program, args: [] },
          env: { CODEX_HOME: home },
        },
      })
      const first = (await old.call(A, 'agent.job', spec)) as { ok: boolean; sessionId: string }
      expect(first).toMatchObject({ ok: true })
      const id = first.sessionId
      await vi.waitFor(
        async () =>
          expect((await old.rows(A)).find((row) => row.id === id)).toMatchObject({
            outcome: 'completed',
            usage: { total: 5 },
          }),
        { timeout: 4000 },
      )
      const { jobs } = await agentScratchRoots(data, { root, remote: A })
      const history = join(jobs, `${id}.agent`, 'codex-home', 'history')
      await vi.waitFor(() => old.call(A, 'agent.message', { session: id, text: 'bad\0follow-up' }))
      await vi.waitFor(async () =>
        expect((await old.rows(A)).find((row) => row.id === id)).toMatchObject({
          state: 'idle',
          outcome: 'failed',
          error: expect.stringMatching(/cannot contain NUL characters/),
        }),
      )
      expect(refusal).toHaveBeenCalledWith(expect.any(Error), { cleanup: expect.any(Promise) })
      expect(spy.mock.calls.at(-1)?.[1]).toContain(thread)
      expect(await readFile(history, 'utf8')).toBe('thread contents')
      const launched = spy.mock.calls[0]?.[2].ownershipRecordPath
      const refused = spy.mock.calls.at(-1)?.[2].ownershipRecordPath
      const nonLaunch =
        refused && (await readFile(join(dirname(dirname(refused)), 'nonlaunch'), 'utf8'))
      const settled = await readFile(join(jobs, `${id}.turn`), 'utf8').catch(() => undefined)
      await expect(access(join(jobs, `${id}.pid`))).rejects.toMatchObject({ code: 'ENOENT' })
      // Simulate re-entry after Main disappeared: no stop or retention cleanup
      // from the previous host, which has no pending admission or live child.
      await fresh.enter(A)
      expect(await fresh.call(A, 'agent.job', spec)).toMatchObject({ ok: true })
      expect(launched).toBeDefined()
      expect(refused).toBeDefined()
      expect(refused).not.toBe(launched)
      expect(nonLaunch).toMatch(/NONLAUNCH\n$/)
      expect(settled).toMatch(/SETTLED\n$/)
      await expect(access(history)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('vault history')
      await vi.waitFor(
        async () =>
          expect(await fresh.rows(A)).toEqual(
            expect.arrayContaining([expect.objectContaining({ outcome: 'completed' })]),
          ),
        { timeout: 4000 },
      )
      await fresh.host.stopAll()
    } finally {
      await Promise.allSettled([fresh.host.stopAll(), old.host.stopAll()])
      vi.unstubAllEnvs()
      spy.mockRestore()
      await ledger.reap()
      await vi.waitFor(() => {
        for (const pid of identities) expect(absent(pid)).toBe(true)
      })
      await ledger.remove()
    }
  },
  15000,
)
