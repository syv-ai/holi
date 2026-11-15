import { describe, expect, it, vi } from 'vitest'
import { MailMarkerActions } from '../renderer/mail-marker-actions'
import { MailMarkerStatus } from '../renderer/mail-marker-icon'
import { render, screen } from '@testing-library/react'

const state = (
  marker: 'yellow-star' | 'red-star' | 'blue-question' | null,
  starred = marker !== null,
) => ({
  marker,
  starred,
})

describe('MailMarkerActions', () => {
  it('shows a Retry for reconciliation errors even when the actual mail is unstarred', () => {
    const retry = vi.fn()
    render(<MailMarkerStatus state={{ kind: 'error' }} starred={false} onRetry={retry} />)
    expect(screen.getByText('Marker unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry marker' })).toBeVisible()
    expect(screen.queryByLabelText('Starred')).not.toBeInTheDocument()
  })
  it('cycles inclusively through a burst, wraps, then unstars outside the burst', async () => {
    vi.useFakeTimers()
    const writes: unknown[][] = []
    const action = new MailMarkerActions({
      write: async (_owner, ...args) => void writes.push(args),
      reconcile: async () => state(null, false),
      changed: () => {},
      now: Date.now,
    })
    action.setOwner('vault\0account', ['red-star', 'blue-question'])
    action.activate('thread', false, null)
    action.activate('thread', true, 'red-star')
    action.activate('thread', true, 'blue-question')
    await vi.runAllTimersAsync()
    expect(writes).toEqual([
      ['thread', 'red-star'],
      ['thread', 'red-star'],
    ])
    await vi.advanceTimersByTimeAsync(501)
    action.activate('thread', true, 'red-star')
    await vi.runAllTimersAsync()
    expect(writes.at(-1)).toEqual(['thread', null])
    vi.useRealTimers()
  })

  it('stars with the first configured marker when Gmail is unstarred but the annotation is stale', async () => {
    const writes: unknown[][] = []
    const action = new MailMarkerActions({
      write: async (_owner, ...args) => void writes.push(args),
      reconcile: async () => state(null, false),
      changed: () => {},
      now: () => 0,
    })
    action.setOwner('owner', ['red-star', 'blue-question'])
    action.activate('thread', false, 'blue-question')
    await vi.waitFor(() => expect(writes).toEqual([['thread', 'red-star']]))
  })

  it('keeps one marker as an ordinary star/unstar toggle', async () => {
    const writes: unknown[][] = []
    const action = new MailMarkerActions({
      write: async (_owner, ...args) => void writes.push(args),
      reconcile: async () => state(null, false),
      changed: () => {},
      now: () => 0,
    })
    action.setOwner('owner', ['yellow-star'])
    action.activate('thread', false, null)
    action.activate('thread', true, 'yellow-star')
    await vi.waitFor(() =>
      expect(writes).toEqual([
        ['thread', 'yellow-star'],
        ['thread', null],
      ]),
    )
  })

  it('coalesces each thread independently while another thread write is delayed', async () => {
    let release!: () => void
    const first = new Promise<void>((resolve) => (release = resolve))
    const writes: unknown[][] = []
    const action = new MailMarkerActions({
      write: async (_owner, ...args) => {
        writes.push(args)
        if (args[0] === 'a' && args[1] === 'yellow-star') await first
      },
      reconcile: async () => state(null, false),
      changed: () => {},
      now: () => 0,
    })
    action.setOwner('owner', ['yellow-star', 'red-star', 'blue-question'])
    action.activate('a', false, null)
    action.activate('a', true, 'yellow-star')
    action.activate('b', false, null)
    action.activate('b', true, 'yellow-star')
    action.activate('b', true, 'red-star')
    await vi.waitFor(() => expect(writes).toContainEqual(['b', 'blue-question']))
    release()
    await vi.waitFor(() => expect(writes).toContainEqual(['a', 'red-star']))
    expect(writes).toContainEqual(['b', 'blue-question'])
  })

  it('lets later context actions proceed after a settled primary action', async () => {
    const writes: unknown[][] = []
    const action = new MailMarkerActions({
      write: async (_owner, ...args) => void writes.push(args),
      reconcile: async () => state('yellow-star'),
      changed: () => {},
      now: Date.now,
    })
    action.setOwner('owner', ['yellow-star', 'red-star'])
    action.activate('thread', false, null)
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 510))
    action.activate('thread', true, 'yellow-star')
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(writes.at(-1)).toEqual(['thread', null])
  })

  it('does not retain a failed reconciliation overlay and supports Retry', async () => {
    let reads = 0
    const changed = vi.fn()
    const action = new MailMarkerActions({
      write: async () => {},
      reconcile: async () => {
        reads++
        if (reads === 1) throw new Error('temporary read failure')
        return state('yellow-star')
      },
      changed,
      now: () => 0,
    })
    action.setOwner('owner', ['yellow-star'])
    action.activate('thread', false, null)
    await vi.waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith('thread', state('yellow-star'), true),
    )
    await action.retry('thread')
    expect(changed).toHaveBeenLastCalledWith('thread', state('yellow-star'), false)
  })

  it('reconciles annotation and Gmail star independently after a refused unstar', async () => {
    const changed = vi.fn()
    const action = new MailMarkerActions({
      write: async () => {
        throw new Error('refused')
      },
      reconcile: async () => state(null, true),
      changed,
      now: () => 0,
    })
    action.setOwner('owner', ['yellow-star'])
    action.activate('external-star', true, null)
    await vi.waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith('external-star', state(null, true), false),
    )
  })

  it('ignores a delayed Retry after a newer primary activation', async () => {
    let release!: (value: ReturnType<typeof state>) => void
    const changed = vi.fn()
    const action = new MailMarkerActions({
      write: async () => {},
      reconcile: async () => new Promise((resolve) => (release = resolve)),
      changed,
      now: () => 0,
    })
    action.setOwner('owner', ['yellow-star', 'red-star'])
    const retry = action.retry('thread')
    action.activate('thread', false, null)
    const changes = changed.mock.calls.length
    release(state('yellow-star'))
    await retry
    expect(changed).toHaveBeenCalledTimes(changes)
  })

  it('ignores a delayed Retry after ordinary invalidation and fences repeated retries', async () => {
    let releaseFirst!: (value: ReturnType<typeof state>) => void
    let releaseSecond!: (value: ReturnType<typeof state>) => void
    const changed = vi.fn()
    const action = new MailMarkerActions({
      write: async () => {},
      reconcile: vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)))
        .mockImplementationOnce(() => new Promise((resolve) => (releaseSecond = resolve)))
        .mockResolvedValue(state(null, false)),
      changed,
      now: () => 0,
    })
    action.setOwner('owner', ['yellow-star'])
    const first = action.retry('thread')
    const second = action.retry('thread')
    releaseFirst(state('red-star'))
    await first
    expect(changed).not.toHaveBeenCalled()
    releaseSecond(state('yellow-star'))
    await second
    expect(changed).toHaveBeenCalledTimes(1)
    const third = action.retry('thread')
    action.invalidate('thread')
    const changes = changed.mock.calls.length
    releaseSecond(state('red-star'))
    await third
    expect(changed).toHaveBeenCalledTimes(changes)
  })

  it('discards queued old-owner actions through A-B-A and suppresses stale completion', async () => {
    let release!: () => void
    const first = new Promise<void>((resolve) => (release = resolve))
    const changed = vi.fn()
    const writes: unknown[][] = []
    const action = new MailMarkerActions({
      write: async (owner, id, marker) => {
        writes.push([owner, id, marker])
        if (writes.length === 1) await first
      },
      reconcile: async () => state('yellow-star'),
      changed,
      now: () => 0,
    })
    action.setOwner('A', ['yellow-star'])
    action.activate('old', false, null)
    action.activate('old', true, 'yellow-star')
    const oldChangeCount = changed.mock.calls.length
    action.setOwner('B', ['yellow-star'])
    action.setOwner('A', ['red-star'])
    release()
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(changed).toHaveBeenCalledTimes(oldChangeCount)
    action.activate('fresh', false, null)
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(writes.at(-1)).toEqual(['A', 'fresh', 'red-star'])
  })
})
