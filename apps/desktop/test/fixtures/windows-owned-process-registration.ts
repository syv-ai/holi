import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { runBroker } from '../../src/main/owned-process-broker'
import { ownedLaunchControl, windowsAdapterLaunch } from '../../src/main/owned-process-launch'
import { spawnOwnedLaunchWithRegistrationFault } from '../owned-process-test-adapter'
import {
  fixtureChild,
  fixtureResult,
  pollFixture,
  stopFixtureChild,
  withFixtureCleanup,
  within,
} from './fixture-deadline'
import { rejectedStatusReceipt, statusWaitMs } from './windows-owned-process-status'
import { fixtureNonce, startRegistrationWitness } from './windows-owned-process-witness'

type Adapter = NonNullable<Parameters<typeof spawnOwnedLaunchWithRegistrationFault>[3]>
type BrokerObservation = Parameters<Adapter['brokerClosed']>[0]
type Point = Exclude<
  Parameters<typeof spawnOwnedLaunchWithRegistrationFault>[2],
  'before-first-dup'
>
type Action = Parameters<typeof runBroker>[1]
const brokerMs = 24_000
const lostReceiptMessage = 'owned Job broker ended without proof'

export async function registrationEvidence(point: Point, loseReceipt: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'holi-owned-registration-'))
  const result = await withFixtureCleanup(
    async () => {
      const powershell = windowsAdapterLaunch({}).file
      const witness = await startRegistrationWitness({
        powershellPath: powershell,
        deadlineMs: 10_000,
      })
      let witnessClosed = false
      const observation = await withFixtureCleanup(
        () => exerciseRegistration(witness, powershell, directory, point, loseReceipt),
        async () => {
          await witness.close()
          witnessClosed = true
        },
      )
      return { ...observation, cleanup: { ...observation.cleanup, witnessClosed } }
    },
    () => rm(directory, { recursive: true, force: true, maxRetries: 3 }),
  )
  const tempRemoved = await lstat(directory).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return true
      throw error
    },
  )
  assert(tempRemoved, 'registration fixture directory survived cleanup')
  return { ...result, cleanup: { ...result.cleanup, tempRemoved } }
}

async function exerciseRegistration(
  witness: Awaited<ReturnType<typeof startRegistrationWitness>>,
  powershell: string,
  directory: string,
  point: Point,
  loseReceipt: boolean,
) {
  const adoptedPath = point === 'drop-registered'
  assert(!loseReceipt || adoptedPath)
  const nonce = fixtureNonce()
  const image = resolve(process.execPath)
  const hello = fixtureResult<Parameters<Adapter['pauseAuth']>[0]>()
  const allowAuth = fixtureResult<void>()
  const allowJoin = fixtureResult<void>()
  const brokerEntered = fixtureResult<Action>()
  const allowBroker = fixtureResult<void>()
  const brokerClosed = fixtureResult<BrokerObservation>()
  const adopted = fixtureResult<Parameters<Adapter['adopted']>[0]>()
  let brokerOperations = 0
  let helperFallbacks = 0
  let unblockedReceipt = false
  const child = spawnOwnedLaunchWithRegistrationFault(
    {
      file: image,
      args: ['-e', 'setTimeout(() => process.exit(2), 45000)', nonce],
      verbatim: false,
    },
    { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] },
    point,
    {
      directory,
      loseReceipt,
      pauseAuth: (identity) => {
        hello.settle({ value: identity })
        return allowAuth.wait(statusWaitMs, 'registration AUTH release')
      },
      beforeJoin: () => allowJoin.wait(statusWaitMs, 'registration helper exit gate'),
      adopted: ({ jobHandle, commitGuardHandle }) =>
        adopted.settle({ value: { jobHandle, commitGuardHandle } }),
      beforeBroker: (action) => {
        brokerOperations++
        brokerEntered.settle({ value: action })
        return allowBroker.wait(statusWaitMs, 'registration broker release')
      },
      brokerClosed: (observation) => brokerClosed.settle({ value: observation }),
    },
  )
  const helper = fixtureChild(child)
  for (const output of [child.stdout, child.stderr]) output?.on('error', () => undefined).resume()
  const original = child.ownedCompletion
  const control = ownedLaunchControl(child)
  const lease = control?.lease
  let revoke: Promise<void> | undefined
  let completed = false
  async function releaseReceipt() {
    await writeFile(join(directory, 'broker-finish'), '', { flag: 'wx' })
    unblockedReceipt = true
  }

  return withFixtureCleanup(
    async () => {
      assert(control && lease)
      const { pid, birth, parentBirth, jobId, commitGuardId } = await hello.wait(
        18_000,
        'registration HELLO',
      )
      assert(pid === child.pid, 'registration helper identity disagrees')
      const heldHelper = await witness.pin({ pid, birth, expectedImage: powershell })
      await witness.pinInspectionParent(parentBirth)
      const helperPinnedBeforeAuth = !(await witness.exited(heldHelper.id))
      assert(helperPinnedBeforeAuth)
      allowAuth.settle({ value: undefined })

      const first = await rejectedStatusReceipt(child, original)
      const originalCause = first.error.cause
      assert(originalCause instanceof Error)
      const completionError = originalCause.message
      if (adoptedPath) assert.equal(completionError, 'fixture dropped REGISTERED')
      else assert.equal(completionError, 'owned control ended without terminal receipt')
      revoke = lease.revoke()
      const nodeExit = await helper.join(statusWaitMs, 'registration helper')
      const helperHandleExited = await witness.exited(heldHelper.id)
      assert(helperHandleExited && nodeExit === 125 && child.signalCode === null)
      const helperExitCode = await witness.exitCode(heldHelper.id)
      assert.equal(helperExitCode, nodeExit)
      allowJoin.settle({ value: undefined })

      const action = await brokerEntered.wait(statusWaitMs, 'registration broker gate')
      assert.equal(action, adoptedPath ? 'revoke' : 'recover')
      const known = adopted.current
      assert.equal(known !== undefined, adoptedPath)
      const before = await witness.surveyJobs(
        heldHelper.id,
        { jobId, commitGuardId },
        known && 'value' in known ? known.value : undefined,
      )
      const guardAbsent = point === 'after-first-dup'
      assert.deepEqual(before, {
        main: { matches: 1, active: 0, total: 0, openError: null },
        guard: guardAbsent
          ? { matches: 0, active: null, total: null, openError: 2 }
          : { matches: 1, active: 0, total: 0, openError: null },
        knownSlotsMatch: adoptedPath ? true : null,
      })
      allowBroker.settle({ value: undefined })

      let reused: Awaited<ReturnType<typeof witness.reuseSlot>> | null = null
      if (loseReceipt) {
        // The native audit is written only after both CLOSE_SOURCE calls succeeded.
        // Keep the original promise pending while a distinct event reuses its slot.
        await readNativeAudit(directory)
        assert(!brokerClosed.current, 'broker settled before fixture slot reuse')
        reused = await witness.reuseSlot()
        assert.deepEqual(reused, { reused: true, distinct: true, open: true })
        assert(!brokerClosed.current, 'broker settled before stale stop probe')
        assert(
          child.kill('SIGTERM') && lease.revoke() === revoke,
          'stop changed the pending revoke',
        )
        await releaseReceipt()
      }

      const settled = await settleRevoke(revoke)
      const broker = await brokerClosed.wait(statusWaitMs, 'registration broker close')
      assert(broker.code === 0 && broker.signal === null && broker.eof)
      const nativeAudit = await readNativeAudit(directory)
      assert.deepEqual(nativeAudit, {
        action,
        sweeps: adoptedPath ? 0 : 2,
        jobActive: adoptedPath ? 0 : null,
        guardActive: adoptedPath ? 0 : null,
      })
      const terminal = broker.receipt?.type ?? null
      assert.equal(terminal, adoptedPath ? (loseReceipt ? null : 'drained') : 'recovered')
      const recovered = broker.receipt?.type === 'recovered' ? publicRecovery(broker.receipt) : null
      if (recovered) {
        const closedZero = {
          state: 'closed-zero',
          before: 1,
          after: 0,
          activeBefore: 0,
          activeAfter: 0,
        }
        assert.deepEqual(recovered, {
          main: closedZero,
          guard: guardAbsent
            ? { state: 'absent', before: null, after: null, activeBefore: null, activeAfter: null }
            : closedZero,
        })
      }
      assert.equal(settled.outcome, loseReceipt ? 'rejected' : 'resolved')
      const revokeError =
        settled.outcome === 'rejected' && settled.error instanceof Error
          ? settled.error.message
          : null
      assert.equal(revokeError, loseReceipt ? lostReceiptMessage : null)
      const replacementOpenAfterClose = reused ? await witness.replacementOpen() : null
      if (reused) assert(replacementOpenAfterClose)

      const stopAccepted = child.kill('SIGTERM')
      const repeated = lease.revoke()
      const sameRevoke = repeated === revoke
      const repeatedRevoke = await settleRevoke(repeated)
      const sameRevokeOutcome =
        settled.outcome === repeatedRevoke.outcome &&
        (settled.outcome === 'resolved' ||
          (repeatedRevoke.outcome === 'rejected' && settled.error === repeatedRevoke.error))
      const again = await rejectedStatusReceipt(child, original)
      const sameFailure = again.error === first.error
      const sameCause = again.error.cause === originalCause
      const sameLease = first.sameLease && again.sameLease && again.error.lease === lease
      const sameReceipt = first.sameReceipt && again.sameReceipt
      assert(
        stopAccepted &&
          sameRevoke &&
          sameRevokeOutcome &&
          sameFailure &&
          sameCause &&
          sameLease &&
          sameReceipt &&
          brokerOperations === 1,
      )
      const replacementOpenAfterStop = reused ? await witness.replacementOpen() : null
      if (reused) assert(replacementOpenAfterStop)

      const after = await witness.resurveyJobs()
      assert.deepEqual(after, {
        main: { ...before.main, matches: 0 },
        guard: { ...before.guard, matches: 0 },
        knownSlotsMatch: null,
      })
      const rootMatches = await witness.rootCount(heldHelper.id, image, nonce)
      const diagnostics = control.diagnostics()
      const rootStarted = diagnostics.rootStarted || diagnostics.rootPid !== null
      assert(!rootStarted && rootMatches === 0, 'registration fault admitted a Root')
      completed = true
      return {
        proof: {
          kind: 'registration-fault',
          point,
          receipt: first.receipt,
          completionError,
          sameReceipt,
          sameFailure,
          sameCause,
          sameLease,
          sameRevoke,
          sameRevokeOutcome,
          stopAccepted,
          helperPinnedBeforeAuth,
          helperExitCode,
          rootStarted,
          rootMatches,
          before,
          after,
          broker: {
            ...nativeAudit,
            operations: brokerOperations,
            exitCode: broker.code,
            eof: broker.eof,
            terminal,
            recovered,
            revokeOutcome: settled.outcome,
            revokeError,
          },
          reuse: reused && {
            ...reused,
            openAfterClose: replacementOpenAfterClose,
            openAfterStop: replacementOpenAfterStop,
          },
        },
        cleanup: {
          helperClosed: child.exitCode === nodeExit,
          helperHandleExited,
          brokerClosed: !!brokerClosed.current,
          helperFallbacks,
        },
      }
    },
    async () => {
      // Unblock every gate even when a witness/operation assertion fails. No
      // positive case reaches the process fallback or consumes a Job in the witness.
      allowAuth.settle({ value: undefined })
      allowJoin.settle({ value: undefined })
      allowBroker.settle({ value: undefined })
      if (completed) return
      await withFixtureCleanup(
        () => (loseReceipt && !unblockedReceipt ? releaseReceipt() : Promise.resolve()),
        async () => {
          await withFixtureCleanup(
            async () => {
              if (child.exitCode === null && child.signalCode === null) {
                helperFallbacks++
                await stopFixtureChild(child, statusWaitMs, 'failed registration helper')
              } else await helper.join(statusWaitMs, 'failed registration helper')
            },
            async () => {
              if (!lease) return
              const result = await settleRevoke(revoke ?? lease.revoke())
              if (
                result.outcome === 'rejected' &&
                !(
                  loseReceipt &&
                  result.error instanceof Error &&
                  result.error.message === lostReceiptMessage
                )
              )
                throw result.error
            },
          )
        },
      )
    },
  )
}

function settleRevoke(revoke: Promise<void>) {
  return within(
    revoke.then(
      () => ({ outcome: 'resolved' as const }),
      (error: unknown) => ({ outcome: 'rejected' as const, error }),
    ),
    brokerMs,
    'original registration revoke',
  )
}

function readNativeAudit(dir: string) {
  return pollFixture(
    async () => {
      const text = await readFile(join(dir, 'broker-close.json'), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        },
      )
      if (text === undefined) return undefined
      const { action, sweeps, jobActive, guardActive } = JSON.parse(text) as Record<string, unknown>
      return { action, sweeps, jobActive, guardActive }
    },
    performance.now() + brokerMs,
    'native broker close audit',
    10,
  )
}

function publicRecovery(record: Extract<BrokerObservation['receipt'], { type: 'recovered' }>) {
  const job = (prefix: 'job' | 'guard') => ({
    state: record[`${prefix}State`],
    before: record[`${prefix}Before`],
    after: record[`${prefix}After`],
    activeBefore: record[`${prefix}ActiveBefore`],
    activeAfter: record[`${prefix}ActiveAfter`],
  })
  return { main: job('job'), guard: job('guard') }
}
