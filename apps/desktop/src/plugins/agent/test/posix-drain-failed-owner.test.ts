import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { it as test, expect, vi } from 'vitest'
import { inspectPosixOwnership } from '../../../main/posix-ownership-journal'
import {
  bounded,
  missing,
  pending,
  physical,
  withDrainActivation,
} from './fixtures/drain-activation'

const it = test.runIf(process.platform !== 'win32')
const families = ['pi', 'pty', 'fenced', 'job', 'direct PTY stop', 'fenced Pi'] as const
const nested = (error: unknown): unknown[] =>
  error instanceof AggregateError ? error.errors.flatMap(nested) : [error]

it.each(families)(
  '%s retains original failure without waiting for inherited stdio close',
  async (route) => {
    const kind = route === 'direct PTY stop' ? 'pty' : route === 'fenced Pi' ? 'fenced' : route
    await withDrainActivation(async (f) => {
      const a = await f.start(f.A, kind, 'inherit', 7, 'hold', route === 'fenced Pi')
      const b = await f.start(f.B, kind, 'ignore', 0, 'reply')
      expect(b.sessionId).toBe(a.sessionId)
      if (kind === 'pi') {
        expect(f.syncHeld(f.A)).toBe(true)
        expect(f.syncHeld(f.B)).toBe(false)
      }
      if (kind === 'pty' || route === 'fenced Pi') {
        expect(f.syncHeld(f.A)).toBe(true)
        expect(f.syncHeld(f.B)).toBe(true)
      }
      const cause = new Error(`${kind}: owned proof unavailable`)
      a.drain.hold()
      a.close.hold()
      const explicit =
        route === 'direct PTY stop' ? f.call(f.A, 'agent.stop', { id: a.sessionId }) : undefined
      if (explicit) {
        pending(explicit)
        await bounded(a.drain.entered, 'direct stop starts drain before root exit')
        a.live()
      }
      a.exit()
      await bounded(a.drain.entered, 'drain begun')
      expect(await bounded(a.exited.promise, 'failed A root exit')).toBe(7)
      const noPhysicalReceipt = pending(a.proven.promise)
      a.drain.reject(cause)
      // Leave rejection unattended for a task (Vitest fails on unhandled rejections).
      await f.cli(f.B, 'agent', 'sessions')
      expect(a.close.hit).toBe(false)
      a.aliveAfterExit()
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          bounded(f.call(f.A, 'agent.stop', { id: a.sessionId }), 'session stop'),
        ).rejects.toBe(cause)
      }
      if (explicit) await expect(explicit).rejects.toBe(cause)
      if (kind === 'pty' || route === 'fenced Pi') {
        expect(f.syncHeld(f.A)).toBe(true)
        expect(await f.call(f.A, 'agent.terminals')).toContainEqual(
          expect.objectContaining({ id: a.terminalId, launchedFor: a.sessionId }),
        )
      }
      const failure = await bounded(
        f.stop(f.A).catch((error: unknown) => error),
        'failed stop without close',
      )
      expect(nested(failure)).toContain(cause)
      expect(nested(failure).map(String).join('\n')).not.toMatch(/timed out|StopTimeout/i)
      f.expectedFailures.set(f.A, failure)
      expect(a.release.hit).toBe(false)
      if (kind === 'job') {
        await access(a.pidFile)
        await access(a.cwd)
        await missing(join(f.roots[f.A], 'output.md'))
      }
      if (kind === 'fenced') await access(a.cwd)
      await missing(join(f.roots[f.A], 'output.md'))
      await expect(f.stop(f.A)).rejects.toBe(failure)
      await expect(f.enter(f.A)).rejects.toBe(failure)
      expect((await f.hook(f.A, a.sessionId)).status).toBe(404)
      await f.work(f.B, b, 'a-failed', 41)
      if (kind === 'pi') {
        expect(f.syncHeld(f.A)).toBe(true)
        expect(f.syncHeld(f.B)).toBe(false)
        expect(f.publications).not.toContainEqual(
          expect.objectContaining({ remote: f.A, name: 'turn-end' }),
        )
      }
      if (kind === 'pty') {
        const thread = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        expect((await f.hook(f.B, b.sessionId, thread)).status).toBe(204)
        expect((await f.rows(f.B)).find((row) => row.id === b.sessionId)?.conversationId).toBe(
          thread,
        )
      }
      b.exit()
      expect(await bounded(b.exited.promise, 'B root exit')).toBe(0)
      await physical(b.proven.promise, 'B drains while A failed')
      b.absent()
      if (kind === 'pty') {
        await vi.waitFor(() => expect(f.syncHeld(f.B)).toBe(false))
        expect(f.syncHeld(f.A)).toBe(true)
      }
      if (kind === 'job' || kind === 'fenced') {
        await vi.waitFor(async () =>
          expect(await f.rows(f.B)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: b.sessionId,
                outcome: 'completed',
                ...(kind === 'job' ? { usage: { total: 12 } } : {}),
              }),
            ]),
          ),
        )
        expect(await readFile(join(f.roots[f.B], 'output.md'), 'utf8')).toBe(f.B)
      }
      const shutdownFailure = await f.host.stopAll().catch((error: unknown) => error)
      expect(shutdownFailure).toBeInstanceOf(AggregateError)
      expect((shutdownFailure as AggregateError).errors).toEqual([failure])
      // Fixture-only authority can clean the living group, never repair the consumer receipt.
      await physical(a.nativeDrain!(), 'retained authority after physical rejection')
      a.absent()
      expect(inspectPosixOwnership(a.ownershipPath)).toEqual({
        state: 'confirmed',
        proof: 'settled',
      })
      a.close.open()
      await bounded(a.emittedClose.promise, 'late output after fixture emergency cleanup')
      noPhysicalReceipt()
      expect(await readFile(join(dirname(dirname(a.ownershipPath)), 'failed'), 'utf8')).toContain(
        String(cause),
      )
      await expect(f.stop(f.A)).rejects.toBe(failure)
      await expect(f.enter(f.A)).rejects.toBe(failure)
      expect(a.release.hit).toBe(false)
      if (kind === 'pi' || kind === 'pty' || route === 'fenced Pi')
        expect(f.syncHeld(f.A)).toBe(true)
    })
  },
  15_000,
)
it('joins failed startup after native creation before scratch cleanup or replacement', async () => {
  await withDrainActivation(async (f) => {
    const b = await f.start(f.B, 'fenced', 'ignore')
    const cause = new Error('native adapter failed after creating the PTY')
    const { starting, run } = f.failPtyStart(f.A, cause)
    const notStarted = pending(starting)
    await vi.waitFor(() => expect(run().launchError).toBe(cause))
    const a = run()
    await bounded(a.drain.entered, 'cancel admitted native startup')
    expect(a.pid).toBeGreaterThan(1)
    await vi.waitFor(async () => expect(await a.captureJournal()).toContain(`ROOT ${a.pid}\n`))
    await access(a.cwd)
    await access(a.home)
    const stopping = f.stop(f.A)
    const notStopped = pending(stopping)
    const reopening = f.enter(f.A)
    const notReopened = pending(reopening)
    expect((await f.cli(f.A, 'agent', 'sessions')).status).not.toBe(200)
    expect((await f.cli(f.B, 'agent', 'sessions')).text).toContain(b.name)
    b.live()
    notStarted()
    notStopped()
    notReopened()
    expect(a.release.hit).toBe(false)
    a.drain.open()
    await physical(a.proven.promise, 'failed startup cleanup receipt')
    await expect(bounded(starting, 'failed start result')).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining(cause.message),
    })
    await bounded(stopping, 'failed start teardown')
    await bounded(reopening, 'reopen after startup cleanup')
    await missing(a.cwd)
    await missing(a.home)
    const fresh = await f.start(f.A, 'fenced', 'ignore')
    expect(fresh.sessionId).toBe(b.sessionId)
    fresh.exit()
    await physical(fresh.proven.promise, 'fresh fenced drain')
    fresh.absent()
    await vi.waitFor(async () =>
      expect(await readFile(join(f.roots[f.A], 'output.md'), 'utf8')).toBe(f.A),
    )
    await missing(join(f.roots[f.B], 'output.md'))
  })
})
it('joins admitted job recovery when agent activation fails during hook setup', async () => {
  await withDrainActivation(async (f) => {
    await f.stop(f.A)
    const b = await f.start(f.B, 'job', 'ignore')
    const cause = new Error('native bridge route setup failed')
    const cleanupError = new Error('admitted recovery could not read scratch')
    const { jobs, sweep, entering } = await f.failActivation(f.A, cause)
    const notEntered = pending(entering)
    await bounded(sweep.entered, 'admitted A recovery sweep')
    // A cannot report failure yet: the work already admitted by its
    // activation is still pending and B owns a separate live job.
    notEntered()
    expect((await f.cli(f.B, 'agent', 'sessions')).text).toContain(b.name)
    b.live()
    sweep.reject(cleanupError)
    const sticky = await bounded(
      entering.catch((error: unknown) => error),
      'failed activation cleanup',
    )
    expect(nested(sticky)).toEqual(expect.arrayContaining([cause, cleanupError]))
    f.expectedFailures.set(f.A, sticky)
    expect((await f.cli(f.A, 'agent', 'sessions')).status).not.toBe(200)
    expect((await f.hook(f.A, b.sessionId)).status).toBe(404)
    await expect(f.enter(f.A)).rejects.toBe(sticky)
    await expect(f.stop(f.A)).rejects.toBe(sticky)
    await missing(jobs)
    b.exit()
    await physical(b.proven.promise, 'B completes independently of failed activation')
    b.absent()
    await vi.waitFor(async () =>
      expect(await readFile(join(f.roots[f.B], 'output.md'), 'utf8')).toBe(f.B),
    )
  })
})

it.each(['success', 'failure'] as const)(
  'keeps agent.stop routing until the final fenced ownership retirement: %s',
  async (mode) => {
    await withDrainActivation(async (f) => {
      const run = await f.start(f.A, 'fenced', 'ignore')
      const record = dirname(dirname(run.ownershipPath))
      const cause = new Error('durable fenced retirement failed')
      const completed = () =>
        f.publications.filter(
          ({ remote, name, payload }) =>
            remote === f.A &&
            name === 'sessions' &&
            Array.isArray(payload) &&
            payload.some((row) => row.id === run.sessionId && row.outcome === 'completed'),
        )
      const retiring = vi.fn(() => {
        expect(completed()).toEqual([])
        if (mode === 'failure') throw cause
      })
      f.observeRetirement(record, retiring)
      run.release.hold()
      const copy = f.holdCopyWrite(f.A)
      run.exit()
      await physical(run.proven.promise, 'fenced exit proof')
      run.absent()
      await bounded(copy.entered, 'physical proof while vault copy is still staged')
      expect(f.syncHeld(f.A)).toBe(true)
      expect(completed()).toEqual([])
      await missing(join(f.roots[f.A], 'output.md'))
      copy.open()
      await bounded(run.release.entered, 'provider release after successful copy')
      expect(await readFile(join(f.roots[f.A], 'output.md'), 'utf8')).toBe(f.A)
      expect(f.syncHeld(f.A)).toBe(true)
      const stopping = f.call(f.A, 'agent.stop', { id: run.sessionId })
      const notStopped = pending(stopping)
      expect(await f.rows(f.A)).toContainEqual(
        expect.objectContaining({ id: run.sessionId, copying: true }),
      )
      notStopped()
      run.release.open()
      if (mode === 'failure') {
        await expect(stopping).rejects.toBe(cause)
        await expect(f.call(f.A, 'agent.stop', { id: run.sessionId })).rejects.toBe(cause)
        expect(completed()).toEqual([])
        expect(await f.rows(f.A)).not.toContainEqual(
          expect.objectContaining({ outcome: 'completed' }),
        )
        const failure = await f.stop(f.A).catch((error: unknown) => error)
        f.expectedFailures.set(f.A, failure)
        expect(nested(failure)).toContain(cause)
        await expect(f.stop(f.A)).rejects.toBe(failure)
      } else {
        await expect(stopping).resolves.toEqual({ ok: true })
        expect(completed()).toHaveLength(1)
        await missing(record)
        expect(f.syncHeld(f.A)).toBe(false)
        expect(await f.call(f.A, 'agent.terminals')).not.toContainEqual(
          expect.objectContaining({ launchedFor: run.sessionId }),
        )
      }
      expect(retiring).toHaveBeenCalledOnce()
    })
  },
)
