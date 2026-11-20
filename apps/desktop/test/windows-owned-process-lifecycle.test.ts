import { describe, expect, it } from 'vitest'
import {
  lifecycleBudgetMs,
  witnessLifecycle,
  type TreeStdio,
} from './fixtures/windows-owned-process-lifecycle'

const withTree = ['root', 'grandchild', 'helper'] as const

describe.skipIf(process.platform !== 'win32')('native Windows owned-process lifecycle', () => {
  it(
    'hands off an execProgram success with output and a live pinned descendant',
    { timeout: lifecycleBudgetMs },
    ({ task }) =>
      witnessLifecycle('retained-success', task.name, async (fixture) => {
        const { commitHandoff } = await fixture.retained('ignore')
        await fixture.release(0)
        return commitHandoff()
      }),
  )

  it(
    'drains a retained execProgram nonzero exit without handing off',
    { timeout: lifecycleBudgetMs },
    ({ task }) =>
      witnessLifecycle('retained-nonzero', task.name, async (fixture) => {
        const { child, callback } = await fixture.retained('inherit')
        await fixture.release(37)
        const kind = await fixture.receipt(child)
        expect(kind).toBe('empty')
        await fixture.observeEmpty()
        const { error, ownership } = await callback()
        expect(error).toBeInstanceOf(Error)
        expect(error).toMatchObject({ code: 37, signal: null, killed: false })
        expect(ownership).toStrictEqual({ kind: 'settled' })
        return kind
      }),
  )

  it(
    'drains a cancelled retained execProgram launch without handing off',
    { timeout: lifecycleBudgetMs },
    ({ task }) =>
      witnessLifecycle('retained-cancelled', task.name, async (fixture) => {
        const { child, callback } = await fixture.retained('inherit')
        expect(child.kill('SIGTERM')).toBe(true)
        const kind = await fixture.receipt(child)
        expect(kind).toBe('empty')
        await fixture.observeEmpty()
        const { error, ownership } = await callback()
        expect(error).toBeInstanceOf(Error)
        expect(error).toMatchObject({ code: 1, signal: null, killed: false })
        expect(ownership).toStrictEqual({ kind: 'settled' })
        return kind
      }),
  )

  it.each([
    ['ignore', 'exits'],
    ['inherit', 'exits'],
    ['ignore', 'is cancelled'],
    ['inherit', 'is cancelled'],
  ] as const)(
    'drains a resistant grandchild with %s stdio when the root %s',
    { timeout: lifecycleBudgetMs },
    (stdio: TreeStdio, action) =>
      witnessLifecycle(
        `resistant-${stdio}-${action === 'exits' ? 'exit' : 'cancel'}`,
        `drains a resistant grandchild with ${stdio} stdio when the root ${action}`,
        async (fixture) => {
          const child = await fixture.owned(stdio)
          if (action === 'exits') await fixture.release(0)
          else expect(child.kill('SIGTERM')).toBe(true)
          const kind = await fixture.receipt(child)
          expect(kind).toBe('empty')
          expect(child.exitCode).toBe(action === 'exits' ? 0 : 1)
          await fixture.observeEmpty()
          return kind
        },
      ),
  )

  it(
    'rejects ownership completion after abnormal helper death and observes job kill-on-close',
    { timeout: lifecycleBudgetMs },
    ({ task }) =>
      witnessLifecycle('helper-death', task.name, async (fixture) => {
        const child = await fixture.owned('inherit')
        await fixture.terminate('helper')
        const kind = await fixture.rejectedReceipt(child)
        await fixture.observeExit(...withTree)
        return kind
      }),
  )

  it(
    'drains the pinned tree and helper after the disposable Node parent dies',
    { timeout: lifecycleBudgetMs },
    ({ task }) =>
      witnessLifecycle('parent-death', task.name, async (fixture) => {
        await fixture.disposableParent()
        await fixture.terminateParentAndObserveCleanup()
        return 'unobservable-parent-death'
      }),
  )

  it(
    'kills the pinned descendant when the Node parent dies after HANDOFF but before commit',
    { timeout: lifecycleBudgetMs },
    ({ task }) =>
      witnessLifecycle('retained-precommit-parent-death', task.name, (fixture) =>
        fixture.parentDeathAfterHandoff('precommit'),
      ),
  )

  it.each(['before-send', 'after-send'] as const)(
    'rolls back the native commit when the Node parent dies at the %s barrier',
    { timeout: lifecycleBudgetMs },
    (point) =>
      witnessLifecycle(
        `retained-commit-parent-death-${point}`,
        `rolls back the native commit when the Node parent dies at the ${point} barrier`,
        (fixture) => fixture.parentDeathDuringCommit(point),
      ),
  )

  it(
    'preserves the pinned descendant when the Node parent dies after native commit',
    { timeout: lifecycleBudgetMs },
    ({ task }) =>
      witnessLifecycle('retained-postcommit-parent-death', task.name, (fixture) =>
        fixture.parentDeathAfterHandoff('postcommit'),
      ),
  )
})
