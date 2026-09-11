/**
 * Reading the values Holi is actually painting.
 *
 * **The resolution is not tested here, on purpose, and that is the lesson.**
 * jsdom hands computed colours back as `rgb(…)` while Chrome keeps them in
 * their own space (`oklch(…)`, `color(srgb …)`), so a test that appeared to
 * check resolution would assert jsdom's behaviour and pass while the real app
 * wrote `#000000` for every token. That bug existed and was caught by running
 * the code in the live window, not here.
 *
 * What belongs here is what is ours: turning painted bytes into a value the
 * validator accepts, the literal tokens, and the probe not leaking.
 */
import { afterEach, expect, test } from 'vitest'
import { resolveThemeDefaults, themeValueFromPixel } from '../theme-defaults'

const sheets: HTMLStyleElement[] = []
afterEach(() => {
  sheets.splice(0).forEach((s) => s.remove())
  document.documentElement.removeAttribute('style')
})

function declare(css: string): void {
  const el = document.createElement('style')
  el.textContent = css
  document.head.appendChild(el)
  sheets.push(el)
}

test('an opaque pixel becomes a hex', () => {
  // The bytes are what `oklch(0.145 0 0)` actually paints, measured in the
  // running app: Tailwind's neutral-950, which is #0a0a0a.
  expect(themeValueFromPixel([10, 10, 10, 255])).toBe('#0a0a0a')
  expect(themeValueFromPixel([139, 92, 246, 255])).toBe('#8b5cf6')
})

test('a translucent pixel keeps its alpha', () => {
  // `--selection` defaults to a 30%-opaque `color-mix`. Flattened to `#rrggbb`
  // it would paint over the text it is meant to sit behind, in every vault —
  // and `rgb(r g b / a)` is on the validator's list, so honest is also legal.
  expect(themeValueFromPixel([0, 103, 169, 77])).toBe('rgb(0 103 169 / 0.302)')
})

test('a fully transparent pixel is the keyword, not a black hex', () => {
  // A colour the engine refused paints nothing, and `#000000` would be a lie
  // about it — a token silently set to black in every vault.
  expect(themeValueFromPixel([0, 0, 0, 0])).toBe('transparent')
})

test('an incomplete pixel is left out rather than guessed at', () => {
  expect(themeValueFromPixel([1, 2])).toBeNull()
})

test('reads a length and a shadow as the literal they are', () => {
  // No resolution to ask for: a `color` round trip would turn these into
  // nonsense, so they come off the custom property directly.
  declare(`
    :root, [data-theme='dark'] {
      --radius: 0.75rem;
      --shadow-popover: 0 2px 8px rgb(0 0 0 / 0.4);
    }
  `)
  const out = resolveThemeDefaults('dark')
  expect(out.radius).toBe('0.75rem')
  expect(out['shadow-popover']).toBe('0 2px 8px rgb(0 0 0 / 0.4)')
})

test('leaves no probe behind', () => {
  // It attaches to `document.body` to resolve at all, so a leak would be one
  // stray node per vault open, forever.
  const before = document.body.childElementCount
  resolveThemeDefaults('dark')
  expect(document.body.childElementCount).toBe(before)
})
