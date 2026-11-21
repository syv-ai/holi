import { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import {
  kernelGroupAbsent,
  posixFixtureLedger,
} from '../../../../test/fixtures/posix-fixture-ledger'
import * as processApi from '../../../main/plugin-api'
import { PRESETS } from '../main/harness/record'
import * as turnLog from '../main/host/turn-log'
import * as worktree from '../main/host/worktree-end'
import { activationHosts } from './fixtures/activation-hosts'

vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  nativeTheme: { shouldUseDarkColors: false },
}))
vi.mock('../main/claude/cli', async (original) => ({
  ...(await original<typeof import('../main/claude/cli')>()),
  resolveClaudeBin: () => null,
}))

const spec = { provider: 'codex', name: 'fixture', prompt: 'go', allow: [] }
const thread = '123e4567-e89b-42d3-a456-426614174000'
const completed = [
  JSON.stringify({ type: 'thread.started', thread_id: thread }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5 } }),
  '',
].join('\n')

function complete(child: ChildProcess) {
  const stdout = child.stdout as PassThrough
  if (stdout.writableEnded) return
  stdout.end(completed)
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
}

async function attach(
  h: ReturnType<typeof activationHosts>,
  { bin, home, head }: { bin: string; home: string; head: string | null },
) {
  const { A } = h
  await h.host.reconcile(
    {
      remote: A,
      root: h.roots[A],
      pause: () => {},
      resume: () => {},
      drainSync: async () => {},
      commitNow: async () => head,
      repo: { head: async () => head },
    },
    'open',
  )
  await h.call(A, 'agent.harnessSave', {
    harness: {
      ...PRESETS.find(({ id }) => id === 'codex')!,
      command: { bin, args: [] },
      env: { CODEX_HOME: home },
    },
  })
}

it.skipIf(process.platform === 'win32')(
  'cancels a registering vault job on activation abort and reopens an actual host',
  async () => {
    const ledger = await posixFixtureLedger('holi-job-activation-cancel-')
    const old = activationHosts(ledger.root)
    const fresh = activationHosts(ledger.root)
    const { A } = old
    const root = old.roots[A]
    const home = join(ledger.root, 'codex-home')
    const bin = join(ledger.root, 'fixture-codex')
    const script = join(ledger.root, 'fixture.cjs')
    const marker = join(root, 'provider-body')
    const options = { home, bin, head: 'base' }
    const spawn = processApi.spawnOwnedProgram
    const identities = new Set<number>()
    const groups = new Set<number>()
    let stopping: Promise<void> | undefined
    let stopped = false
    let cancelled!: (journal: string) => void
    const cancelledJournal = new Promise<string>((resolve) => (cancelled = resolve))
    let releaseProof!: () => void
    const proofGate = new Promise<void>((resolve) => (releaseProof = resolve))
    const observed = vi.spyOn(processApi, 'spawnOwnedProgram').mockImplementation((...args) => {
      const child = spawn(...args)
      const lease = child[processApi.ownedProcessDrain]!
      const drain = lease.drain
      const first = stopping === undefined
      const journal = join(args[2].ownershipRecordPath!, 'journal')
      const pid = ledger.record(child)
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      const retained = async () => {
        await drain()
        const text = readFileSync(journal, 'utf8')
        for (const [, role, value] of text.matchAll(/^(ROOT|REAPER|ANCHOR) (\d+)$/gm)) {
          const owner = Number(value)
          identities.add(owner)
          if (role !== 'ANCHOR') groups.add(owner)
        }
        if (first) {
          cancelled(text)
          await proofGate
        }
      }
      // Cache the proof, including the identities, before Main can retire the journal.
      let proof: Promise<void> | undefined
      lease.drain = () => (proof ??= retained())
      ledger.retain(pid, lease.drain, closed, 'vault job control')
      if (first) {
        stopping = old.stop(A)
        void stopping.then(
          () => {
            stopped = true
          },
          () => {},
        )
      }
      return child
    })
    vi.stubEnv('TMPDIR', ledger.root)
    try {
      await mkdir(root)
      await mkdir(home)
      await writeFile(join(home, 'auth.json'), '{"fixture":"not a credential"}')

      await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
        mode: 0o700,
      })
      await writeFile(
        script,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'entered'); process.stdout.write(${JSON.stringify(completed)});`,
      )
      await attach(old, options)
      await old.call(A, 'agent.job', spec)
      expect(stopping).toBeDefined()
      expect(await cancelledJournal).not.toMatch(/^GO$/m)
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(stopped).toBe(false)
      releaseProof()
      await expect(stopping).resolves.toBeUndefined()
      expect(old.publications.map(({ name }) => name)).not.toContain('turn-end')
      await attach(fresh, options)
      expect(await fresh.call(A, 'agent.job', spec)).toMatchObject({ ok: true })
      await vi.waitFor(
        async () => {
          expect(await fresh.rows(A)).toEqual([expect.objectContaining({ outcome: 'completed' })])
        },
        { timeout: 4_000 },
      )
      await access(marker)
      await fresh.stop(A)
    } finally {
      releaseProof()
      await Promise.allSettled([old.host.stopAll(), fresh.host.stopAll()])
      vi.unstubAllEnvs()
      observed.mockRestore()
      await ledger.reap()
      await vi.waitFor(() => {
        for (const group of groups) kernelGroupAbsent(group)
        for (const pid of identities)
          expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      })
      await ledger.remove()
    }
  },
)

it.each([
  ['win32', 'missing'],
  ['win32', 'rejected'],
  ['posix', 'missing'],
  ['posix', 'rejected'],
] as const)('actual agent wiring: %s with %s job history', async (platform, history) => {
  if (platform === 'posix' && process.platform === 'win32') return
  const data = await mkdtemp(join(tmpdir(), 'holi-job-history-'))
  const h = activationHosts(data)
  const { A } = h
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const appendError = new Error('fixture history append rejected')
  const append = vi.fn(async () => {
    throw appendError
  })
  const log = vi.spyOn(turnLog, 'openTurnLog').mockReturnValue({ list: async () => [], append })
  const children: ChildProcess[] = []
  const spawn = vi.spyOn(processApi, 'spawnOwnedProgram').mockImplementation(() => {
    const child = Object.assign(new ChildProcess(), {
      stdout: new PassThrough(),
      ...(platform === 'posix' && { [processApi.ownedProcessDrain]: { drain: async () => {} } }),
    })
    children.push(child)
    return child
  })
  try {
    if (platform === 'win32')
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
    await mkdir(h.roots[A])
    const home = join(data, 'codex-home')
    await mkdir(home)
    await writeFile(join(home, 'auth.json'), '{"fixture":"not a credential"}')

    const bin = join(data, 'fixture.exe')
    await writeFile(bin, '', { mode: 0o700 })
    await attach(h, { home, bin, head: history === 'missing' ? null : 'base' })
    const start = (await h.call(A, 'agent.job', spec)) as { ok: boolean; sessionId: string }
    expect(start).toMatchObject({ ok: true })
    const { sessionId: id } = start
    complete(children[0]!)
    await vi.waitFor(async () => {
      expect(await h.rows(A)).toEqual([expect.objectContaining({ state: 'idle' })])
    })
    expect(append).toHaveBeenCalledTimes(history === 'missing' ? 0 : 1)
    const follow = () => h.call(A, 'agent.message', { session: id, text: 'follow up' })
    if (platform === 'win32') {
      expect(await h.rows(A)).toEqual([expect.objectContaining({ outcome: 'completed' })])
      expect(await follow()).toEqual({ ok: true })
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(spawn.mock.calls[1]?.[1]).toContain(thread)
      complete(children[1]!)
      await vi.waitFor(async () => {
        expect(await h.rows(A)).toEqual([expect.objectContaining({ outcome: 'completed' })])
      })
      expect(h.publications.filter(({ name }) => name === 'turn-end')).toHaveLength(2)
    } else {
      const error = history === 'missing' ? /No turn history was written/ : appendError.message
      expect(await h.rows(A)).toEqual([
        expect.objectContaining({ outcome: 'failed', error: expect.stringMatching(error) }),
      ])
      await expect(follow()).rejects.toThrow('That job has ended.')
      await expect(h.call(A, 'agent.stop', { id })).rejects.toThrow(error)
      expect(h.publications.filter(({ name }) => name === 'turn-end')).toHaveLength(0)
      expect(spawn).toHaveBeenCalledOnce()
    }
  } finally {
    for (const child of children) complete(child)
    await h.host.stopAll().catch(() => {})
    Object.defineProperty(process, 'platform', originalPlatform)
    log.mockRestore()
    spawn.mockRestore()
    await rm(data, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32').each(['rejected', 'unavailable'] as const)(
  'actual agent wiring: fails only the overlapping job whose snapshot is %s',
  async (mode) => {
    const data = await mkdtemp(join(tmpdir(), 'holi-overlapping-job-history-'))
    const h = activationHosts(data)
    const { A } = h
    const root = h.roots[A]
    const history = turnLog.openTurnLog(root)
    const original = new Error('fixture worktree snapshot rejected')
    const snapshot = vi.spyOn(worktree, 'worktreeEnd').mockResolvedValue('snapshot')
    if (mode === 'rejected') snapshot.mockRejectedValueOnce(original)
    else snapshot.mockResolvedValueOnce(null)
    const children: ChildProcess[] = []
    const spawn = vi.spyOn(processApi, 'spawnOwnedProgram').mockImplementation(() => {
      const child = Object.assign(new ChildProcess(), {
        stdout: new PassThrough(),
        [processApi.ownedProcessDrain]: { drain: async () => {} },
      })
      children.push(child)
      return child
    })
    try {
      const home = join(data, 'codex-home')
      const bin = join(data, 'fixture-codex')
      await mkdir(root)
      await mkdir(home)
      await writeFile(join(home, 'auth.json'), '{"fixture":"not a credential"}')
      await writeFile(bin, '', { mode: 0o700 })
      await attach(h, { home, bin, head: 'base' })
      const start = async () => {
        const job = (await h.call(A, 'agent.job', spec)) as { ok: boolean; sessionId: string }
        expect(job).toMatchObject({ ok: true })
        return job.sessionId
      }
      const failed = await start()
      const next = await start()
      const last = await start()
      const outcome = (id: string, expected: 'failed' | 'completed') =>
        vi.waitFor(async () => {
          expect((await h.rows(A)).find((row) => row.id === id)).toMatchObject({
            outcome: expected,
          })
        })

      complete(children[0]!)
      await outcome(failed, 'failed')
      expect(await history.list()).toEqual([])
      const stop = () => h.call(A, 'agent.stop', { id: failed })
      const cause = await stop().catch((error: unknown) => error)
      if (mode === 'rejected') expect(cause).toBe(original)
      else
        expect(cause).toMatchObject({ message: expect.stringMatching(/snapshot the working tree/) })

      complete(children[1]!)
      await outcome(next, 'completed')
      complete(children[2]!)
      await outcome(last, 'completed')
      expect(
        (await history.list()).map(({ sessionId, base, end, overlapped }) => [
          sessionId,
          base,
          end,
          overlapped,
        ]),
      ).toEqual([
        [last, 'base', 'base', true],
        [next, 'base', 'snapshot', true],
      ])
      expect(
        h.publications.filter(({ name }) => name === 'turn-end').map(({ payload }) => payload),
      ).toEqual([expect.objectContaining({ id: next }), expect.objectContaining({ id: last })])
      await expect(stop()).rejects.toBe(cause)
    } finally {
      for (const child of children) complete(child)
      await h.host.stopAll().catch(() => {})
      spawn.mockRestore()
      snapshot.mockRestore()
      await rm(data, { recursive: true, force: true })
    }
  },
)
