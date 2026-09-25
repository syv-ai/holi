/**
 * The history sidebar slides out before it unmounts: the close is held for the
 * slide token, the pane-exit pattern, and a reopen mid-exit cancels it.
 */
import { createStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('../src/renderer/src/lib/motion', () => ({
  prefersReducedMotion: () => motion.reduced,
  motionDurationMs: () => 400,
}))
vi.mock('../src/renderer/src/lib/trpc', () => ({ trpc: {} }))

import {
  historyLeavingAtom,
  historyOpenAtom,
  setHistoryOpenAtom,
} from '../src/renderer/src/state/history'

beforeEach(() => {
  vi.useFakeTimers()
  motion.reduced = false
})
afterEach(() => vi.useRealTimers())

function opened() {
  const store = createStore()
  store.set(setHistoryOpenAtom, true)
  return store
}

describe('setHistoryOpenAtom', () => {
  it('opens at once', () => {
    const store = opened()
    expect(store.get(historyOpenAtom)).toBe(true)
    expect(store.get(historyLeavingAtom)).toBe(false)
  })

  it('closes after the slide, leaving meanwhile', () => {
    const store = opened()
    store.set(setHistoryOpenAtom, false)
    expect(store.get(historyOpenAtom)).toBe(true)
    expect(store.get(historyLeavingAtom)).toBe(true)

    vi.advanceTimersByTime(400)
    expect(store.get(historyOpenAtom)).toBe(false)
    expect(store.get(historyLeavingAtom)).toBe(false)
  })

  it('a reopen during the exit cancels the close', () => {
    const store = opened()
    store.set(setHistoryOpenAtom, false)
    vi.advanceTimersByTime(200)
    store.set(setHistoryOpenAtom, true)
    expect(store.get(historyLeavingAtom)).toBe(false)

    vi.advanceTimersByTime(400)
    expect(store.get(historyOpenAtom)).toBe(true)
  })

  it('under reduced motion there is nothing to wait for', () => {
    motion.reduced = true
    const store = opened()
    store.set(setHistoryOpenAtom, false)
    expect(store.get(historyOpenAtom)).toBe(false)
  })
})
