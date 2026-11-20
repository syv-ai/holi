import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { kernelGroupAbsent } from '../../../../test/fixtures/posix-fixture-ledger'
import { bounded, physical, withDrainActivation } from './fixtures/drain-activation'

const alive = (group: number) => expect(() => process.kill(-group, 0)).not.toThrow()
const missing = (path: string) => expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
const nested = (error: unknown): unknown[] =>
  error instanceof AggregateError ? error.errors.flatMap(nested) : [error]

function pending(work: Promise<unknown>) {
  let done = false
  void work.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  return () => expect(done).toBe(false)
}

const families = ['pi', 'pty', 'fenced', 'job'] as const
const cells = families.flatMap((kind) =>
  (['ignore', 'inherit'] as const).flatMap((stdio) =>
    [0, 7].map((code) => ({ kind, stdio, code })),
  ),
)

describe.runIf(process.platform !== 'win32')(
  'POSIX agent drains across real vault activations',
  () => {
    it.each(cells)(
      '$kind / $stdio / exit $code drains while A stops and reopens',
      async ({ kind, stdio, code }) => {
        await withDrainActivation(async (f) => {
          const a = await f.start(f.A, kind, 'ignore', 7)
          const b = await f.start(f.B, kind, stdio, code)
          expect(a.sessionId).toBe(b.sessionId)
          const approvalA = await f.approval(f.A)
          const approvalB = await f.approval(f.B)
          expect(approvalA).toMatchObject({
            status: 'approved',
            fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          })
          expect(approvalB?.fingerprint).toBe(approvalA?.fingerprint)
          expect(await f.cli(f.A, 'agent', 'launch', 'unsupported')).toMatchObject({ status: 400 })
          const bBefore = await f.cli(f.B, 'agent', 'sessions')
          expect(bBefore).toMatchObject({ status: 200 })
          expect(bBefore.text).toContain(b.name)
          expect(bBefore.text).not.toContain(a.name)

          a.drain.hold()
          a.close.hold()
          if (kind === 'fenced' || kind === 'job') a.release.hold()
          a.exit()
          expect(await bounded(a.exited.promise, 'A root exit')).toBe(7)
          await bounded(a.drain.entered, 'A drain entered')
          await bounded(a.nativeClosed.promise, 'ignored stdio closes with descendant still alive')
          a.close.open()
          await bounded(a.emittedClose.promise, 'A output edge before physical proof')
          a.aliveAfterExit()
          const notProvenA = pending(a.proven.promise)
          if (kind === 'job') expect(await readFile(a.pidFile, 'utf8')).toBe(`${a.pid}\n${a.cwd}\n`)
          if (a.ptyOutput) expect(a.ptyOutput.path()).toBe('output')
          const stopping = f.stop(f.A)
          const notStopped = pending(stopping)
          const quiet = f.quiet(f.A)
          const reopening = f.enter(f.A)
          const notReopened = pending(reopening)
          expect((await f.cli(f.A, 'agent', 'sessions')).status).not.toBe(200)
          // An installed hook acknowledges until deregistration, but has no activation authority.
          expect(
            (await f.hook(f.A, a.sessionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).status,
          ).toBe(204)
          expect((await f.cli(f.B, 'agent', 'sessions')).text).toContain(b.name)
          alive(b.pid)
          if (kind !== 'pi') {
            b.ping()
            await vi.waitFor(() => expect(b.output).toContain(`fixture-ping:${f.B}`))
          }
          if (kind === 'pty') {
            expect((await f.hook(f.B, b.sessionId)).status).toBe(204)
            expect((await f.rows(f.B)).find((row) => row.id === b.sessionId)?.conversationId).toBe(
              '12345678-1234-4234-8234-123456789abc',
            )
            expect(await readFile(join(f.roots[f.B], 'pty-turn.md'), 'utf8')).toBe(f.B)
            await vi.waitFor(async () =>
              expect(await f.call(f.B, 'agent.turns')).toEqual(
                expect.arrayContaining([expect.objectContaining({ sessionId: b.sessionId })]),
              ),
            )
          }
          expect(a.release.hit).toBe(false)
          await missing(join(f.roots[f.A], 'output.md'))
          notStopped()
          notReopened()
          quiet()
          notProvenA()

          a.drain.open()
          await physical(a.proven.promise, 'A physical proof')
          a.absent()
          expect(await readFile(`${a.receipt}.term`, 'utf8')).toBe('TERM')
          if (kind === 'fenced' || kind === 'job') {
            await bounded(a.release.entered, 'A provider still owns finalization')
            notStopped()
            notReopened()
            await access(a.cwd)
            if (kind === 'job') await access(a.pidFile)
          }
          await missing(join(f.roots[f.A], 'output.md'))
          await missing(join(f.roots[f.B], 'output.md'))
          if (b.terminalId) await f.call(f.B, 'agent.attach', { id: b.terminalId })
          b.drain.hold()
          b.close.hold()
          if (kind === 'pi') b.eof.hold()
          if (kind === 'job' || kind === 'fenced') b.release.hold()
          const notProvenB = pending(b.proven.promise)
          const notClosedB = pending(b.emittedClose.promise)
          const tail = `fixture-tail:${f.B}`
          if (b.terminalId && stdio === 'inherit') {
            // Stage the descendant's tail before raw exit, independent of how
            // quickly the real 200 ms output backstop gets a timer turn.
            await b.tail()
            await vi.waitFor(() => expect(b.output).toContain(tail))
          }
          b.exit()
          expect(await bounded(b.exited.promise, 'B root exit')).toBe(code)
          await bounded(b.drain.entered, 'B drain on root exit, not close')
          b.aliveAfterExit()
          if (stdio === 'ignore') {
            // Gating Pi's stdout event also holds Node's child close accounting.
            const output = kind === 'pi' ? b.eof.entered : b.nativeClosed.promise
            await bounded(output, 'ignored descendant leaves no pipe writers')
          } else expect(b.child!.stdout!.readableEnded).toBe(false)
          expect(b.release.hit).toBe(false)
          await missing(join(f.roots[f.B], 'output.md'))
          if (kind === 'fenced') {
            expect((await f.hook(f.B, b.sessionId)).status).toBe(204)
            await missing(join(f.roots[f.B], 'output.md'))
            expect(f.publications).not.toContainEqual(
              expect.objectContaining({ remote: f.B, name: 'turn-end' }),
            )
          }
          if (stdio === 'inherit' && !b.terminalId) await b.tail()
          await vi.waitFor(() => expect(b.output).toContain(tail))
          if (b.terminalId) {
            expect(f.events).toContainEqual({
              remote: f.B,
              name: 'pty-data',
              payload: { id: b.terminalId, data: expect.stringContaining(tail) },
            })
          }
          const noPiResult = async () => {
            expect(await f.call(f.B, 'agent.reply', { session: b.sessionId })).toEqual({
              output: null,
            })
            expect(await f.rows(f.B)).toContainEqual(
              expect.objectContaining({ id: b.sessionId, state: 'working' }),
            )
            expect(f.publications).not.toContainEqual(
              expect.objectContaining({ remote: f.B, name: 'turn-end' }),
            )
          }
          if (kind === 'pi') {
            if (code === 0) await vi.waitFor(() => expect(b.output).toContain('agent_settled'))
            await noPiResult()
          }
          notProvenB()
          notClosedB()
          expect(b.release.hit).toBe(false)
          if (kind === 'job' || kind === 'fenced') await access(b.home)
          if (kind === 'job') expect(await readFile(b.pidFile, 'utf8')).toBe(`${b.pid}\n${b.cwd}\n`)
          await missing(join(f.roots[f.B], 'output.md'))
          b.drain.open()
          await physical(b.proven.promise, 'B physical proof')
          b.absent()
          expect(await readFile(`${b.receipt}.term`, 'utf8')).toBe('TERM')
          if (kind === 'pi') {
            await bounded(b.eof.entered, 'B stdout reached EOF')
            await noPiResult()
            b.eof.open()
            await bounded(b.emittedEOF.promise, 'B stdout EOF delivered')
            if (code === 0)
              await vi.waitFor(async () =>
                expect(await f.call(f.B, 'agent.reply', { session: b.sessionId })).toEqual({
                  output: tail,
                }),
              )
            notClosedB()
          }
          await bounded(b.nativeClosed.promise, 'B real pipes closed')
          expect(f.events).not.toContainEqual(
            expect.objectContaining({ remote: f.B, name: 'pty-exit' }),
          )
          if (kind === 'job' || kind === 'fenced') {
            expect(b.release.hit).toBe(false)
            await access(b.home)
            await access(b.cwd)
            if (kind === 'job') await access(b.pidFile)
            await missing(join(f.roots[f.B], 'output.md'))
          }
          b.close.open()
          await bounded(b.emittedClose.promise, 'B output acknowledged')
          if (b.terminalId)
            await vi.waitFor(() =>
              expect(f.events).toContainEqual({
                remote: f.B,
                name: 'pty-exit',
                payload: { id: b.terminalId, code },
              }),
            )
          if (kind === 'pi') {
            await vi.waitFor(async () =>
              expect(await f.rows(f.B)).toContainEqual(
                expect.objectContaining({
                  id: b.sessionId,
                  outcome: code === 0 ? 'completed' : 'failed',
                  ...(code === 0 ? {} : { error: expect.stringContaining(`exited (${code})`) }),
                }),
              ),
            )
            if (code !== 0)
              expect(await f.call(f.B, 'agent.reply', { session: b.sessionId })).toEqual({
                output: null,
              })
          }
          if (kind === 'job' || kind === 'fenced') {
            await bounded(b.release.entered, 'B provider release')
            if (kind === 'job') {
              await missing(join(f.roots[f.B], 'output.md'))
              await access(b.pidFile)
            } else {
              // Fence copy-back precedes release, but only after physical proof.
              expect(await readFile(join(f.roots[f.B], 'output.md'), 'utf8')).toBe(f.B)
            }
            await access(b.cwd)
            b.release.open()
            await vi.waitFor(
              async () =>
                expect(await f.rows(f.B)).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      id: b.sessionId,
                      // A fenced PTY row reports copy-back; its process code
                      // is the separate pty-exit event asserted above.
                      outcome: kind === 'job' && code !== 0 ? 'failed' : 'completed',
                      ...(kind === 'job' && code !== 0
                        ? { error: expect.stringContaining(`exited with code ${code}`) }
                        : {}),
                    }),
                  ]),
                ),
              { timeout: 4000 },
            )
            if (kind === 'job' && code !== 0) await missing(join(f.roots[f.B], 'output.md'))
            else expect(await readFile(join(f.roots[f.B], 'output.md'), 'utf8')).toBe(f.B)
            await missing(b.cwd)
            if (kind === 'job') await missing(b.pidFile)
          }
          if (kind === 'job' || kind === 'fenced') {
            notStopped()
            notReopened()
            quiet()
            a.release.open()
          }
          await bounded(stopping, 'A stop')
          await bounded(reopening, 'A restart')
          await missing(join(f.roots[f.A], 'output.md'))
          if (kind === 'fenced' || kind === 'job') await missing(a.cwd)
          expect(await f.approval(f.A)).toEqual(approvalA)
          expect(await f.approval(f.B)).toEqual(approvalB)
          const fresh = await f.start(f.A, kind, 'ignore', 0, 'reply')
          expect(fresh.sessionId).toBe(a.sessionId)
          expect(fresh.pid).not.toBe(a.pid)
          if (kind === 'pi')
            await vi.waitFor(async () =>
              expect(await f.call(f.A, 'agent.reply', { session: fresh.sessionId })).toEqual({
                output: f.A,
              }),
            )
          fresh.exit()
          await physical(fresh.proven.promise, 'fresh A drain')
          fresh.absent()
          await bounded(fresh.emittedClose.promise, 'fresh A close')
          await bounded(f.stop(f.A), 'fresh A stop')
        })
      },
      60_000,
    )

    it.each(['pty', 'fenced'] as const)(
      '%s public backstop keeps the original owner until physical proof',
      async (kind) => {
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
          const rootDrain = new Promise<boolean>((resolve) => {
            // Installed after the adapter's raw-exit handler, in the same
            // event stack. Runtime cannot wait for the public edge to drain.
            run.child!.once('exit', () => resolve(run.drain.hit))
          })
          run.exit()
          expect(await bounded(rootDrain, 'draining synchronously on raw exit')).toBe(true)
          expect(await bounded(run.exited.promise, 'raw root status')).toBe(7)
          await bounded(run.emittedClose.promise, 'public exit from 200 ms backstop')
          expect(run.ptyOutput!.path()).toBe('backstop')
          expect(run.ptyOutput!.timerPending()).toBe(false)
          notNativeClosed() // stderr is still inherited even after stdout destruction.
          run.aliveAfterExit()
          notProven()
          const stop = () => f.call(f.A, 'agent.stop', { id: run.sessionId })
          const first = stop()
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
          expect(
            f.events.filter((event) => event.remote === f.A && event.name === 'pty-exit'),
          ).toEqual([{ remote: f.A, name: 'pty-exit', payload: { id: terminalId, code: 7 } }])
          expect(run.drainCalls).toBe(1)
          run.absent()
        })
      },
      30_000,
    )

    it.each(families)(
      '%s retains original failure without waiting for inherited stdio close',
      async (kind) => {
        await withDrainActivation(async (f) => {
          const a = await f.start(f.A, kind, 'inherit', 7)
          const b = await f.start(f.B, kind, 'ignore', 0, 'reply')
          expect(b.sessionId).toBe(a.sessionId)
          const cause = new Error(`${kind}: owned proof unavailable`)
          a.drain.hold()
          a.close.hold()
          a.exit()
          await bounded(a.drain.entered, 'natural exit starts drain')
          expect(await bounded(a.exited.promise, 'failed A root exit')).toBe(7)
          const noPhysicalReceipt = pending(a.proven.promise)
          a.drain.reject(cause)
          // Leave rejection unattended for a task (Vitest fails on unhandled rejections).
          await f.cli(f.B, 'agent', 'sessions')
          expect(a.close.hit).toBe(false)
          alive(a.pid)
          for (let attempt = 0; attempt < 2; attempt++) {
            await expect(
              bounded(f.call(f.A, 'agent.stop', { id: a.sessionId }), 'session stop'),
            ).rejects.toBe(cause)
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
          alive(b.pid)
          if (kind === 'pi') {
            expect(await f.cli(f.B, 'agent', 'message', b.sessionId, 'reply')).toEqual({
              status: 200,
              text: 'sent',
            })
            await vi.waitFor(async () =>
              expect(await f.call(f.B, 'agent.reply', { session: b.sessionId })).toEqual({
                output: f.B,
              }),
            )
          } else if (kind === 'pty') {
            b.ping()
            await vi.waitFor(() => expect(b.output).toContain(`fixture-ping:${f.B}`))
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
          a.close.open()
          await bounded(a.emittedClose.promise, 'late output after fixture emergency cleanup')
          noPhysicalReceipt()
          await expect(f.stop(f.A)).rejects.toBe(failure)
          await expect(f.enter(f.A)).rejects.toBe(failure)
          expect(a.release.hit).toBe(false)
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
        await access(a.cwd)
        await access(a.home)
        const stopping = f.stop(f.A)
        const notStopped = pending(stopping)
        const reopening = f.enter(f.A)
        const notReopened = pending(reopening)
        expect((await f.cli(f.A, 'agent', 'sessions')).status).not.toBe(200)
        expect((await f.cli(f.B, 'agent', 'sessions')).text).toContain(b.name)
        alive(b.pid)
        notStarted()
        notStopped()
        notReopened()
        expect(a.release.hit).toBe(false)
        a.drain.open()
        await physical(a.proven.promise, 'failed startup cleanup receipt')
        kernelGroupAbsent(a.pid)
        await expect(bounded(starting, 'failed start result')).resolves.toMatchObject({ ok: false })
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
        alive(b.pid)
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
  },
)
