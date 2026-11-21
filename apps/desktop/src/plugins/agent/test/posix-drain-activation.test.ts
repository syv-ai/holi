import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { it, expect, vi } from 'vitest'
import {
  bounded,
  missing,
  pending,
  physical,
  withDrainActivation,
} from './fixtures/drain-activation'

const cells = (['pi', 'pty', 'fenced', 'job'] as const).flatMap((kind) =>
  (['ignore', 'inherit'] as const).flatMap((stdio) =>
    [0, 7].map((code) => ({ kind, stdio, code })),
  ),
)

const posix = it.runIf(process.platform !== 'win32')

posix.each(cells)(
  '$kind / $stdio / exit $code keeps original B working through A restart',
  async ({ kind, stdio, code }) => {
    await withDrainActivation(async (f) => {
      const a = await f.start(f.A, kind, 'ignore', 7)
      const b = await f.start(f.B, kind, stdio, code, 'reply')
      const notExitedB = pending(b.exited.promise)
      if (kind === 'pi') {
        expect(f.syncHeld(f.A)).toBe(true)
        expect(f.syncHeld(f.B)).toBe(false)
        expect(await f.call(f.B, 'agent.turns')).toEqual(
          expect.arrayContaining([expect.objectContaining({ sessionId: b.sessionId })]),
        )
      }
      expect(a.ownershipPath).not.toBe(b.ownershipPath)
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
      if (a.terminalId) {
        a.input('close-output')
        await vi.waitFor(() => expect(a.ptyOutput!.pty._emittedClose).toBe(true))
        a.live()
        expect(a.drain.hit).toBe(false)
      } else a.close.hold()
      if (kind === 'fenced' || kind === 'job') a.release.hold()
      const immediateDrain =
        a.terminalId &&
        new Promise<boolean>((resolve) => {
          a.child!.once('exit', () => resolve(a.drain.hit))
        })
      a.exit()
      if (immediateDrain)
        expect(await bounded(immediateDrain, 'synchronous drain via public exit')).toBe(true)
      expect(await bounded(a.exited.promise, 'A root exit')).toBe(7)
      await bounded(a.drain.entered, 'A drain entered')
      await bounded(a.nativeClosed.promise, 'ignored stdio closes with descendant still alive')
      a.close.open()
      await bounded(a.emittedClose.promise, 'A output edge before physical proof')
      a.aliveAfterExit()
      const notProvenA = pending(a.proven.promise)
      if (kind === 'job') expect(await readFile(a.pidFile, 'utf8')).toBe(`${a.pid}\n${a.cwd}\n`)
      if (a.ptyOutput) {
        expect(a.ptyOutput.path()).toBe('already-closed')
        expect(a.publicExit).toEqual({ groupAlive: true, proofDelivered: false })
        expect(a.ptyOutput.pty._boundClose).toBe(false)
        expect(a.ptyOutput.timerPending()).toBe(false)
        expect(
          await f.call(f.A, 'agent.send', { target: a.sessionId, text: 'late input' }),
        ).toMatchObject({ ok: false })
      }
      const stopping = f.stop(f.A)
      const notStopped = pending(stopping)
      const quiet = f.quiet(f.A)
      const reopening = f.enter(f.A)
      const notReopened = pending(reopening)
      expect((await f.cli(f.A, 'agent', 'sessions')).status).not.toBe(200)
      // An installed hook acknowledges until deregistration, but has no activation authority.
      expect((await f.hook(f.A, a.sessionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).status).toBe(
        204,
      )
      expect((await f.cli(f.B, 'agent', 'sessions')).text).toContain(b.name)
      await f.work(f.B, b, 'a-draining', 21)
      notExitedB()
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
        await f.work(f.B, b, 'a-finalizing', 22)
        notStopped()
        notReopened()
        notExitedB()
        quiet()
        a.release.open()
      }
      await bounded(stopping, 'A stop')
      await bounded(reopening, 'A restart')
      await missing(join(f.roots[f.A], 'output.md'))
      if (kind === 'fenced' || kind === 'job') await missing(a.cwd)
      await missing(dirname(dirname(a.ownershipPath)))
      expect(await f.approval(f.A)).toEqual(approvalA)
      expect(await f.approval(f.B)).toEqual(approvalB)
      b.live()
      notExitedB()
      const fresh = await f.start(f.A, kind, 'ignore', 0, 'reply')
      expect(fresh.sessionId).toBe(a.sessionId)
      expect(fresh.pid).not.toBe(a.pid)
      expect(fresh.ownershipPath).not.toBe(a.ownershipPath)
      const freshMarker = await f.work(f.A, fresh, 'fresh-a', 31)
      const lastLiveB = await f.work(f.B, b, 'a-reopened', 23)
      expect(fresh.output).not.toContain(lastLiveB)
      expect(b.output).not.toContain(freshMarker)
      for (const [remote, own, other] of [
        [f.A, fresh, b],
        [f.B, b, fresh],
      ] as const) {
        const listing = await f.cli(remote, 'agent', 'sessions')
        expect(listing.status).toBe(200)
        expect(listing.text).toContain(own.name)
        expect(listing.text).not.toContain(other.name)
      }
      if (kind === 'pi') {
        expect(await f.call(f.A, 'agent.reply', { session: fresh.sessionId })).toEqual({
          output: freshMarker,
        })
        expect(await f.cli(f.B, 'agent', 'message', b.sessionId, 'hold')).toEqual({
          status: 200,
          text: 'sent',
        })
        await vi.waitFor(() => access(`${b.receipt}.payload`))
      }
      // Only the original B may finish, and only after A has stopped,
      // reopened, and completed work on its fresh native process.
      b.live()
      notExitedB()
      await missing(join(f.roots[f.B], 'output.md'))
      if (b.terminalId) await f.call(f.B, 'agent.attach', { id: b.terminalId })
      b.drain.hold()
      const earlyPtyOutput = b.terminalId !== undefined && stdio === 'ignore'
      if (!earlyPtyOutput) b.close.hold()
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
      if (earlyPtyOutput) {
        b.input('close-output')
        await vi.waitFor(() => expect(b.ptyOutput!.pty._emittedClose).toBe(true))
        b.live()
      }
      const bBeforeFinalTurn = f.publications.filter(
        ({ remote, name }) => remote === f.B && name === 'turn-end',
      )
      b.exit()
      expect(await bounded(b.exited.promise, 'B root exit')).toBe(code)
      await bounded(b.drain.entered, 'B drain on native exit')
      if (earlyPtyOutput) {
        await bounded(b.emittedClose.promise, 'B already-closed output edge')
        expect(b.ptyOutput!.path()).toBe('already-closed')
        expect(b.publicExit).toEqual({ groupAlive: true, proofDelivered: false })
        expect(b.ptyOutput!.pty._boundClose).toBe(false)
      }
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
        expect(f.syncHeld(f.B)).toBe(true)
        expect(await f.call(f.B, 'agent.reply', { session: b.sessionId })).toEqual({
          output: lastLiveB,
        })
        expect(await f.rows(f.B)).toContainEqual(
          expect.objectContaining({ id: b.sessionId, state: 'working' }),
        )
        expect(
          f.publications.filter(({ remote, name }) => remote === f.B && name === 'turn-end'),
        ).toEqual(bBeforeFinalTurn)
      }
      if (kind === 'pi') {
        if (code === 0) expect(b.output).toContain('agent_settled')
        await noPiResult()
      }
      notProvenB()
      if (!earlyPtyOutput) notClosedB()
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
        expect(await f.call(f.B, 'agent.reply', { session: b.sessionId })).toEqual({
          output: lastLiveB,
        })
        await access(b.ownershipPath)
        expect(f.syncHeld(f.B)).toBe(true)
        notClosedB()
      }
      await bounded(b.nativeClosed.promise, 'B real pipes closed')
      if (!earlyPtyOutput)
        expect(f.events).not.toContainEqual(
          expect.objectContaining({ remote: f.B, name: 'pty-exit' }),
        )
      if (kind === 'job' || (kind === 'fenced' && !earlyPtyOutput)) {
        expect(b.release.hit).toBe(false)
        await access(b.home)
        await access(b.cwd)
        if (kind === 'job') await access(b.pidFile)
        await missing(join(f.roots[f.B], 'output.md'))
      }
      b.close.open()
      await bounded(b.emittedClose.promise, 'B output acknowledged')
      if (b.terminalId && !earlyPtyOutput)
        expect(b.publicExit).toEqual({ groupAlive: false, proofDelivered: true })
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
        await vi.waitFor(async () => {
          expect(await f.call(f.B, 'agent.reply', { session: b.sessionId })).toEqual({
            output: code === 0 ? tail : lastLiveB,
          })
          await missing(dirname(dirname(b.ownershipPath)))
        })
        expect(f.syncHeld(f.B)).toBe(false)
      }
      if (kind === 'job' || kind === 'fenced') {
        await bounded(b.release.entered, 'B provider release')
        if (kind === 'job') {
          await missing(join(f.roots[f.B], 'output.md'))
          await access(b.pidFile)
        } else {
          // Fence copy-back precedes release, but only after physical proof.
          expect(f.syncHeld(f.B)).toBe(true)
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
                  ...(kind === 'job' ? { usage: { total: 12 } } : {}),
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
        if (kind === 'job') {
          await missing(b.pidFile)
          expect(await readFile(join(dirname(b.pidFile), `${b.sessionId}.turn`), 'utf8')).toBe(
            `HOLI-JOB-1 ${b.sessionId}\nSETTLED\n`,
          )
        }
      }
      await missing(join(f.roots[f.A], 'output.md'))
      fresh.exit()
      await physical(fresh.proven.promise, 'fresh A drain')
      fresh.absent()
      await bounded(fresh.emittedClose.promise, 'fresh A close')
      await bounded(f.stop(f.A), 'fresh A stop')
      await bounded(f.stop(f.B), 'original B stop')
      await missing(dirname(dirname(fresh.ownershipPath)))
      await missing(dirname(dirname(b.ownershipPath)))
    })
  },
  60_000,
)
