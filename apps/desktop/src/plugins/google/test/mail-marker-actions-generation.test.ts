import { describe, expect, it, vi } from 'vitest'
import { MailMarkerActions, type MailMarkerState } from '../renderer/mail-marker-actions'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const blue: MailMarkerState = { marker: 'blue-question', starred: true }

describe('marker mutation generations', () => {
  it.each([
    ['filter disposal', 'success'],
    ['filter disposal', 'refusal'],
    ['account round trip', 'success'],
    ['account round trip', 'refusal'],
  ] as const)(
    'fences a pending %s write on %s and protects the new activation',
    async (retirement, outcome) => {
      const oldWrite = deferred<void>()
      const oldWorkDone = deferred<void>()
      const oldWrapperExit = deferred<void>()
      const newWriteStarted = deferred<void>()
      const newWrite = deferred<void>()
      const acknowledged = deferred<void>()
      const oldSurface = { writes: 0 }
      const newSurface = { writes: 0 }
      let surface = oldSurface
      const changed = vi.fn()
      const failed = vi.fn()
      const settled = vi.fn(() => acknowledged.resolve())
      const write = vi.fn(async () => {
        if (write.mock.calls.length === 1) {
          expect(oldSurface.writes).toBe(1)
          await oldWrite.promise
        } else {
          expect(oldSurface.writes).toBe(0)
          expect(newSurface.writes).toBe(1)
          newWriteStarted.resolve()
          await newWrite.promise
        }
      })
      const reconcile = vi.fn(async () => blue)
      const actions = new MailMarkerActions({
        runMutation: async (work) => {
          const owner = surface
          owner.writes++
          try {
            await work()
            if (owner === oldSurface) {
              oldWorkDone.resolve()
              await oldWrapperExit.promise
            }
          } finally {
            owner.writes--
          }
        },
        write,
        reconcile,
        changed,
        failed,
        settled,
        now: () => 0,
      })
      actions.setOwner('vault\0account', ['yellow-star', 'red-star'])
      actions.activate('thread', false, null)
      actions.activate('thread', true, 'yellow-star')
      if (retirement === 'filter disposal') actions.dispose()
      else actions.setOwner('other-vault\0other-account', ['yellow-star'])
      surface = newSurface
      actions.setOwner('vault\0account', ['red-star', 'blue-question'])
      actions.activate('thread', false, null)
      actions.activate('thread', true, 'red-star')
      expect(changed).toHaveBeenLastCalledWith('thread', blue, false)
      const optimisticChanges = changed.mock.calls.length

      if (outcome === 'success') oldWrite.resolve()
      else oldWrite.reject(new Error('retired refusal'))
      await oldWorkDone.promise
      expect(write).toHaveBeenCalledTimes(1)
      expect(reconcile).not.toHaveBeenCalled()
      expect(failed).not.toHaveBeenCalled()
      expect(settled).not.toHaveBeenCalled()
      expect(changed).toHaveBeenCalledTimes(optimisticChanges)

      oldWrapperExit.resolve()
      await newWriteStarted.promise
      expect(write.mock.calls).toEqual([
        ['vault\0account', 'thread', 'yellow-star'],
        ['vault\0account', 'thread', 'blue-question'],
      ])
      expect(newSurface.writes).toBe(1)
      newWrite.resolve()
      await acknowledged.promise
      expect(reconcile).toHaveBeenCalledExactlyOnceWith('vault\0account', 'thread', false)
      expect(changed).toHaveBeenCalledTimes(optimisticChanges + 1)
      expect(changed).toHaveBeenLastCalledWith('thread', blue, false)
      expect(failed).not.toHaveBeenCalled()
      expect(settled).toHaveBeenCalledExactlyOnceWith('thread')
    },
  )

  it('ignores retired acknowledgement and reconciles a new refusal under its own mutation owner', async () => {
    const oldReadStarted = deferred<void>()
    const oldRead = deferred<MailMarkerState>()
    const newReadStarted = deferred<void>()
    const newRead = deferred<MailMarkerState>()
    const acknowledged = deferred<void>()
    const refusal = new Error('new write refused')
    const oldSurface = { writes: 0 }
    const newSurface = { writes: 0 }
    let surface = oldSurface
    const changed = vi.fn()
    const failed = vi.fn()
    const settled = vi.fn(() => acknowledged.resolve())
    const write = vi.fn(async () => {
      if (write.mock.calls.length > 1) {
        expect(oldSurface.writes).toBe(0)
        expect(newSurface.writes).toBe(1)
        throw refusal
      }
    })
    const reconcile = vi.fn(async (_owner: string, _id: string, readActualStar: boolean) => {
      if (!readActualStar) {
        oldReadStarted.resolve()
        return oldRead.promise
      }
      expect(newSurface.writes).toBe(1)
      newReadStarted.resolve()
      return newRead.promise
    })
    const actions = new MailMarkerActions({
      runMutation: async (work) => {
        const owner = surface
        owner.writes++
        try {
          await work()
        } finally {
          owner.writes--
        }
      },
      write,
      reconcile,
      changed,
      failed,
      settled,
      now: () => 0,
    })
    actions.setOwner('owner', ['yellow-star'])
    actions.activate('thread', false, null)
    await oldReadStarted.promise
    actions.dispose()
    surface = newSurface
    actions.setOwner('owner', ['blue-question'])
    actions.activate('thread', false, null)
    const optimisticChanges = changed.mock.calls.length
    oldRead.resolve({ marker: 'yellow-star', starred: true })
    await newReadStarted.promise
    expect(changed).toHaveBeenCalledTimes(optimisticChanges)
    expect(changed).toHaveBeenLastCalledWith('thread', blue, false)
    expect(settled).not.toHaveBeenCalled()
    expect(failed).toHaveBeenCalledExactlyOnceWith(refusal)
    newRead.resolve({ marker: null, starred: true })
    await acknowledged.promise
    expect(changed).toHaveBeenLastCalledWith('thread', { marker: null, starred: true }, false)
    expect(settled).toHaveBeenCalledExactlyOnceWith('thread')
    expect(write.mock.calls).toEqual([
      ['owner', 'thread', 'yellow-star'],
      ['owner', 'thread', 'blue-question'],
    ])
  })
})
