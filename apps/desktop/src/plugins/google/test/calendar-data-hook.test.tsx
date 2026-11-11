import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useGoogleCalendar } from '../renderer/calendar-data'

const agenda = vi.fn()
const schedule = vi.fn()
const setCalendar = vi.fn()
const calendarMethods: Record<string, (params: Record<string, unknown>) => unknown> = {
  'google.agenda': (params) => agenda(params),
  'google.agendaCached': () => null,
  'google.calendars': () => [],
  'google.schedule': (params) => schedule(params),
  'google.setCalendar': (params) => setCalendar(params),
  'google.reschedule': () => ({ ok: true }),
  'google.unschedule': () => ({ ok: true }),
}
vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      run: {
        mutate: async ({
          name,
          remote,
          paramsJson,
        }: {
          name: string
          remote: string
          paramsJson?: string
        }) => {
          const method = calendarMethods[name]
          if (method === undefined) throw new Error(`Unexpected capability ${name}`)
          return method({
            remote,
            ...(JSON.parse(paramsJson ?? '{}') as Record<string, unknown>),
          })
        },
      },
    },
  },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const range = { start: new Date(2026, 8, 7), end: new Date(2026, 8, 14) }

afterEach(() => {
  agenda.mockReset().mockResolvedValue([])
  schedule.mockReset().mockResolvedValue({ id: 'new' })
  setCalendar.mockReset().mockResolvedValue({ ok: true })
})

describe('useGoogleCalendar context fencing', () => {
  test('a write completion reloads the latest visible range, not the range it started in', async () => {
    const write = deferred<{ id: string }>()
    schedule.mockReturnValueOnce(write.promise)
    agenda.mockResolvedValue([])
    const { result } = renderHook(() => useGoogleCalendar('account-a', 'person-a'))
    act(() => result.current.showRange(range))
    await waitFor(() => expect(agenda).toHaveBeenCalledTimes(1))
    let create!: Promise<void>
    act(() => {
      create = result.current.create({
        title: 'Saved event',
        location: '',
        start: new Date(2026, 8, 7, 9),
        end: new Date(2026, 8, 7, 10),
        allDay: false,
      })
    })

    const nextRange = { start: new Date(2026, 8, 14), end: new Date(2026, 8, 21) }
    act(() => result.current.showRange(nextRange))
    await waitFor(() => expect(agenda).toHaveBeenCalledTimes(2))
    const currentRange = agenda.mock.calls[1]![0] as { from: string; to: string }
    await act(async () => {
      write.resolve({ id: 'saved' })
      await create
    })

    await waitFor(() => expect(agenda).toHaveBeenCalledTimes(3))
    expect(agenda.mock.calls[2]![0]).toEqual(currentRange)
  })

  test('a completed write in the old remote cannot start a stale reload', async () => {
    const write = deferred<{ id: string }>()
    const oldRead = deferred<never[]>()
    schedule.mockReturnValueOnce(write.promise)
    agenda.mockImplementation((params: { remote: string }) =>
      params.remote.includes('account-b') ? Promise.resolve([{ id: 'b' }]) : oldRead.promise,
    )
    const { result, rerender } = renderHook(
      ({ remote, account }: { remote: string; account: string }) =>
        useGoogleCalendar(remote, account),
      { initialProps: { remote: 'account-a', account: 'person-a' } },
    )
    act(() => result.current.showRange(range))
    await waitFor(() => expect(agenda).toHaveBeenCalled())
    let create!: Promise<void>
    act(() => {
      create = result.current.create({
        title: 'Old account',
        location: '',
        start: new Date(2026, 8, 7, 9),
        end: new Date(2026, 8, 7, 10),
        allDay: false,
      })
    })
    rerender({ remote: 'account-b', account: 'person-b' })
    await waitFor(() =>
      expect(agenda.mock.calls.some(([params]) => params.remote === 'account-b')).toBe(true),
    )
    const currentCalls = agenda.mock.calls.length
    await act(async () => {
      write.resolve({ id: 'new' })
      await create
    })
    await waitFor(() => expect(agenda).toHaveBeenCalledTimes(currentCalls))
    expect(agenda.mock.calls.at(-1)?.[0]).toMatchObject({ remote: 'account-b' })
  })

  test('an old calendar toggle cannot invalidate the current remote’s pending read', async () => {
    const toggle = deferred<{ ok: boolean }>()
    const currentRead = deferred<{ id: string }[]>()
    setCalendar.mockReturnValueOnce(toggle.promise)
    agenda.mockImplementation((params: { remote: string }) =>
      params.remote === 'account-a' ? Promise.resolve([{ id: 'old' }]) : currentRead.promise,
    )
    const { result, rerender } = renderHook(
      ({ remote }: { remote: string }) => useGoogleCalendar(remote, remote),
      { initialProps: { remote: 'account-a' } },
    )
    act(() => result.current.showRange(range))
    await waitFor(() => expect(result.current.events).toEqual([{ id: 'old' }]))
    act(() => result.current.setCalendarEnabled('primary', false))
    rerender({ remote: 'account-b' })
    await waitFor(() => expect(agenda).toHaveBeenCalledTimes(2))
    await act(async () => toggle.resolve({ ok: true }))
    expect(agenda).toHaveBeenCalledTimes(2)
    await act(async () => currentRead.resolve([{ id: 'current' }]))
    expect(result.current.events).toEqual([{ id: 'current' }])
    expect(result.current.loading).toBe(false)
  })

  test('a response started for the prior account cannot replace current events', async () => {
    const oldRead = deferred<never[]>()
    agenda.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce([{ id: 'current' }])
    const { result, rerender } = renderHook(
      ({ account }: { account: string }) => useGoogleCalendar('same-vault', account),
      { initialProps: { account: 'person-a' } },
    )
    act(() => result.current.showRange(range))
    rerender({ account: 'person-b' })
    await waitFor(() => expect(agenda).toHaveBeenCalledTimes(2))
    oldRead.resolve([{ id: 'stale' }] as never[])
    await act(async () => Promise.resolve())
    expect(result.current.events).toEqual([{ id: 'current' }])
  })
})
