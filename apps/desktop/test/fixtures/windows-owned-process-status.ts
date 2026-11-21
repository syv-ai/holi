import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import { execProgram } from '../../src/main/launch'
import { runBroker } from '../../src/main/owned-process-broker'
import type { PrivateManagedOwnedChild } from '../../src/main/owned-process-completion'
import * as ownedLaunch from '../../src/main/owned-process-launch'
import {
  ownedHelperIdentity,
  ownedLaunchControl,
  windowsAdapterLaunch,
} from '../../src/main/owned-process-launch'
import { UnconfirmedOwnedProgramError } from '../../src/main/owned-program-lifetime'
import { spawnOwnedLaunchWithRegistrationStopAudit } from '../owned-process-test-adapter'
import {
  fixtureChild,
  fixtureResult,
  pollFixture,
  stopFixtureChild,
  withFixtureCleanup,
  within,
} from './fixture-deadline'
import {
  fixtureNonce,
  startRegistrationWitness,
  startWitness,
  type WindowsOwnedProcessWitness,
  type WitnessProcess,
} from './windows-owned-process-witness'

export const statusWaitMs = 8_000
export const statusCaseMs = 110_000 // Setup, operation and independent failure cleanup.
const setupMs = 20_000
const brokerMs = 22_000
const backstopMs = 45_000 // The tree and inline roots' failure-only watchdogs.
const treeScript = fileURLToPath(new URL('./windows-owned-process-tree.cjs', import.meta.url))
const nodeImage = resolve(process.execPath)
type Role = 'helper' | 'root' | 'grandchild'
type Options = { tree?: true; retained?: true; pauseStderr?: true }

export async function withStatusProducer<T>(
  options: Options,
  body: (fixture: StatusProducer) => Promise<T>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'holi-owned-status-'))
  const result = await withFixtureCleanup(
    async () => {
      const powershell = windowsAdapterLaunch({}).file
      const witness = await startWitness({ powershellPath: powershell, deadlineMs: 10_000 })
      return withFixtureCleanup(
        async () => {
          const fixture = new StatusProducer(dir, powershell, witness, options)
          let verified: Awaited<ReturnType<StatusProducer['verify']>> | undefined
          const proof = await withFixtureCleanup(
            async () => {
              const proof = await body(fixture)
              verified = await fixture.verify()
              return proof
            },
            async () => {
              if (!verified) await fixture.drainFailedLaunch()
            },
          )
          assert(verified)
          return { proof, cleanup: verified }
        },
        () => witness.close(),
      )
    },
    () => rm(dir, { recursive: true, force: true, maxRetries: 3 }),
  )
  return {
    proof: result.proof,
    cleanup: { ...result.cleanup, witnessClosed: true as const, tempRemoved: true as const },
  }
}

export type StatusCleanup = Awaited<ReturnType<typeof withStatusProducer>>['cleanup']

class StatusProducer {
  readonly nonce = fixtureNonce()
  readonly nodeImage = nodeImage
  private readonly pins = new Map<Role, WitnessProcess>()
  private child?: PrivateManagedOwnedChild
  private original?: PrivateManagedOwnedChild['ownedCompletion']
  private control?: ReturnType<typeof ownedLaunchControl>
  private launchedAt = 0

  constructor(
    readonly dir: string,
    readonly powershell: string,
    private readonly witness: WindowsOwnedProcessWitness,
    private readonly options: Options,
  ) {}

  get treeArgs() {
    return [treeScript, 'root', this.dir, this.nonce, 'ignore']
  }

  start<T extends PrivateManagedOwnedChild>(spawn: () => T) {
    assert(!this.child, 'status fixture only owns one production launch')
    this.launchedAt = performance.now()
    const child = (this.child = spawn())
    fixtureChild(child)
    assert(child.stdout && child.stderr, 'missing fixture output streams')
    // The retained output-failure path may destroy either relay with an error.
    child.stdout.on('error', () => undefined).resume()
    child.stderr.on('error', () => undefined)
    if (!this.options.pauseStderr) child.stderr.resume()
    const original = (this.original = child.ownedCompletion)
    const control = (this.control = ownedLaunchControl(child))
    assert(original && control && child.pid, 'missing production owned launch')
    return { child, control, original }
  }

  async holdRoot(image = nodeImage) {
    const { child } = this
    assert(child)
    const until = performance.now() + setupMs
    const helper = await within(ownedHelperIdentity(child), setupMs, 'authenticated helper HELLO')
    assert.equal(helper.pid, child.pid)
    await this.pin('helper', {
      pid: helper.pid,
      birth: helper.birth,
      expectedImage: this.powershell,
    })
    const root = await this.ready('root', until)
    // Essential diagnostics identify the production Root even with tracing off.
    await pollFixture(
      () => (this.control?.diagnostics().rootPid === root.pid ? true : undefined),
      until,
      'authenticated Root PID',
      20,
    )
    await this.pin('root', {
      pid: root.pid,
      expectedImage: image,
      nonce: this.nonce,
      parentPid: helper.pid,
    })
    if (this.options.tree) {
      await this.mark('start-grandchild')
      const grandchild = await this.ready('grandchild', until)
      await this.pin('grandchild', {
        pid: grandchild.pid,
        expectedImage: nodeImage,
        nonce: this.nonce,
        parentPid: root.pid,
      })
    }
    this.beforeBackstop()
  }

  private async pin(role: Role, request: Parameters<WindowsOwnedProcessWitness['pin']>[0]) {
    const pin = await this.witness.pin(request)
    this.pins.set(role, pin)
    // Different roles must be different stable identities.
    assert.equal(new Set([...this.pins.values()].map(({ pid }) => pid)).size, this.pins.size)
    if (request.parentPid !== undefined) {
      const parent = [...this.pins.values()].find(({ pid }) => pid === request.parentPid)
      assert(parent && BigInt(pin.birth) >= BigInt(parent.birth), 'child predates held creator')
    }
  }

  private ready(role: 'root' | 'grandchild', until: number) {
    return pollFixture(
      async () => {
        const text = await readFile(join(this.dir, `${role}.json`), 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          },
        )
        if (text === undefined) return undefined
        const { pid, nonce } = JSON.parse(text) as Record<string, unknown>
        assert(
          nonce === this.nonce && typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0,
          `bad ${role} readiness`,
        )
        return { pid }
      },
      until,
      `${role} readiness`,
      20,
    )
  }

  mark(file: 'start-grandchild' | 'release-0' | 'release-status') {
    return writeFile(join(this.dir, file), '', { flag: 'wx' })
  }

  private id(role: Role) {
    const pin = this.pins.get(role)
    assert(pin, `missing pinned ${role}`)
    return pin.id
  }

  exited(role: Role) {
    return this.witness.exited(this.id(role))
  }

  async waitForExit(role: Role) {
    const exited = await pollFixture(
      async () => (await this.exited(role)) || undefined,
      performance.now() + statusWaitMs,
      `held ${role} exit`,
      20,
    )
    this.beforeBackstop()
    return exited
  }

  private beforeBackstop() {
    assert(
      performance.now() - this.launchedAt < backstopMs,
      'fixture reached its failure-only watchdog',
    )
  }

  async exitCode(role: Role) {
    await this.waitForExit(role)
    return this.witness.exitCode(this.id(role))
  }

  async helperStatus() {
    assert(this.child)
    const nodeExitCode = await fixtureChild(this.child).join(statusWaitMs, 'owned helper')
    const helperExitCode = await this.exitCode('helper')
    assert(
      nodeExitCode !== null &&
        Number.isInteger(nodeExitCode) &&
        nodeExitCode >= -0x80000000 &&
        nodeExitCode <= 0xffffffff,
    )
    assert.equal(this.child.signalCode, null)
    assert.equal(nodeExitCode >>> 0, helperExitCode, 'Node close disagrees with held helper DWORD')
    return { helperExitCode, nodeExitCode }
  }

  async verify() {
    assert(this.child)
    await fixtureChild(this.child).join(statusWaitMs, 'owned helper final close')
    const helperHandleExited = await this.waitForExit('helper')
    const rootHandleExited = await this.waitForExit('root')
    const grandchildHandleExited = this.options.tree ? await this.waitForExit('grandchild') : null
    const broker = await this.settleRetained()
    return {
      helperClosed: true as const,
      helperHandleExited,
      rootHandleExited,
      grandchildHandleExited,
      broker,
    }
  }

  private async settleRetained() {
    const { child, control, original } = this
    if (!this.options.retained || !child) return null
    assert(control && original, 'missing original retained launch')
    const revoke = () => within(control.lease.revoke(), brokerMs, 'revoke original retained Job')
    const receipt = await within(
      original.catch(() => null),
      statusWaitMs,
      'retained settlement',
    ).catch((error: unknown) => withFixtureCleanup(() => Promise.reject(error), revoke))
    if (receipt === 'empty') {
      await within(control.lease.revoke(), brokerMs, 'release verified empty Job')
      return 'released' as const
    }
    await revoke()
    return 'drained' as const
  }

  async drainFailedLaunch() {
    const { child } = this
    if (!child) return
    // Failure-only backstop, including a fixture not yet verified by the witness.
    // The witness drains any pinned survivors when its sole cleanup owner closes.
    await withFixtureCleanup(
      async () => {
        const live = () =>
          child.pid !== undefined && child.exitCode === null && child.signalCode === null
        if (live()) child.kill('SIGKILL')
        child.stderr?.resume()
        const observed = fixtureChild(child)
        try {
          await observed.join(statusWaitMs, 'failed owned launch')
        } catch {
          if (live()) ChildProcess.prototype.kill.call(child, 'SIGKILL')
          await observed.join(statusWaitMs, 'failed owned launch after stable-handle stop')
        }
      },
      async () => {
        await withFixtureCleanup(
          () => this.settleRetained(),
          () => writeFile(join(this.dir, 'abort'), ''),
        )
      },
    )
  }
}

type RegistrationAudit = Parameters<typeof spawnOwnedLaunchWithRegistrationStopAudit>[3]
type Broker = NonNullable<RegistrationAudit['broker']>
type BrokerClose = Parameters<NonNullable<Parameters<typeof runBroker>[4]>['closed']>[0]
type ExecCallback = Parameters<typeof execProgram>[3]

export async function registrationStopEvidence(mode: 'ordinary' | 'retained') {
  const dir = await mkdtemp(join(tmpdir(), 'holi-owned-registration-stop-'))
  const result = await withFixtureCleanup(
    async () => {
      const powershell = windowsAdapterLaunch({}).file
      const witness = await startRegistrationWitness({
        powershellPath: powershell,
        deadlineMs: 10_000,
      })
      return withFixtureCleanup(
        () => exerciseRegistrationStop(mode, dir, powershell, witness),
        () => witness.close(),
      )
    },
    () => rm(dir, { recursive: true, force: true, maxRetries: 3 }),
  )
  await assert.rejects(lstat(dir), { code: 'ENOENT' })
  return {
    proof: result.proof,
    cleanup: { ...result.cleanup, witnessClosed: true, tempRemoved: true },
  }
}

async function exerciseRegistrationStop(
  mode: 'ordinary' | 'retained',
  dir: string,
  powershell: string,
  witness: Awaited<ReturnType<typeof startRegistrationWitness>>,
) {
  const retained = mode === 'retained'
  const hello = fixtureResult<Parameters<NonNullable<RegistrationAudit['pauseAuth']>>>()
  const allowAuth = fixtureResult<void>()
  const allowBroker = fixtureResult<void>()
  const brokerEntered = fixtureResult<Parameters<Broker>[1]>()
  const brokerClosed = fixtureResult<BrokerClose>()
  const callback = fixtureResult<{ args: Parameters<ExecCallback>; brokerClosed: boolean }>()
  const errors = fixtureResult<Error>()
  const abort = new AbortController()
  const reason = new Error('native registration cancelled')
  let slots: Parameters<NonNullable<RegistrationAudit['adopted']>>[0] | undefined
  let brokerOperations = 0
  const audit: RegistrationAudit = {
    pauseAuth: (...identity) => {
      hello.settle({ value: identity })
      return allowAuth.wait(statusWaitMs, 'stopped registration AUTH gate')
    },
    adopted: ({ jobHandle, commitGuardHandle }) => {
      slots = { jobHandle, commitGuardHandle }
    },
    broker: async (ticket, action, grant, committed) => {
      brokerOperations++
      brokerEntered.settle({ value: action })
      await allowBroker.wait(brokerMs, 'stopped registration broker gate')
      return runBroker(ticket, action, grant, committed, {
        directory: dir,
        transformSource: (source) => source,
        closed: (value) => brokerClosed.settle({ value }),
      })
    },
  }
  const args = ['-e', 'require("node:fs").writeFileSync("root-ran", "ran", { flag: "wx" })']
  const child = retained
    ? startRetainedExec()
    : spawnOwnedLaunchWithRegistrationStopAudit(
        { file: nodeImage, args, verbatim: false },
        { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
        false,
        audit,
      )
  function startRetainedExec() {
    // Only inject the private launch adapter. The actual exec output, status and
    // resource join all run unchanged, including their callback ordering.
    const spawn = vi
      .spyOn(ownedLaunch, 'spawnOwnedLaunch')
      .mockImplementationOnce((plan, options, pid, retain) => {
        assert(pid === process.pid && retain)
        return spawnOwnedLaunchWithRegistrationStopAudit(
          plan,
          { ...options, signal: abort.signal },
          true,
          audit,
        )
      })
    try {
      return execProgram(
        nodeImage,
        args,
        {
          cwd: dir,
          env: process.env,
          timeoutMs: 60_000,
          maxBuffer: 4096,
          encoding: 'utf8',
          retainDescendantsOnSuccess: true,
        },
        (...args) => callback.settle({ value: { args, brokerClosed: !!brokerClosed.current } }),
      ) as PrivateManagedOwnedChild
    } finally {
      spawn.mockRestore()
    }
  }
  const helper = fixtureChild(child)
  for (const stream of [child.stdout, child.stderr]) stream?.on('error', () => undefined).resume()
  child.on('error', (error) => errors.settle({ value: error }))
  const control = ownedLaunchControl(child)
  const original = child.ownedCompletion
  let verified = false
  return withFixtureCleanup(
    async () => {
      assert(control && original)
      const [identity, jobs] = await hello.wait(setupMs, 'stopped registration HELLO')
      assert.equal(child.pid, identity.pid)
      const held = await witness.pin({
        pid: identity.pid,
        birth: identity.birth,
        expectedImage: powershell,
      })
      if (retained) await witness.pinInspectionParent(identity.parentBirth)
      assert(!(await witness.exited(held.id)), 'helper must be held alive before AUTH')
      assert(!slots && control.diagnostics().helperLastPhase === 'helper-spawned')
      if (retained) abort.abort(reason)
      else assert(child.kill('SIGINT'))
      assert(control.stopped && !slots, 'STOP must be recorded before AUTH and SETUP')
      const abortError = retained
        ? ((await errors.wait(statusWaitMs, 'pre-AUTH AbortError')) as NodeJS.ErrnoException)
        : null
      if (abortError) {
        assert.equal(abortError.name, 'AbortError')
        assert.equal(abortError.code, 'ABORT_ERR')
        assert.equal(abortError.cause, reason)
      }
      allowAuth.settle({ value: undefined })

      const receipt = await within(original, statusWaitMs, 'original stopped registration receipt')
      assert(receipt === 'empty' && child.ownedCompletion === original)
      const { helperStarted, helperLastPhase, rootStarted, rootPid, rootState } =
        control.diagnostics()
      const registrationStop = retained ? 'SIGTERM' : 'SIGINT'
      assert(helperStarted && helperLastPhase === 'registration-stopped')
      assert.equal(rootState, `create-calls=0.active=0.stop=${registrationStop}`)
      assert(!rootStarted && rootPid === null)
      const nodeExit = await helper.join(statusWaitMs, 'stopped registration helper')
      assert(nodeExit === 1 && child.signalCode === null && (await witness.exited(held.id)))
      const helperExitCode = await witness.exitCode(held.id)
      assert.equal(helperExitCode, 1)
      await within(control.joinControlClose(), statusWaitMs, 'stopped registration control close')
      await assert.rejects(lstat(join(dir, 'root-ran')), { code: 'ENOENT' })

      let retainedProof = null
      if (retained) {
        const cleanup = control.resourceCleanup
        assert(cleanup && jobs && slots)
        assert.equal(
          await brokerEntered.wait(statusWaitMs, 'original stopped registration broker'),
          'revoke',
        )
        assert(!callback.current && !brokerClosed.current, 'exec escaped its retained cleanup join')
        assert.equal(control.lease.revoke(), cleanup)
        const before = await witness.surveyJobs(held.id, jobs, slots)
        const one = { matches: 1, active: 0, total: 0, openError: null }
        assert.deepEqual(before, { main: one, guard: one, knownSlotsMatch: true })
        allowBroker.settle({ value: undefined })
        await within(cleanup, brokerMs, 'stopped registration resource cleanup')
        const closed = await brokerClosed.wait(statusWaitMs, 'stopped registration broker close')
        assert.deepEqual(closed, { code: 0, signal: null, eof: true, receipt: { type: 'drained' } })
        assert.equal(brokerOperations, 1)
        const after = await witness.resurveyJobs()
        const zero = { ...one, matches: 0 }
        assert.deepEqual(after, { main: zero, guard: zero, knownSlotsMatch: null })
        const done = await callback.wait(
          statusWaitMs,
          'retained stopped registration exec callback',
        )
        const [error, out, err, metadata] = done.args
        assert(done.brokerClosed && abortError && error === abortError)
        assert.deepEqual([out, err, metadata], ['', '', { kind: 'settled' }])
        retainedProof = {
          errorName: abortError.name,
          errorCode: abortError.code,
          reasonPreserved: abortError.cause === reason,
          sameError: error === abortError,
          metadata,
          before,
          after,
          sameResourceCleanup: control.resourceCleanup === cleanup,
          callbackAfterBrokerClose: done.brokerClosed,
          brokerOperations,
          brokerExitCode: closed.code,
          brokerEof: closed.eof,
          brokerTerminal: closed.receipt?.type,
        }
        assert(retainedProof.sameResourceCleanup)
      } else {
        assert(!errors.current && !control.resourceCleanup && brokerOperations === 0)
      }
      verified = true
      return {
        proof: {
          kind: 'registration-stop',
          mode,
          helperPinnedBeforeAuth: true,
          stopRecordedBeforeAuth: true,
          registrationStop,
          createProcessCalls: 0,
          queryActive: 0,
          rootStarted,
          rootPid,
          sentinelAbsent: true,
          receipt,
          sameReceipt: child.ownedCompletion === original,
          helperExitCode,
          retained: retainedProof,
        },
        cleanup: {
          helperClosed: true,
          helperHandleExited: true,
          controlClosed: true,
          brokerClosed: retained ? !!brokerClosed.current : null,
        },
      }
    },
    async () => {
      if (verified) return
      await withFixtureCleanup(
        async () => {
          try {
            if (!control?.stopped && child.exitCode === null && child.signalCode === null)
              child.kill('SIGKILL')
          } finally {
            allowAuth.settle({ value: undefined })
            allowBroker.settle({ value: undefined })
          }
          try {
            await helper.join(statusWaitMs, 'failed stopped registration helper')
          } catch {
            await stopFixtureChild(
              child,
              statusWaitMs,
              'failed stopped registration helper fallback',
            )
          }
        },
        async () => {
          if (!control) return
          await withFixtureCleanup(
            async () => {
              if (retained)
                await within(
                  control.lease.revoke(),
                  brokerMs,
                  'failed stopped registration cleanup',
                )
            },
            () =>
              within(
                control.joinControlClose(),
                statusWaitMs,
                'failed stopped registration control close',
              ),
          )
        },
      )
    },
  )
}

/** A deadline is not an ownership rejection, and a new lease is not this launch's. */
export async function rejectedStatusReceipt(
  child: PrivateManagedOwnedChild,
  original: NonNullable<PrivateManagedOwnedChild['ownedCompletion']>,
) {
  const result = await within(
    original.then(
      (value) => ({ receipt: value }),
      (error: unknown) => ({ receipt: 'rejected' as const, error }),
    ),
    statusWaitMs,
    'original owned completion',
  )
  assert(result.receipt === 'rejected', 'original owned completion did not reject')
  const { error } = result
  assert(error instanceof UnconfirmedOwnedProgramError)
  const sameReceipt = child.ownedCompletion === original
  const sameLease = error.lease !== undefined && error.lease === ownedLaunchControl(child)?.lease
  assert(sameReceipt && sameLease)
  return { receipt: result.receipt, error, sameReceipt, sameLease }
}
