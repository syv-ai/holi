import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  useMailMarkerActions,
  publishMailMarkerPreferences,
} from '../renderer/use-mail-marker-actions'

const run = vi.fn()
vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      run: {
        mutate: (input: unknown) => run(input),
      },
    },
  },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const annotations = (marker: string | null) => ({ thread: marker })
const props = { remote: 'vault-a', accountSub: 'account-a', activeThreadId: null }

afterEach(() => run.mockReset())

describe('useMailMarkerActions production hook', () => {
  it('allows ordinary and bulk invalidation after a settled primary action', async () => {
    run.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'google.mailMarkerPreferences') return { enabledOrder: ['yellow-star'] }
      if (name === 'google.setMailMarker') return { ok: true }
      if (name === 'google.mailMarkerAnnotations') return annotations('yellow-star')
      return { threads: [] }
    })
    const { result } = renderHook(() =>
      useMailMarkerActions({ ...props, reconcile: vi.fn(), onFailure: vi.fn(), onChange: vi.fn() }),
    )
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'google.mailMarkerPreferences' }),
      ),
    )
    act(() => result.current.activate('thread', false, null))
    await waitFor(() => expect(result.current.get('thread')?.marker).toBe('yellow-star'))
    await new Promise((resolve) => setTimeout(resolve, 510))
    act(() => result.current.invalidate('thread'))
    expect(result.current.get('thread')).toBeUndefined()
    act(() => result.current.activate('thread', false, null))
    await waitFor(() =>
      expect(
        run.mock.calls.filter(
          ([input]) => (input as { name: string }).name === 'google.setMailMarker',
        ),
      ).toHaveLength(2),
    )
  })

  it('cycles from the owned overlay while the annotation reload is pending', async () => {
    run.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'google.mailMarkerPreferences')
        return { enabledOrder: ['yellow-star', 'red-star'] }
      if (name === 'google.setMailMarker') return { ok: true }
      if (name === 'google.mailMarkerAnnotations') return annotations('yellow-star')
      return { ok: true }
    })
    const { result } = renderHook(() =>
      useMailMarkerActions({ ...props, reconcile: vi.fn(), onFailure: vi.fn(), onChange: vi.fn() }),
    )
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'google.mailMarkerPreferences' }),
      ),
    )

    act(() => result.current.activate('thread', false, null))
    await waitFor(() => expect(result.current.get('thread')?.marker).toBe('yellow-star'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    act(() => result.current.activate('thread', true, null))

    await waitFor(() =>
      expect(
        run.mock.calls.filter(
          ([input]) => (input as { name: string }).name === 'google.setMailMarker',
        ),
      ).toHaveLength(2),
    )
    const writes = run.mock.calls.filter(
      ([input]) => (input as { name: string }).name === 'google.setMailMarker',
    )
    expect(
      writes.map(([input]) => JSON.parse((input as { paramsJson: string }).paramsJson).marker),
    ).toEqual(['yellow-star', 'red-star'])
  })

  it('retries after reconciliation failure and uses actual starred state for a refused external-star unstar', async () => {
    let reads = 0
    const changed = vi.fn()
    run.mockImplementation(async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
      const params = JSON.parse(paramsJson ?? '{}') as { marker?: string | null }
      if (name === 'google.mailMarkerPreferences') return { enabledOrder: ['yellow-star'] }
      if (name === 'google.setMailMarker') throw new Error('write refused')
      if (name === 'google.mailMarkerAnnotations') {
        reads++
        if (reads === 1) throw new Error('temporary read failure')
        return annotations(null)
      }
      if (name === 'google.search') return { threads: [{ id: 'thread' }] }
      return { ok: true, marker: params.marker }
    })
    const onFailure = vi.fn()
    const { result } = renderHook(() =>
      useMailMarkerActions({ ...props, reconcile: vi.fn(), onFailure, onChange: changed }),
    )
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'google.mailMarkerPreferences' }),
      ),
    )
    act(() => result.current.activate('thread', true, null))
    await waitFor(() => expect(result.current.get('thread')?.error).toBe(true))
    await act(async () => result.current.retry('thread'))
    expect(result.current.get('thread')?.error).toBe(false)
    expect(onFailure).toHaveBeenCalled()
    expect(
      run.mock.calls.filter(
        ([input]) => (input as { name: string }).name === 'google.setMailMarker',
      ),
    ).toHaveLength(1)
  })

  it('propagates same-account preference changes across vaults but not other accounts', async () => {
    run.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'google.mailMarkerPreferences') return { enabledOrder: ['yellow-star'] }
      if (name === 'google.mailMarkerAnnotations') return annotations('yellow-star')
      return { ok: true }
    })
    const options = { reconcile: vi.fn(), onFailure: vi.fn(), onChange: vi.fn() }
    const a = renderHook(() =>
      useMailMarkerActions({
        ...options,
        remote: 'vault-a',
        accountSub: 'account-a',
        activeThreadId: null,
      }),
    )
    const b = renderHook(() =>
      useMailMarkerActions({
        ...options,
        remote: 'vault-b',
        accountSub: 'account-a',
        activeThreadId: null,
      }),
    )
    const other = renderHook(() =>
      useMailMarkerActions({
        ...options,
        remote: 'vault-c',
        accountSub: 'account-b',
        activeThreadId: null,
      }),
    )
    await waitFor(() =>
      expect(
        run.mock.calls.filter(
          ([input]) => (input as { name: string }).name === 'google.mailMarkerPreferences',
        ),
      ).toHaveLength(3),
    )
    act(() =>
      publishMailMarkerPreferences('vault-a', 'account-a', {
        enabledOrder: ['blue-question', 'yellow-star'],
      }),
    )
    act(() => {
      a.result.current.activate('thread', false, null)
      b.result.current.activate('thread', false, null)
      other.result.current.activate('thread', false, null)
    })
    await waitFor(() =>
      expect(
        run.mock.calls.filter(
          ([input]) => (input as { name: string }).name === 'google.setMailMarker',
        ),
      ).toHaveLength(3),
    )
    const writes = run.mock.calls.filter(
      ([input]) => (input as { name: string }).name === 'google.setMailMarker',
    )
    expect(
      writes.map(([input]) => JSON.parse((input as { paramsJson: string }).paramsJson).marker),
    ).toEqual(['blue-question', 'blue-question', 'yellow-star'])
  })

  it('discards queued work after unmount and through A-B-A; refused Unstar preserves an external Gmail star', async () => {
    const write = deferred<unknown>()
    const onChange = vi.fn()
    let writes = 0
    run.mockImplementation(async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
      if (name === 'google.mailMarkerPreferences') return { enabledOrder: ['yellow-star'] }
      if (name === 'google.setMailMarker' && writes++ === 0) return write.promise
      if (name === 'google.setMailMarker') throw new Error('refused')
      if (name === 'google.mailMarkerAnnotations') return annotations(null)
      if (name === 'google.search') return { threads: [{ id: 'thread' }] }
      return { ok: true, ...JSON.parse(paramsJson ?? '{}') }
    })
    const hook = renderHook(
      ({ remote, accountSub }: { remote: string; accountSub: string }) =>
        useMailMarkerActions({
          remote,
          accountSub,
          activeThreadId: null,
          reconcile: vi.fn(),
          onFailure: vi.fn(),
          onChange,
        }),
      { initialProps: { remote: 'vault-a', accountSub: 'account-a' } },
    )
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'google.mailMarkerPreferences' }),
      ),
    )
    act(() => hook.result.current.activate('thread', false, null))
    hook.rerender({ remote: 'vault-b', accountSub: 'account-b' })
    hook.rerender({ remote: 'vault-a', accountSub: 'account-a' })
    await waitFor(() =>
      expect(
        run.mock.calls.filter(
          ([input]) => (input as { name: string }).name === 'google.mailMarkerPreferences',
        ),
      ).toHaveLength(3),
    )
    const changes = onChange.mock.calls.length
    hook.unmount()
    await act(async () => write.resolve({ ok: true }))
    expect(onChange.mock.calls.length).toBe(changes)

    const external = renderHook(() =>
      useMailMarkerActions({ ...props, reconcile: vi.fn(), onFailure: vi.fn(), onChange }),
    )
    await waitFor(() =>
      expect(
        run.mock.calls.filter(
          ([input]) => (input as { name: string }).name === 'google.mailMarkerPreferences',
        ),
      ).toHaveLength(4),
    )
    act(() => external.result.current.activate('thread', true, null))
    await waitFor(() => expect(external.result.current.get('thread')?.starred).toBe(true))
    expect(external.result.current.get('thread')).toMatchObject({
      marker: null,
      starred: true,
      error: false,
    })
  })
})
