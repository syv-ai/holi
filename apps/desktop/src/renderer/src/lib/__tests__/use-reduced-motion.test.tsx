import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useReducedMotion } from '@/lib/use-reduced-motion'

/**
 * A `matchMedia` we can actually change.
 *
 * `test/setup.dom.ts` installs a global stub that answers "no match" and whose
 * `addEventListener` is a no-op — enough for the editor stack to mount, useless
 * for testing a subscription. This one keeps its listeners so a test can flip
 * the setting the way an OS does.
 */
function installMatchMedia(initial: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  let matches = initial
  const removed: string[] = []
  const mql = {
    get matches() {
      return matches
    },
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => void listeners.add(fn),
    removeEventListener: (type: string, fn: (e: MediaQueryListEvent) => void) => {
      removed.push(type)
      listeners.delete(fn)
    },
    dispatchEvent: () => false,
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql),
  )
  return {
    set(next: boolean) {
      matches = next
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent)
    },
    listenerCount: () => listeners.size,
    removedTypes: () => removed,
  }
}

afterEach(() => vi.unstubAllGlobals())

test('reads the setting on mount', () => {
  installMatchMedia(false)
  expect(renderHook(() => useReducedMotion()).result.current).toBe(false)

  installMatchMedia(true)
  expect(renderHook(() => useReducedMotion()).result.current).toBe(true)
})

// The point of a hook rather than a one-shot read: the OS setting can change
// while the app is running, and the app should follow it without a reload.
test('follows the setting when it changes under the app', () => {
  const media = installMatchMedia(false)
  const { result } = renderHook(() => useReducedMotion())
  expect(result.current).toBe(false)

  act(() => media.set(true))
  expect(result.current).toBe(true)

  act(() => media.set(false))
  expect(result.current).toBe(false)
})

test('unsubscribes on unmount', () => {
  const media = installMatchMedia(false)
  const { unmount } = renderHook(() => useReducedMotion())
  expect(media.listenerCount()).toBe(1)

  unmount()
  expect(media.listenerCount()).toBe(0)
  expect(media.removedTypes()).toContain('change')
})

// Imported by editor code that also runs under plain Node, where `matchMedia`
// does not exist. Absent must read as "no preference", never as a throw.
test('survives a platform with no matchMedia', () => {
  vi.stubGlobal('matchMedia', undefined)
  expect(renderHook(() => useReducedMotion()).result.current).toBe(false)
})
