/**
 * The hook that reads a session's conversation: it polls, folds only what is
 * new, reads earlier parts and sub-agents on demand, and starts over on a
 * `/clear`.
 */
import { act, renderHook } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { activeRemoteAtom } from '@/plugin-api'
import { useTranscript } from '../renderer/chat/use-transcript'
import type { ChatEntry } from '../renderer/chat/items'

const cap = vi.hoisted(() => ({
  transcript: vi.fn(),
  transcriptEarlier: vi.fn(),
  subagent: vi.fn(),
}))
vi.mock('../renderer/agent-cap', () => ({
  agentCap: {
    transcript: (_remote: string, args: unknown) => cap.transcript(args),
    transcriptEarlier: (_remote: string, args: unknown) => cap.transcriptEarlier(args),
    subagent: (_remote: string, args: unknown) => cap.subagent(args),
  },
}))

const user = (id: string): ChatEntry => ({ kind: 'user', id, text: id })
const call = (id: string): ChatEntry => ({
  kind: 'tool',
  id,
  name: 'Bash',
  summary: id,
  args: {},
})
const done = (id: string): ChatEntry => ({ kind: 'tool-result', id, ok: true, text: 'ok' })

function setup(busy = false, sessionId = 's1') {
  const store = createStore()
  store.set(activeRemoteAtom, 'remote')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  return renderHook(
    (props: { sessionId: string; busy: boolean }) => useTranscript(props.sessionId, props.busy),
    {
      wrapper,
      initialProps: { sessionId, busy },
    },
  )
}

/** Lets the pending reads settle without moving the clock past a tick. */
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)))
const tickFor = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

beforeEach(() => {
  vi.useFakeTimers()
  for (const fn of Object.values(cap)) fn.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('polling', () => {
  test('reads from the tail first, then from the offset it was given', async () => {
    cap.transcript.mockResolvedValueOnce({
      sessionId: 'c1',
      offset: 10,
      start: 0,
      entries: [user('u1'), call('a')],
    })
    cap.transcript.mockResolvedValue({ sessionId: 'c1', offset: 20, entries: [done('a')] })
    const { result } = setup(true)
    await settle()
    expect(cap.transcript).toHaveBeenLastCalledWith({ id: 's1' })
    expect(result.current.loaded).toBe(true)
    expect(result.current.items).toHaveLength(2)
    await tickFor(900)
    expect(cap.transcript).toHaveBeenLastCalledWith({ id: 's1', offset: 10 })
    const tool = result.current.items[1]
    expect(tool).toMatchObject({ kind: 'tool', state: 'done' })
  })

  test('a busy session is looked at faster than a quiet one', async () => {
    cap.transcript.mockResolvedValue({ sessionId: 'c1', offset: 1, start: 0, entries: [] })
    const quiet = setup(false)
    await settle()
    expect(cap.transcript).toHaveBeenCalledTimes(1)
    await tickFor(1000)
    expect(cap.transcript).toHaveBeenCalledTimes(1)
    await tickFor(1600)
    expect(cap.transcript).toHaveBeenCalledTimes(2)
    quiet.unmount()
    cap.transcript.mockClear()
    setup(true)
    await settle()
    await tickFor(1000)
    expect(cap.transcript).toHaveBeenCalledTimes(2)
  })

  test('nothing new keeps the very same items, and refresh looks at once', async () => {
    cap.transcript.mockResolvedValueOnce({
      sessionId: 'c1',
      offset: 5,
      start: 0,
      entries: [user('u1')],
    })
    cap.transcript.mockResolvedValue({ sessionId: 'c1', offset: 5, entries: [] })
    const { result } = setup(true)
    await settle()
    const items = result.current.items
    const ctx = result.current.ctx
    await tickFor(900)
    expect(cap.transcript).toHaveBeenCalledTimes(2)
    expect(result.current.items).toBe(items)
    expect(result.current.ctx).toBe(ctx)
    act(() => result.current.refresh())
    await settle()
    expect(cap.transcript).toHaveBeenCalledTimes(3)
  })

  test('a failed read shows its error and the next good one clears it', async () => {
    cap.transcript.mockRejectedValueOnce(new Error('boom'))
    cap.transcript.mockResolvedValue({ sessionId: 'c1', offset: 1, start: 0, entries: [] })
    const { result } = setup(true)
    await settle()
    expect(result.current.error).toContain('boom')
    expect(result.current.loaded).toBe(true)
    await tickFor(900)
    expect(result.current.error).toBeNull()
  })

  test('a replayed entry is not shown twice, and only the changed tool is a new object', async () => {
    cap.transcript.mockResolvedValueOnce({
      sessionId: 'c1',
      offset: 5,
      start: 0,
      entries: [user('u1'), call('a'), call('b')],
    })
    cap.transcript.mockResolvedValueOnce({
      sessionId: 'c1',
      offset: 9,
      entries: [user('u1'), done('b')],
    })
    const { result } = setup(true)
    await settle()
    const before = result.current.items
    await tickFor(900)
    const after = result.current.items
    expect(after.map((i) => i.id)).toEqual(['u1', 'a', 'b'])
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(after[2]).not.toBe(before[2])
  })
})

describe('a file rewritten under the reader', () => {
  const at = (text: string): ChatEntry => ({ kind: 'user', id: 'L0', text })

  test('replaces what it holds instead of adding to it, and drops its caches', async () => {
    cap.transcript.mockResolvedValueOnce({
      sessionId: 'c1',
      offset: 10,
      start: 4,
      fingerprint: 'fp1',
      entries: [at('old'), call('a')],
    })
    // Same id as before (a line with no uuid is named by its offset).
    cap.transcript.mockResolvedValueOnce({
      sessionId: 'c1',
      offset: 6,
      start: 0,
      fingerprint: 'fp2',
      reset: true,
      entries: [at('new')],
    })
    cap.transcript.mockResolvedValue({
      sessionId: 'c1',
      offset: 6,
      fingerprint: 'fp2',
      entries: [],
    })
    const { result } = setup(true)
    await settle()
    expect(result.current.items).toHaveLength(2)
    expect(result.current.canLoadEarlier).toBe(true)
    await tickFor(900)
    expect(cap.transcript).toHaveBeenLastCalledWith({ id: 's1', offset: 10, fingerprint: 'fp1' })
    expect(result.current.items).toEqual([expect.objectContaining({ id: 'L0', text: 'new' })])
    expect(result.current.canLoadEarlier).toBe(false)
    await tickFor(900)
    expect(cap.transcript).toHaveBeenLastCalledWith({ id: 's1', offset: 6, fingerprint: 'fp2' })
    expect(result.current.items).toHaveLength(1)
  })

  test('forgets the sub-agents it had read', async () => {
    cap.transcript.mockResolvedValueOnce({ sessionId: 'c1', offset: 10, start: 0, entries: [] })
    cap.transcript.mockResolvedValueOnce({
      sessionId: 'c1',
      offset: 6,
      start: 0,
      reset: true,
      entries: [],
    })
    cap.transcript.mockResolvedValue({ sessionId: 'c1', offset: 6, entries: [] })
    cap.subagent.mockResolvedValue({ sessionId: 'c1', offset: 3, entries: [user('s1')] })
    const { result } = setup(true)
    await settle()
    await act(async () => void (await result.current.loadSubagent('ag1')))
    cap.subagent.mockClear()
    await tickFor(900)
    await act(async () => void (await result.current.loadSubagent('ag1')))
    expect(cap.subagent.mock.calls[0]![0]).toEqual({ id: 's1', agentId: 'ag1' })
  })

  test('an earlier part that was being read for the old file is not added to the new', async () => {
    cap.transcript.mockResolvedValueOnce({ sessionId: 'c1', offset: 100, start: 60, entries: [] })
    cap.transcript.mockResolvedValueOnce({
      sessionId: 'c1',
      offset: 8,
      start: 0,
      reset: true,
      entries: [user('n1')],
    })
    cap.transcript.mockResolvedValue({ sessionId: 'c1', offset: 8, entries: [] })
    let release: (v: unknown) => void = () => {}
    cap.transcriptEarlier.mockReturnValue(new Promise((r) => (release = r)))
    const { result } = setup(true)
    await settle()
    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = result.current.loadEarlier()
    })
    await tickFor(900)
    await act(async () => {
      release({ start: 0, entries: [user('old')] })
      await pending
    })
    expect(result.current.items.map((i) => i.id)).toEqual(['n1'])
  })
})

describe('a /clear', () => {
  test('starts over from the new conversation', async () => {
    cap.transcript.mockResolvedValueOnce({
      sessionId: 'c1',
      offset: 5,
      start: 0,
      entries: [user('old')],
    })
    cap.transcript.mockResolvedValueOnce({ sessionId: 'c2', offset: 8, entries: [user('x')] })
    cap.transcript.mockResolvedValueOnce({
      sessionId: 'c2',
      offset: 3,
      start: 0,
      entries: [user('new')],
    })
    const { result } = setup(true)
    await settle()
    expect(result.current.items.map((i) => i.id)).toEqual(['old'])
    await tickFor(900)
    await tickFor(10)
    // Read again
    expect(cap.transcript).toHaveBeenLastCalledWith({ id: 's1' })
    expect(result.current.items.map((i) => i.id)).toEqual(['new'])
  })

  test('another session id resets the chat', async () => {
    cap.transcript.mockResolvedValue({
      sessionId: 'c1',
      offset: 1,
      start: 0,
      entries: [user('u1')],
    })
    const { result, rerender } = setup(false, 's1')
    await settle()
    expect(result.current.items).toHaveLength(1)
    cap.transcript.mockResolvedValue({ sessionId: 'c9', offset: 1, start: 0, entries: [user('z')] })
    rerender({ sessionId: 's2', busy: false })
    await settle()
    expect(cap.transcript).toHaveBeenLastCalledWith({ id: 's2' })
    expect(result.current.items.map((i) => i.id)).toEqual(['z'])
  })
})

describe('earlier history', () => {
  const first = {
    sessionId: 'c1',
    offset: 100,
    start: 60,
    entries: [done('a'), user('u2')],
    drift: { lines: 2, unknown: [{ shape: 'x', count: 1 }], oversize: 0, unparseable: 0 },
  }

  test('is offered while the first read began past the file start', async () => {
    cap.transcript.mockResolvedValue({ ...first, entries: [] })
    const { result } = setup()
    await settle()
    expect(result.current.canLoadEarlier).toBe(true)
    cap.transcript.mockResolvedValue({ sessionId: 'c1', offset: 1, start: 0, entries: [] })
  })

  test('is prepended, completes a pair across the boundary, and moves the start', async () => {
    cap.transcript.mockResolvedValue({ ...first, entries: first.entries })
    cap.transcriptEarlier.mockResolvedValue({
      start: 0,
      entries: [user('u1'), call('a')],
      drift: { lines: 5, unknown: [{ shape: 'x', count: 2 }], oversize: 1, unparseable: 0 },
    })
    const { result } = setup()
    await settle()
    expect(result.current.items[0]).toMatchObject({ orphan: true })
    await act(async () => {
      await result.current.loadEarlier()
    })
    expect(cap.transcriptEarlier).toHaveBeenCalledWith({ id: 's1', before: 60 })
    expect(result.current.items.map((i) => i.id)).toEqual(['u1', 'a', 'u2'])
    expect(result.current.items[1]).toMatchObject({ state: 'done', name: 'Bash' })
    expect(result.current.canLoadEarlier).toBe(false)
    expect(result.current.drift).toEqual({
      unknownShapes: [{ shape: 'x', count: 3 }],
      total: 7,
      oversize: 1,
      unparseable: 0,
    })
  })

  test('is one read at a time', async () => {
    cap.transcript.mockResolvedValue({ ...first, entries: [] })
    let release: (v: unknown) => void = () => {}
    cap.transcriptEarlier.mockReturnValue(new Promise((r) => (release = r)))
    const { result } = setup()
    await settle()
    let p1: Promise<void> = Promise.resolve()
    let p2: Promise<void> = Promise.resolve()
    act(() => {
      p1 = result.current.loadEarlier()
      p2 = result.current.loadEarlier()
    })
    expect(cap.transcriptEarlier).toHaveBeenCalledTimes(1)
    expect(result.current.loadingEarlier).toBe(true)
    await act(async () => {
      release({ start: 20, entries: [user('u0')] })
      await Promise.all([p1, p2])
    })
    expect(result.current.loadingEarlier).toBe(false)
    expect(result.current.canLoadEarlier).toBe(true)
    cap.transcriptEarlier.mockResolvedValue({ start: 0, entries: [] })
    await act(async () => {
      await result.current.loadEarlier()
    })
    expect(cap.transcriptEarlier).toHaveBeenLastCalledWith({ id: 's1', before: 20 })
    expect(result.current.canLoadEarlier).toBe(false)
  })

  test('is not read when there is nothing earlier', async () => {
    cap.transcript.mockResolvedValue({ sessionId: 'c1', offset: 3, start: 0, entries: [] })
    const { result } = setup()
    await settle()
    await act(async () => {
      await result.current.loadEarlier()
    })
    expect(cap.transcriptEarlier).not.toHaveBeenCalled()
  })

  test('a failed read leaves things as they were, to try again', async () => {
    cap.transcript.mockResolvedValue({ ...first, entries: [] })
    cap.transcriptEarlier.mockRejectedValueOnce(new Error('no'))
    const { result } = setup()
    await settle()
    await act(async () => {
      await result.current.loadEarlier()
    })
    expect(result.current.canLoadEarlier).toBe(true)
    expect(result.current.loadingEarlier).toBe(false)
  })
})

describe('the polling loop', () => {
  test('goes on after a read it could not make sense of', async () => {
    cap.transcript.mockResolvedValueOnce({
      sessionId: 'c1',
      offset: 5,
      start: 0,
      entries: [null],
    })
    cap.transcript.mockResolvedValue({
      sessionId: 'c1',
      offset: 9,
      entries: [user('u1')],
    })
    const { result } = setup(true)
    await settle()
    await tickFor(900)
    expect(cap.transcript).toHaveBeenCalledTimes(2)
    expect(result.current.items.map((i) => i.id)).toEqual(['u1'])
  })

  test('does nothing more once the hook is gone, even for a read still on its way', async () => {
    let release: (v: unknown) => void = () => {}
    cap.transcript.mockReturnValue(new Promise((r) => (release = r)))
    const { unmount } = setup(true)
    await settle()
    unmount()
    await act(async () => {
      release({ sessionId: 'c1', offset: 5, start: 0, entries: [user('u1')] })
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(cap.transcript).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a sub-agent read stops reading once the hook is gone', async () => {
    cap.transcript.mockResolvedValue({ sessionId: 'c1', offset: 1, start: 0, entries: [] })
    let release: (v: unknown) => void = () => {}
    cap.subagent.mockReturnValue(new Promise((r) => (release = r)))
    const { result, unmount } = setup()
    await settle()
    let pending: Promise<unknown> = Promise.resolve()
    act(() => {
      pending = result.current.loadSubagent('ag1')
    })
    unmount()
    await act(async () => {
      release({ sessionId: 'c1', offset: 10, entries: [user('s1')] })
      await pending
    })
    expect(cap.subagent).toHaveBeenCalledTimes(1)
  })
})

describe('a sub-agent', () => {
  beforeEach(() => {
    cap.transcript.mockResolvedValue({ sessionId: 'c1', offset: 1, start: 0, entries: [] })
  })

  test('is read from its start until nothing new comes, and folded', async () => {
    cap.subagent
      .mockResolvedValueOnce({ sessionId: 'c1', offset: 10, entries: [user('s1'), call('t')] })
      .mockResolvedValueOnce({ sessionId: 'c1', offset: 20, entries: [done('t')] })
      .mockResolvedValueOnce({ sessionId: 'c1', offset: 20, entries: [] })
    const { result } = setup()
    await settle()
    let items: unknown
    await act(async () => {
      items = await result.current.loadSubagent('ag1')
    })
    expect(cap.subagent.mock.calls.map((c) => c[0])).toEqual([
      // The first read has no offset: main takes the bounded tail of the file.
      { id: 's1', agentId: 'ag1' },
      { id: 's1', agentId: 'ag1', offset: 10 },
      { id: 's1', agentId: 'ag1', offset: 20 },
    ])
    expect(items).toEqual([
      expect.objectContaining({ kind: 'user' }),
      expect.objectContaining({ kind: 'tool', state: 'done' }),
    ])
  })

  test('asked again continues where it stopped and keeps unchanged items', async () => {
    cap.subagent.mockResolvedValueOnce({ sessionId: 'c1', offset: 10, entries: [user('s1')] })
    cap.subagent.mockResolvedValueOnce({ sessionId: 'c1', offset: 10, entries: [] })
    const { result } = setup()
    await settle()
    let first: unknown[] | null = null
    await act(async () => {
      first = await result.current.loadSubagent('ag1')
    })
    cap.subagent.mockResolvedValueOnce({ sessionId: 'c1', offset: 15, entries: [user('s2')] })
    cap.subagent.mockResolvedValueOnce({ sessionId: 'c1', offset: 15, entries: [] })
    let again: unknown[] | null = null
    await act(async () => {
      again = await result.current.loadSubagent('ag1')
    })
    expect(cap.subagent).toHaveBeenLastCalledWith({ id: 's1', agentId: 'ag1', offset: 15 })
    expect(again).toHaveLength(2)
    expect(again![0]).toBe(first![0])
  })

  test('sends back what main said of the file, and starts over when it was rewritten', async () => {
    cap.subagent
      .mockResolvedValueOnce({
        sessionId: 'c1',
        offset: 10,
        start: 5,
        fingerprint: 'f1',
        entries: [user('s1')],
      })
      .mockResolvedValueOnce({ sessionId: 'c1', offset: 10, fingerprint: 'f1', entries: [] })
    const { result } = setup()
    await settle()
    await act(async () => void (await result.current.loadSubagent('ag1')))
    expect(cap.subagent.mock.calls.map((c) => c[0])).toEqual([
      { id: 's1', agentId: 'ag1' },
      { id: 's1', agentId: 'ag1', offset: 10, fingerprint: 'f1' },
    ])
    cap.subagent.mockResolvedValueOnce({
      sessionId: 'c1',
      offset: 4,
      start: 0,
      fingerprint: 'f2',
      reset: true,
      entries: [user('n1')],
    })
    cap.subagent.mockResolvedValueOnce({
      sessionId: 'c1',
      offset: 4,
      fingerprint: 'f2',
      entries: [],
    })
    let items: unknown
    await act(async () => {
      items = await result.current.loadSubagent('ag1')
    })
    expect(items).toEqual([expect.objectContaining({ id: 'n1' })])
  })

  test('is null when it cannot be read', async () => {
    cap.subagent.mockResolvedValue(null)
    const { result } = setup()
    await settle()
    let items: unknown = 'unset'
    await act(async () => {
      items = await result.current.loadSubagent('gone')
    })
    expect(items).toBeNull()
    cap.subagent.mockRejectedValue(new Error('x'))
    await act(async () => {
      items = await result.current.loadSubagent('broken')
    })
    expect(items).toBeNull()
  })

  test('stops at 20 reads', async () => {
    let offset = 0
    cap.subagent.mockImplementation(() => {
      offset += 1
      return Promise.resolve({ sessionId: 'c1', offset, entries: [user(`m${offset}`)] })
    })
    const { result } = setup()
    await settle()
    await act(async () => {
      await result.current.loadSubagent('long')
    })
    expect(cap.subagent).toHaveBeenCalledTimes(20)
  })

  test('the context hands rows the same loader and the task list', async () => {
    cap.transcript.mockResolvedValue({
      sessionId: 'c1',
      offset: 4,
      start: 0,
      entries: [
        { kind: 'tool', id: 'c', name: 'TaskCreate', summary: '', args: { subject: 'Do it' } },
        {
          kind: 'tool-result',
          id: 'c',
          ok: true,
          text: 'Task #1 created successfully: Do it',
          data: { task: { id: '1', subject: 'Do it' } },
        },
      ],
    })
    const { result } = setup()
    await settle()
    expect(result.current.ctx.sessionId).toBe('s1')
    expect(result.current.ctx.loadSubagent).toBe(result.current.loadSubagent)
    expect([...result.current.ctx.tasks.values()]).toEqual([
      { id: '1', subject: 'Do it', status: 'pending' },
    ])
    expect(result.current.tasks).toBe(result.current.ctx.tasks)
  })
})
