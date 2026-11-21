import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execProgram } from '../../src/main/launch'
import type { PrivateManagedOwnedChild } from '../../src/main/owned-process-completion'
import { spawnOwnedProgram } from '../../src/main/owned-process'
import { ownedHelperIdentity, ownedLaunchControl } from '../../src/main/owned-process-launch'
import type { RetainedExecMetadata } from '../../src/main/owned-program-lifetime'
import { configureBrokerFixture } from '../owned-process-test-adapter'
import { fixtureChild, fixtureResult, withFixtureCleanup, within } from './fixture-deadline'

// This standalone Node parent owns the real control socket. Killing it cannot
// accidentally leave a controller running in the Vitest worker.
const [dir, nonce, mode] = process.argv.slice(2) as [string, string, string]
assert(
  mode === 'ordinary' || mode === 'precommit' || mode === 'postcommit' || mode === 'duringcommit',
)
if (mode === 'duringcommit') {
  const input: Buffer[] = []
  for await (const chunk of process.stdin) input.push(chunk as Buffer)
  configureBrokerFixture(dir, Buffer.concat(input).toString('ascii'))
}
const aborted = () => !existsSync(dir) || existsSync(join(dir, 'abort'))
const deadline = performance.now() + 45_000 // Fixture fail-safe, never used as evidence.
while (!aborted() && !existsSync(join(dir, 'start-parent')) && performance.now() < deadline)
  await delay(20)
if (aborted() || performance.now() >= deadline) process.exit(2)

const callback = fixtureResult<RetainedExecMetadata | undefined>()
const args = [join(dir, 'tree.cjs'), 'root', dir, nonce, mode === 'ordinary' ? 'inherit' : 'ignore']
const helper =
  mode === 'ordinary'
    ? spawnOwnedProgram(process.execPath, args, { cwd: dir, stdio: 'ignore' })
    : (execProgram(
        process.execPath,
        args,
        {
          cwd: dir,
          env: process.env,
          encoding: 'utf8',
          maxBuffer: 4096,
          timeoutMs: 20_000,
          retainDescendantsOnSuccess: true,
        },
        (error, stdout, stderr, ownership) => {
          if (error) callback.settle({ error })
          else if (stdout !== 'fixture stdout\n' || stderr !== 'fixture stderr\n')
            callback.settle({ error: new Error('disposable parent did not collect root output') })
          else callback.settle({ value: ownership })
        },
      ) as PrivateManagedOwnedChild)
const observed = fixtureChild(helper)
function publish(record: string, value: object) {
  writeFileSync(join(dir, `${record}.tmp`), JSON.stringify({ ...value, nonce }), { flag: 'wx' })
  renameSync(join(dir, `${record}.tmp`), join(dir, `${record}.json`))
}
await withFixtureCleanup(
  async () => {
    assert(helper.pid && helper.ownedCompletion, 'managed helper did not spawn')
    const identity = await within(
      ownedHelperIdentity(helper),
      15_000,
      'authenticated helper identity',
    )
    assert.equal(identity.pid, helper.pid)
    // Only this driver can look up its launch; atomically pass the HELLO birth,
    // PID and launch ID to the worker in the fixture's private ready record.
    publish('helper', identity)
    if (mode !== 'ordinary') {
      const ownership = await callback.wait(22_000, 'retained parent callback')
      const receipt = await within(helper.ownedCompletion, 5000, 'retained parent receipt')
      const helperExitCode = await observed.join(5000, 'retained parent helper')
      const control = ownedLaunchControl(helper)
      assert.equal(receipt, 'handoff')
      assert.equal(helperExitCode, 0)
      assert(ownership?.kind === 'settled' && ownership.lease && control)
      assert.equal(ownership.lease, control.lease)
      if (mode === 'postcommit') await ownership.lease.commit()
      // For precommit, this driver has no path that calls commit or revoke.
      // Only the worker's held parent handle is used to end this process.
      publish('handoff', {
        receipt,
        helperExitCode,
        helperPid: identity.pid,
        rootPid: control.diagnostics().rootPid,
        stage: mode,
      })
      if (mode === 'duringcommit') {
        // The synthetic provider ID is already known and bound to the witness
        // nonce before granting release. No worker can commit or revoke this lease.
        assert(nonce)
        await ownership.lease.commit()
        throw new Error('private commit barrier unexpectedly allowed commit')
      }
    }
    while (!aborted() && performance.now() < deadline) await delay(20)
  },
  async () => {
    // Only a failure-path backstop. The controlled parent-loss case kills this
    // driver before it can signal the helper itself.
    await withFixtureCleanup(
      async () => {
        if (helper.pid && helper.exitCode === null && helper.signalCode === null)
          ChildProcess.prototype.kill.call(helper, 'SIGKILL')
      },
      () => observed.join(5_000, 'disposable parent helper'),
    )
  },
)
