import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { arrivalIndex, MOTION_STAGGER_CAP, staggerDelay } from '@/lib/motion'

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

/**
 * Which rows are actually NEW, which is the gate an arrival needs.
 *
 * An `animation` declared on a list's children replays on every re-render —
 * that is D92's file-open bug in a new costume, and it is why this is computed
 * from what changed rather than declared on the element.
 */
describe('arrivalIndex', () => {
  test('the first render animates nothing', () => {
    // The tree appearing because the app started, or because the vault
    // switched, is the shell's business. Two hundred rows arriving one after
    // another on every mount is noise, not life.
    expect(arrivalIndex(null, ['a', 'b', 'c']).size).toBe(0)
  })

  test('only the added ids arrive, numbered in the order they appear', () => {
    const got = arrivalIndex(['a', 'd'], ['a', 'b', 'c', 'd', 'e'])
    expect([...got]).toEqual([
      ['b', 0],
      ['c', 1],
      ['e', 2],
    ])
  })

  test('an unchanged list arrives nothing, however often it re-renders', () => {
    expect(arrivalIndex(['a', 'b'], ['a', 'b']).size).toBe(0)
  })

  test('reordering is not arriving', () => {
    expect(arrivalIndex(['a', 'b'], ['b', 'a']).size).toBe(0)
  })

  test('removals do not shift the numbering of what stayed', () => {
    expect([...arrivalIndex(['a', 'b', 'c'], ['a', 'z'])]).toEqual([['z', 0]])
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
  test.each(['--motion-stagger', '--motion-slide', '--ease-slide'])(
    '%s is declared outside @theme, where it cannot be tree-shaken',
    (token) => {
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
      const declared = new RegExp(`${token}\\s*:`)
      expect(themeBlocks.some((b) => declared.test(b))).toBe(false)
      expect(css).toMatch(declared)
    },
  )
})

/**
 * The ritual keeps its own motion, and its own trap.
 *
 * `.onboarding-ritual` redefines `--primary`, `--background`, `--border` and
 * the rest as bare HSL TRIPLETS, because that stylesheet applies alpha with
 * `hsl(var(--x) / a)`. `color-mix()` wants a <color>, so mixing from one of
 * those is invalid and the whole declaration is silently dropped — which is
 * exactly what had happened to the wake ring: it never drew, and only the
 * `scale()` halves of its keyframe ever ran. The full-colour aliases are the
 * `--color-*` pair the same block defines.
 */
test('the ritual mixes only from its full-colour aliases', () => {
  const css = readFileSync(
    fileURLToPath(
      new URL('../src/renderer/src/features/onboarding/onboarding-ritual.css', import.meta.url),
    ),
    'utf8',
  )
  const mixedTokens = [...css.matchAll(/color-mix\([^)]*?var\((--[\w-]+)\)/g)].map((m) => m[1])
  expect(mixedTokens.length).toBeGreaterThan(0)
  expect(mixedTokens.filter((t) => !t.startsWith('--color-'))).toEqual([])
})
