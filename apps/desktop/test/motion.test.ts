import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { MOTION_STAGGER_CAP, staggerDelay } from '@/lib/motion'

describe('staggerDelay', () => {
  test('the first item has no delay', () => {
    expect(staggerDelay(0)).toBe('0ms')
  })

  test('each later item is one step further out', () => {
    expect(staggerDelay(1)).toBe('calc(var(--motion-stagger) * 1)')
    expect(staggerDelay(3)).toBe('calc(var(--motion-stagger) * 3)')
  })

  // The whole point of the cap: a folder with two hundred children must not
  // take nine seconds to open. Past the cap every remaining item arrives with
  // the capped one rather than queueing behind it.
  test('the ramp is capped, so a long list does not queue', () => {
    expect(staggerDelay(MOTION_STAGGER_CAP)).toBe(
      `calc(var(--motion-stagger) * ${MOTION_STAGGER_CAP})`,
    )
    expect(staggerDelay(40)).toBe(`calc(var(--motion-stagger) * ${MOTION_STAGGER_CAP})`)
    expect(staggerDelay(4000)).toBe(staggerDelay(MOTION_STAGGER_CAP))
  })

  test('an explicit cap overrides the default', () => {
    expect(staggerDelay(9, { cap: 2 })).toBe('calc(var(--motion-stagger) * 2)')
  })

  test('reduced motion flattens the ramp entirely', () => {
    expect(staggerDelay(5, { reduced: true })).toBe('0ms')
    expect(staggerDelay(0, { reduced: true })).toBe('0ms')
  })

  // A caller mapping over a list can hand us anything; none of it should
  // produce a negative delay, which browsers read as "already part-played".
  test('nonsense indexes are floored rather than trusted', () => {
    expect(staggerDelay(-3)).toBe('0ms')
    expect(staggerDelay(2.7)).toBe('calc(var(--motion-stagger) * 2)')
    expect(staggerDelay(Number.NaN)).toBe('0ms')
  })
})

// ── Guards over the vocabulary itself ─────────────────────────────────
// index.css is the single source for every number in the app's motion. These
// three failures are all silent in a browser — an unknown animation name is
// not an error, it simply does nothing — so they are worth catching in CI.
describe('index.css is the one motion vocabulary', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../src/renderer/src/index.css', import.meta.url)),
    'utf8',
  )

  test('the size-named duration tier is gone', () => {
    expect(css).not.toMatch(/--duration-(micro|base|enter)\s*:/)
  })

  test('every animation named in the file has a keyframe to run', () => {
    const referenced = [
      ...css.matchAll(/animation:\s*([A-Za-z][\w-]*)/g),
      ...css.matchAll(/--animate-[\w-]+:\s*([A-Za-z][\w-]*)/g),
    ]
      .map((m) => m[1])
      // `animation: none` in the reduced-motion block is a keyword, not a name.
      .filter((name) => !['none', 'inherit', 'initial', 'unset', 'revert'].includes(name))
    const defined = new Set([...css.matchAll(/@keyframes\s+([A-Za-z][\w-]*)/g)].map((m) => m[1]))
    expect(referenced.length).toBeGreaterThan(0)
    expect([...new Set(referenced)].filter((name) => !defined.has(name))).toEqual([])
  })

  // Regression guard for a measured trap: Tailwind v4 emits the `@theme`
  // variables the CSS references and drops the rest. `--motion-stagger`'s only
  // consumer is staggerDelay() above, which builds its calc() at runtime, so in
  // `@theme` it was tree-shaken out of the built stylesheet entirely and the
  // stagger silently resolved to nothing.
  test('--motion-stagger is declared outside @theme, where it cannot be tree-shaken', () => {
    const themeBlocks = [...css.matchAll(/@theme\s*\{/g)].map((m) => {
      let depth = 0
      let i = m.index + m[0].length - 1
      do {
        if (css[i] === '{') depth++
        else if (css[i] === '}') depth--
        i++
      } while (depth > 0 && i < css.length)
      return css.slice(m.index, i)
    })
    expect(themeBlocks.some((b) => /--motion-stagger\s*:/.test(b))).toBe(false)
    expect(css).toMatch(/--motion-stagger\s*:/)
  })
})
