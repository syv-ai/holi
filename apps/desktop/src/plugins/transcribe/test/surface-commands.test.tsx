/**
 * The command menu's way to Meetings: Go to lists it always, since the nav is
 * not drawn, and opening it never starts a recording; Start meeting is the
 * action that records.
 */
import { atom, createStore } from 'jotai'
import { beforeEach, expect, test, vi } from 'vitest'
import { meetingMenuEntriesAtom, runMeetingMenuEntryAtom } from '../renderer/commands'
import { recorderAtom } from '../renderer/recorder'
import { MEETINGS_SURFACE } from '../renderer/state'

const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/trpc', () => ({
  trpc: { cap: { run: { mutate: (input: unknown) => run(input) } } },
}))
vi.mock('../renderer/audio/capture', () => ({ startCapture: vi.fn() }))
const opened = vi.hoisted(() => [] as string[])
vi.mock('@/plugin-api', async (original) => ({
  ...(await original<typeof import('@/plugin-api')>()),
  openSurfaceAtom: atom(null, (_get, _set, surface: string) => void opened.push(surface)),
}))

beforeEach(() => {
  run.mockReset()
  opened.length = 0
})

test('Meetings is under Go to while idle, beside Start meeting', () => {
  const store = createStore()
  const entries = store.get(meetingMenuEntriesAtom)
  expect(entries.map((e) => [e.id, e.group, e.label])).toEqual([
    ['open', 'go', 'Meetings'],
    ['start', 'action', 'Start meeting'],
  ])
})

test('going to Meetings opens the tab and records nothing', () => {
  const store = createStore()
  store.set(runMeetingMenuEntryAtom, 'open')
  expect(opened).toEqual([MEETINGS_SURFACE])
  expect(store.get(recorderAtom).phase).toBe('idle')
  expect(run).not.toHaveBeenCalled()
})

test('while recording, Go to Meetings says so', () => {
  const store = createStore()
  store.set(recorderAtom, { ...store.get(recorderAtom), phase: 'recording' })
  const open = store.get(meetingMenuEntriesAtom).find((e) => e.id === 'open')
  expect(open?.detail).toBe('Recording')
})
