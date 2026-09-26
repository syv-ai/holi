/**
 * Reading the values Holi is actually painting.
 *
 * Resolution is deliberately not tested: jsdom returns `rgb(…)` where Chrome
 * keeps `oklch(…)`, so such a test would pass while the app wrote `#000000`.
 * Tested here: painted bytes to a valid value, literal tokens, no probe leak.
 */
import { expect, test } from 'vitest'
import { resolveThemeDefaults, themeValueFromPixel } from '../theme-defaults'

test('an opaque pixel becomes a hex', () => {
  // What `oklch(0.145 0 0)` (neutral-950) actually paints.
  expect(themeValueFromPixel([10, 10, 10, 255])).toBe('#0a0a0a')
  expect(themeValueFromPixel([139, 92, 246, 255])).toBe('#8b5cf6')
})

test('a translucent pixel keeps its alpha', () => {
  // `--selection` is 30% opaque; flattened it would paint over the text.
  expect(themeValueFromPixel([0, 103, 169, 77])).toBe('rgb(0 103 169 / 0.302)')
})

test('a fully transparent pixel is the keyword, not a black hex', () => {
  // A refused colour paints nothing; `#000000` would be a lie.
  expect(themeValueFromPixel([0, 0, 0, 0])).toBe('transparent')
})

test('an incomplete pixel is left out rather than guessed at', () => {
  expect(themeValueFromPixel([1, 2])).toBeNull()
})

test('returns null where colours cannot be resolved, rather than a partial answer', () => {
  // No 2D canvas: nothing trustworthy to write.
  expect(resolveThemeDefaults('dark')).toBeNull()
})

test('leaves no probe behind, even on the path that gives up', () => {
  // The probe attaches to `document.body`; the early return is the path most
  // likely to skip cleanup.
  const before = document.body.childElementCount
  expect(resolveThemeDefaults('dark')).toBeNull()
  expect(document.body.childElementCount).toBe(before)
})
