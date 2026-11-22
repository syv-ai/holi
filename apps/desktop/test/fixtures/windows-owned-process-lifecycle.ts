import assert from 'node:assert/strict'
import { ChildProcess, spawn, type ExecFileException } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { release, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { execProgram } from '../../src/main/launch'
import type {
  PrivateManagedOwnedChild,
  PrivateCompletion,
} from '../../src/main/owned-process-completion'
import { spawnOwnedProgram } from '../../src/main/owned-process'
import {
  ownedHelperIdentity,
  ownedLaunchControl,
  windowsAdapterLaunch,
} from '../../src/main/owned-process-launch'
import {
  UnconfirmedOwnedProgramError,
  type OwnedProgramCleanupLease,
  type RetainedExecMetadata,
} from '../../src/main/owned-program-lifetime'
import { nativeCommitBarrier, type CommitBarrier } from '../owned-process-test-adapter'
import {
  fixtureChild,
  fixtureResult,
  pollFixture,
  withFixtureCleanup,
  within,
} from './fixture-deadline'
import {
  fixtureNonce,
  startWitness,
  type PinRequest,
  type WindowsOwnedProcessWitness,
  type WitnessProcess,
} from './windows-owned-process-witness'

export type TreeStdio = 'ignore' | 'inherit'
type Role = 'parent' | 'helper' | 'root' | 'grandchild' | 'broker'
type Receipt = PrivateCompletion | 'rejected' | 'unobservable-parent-death'
type Identity = WitnessProcess & { pinnedAlive?: true; observedExit?: boolean }
type Cleanup = 'already-exited' | 'terminated-held-handle'
type HelperIdentity = Awaited<ReturnType<typeof ownedHelperIdentity>>
type RetainedCallback = {
  error: ExecFileException | null
  stdout: string
  stderr: string
  ownership: RetainedExecMetadata | undefined
}
type ParentMode = 'ordinary' | 'precommit' | 'postcommit' | 'duringcommit'
type NativeObservations = {
  commitVerified?: true
  postcommitAlive?: true
  parentLossCleanup?: true
  handoffExitCode?: 0
  uncommittedLeaseObserved?: true
  preParentDeathAlive?: true
  postParentDeathAlive?: true
  commitRollback?: {
    barrier: CommitBarrier
    guardArmedAtBarrier: false
    activeAtBarrier: 1
    guardRearmed: true
    activeAfterRollback: 0
    brokerExitCode: 125
    grandchildExitCode: 1
  }
}
const treeRoles = ['helper', 'root', 'grandchild'] as const
const setupMs = 15_000 // Includes the real helper's Add-Type and authentication.
const operationMs = 5_000 // Independent wait budget after readiness.
const revokeMs = setupMs + 2 * operationMs // Helper exit plus Job broker setup and drain.
export const lifecycleBudgetMs = 75_000 // Observer, setup, operation, Job broker and finally.
const proofDirectory = process.env.HOLI_WINDOWS_OWNED_PROCESS_PROOFS

function waitFor<T>(probe: () => Promise<T | undefined>, until: number, label: string) {
  return pollFixture(probe, until, label, 25)
}

export async function withNativeLifecycle<T>(body: (fixture: Lifecycle) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'holi-owned-native-'))
  const fixture = new Lifecycle(dir)
  let verified: Awaited<ReturnType<Lifecycle['clean']>> | undefined
  const result = await withFixtureCleanup(
    async () => {
      await fixture.prepare()
      return body(fixture)
    },
    async () => {
      verified = await fixture.clean()
    },
  )
  assert(verified, 'native fixture cleanup did not finish')
  return { result, verified }
}

export async function witnessLifecycle(
  id: string,
  caseName: string,
  body: (fixture: Lifecycle) => Promise<Receipt>,
) {
  const { result: receiptKind, verified } = await withNativeLifecycle(body)
  const { processes, actualNativeObservations, cleanup } = verified
  const parentLoss = receiptKind === 'unobservable-parent-death'
  const precommit = id === 'retained-precommit-parent-death'
  const postcommit = id === 'retained-postcommit-parent-death'
  const duringCommit = id.startsWith('retained-commit-parent-death-')
  assert.equal(Boolean(actualNativeObservations.commitRollback), duringCommit)
  assert.equal(
    actualNativeObservations.parentLossCleanup,
    parentLoss || precommit || duringCommit ? true : undefined,
  )
  assert.equal(
    actualNativeObservations.handoffExitCode,
    precommit || postcommit || duringCommit ? 0 : undefined,
  )
  assert.equal(
    actualNativeObservations.uncommittedLeaseObserved,
    precommit || duringCommit ? true : undefined,
  )
  assert.equal(
    actualNativeObservations.preParentDeathAlive,
    precommit || postcommit || duringCommit ? true : undefined,
  )
  assert.equal(actualNativeObservations.postParentDeathAlive, postcommit ? true : undefined)
  assert.equal(
    processes.length,
    treeRoles.length +
      Number(parentLoss || precommit || postcommit || duringCommit) +
      Number(duringCommit),
    'incomplete native observations',
  )
  assert.equal(
    new Set(processes.map(({ pid }) => pid)).size,
    processes.length,
    'non-distinct process identities',
  )
  assert(cleanup.witnessClosed, 'native witness did not close')
  const committed = receiptKind === 'handoff' && !precommit && !duringCommit
  assert.equal(actualNativeObservations.commitVerified, committed ? true : undefined)
  assert.equal(actualNativeObservations.postcommitAlive, committed ? true : undefined)
  for (const entry of processes) {
    const retained = committed && entry.role === 'grandchild'
    assert.equal(entry.observedExit, !retained, `${entry.role} exit observation`)
    assert.equal(
      entry.cleanup,
      retained ? 'terminated-held-handle' : 'already-exited',
      `${entry.role} cleanup`,
    )
  }
  if (proofDirectory) {
    // A successful sidecar can only be written after all native checks and teardown.
    await writeFile(
      join(proofDirectory, `${id}.json`),
      JSON.stringify({ caseName, platformVersion: release(), receiptKind, ...verified }),
      { flag: 'wx' },
    )
  }
}

class Lifecycle {
  private readonly nonce = fixtureNonce()
  private readonly identities = new Map<Role, Identity>()
  private readonly direct: ChildProcess[] = []
  private readonly execPath = resolve(process.execPath)
  private readonly helperImage = windowsAdapterLaunch({}).file
  private readonly actualNativeObservations: NativeObservations = {}
  private retainedLease?: OwnedProgramCleanupLease
  private witness?: WindowsOwnedProcessWitness
  private started = false
  private parentLaunchedAt?: number

  constructor(private readonly dir: string) {}

  async prepare() {
    await copyFile(new URL('./windows-owned-process-tree.cjs', import.meta.url), this.tree)
    this.witness = await startWitness({ powershellPath: this.helperImage })
  }

  private get observer() {
    assert(this.witness, 'native witness was not started')
    return this.witness
  }

  private get tree() {
    return join(this.dir, 'tree.cjs')
  }

  private args(stdio: TreeStdio) {
    return [this.tree, 'root', this.dir, this.nonce, stdio]
  }

  private own<T extends ChildProcess>(child: T) {
    fixtureChild(child)
    this.direct.push(child)
    return child
  }

  async retained(stdio: TreeStdio) {
    // Only the synthetic root's stdout changes. The real helper/controller still
    // collect output and authenticate ownership; this line is not native proof.
    const providerReceipt = `backgrounded · ${this.nonce.slice(0, 8)} · Native fixture\n`
    const source = await readFile(this.tree, 'utf8')
    const originalWrite = `writeSync(1, 'fixture stdout\\n')`
    assert(source.includes(originalWrite), 'fixture root output write changed')
    await writeFile(
      this.tree,
      source.replace(
        originalWrite,
        `writeSync(1, code === 0 ? ${JSON.stringify(`${providerReceipt}fixture stdout\n`)} : 'fixture stdout\\n')`,
      ),
    )
    const callback = fixtureResult<RetainedCallback>()
    this.started = true
    const child = this.own(
      execProgram(
        this.execPath,
        this.args(stdio),
        {
          cwd: this.dir,
          env: process.env,
          encoding: 'utf8',
          maxBuffer: 4096,
          timeoutMs: setupMs + operationMs,
          retainDescendantsOnSuccess: true,
        },
        (error, stdout, stderr, ownership) => {
          this.retainedLease ??= ownership?.lease
          callback.settle({ value: { error, stdout, stderr, ownership } })
        },
      ) as PrivateManagedOwnedChild,
    )
    // Retain cleanup authority even if readiness fails before the callback.
    this.retainedLease ??= ownedLaunchControl(child)?.lease
    await this.pinManagedTree(child)
    const result = () => callback.wait(operationMs, 'execProgram callback')
    return {
      child,
      callback: result,
      commitHandoff: async () => {
        const receipt = await this.receipt(child)
        assert.equal(receipt, 'handoff', 'no authenticated HANDOFF')
        assert.equal(await fixtureChild(child).join(operationMs, 'HANDOFF helper'), 0)
        const { error, stdout, stderr, ownership } = await result()
        assert.equal(error, null)
        assert.equal(
          stdout,
          `${providerReceipt}fixture stdout\n`,
          'invalid synthetic provider receipt or stdout',
        )
        assert.equal(stderr, 'fixture stderr\n')
        assert(ownership?.kind === 'settled' && ownership.lease, 'missing settled handoff lease')
        assert.equal(ownership.lease, this.retainedLease, 'callback changed the original lease')
        await this.assertExited('root')
        await this.assertExited('helper')

        // Commit already has a bounded native broker join. Await its outcome
        // before deciding whether teardown may revoke the original Job lease.
        await ownership.lease.commit()
        this.actualNativeObservations.commitVerified = true
        const grandchild = this.identity('grandchild')
        grandchild.observedExit = await this.exited('grandchild')
        assert.equal(grandchild.observedExit, false, 'retained descendant did not survive commit')
        this.actualNativeObservations.postcommitAlive = true
        return receipt
      },
    }
  }

  async owned(stdio: TreeStdio) {
    this.started = true
    const child = this.own(
      spawnOwnedProgram(this.execPath, this.args(stdio), {
        cwd: this.dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )
    child.stdout?.resume()
    child.stderr?.resume()
    await this.pinManagedTree(child)
    return child
  }

  async disposableParent(mode: ParentMode = 'ordinary', point?: CommitBarrier) {
    assert.equal(mode === 'duringcommit', point !== undefined)
    const key = point && randomBytes(32)
    const output = await build({
      configFile: false,
      plugins: point ? [nativeCommitBarrier(point)] : [],
      envFile: false,
      logLevel: 'error',
      build: {
        ssr: fileURLToPath(new URL('./windows-owned-process-parent.ts', import.meta.url)),
        target: 'node20',
        write: false,
      },
    })
    assert(!Array.isArray(output) && 'output' in output)
    const [driver] = output.output
    assert(output.output.length === 1 && driver?.type === 'chunk' && driver.isEntry)
    const path = join(this.dir, 'parent.mjs')
    await writeFile(path, driver.code)
    this.parentLaunchedAt = performance.now()
    const parent = this.own(
      spawn(this.execPath, [path, this.dir, this.nonce, mode], {
        cwd: this.dir,
        stdio: key ? ['pipe', 'ignore', 'ignore'] : 'ignore',
        windowsHide: true,
      }),
    )
    assert(parent.pid)
    if (key) {
      const input = parent.stdin
      assert(input)
      const sent = new Promise<void>((resolve, reject) => {
        input.once('error', reject)
        input.end(key.toString('base64'), resolve)
      })
      await within(sent, operationMs, 'private parent fixture credential')
    }
    await this.pin('parent', {
      pid: parent.pid,
      expectedImage: this.execPath,
      nonce: this.nonce,
      parentPid: process.pid,
    })
    this.started = true
    await this.mark('start-parent')
    const until = performance.now() + setupMs
    // The surviving worker cannot read the disposable driver's launch WeakMap.
    // Its private readiness record carries the authenticated HELLO identity.
    const { pid, birth, launchId } = await this.ready('helper', until)
    assert(typeof birth === 'string' && /^[1-9]\d{16,18}$/.test(birth), 'bad helper birth')
    assert(
      typeof launchId === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(launchId),
      'bad helper launch ID',
    )
    await this.pinTree({ pid, birth, launchId }, parent.pid, until)
    return key
  }

  private async awaitHandoff(stage: Exclude<ParentMode, 'ordinary'>) {
    const proof = await waitFor(
      async () => {
        const raw = await readFile(join(this.dir, 'handoff.json'), 'utf8').catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
        return raw === undefined ? undefined : JSON.parse(raw)
      },
      performance.now() + (stage === 'postcommit' ? revokeMs : operationMs),
      `${stage} disposable parent HANDOFF`,
    )
    assert.deepEqual(proof, {
      receipt: 'handoff',
      helperExitCode: 0 as const,
      helperPid: this.identity('helper').pid,
      rootPid: this.identity('root').pid,
      stage,
      nonce: this.nonce,
    })
    await this.assertExited('helper')
    await this.assertExited('root')
    this.actualNativeObservations.handoffExitCode = proof.helperExitCode
  }

  async parentDeathAfterHandoff(stage: 'precommit' | 'postcommit') {
    await this.disposableParent(stage)
    await this.release(0)
    await this.awaitHandoff(stage)
    if (stage === 'precommit') this.actualNativeObservations.uncommittedLeaseObserved = true
    else this.actualNativeObservations.commitVerified = true
    assert(!(await this.exited('grandchild')), 'grandchild exited before parent termination')
    this.actualNativeObservations.preParentDeathAlive = true
    if (stage === 'postcommit') this.actualNativeObservations.postcommitAlive = true
    await this.terminate('parent')
    await this.observeExit('parent')
    if (stage === 'precommit') {
      // No cleanup broker can run: the dead driver held the only lease.
      await this.observeExit('grandchild')
      this.actualNativeObservations.parentLossCleanup = true
    } else {
      const grandchild = this.identity('grandchild')
      grandchild.observedExit = await this.exited('grandchild')
      assert.equal(grandchild.observedExit, false, 'committed descendant died with the parent')
      this.actualNativeObservations.postParentDeathAlive = true
    }
    assert(
      performance.now() - this.parentLaunchedAt! < 45_000,
      'parent-loss reached fixture backstop',
    )
    return 'handoff' as const
  }

  async parentDeathDuringCommit(point: CommitBarrier) {
    const key = await this.disposableParent('duringcommit', point)
    assert(key)
    await this.release(0)
    await this.awaitHandoff('duringcommit')
    const parent = this.identity('parent')
    const record = (phase: CommitBarrier | 'rollback', ms: number) =>
      waitFor(
        async () => {
          const raw = await readFile(join(this.dir, `broker-${phase}.json`), 'utf8').catch(
            (error) => {
              if (error.code !== 'ENOENT') throw error
            },
          )
          if (raw === undefined) return undefined
          const envelope = JSON.parse(raw) as Record<string, unknown>
          const { payload, mac } = envelope
          assert(
            Object.keys(envelope).length === 2 &&
              typeof payload === 'string' &&
              typeof mac === 'string',
          )
          const expected = createHmac('sha256', key).update(payload).digest('base64')
          const signature = Buffer.from(mac, 'utf8')
          assert(
            signature.length === expected.length &&
              timingSafeEqual(signature, Buffer.from(expected)),
            'broker fixture MAC mismatch',
          )
          return JSON.parse(payload) as Record<string, unknown>
        },
        performance.now() + ms,
        `authenticated broker ${phase}`,
      )
    const barrier = await record(point, setupMs)
    assert(typeof barrier.pid === 'number' && typeof barrier.birth === 'string')
    assert.deepEqual(barrier, {
      phase: point,
      pid: barrier.pid,
      birth: barrier.birth,
      parentPid: parent.pid,
      parentBirth: parent.birth,
      guardArmed: false,
      activeProcesses: 1,
    } as const)
    await this.pin('broker', {
      pid: barrier.pid,
      birth: barrier.birth,
      expectedImage: this.helperImage,
    })
    assert(BigInt(barrier.birth) > BigInt(parent.birth), 'broker predates the disposable parent')
    this.identity('broker').pinnedAlive = true
    assert(!(await this.exited('grandchild')), 'grandchild exited before parent termination')
    assert(!(await this.exited('broker')), 'broker left the barrier before parent termination')
    await this.terminate('parent')
    await this.observeExit('parent', 'grandchild', 'broker')
    const rollback = await record('rollback', operationMs)
    assert.deepEqual(rollback, {
      ...barrier,
      phase: 'rollback',
      guardArmed: true,
      activeProcesses: 0,
    } as const)
    const brokerExitCode = await this.observer.exitCode(this.identity('broker').id)
    const grandchildExitCode = await this.observer.exitCode(this.identity('grandchild').id)
    assert.equal(brokerExitCode, 125)
    assert.equal(grandchildExitCode, 1)
    assert(
      performance.now() - this.parentLaunchedAt! < 45_000,
      'parent-loss reached fixture backstop',
    )
    this.actualNativeObservations.uncommittedLeaseObserved = true
    this.actualNativeObservations.preParentDeathAlive = true
    this.actualNativeObservations.parentLossCleanup = true
    this.actualNativeObservations.commitRollback = {
      barrier: point,
      guardArmedAtBarrier: barrier.guardArmed,
      activeAtBarrier: barrier.activeProcesses,
      guardRearmed: rollback.guardArmed,
      activeAfterRollback: rollback.activeProcesses,
      brokerExitCode,
      grandchildExitCode,
    }
    return 'handoff' as const
  }

  private async mark(file: string) {
    await writeFile(join(this.dir, file), '', { flag: 'wx' })
  }

  private async ready(role: (typeof treeRoles)[number], until: number) {
    return waitFor(
      async () => {
        const record = await readFile(join(this.dir, `${role}.json`), 'utf8').catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
        if (record === undefined) return undefined
        const { pid, nonce, birth, launchId } = JSON.parse(record) as Record<string, unknown>
        assert(
          nonce === this.nonce && typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0,
          `bad ${role} readiness`,
        )
        return { pid, birth, launchId }
      },
      until,
      `${role} readiness`,
    )
  }

  private async pin(role: Role, request: PinRequest) {
    const entry = await this.observer.pin(request)
    // Register before any assertion so finally can still act on verified handles.
    this.identities.set(role, entry)
    const creator = [...this.identities.values()].find((known) => known.pid === request.parentPid)
    assert(!creator || BigInt(creator.birth) <= BigInt(entry.birth), `bad ${role} creation order`)
  }

  private async pinManagedTree(child: ChildProcess) {
    const until = performance.now() + setupMs
    assert(child.pid, 'real launcher did not start a helper')
    const helper = await within(
      ownedHelperIdentity(child),
      setupMs,
      'authenticated helper identity',
    )
    assert.equal(helper.pid, child.pid, 'production helper identity PID changed')
    await this.pinTree(helper, process.pid, until)
  }

  private async pinTree(helper: HelperIdentity, parentPid: number, until: number) {
    await this.pin('helper', {
      pid: helper.pid,
      expectedImage: this.helperImage,
      birth: helper.birth,
      parentPid,
    })
    const root = await this.ready('root', until)
    await this.pin('root', {
      pid: root.pid,
      expectedImage: this.execPath,
      nonce: this.nonce,
      parentPid: helper.pid,
    })
    await this.mark('start-grandchild')
    const grandchild = await this.ready('grandchild', until)
    await this.pin('grandchild', {
      pid: grandchild.pid,
      expectedImage: this.execPath,
      nonce: this.nonce,
      parentPid: root.pid,
    })
    for (const role of this.roles) {
      assert(!(await this.exited(role)), `${role} was not alive at the barrier`)
      this.identity(role).pinnedAlive = true
    }
  }

  private get roles() {
    return this.parentLaunchedAt === undefined ? treeRoles : (['parent', ...treeRoles] as const)
  }

  private identity(role: Role) {
    const entry = this.identities.get(role)
    assert(entry, `${role} was not pinned`)
    return entry
  }

  private exited(role: Role) {
    return this.observer.exited(this.identity(role).id)
  }

  release(code: 0 | 37) {
    return this.mark(`release-${code}`)
  }

  receipt(child: PrivateManagedOwnedChild) {
    assert(child.ownedCompletion, 'native ownership receipt unavailable')
    return within(child.ownedCompletion, operationMs, 'ownership receipt did not settle')
  }

  async rejectedReceipt(child: PrivateManagedOwnedChild) {
    assert(child.ownedCompletion, 'native ownership receipt unavailable')
    const control = ownedLaunchControl(child)
    assert(control, 'original native launch control unavailable')
    // A deadline or command stderr is not a rejection from the controller.
    await assert.rejects(
      within(child.ownedCompletion, operationMs, 'ownership receipt did not settle'),
      (error: unknown) => {
        assert(error instanceof UnconfirmedOwnedProgramError)
        assert.equal(error.lease, control.lease)
        assert(error.cause instanceof Error)
        assert.match(
          error.cause.message,
          /^(?:owned helper exited abnormally|owned control ended without terminal receipt|owned control closed before transcript completion)$/,
        )
        return true
      },
    )
    return 'rejected' as const
  }

  async terminate(role: 'parent' | 'helper') {
    const entry = this.identity(role)
    assert(!(await this.observer.exited(entry.id)), `${role} was already dead before termination`)
    await this.observer.terminate(entry.id)
  }

  async observeExit(...roles: Role[]) {
    const until = performance.now() + operationMs
    await Promise.all(
      roles.map(async (role) => {
        await waitFor(
          async () => (await this.exited(role)) || undefined,
          until,
          `${role} native exit`,
        )
        this.identity(role).observedExit = true
      }),
    )
  }

  async terminateParentAndObserveCleanup() {
    const launchedAt = this.parentLaunchedAt
    assert(launchedAt !== undefined, 'disposable parent was not launched')
    for (const role of treeRoles)
      assert(!(await this.exited(role)), `${role} exited before parent termination`)
    await this.terminate('parent')
    await this.observeExit('parent', ...treeRoles)
    assert(performance.now() - launchedAt < 45_000, 'parent-loss cleanup reached fixture backstop')
    // These are held kernel-handle exits after controlled termination, not an
    // authenticated native cause. Control EOF can race the parent-handle wait.
    this.actualNativeObservations.parentLossCleanup = true
  }

  async observeEmpty() {
    for (const role of treeRoles) await this.assertExited(role)
  }

  private async assertExited(role: Role) {
    assert(await this.exited(role), `${role} was still running after the receipt`)
    this.identity(role).observedExit = true
  }

  pinDescendant(witness: WindowsOwnedProcessWitness) {
    const { pid, birth } = this.identity('grandchild')
    return witness.pin({ pid, birth, expectedImage: this.execPath, nonce: this.nonce })
  }

  async clean() {
    const failures: unknown[] = []
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action()
      } catch (error) {
        failures.push(error)
      }
    }
    const processes: {
      role: Role
      pid: number
      creationFiletime: string
      pinnedAlive: true
      observedExit: boolean
      cleanup: Cleanup
      cleanupExitObserved: true
    }[] = []
    if (this.started && this.roles.some((role) => !this.identities.get(role)?.pinnedAlive)) {
      failures.push(new Error('fixture identity missing during cleanup'))
      // Only for a failed setup. Signal exclusively this fixture's private
      // watchdogs; never turn an unverified PID into a termination target.
      await attempt(() => this.mark('abort'))
      if (this.parentLaunchedAt !== undefined && !this.identities.has('helper')) {
        // Give the driver a chance to close its own stable helper handle before
        // the harness falls back to terminating the known parent handle.
        const parent = this.direct[0]
        if (parent) await attempt(() => fixtureChild(parent).join(operationMs, 'driver fallback'))
      }
    }
    try {
      const lease = this.retainedLease
      if (lease && !this.actualNativeObservations.commitVerified)
        await attempt(() => within(lease.revoke(), revokeMs, 'original retained Job revoke'))
      for (const [role, entry] of this.identities) {
        await attempt(async () => {
          const cleanup: Cleanup = (await this.exited(role))
            ? 'already-exited'
            : 'terminated-held-handle'
          if (cleanup === 'terminated-held-handle') await this.observer.terminate(entry.id)
          await waitFor(
            async () => (await this.exited(role)) || undefined,
            performance.now() + operationMs,
            `${role} cleanup exit`,
          )
          if (entry.pinnedAlive && entry.observedExit !== undefined)
            processes.push({
              role,
              pid: entry.pid,
              creationFiletime: entry.birth,
              pinnedAlive: entry.pinnedAlive,
              observedExit: entry.observedExit,
              cleanup,
              cleanupExitObserved: true,
            })
        })
      }
    } finally {
      for (const child of this.direct) {
        await attempt(async () => {
          if (child.exitCode === null && child.signalCode === null && child.pid !== undefined)
            ChildProcess.prototype.kill.call(child, 'SIGKILL')
        })
        await attempt(() => fixtureChild(child).join(operationMs, 'direct fixture child'))
      }
      await attempt(async () => {
        await this.witness?.close()
      })
      await attempt(() => rm(this.dir, { force: true, recursive: true, maxRetries: 3 }))
    }
    if (failures.length) throw new AggregateError(failures, 'native fixture cleanup incomplete')
    return {
      processes,
      actualNativeObservations: this.actualNativeObservations,
      cleanup: { witnessClosed: Boolean(this.witness), tempRemoved: true },
    }
  }
}
