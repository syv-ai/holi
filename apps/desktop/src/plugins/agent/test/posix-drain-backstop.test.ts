import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { it as test, expect, vi } from 'vitest'
import {
  bounded,
  missing,
  pending,
  physical,
  withDrainActivation,
} from './fixtures/drain-activation'

const it = test.runIf(process.platform !== 'win32')

const cases = (['pty', 'fenced'] as const).flatMap((kind) =>
  (['natural', 'explicit'] as const).map((edge) => ({ kind, edge })),
)

it.each(cases)(
  '$kind $edge stop fences admission before its public backstop',
  async ({ kind, edge }) => {
    await withDrainActivation(async (f) => {
      const run = await f.start(f.A, kind, 'inherit', 7)
      const terminalId = run.terminalId!
      await f.call(f.A, 'agent.attach', { id: terminalId })
      const tail = `fixture-tail:${f.A}`
      await run.tail()
      await vi.waitFor(() =>
        expect(f.events).toContainEqual({
          remote: f.A,
          name: 'pty-data',
          payload: { id: terminalId, data: expect.stringContaining(tail) },
        }),
      )
      run.drain.hold()
      if (kind === 'fenced') run.release.hold()
      const notProven = pending(run.proven.promise)
      const notNativeClosed = pending(run.nativeClosed.promise)
      const stop = () => f.call(f.A, 'agent.stop', { id: run.sessionId })
      const refusesInput = async () => {
        expect(
          await f.call(f.A, 'agent.send', { target: run.sessionId, text: 'late input' }),
        ).toMatchObject({ ok: false })
        if (kind === 'fenced') {
          expect((await f.hook(f.A, run.sessionId)).status).toBe(204)
          expect(f.publications).not.toContainEqual(
            expect.objectContaining({ remote: f.A, name: 'turn-end' }),
          )
        }
      }
      const explicit = edge === 'explicit' ? stop() : undefined
      const notExplicit = explicit && pending(explicit)
      if (explicit) {
        await bounded(run.drain.entered, 'explicit stop starts drain before native exit')
        run.live()
        expect(run.ptyOutput!.pty._boundClose).toBe(false)
        notExplicit!()
        await refusesInput()
      }
      const rootDrain = new Promise((resolve) => {
        // Installed after the adapter's raw-exit handler, in the same
        // event stack. Runtime cannot wait for the public edge to drain.
        run.child!.once('exit', () =>
          resolve({
            draining: run.drain.hit,
            bound: run.ptyOutput!.pty._boundClose,
            closed: run.ptyOutput!.pty._emittedClose,
            backstop: run.ptyOutput!.timerPending(),
          }),
        )
      })
      run.exit()
      expect(await bounded(rootDrain, 'draining synchronously on raw exit')).toEqual({
        draining: true,
        bound: true,
        closed: false,
        backstop: true,
      })
      expect(await bounded(run.exited.promise, 'raw root status')).toBe(7)
      await refusesInput()
      await bounded(run.emittedClose.promise, 'public exit from 200 ms backstop')
      expect(run.ptyOutput!.path()).toBe('backstop')
      expect(run.publicExit).toEqual({ groupAlive: true, proofDelivered: false })
      expect(run.ptyOutput!.timerPending()).toBe(false)
      notNativeClosed() // stderr is still inherited even after stdout destruction.
      run.aliveAfterExit()
      notProven()
      const first = explicit ?? stop()
      const second = stop()
      const notFirst = pending(first)
      const notSecond = pending(second)
      expect(await f.call(f.A, 'agent.terminals')).toContainEqual(
        expect.objectContaining({ id: terminalId, launchedFor: run.sessionId }),
      )
      expect(await f.rows(f.A)).toContainEqual(expect.objectContaining({ id: run.sessionId }))
      expect(f.events).not.toContainEqual(
        expect.objectContaining({ remote: f.A, name: 'pty-exit' }),
      )
      await missing(join(f.roots[f.A], 'output.md'))
      if (kind === 'fenced') await access(run.home)
      expect(run.release.hit).toBe(false)
      notFirst()
      notSecond()
      expect(run.drainCalls).toBe(1)
      run.drain.open()
      await physical(run.proven.promise, 'backstop run physical proof')
      run.absent()
      if (kind === 'fenced') {
        await bounded(run.release.entered, 'fence callback still owns release')
        notFirst()
        notSecond()
        await access(run.home)
        run.release.open()
      }
      for (const close of [first, second])
        await expect(bounded(close, 'joined PTY close')).resolves.toEqual({ ok: true })
      expect(f.events.filter((event) => event.remote === f.A && event.name === 'pty-exit')).toEqual(
        [{ remote: f.A, name: 'pty-exit', payload: { id: terminalId, code: 7 } }],
      )
      expect(run.drainCalls).toBe(1)
      run.absent()
    })
  },
  30_000,
)
