import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixtureChild, withFixtureCleanup } from './fixtures/fixture-deadline'
import { lifecycleBudgetMs, withNativeLifecycle } from './fixtures/windows-owned-process-lifecycle'
import {
  fixtureNonce,
  startWitness,
  startWitnessSelfTest,
  type WindowsOwnedProcessWitness,
} from './fixtures/windows-owned-process-witness'

const image = resolve(process.execPath)
const phaseMs = 5_000
const caseBudgetMs = 60_000

function isolated(body: (defer: (cleanup: () => Promise<unknown>) => void) => Promise<void>) {
  return async () => {
    const cleanups: (() => Promise<unknown>)[] = []
    await withFixtureCleanup(
      () => body((cleanup) => cleanups.push(cleanup)),
      async () => {
        const errors: unknown[] = []
        for (const cleanup of cleanups.reverse()) {
          try {
            await cleanup()
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length) throw new AggregateError(errors, 'witness self-test cleanup incomplete')
      },
    )
  }
}

function directFixture(defer: (cleanup: () => Promise<unknown>) => void) {
  const nonce = fixtureNonce()
  const child = spawn(image, ['-e', 'setInterval(() => {}, 1000)', nonce], {
    windowsHide: true,
    stdio: 'ignore',
  })
  const observation = fixtureChild(child)
  defer(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await observation.join(phaseMs, 'direct witness test fixture')
  })
  assert(child.pid)
  return { child, join: observation.join, pin: { pid: child.pid, nonce, expectedImage: image } }
}

async function pinLive(
  witness: WindowsOwnedProcessWitness,
  pin: Parameters<typeof witness.pin>[0],
) {
  const { id, birth } = await witness.pin(pin)
  expect(birth).toMatch(/^\d+$/)
  expect(await witness.exited(id)).toBe(false)
  return { id, birth }
}

describe.skipIf(process.platform !== 'win32')(
  'Windows owned-process witness native self-test',
  () => {
    it(
      'holds the original process handle, verifies identity, terminates, and observes exit',
      { timeout: caseBudgetMs },
      isolated(async (defer) => {
        const target = directFixture(defer)
        const closeTarget = directFixture(defer)
        const unrelated = directFixture(defer)
        const witness = await startWitness()
        defer(() => witness.close())

        const { id } = await pinLive(witness, target.pin)
        await pinLive(witness, closeTarget.pin)
        await expect(
          witness.pin({ ...unrelated.pin, expectedImage: `${image}.wrong` }),
        ).rejects.toThrow('image-mismatch')
        await expect(witness.pin({ ...unrelated.pin, nonce: fixtureNonce() })).rejects.toThrow(
          'nonce-mismatch',
        )
        expect(await witness.exited(id)).toBe(false)

        await witness.terminate(id)
        await target.join(phaseMs, 'explicitly terminated fixture')
        expect(await witness.exited(id)).toBe(true)
        await Promise.all([witness.close(), witness.close()])
        await closeTarget.join(phaseMs, 'ordinary close target')
        expect(unrelated.child.exitCode).toBeNull()
        expect(unrelated.child.signalCode).toBeNull()
      }),
    )

    it(
      'drains verified handles on abnormal witness stdin EOF',
      { timeout: caseBudgetMs },
      isolated(async (defer) => {
        const target = directFixture(defer)
        const test = await startWitnessSelfTest()
        defer(() => test.disconnect())
        await pinLive(test.witness, target.pin)
        expect(await test.disconnect()).toEqual({ reason: 'eof', drained: true })
        await target.join(phaseMs, 'EOF target')
      }),
    )

    it(
      'drains verified handles when the held witness parent dies with stdin open',
      { timeout: caseBudgetMs },
      isolated(async (defer) => {
        const parent = directFixture(defer)
        const target = directFixture(defer)
        const test = await startWitnessSelfTest({ parentPid: parent.pin.pid })
        defer(() => test.disconnect())
        await pinLive(test.witness, target.pin)
        expect(parent.child.kill('SIGKILL')).toBe(true)
        await parent.join(phaseMs, 'held parent')
        expect(await test.join()).toEqual({ reason: 'parent-death', drained: true })
        await target.join(phaseMs, 'parent-death target')
      }),
    )

    it(
      'joins native drain after a request timeout with a live handed-off descendant',
      { timeout: lifecycleBudgetMs },
      () =>
        withNativeLifecycle(async (fixture) => {
          const test = await startWitnessSelfTest()
          await withFixtureCleanup(
            async () => {
              const launchedAt = performance.now()
              const { commitHandoff } = await fixture.retained('ignore')
              await fixture.release(0)
              await commitHandoff()
              // Hold the same committed descendant in both witnesses. The outer
              // one never stalls, so it can independently verify physical exit.
              const watched = await fixture.pinDescendant(test.witness)
              expect(await test.witness.exited(watched.id)).toBe(false)

              const stall = test.stall()
              await stall.entered
              const firstError = await stall.request.then(
                () => undefined,
                (error: unknown) => error,
              )
              expect(firstError).toMatchObject({ message: 'witness stall deadline exceeded' })
              await expect(test.witness.terminate(watched.id)).rejects.toBe(firstError)
              // Close retains the client failure, but only settles after the separate native join.
              await expect(test.witness.close()).rejects.toBe(firstError)
              expect(await test.join()).toEqual({ reason: 'eof', drained: true })
              await fixture.observeExit('grandchild')
              expect(performance.now() - launchedAt).toBeLessThan(45_000) // exclude the fixture backstop
            },
            () => test.disconnect(),
          )
        }),
    )
  },
)
