import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

// ── Guards over the vocabulary itself ─────────────────────────────────
// index.css is the single source for every number in the app's motion. These
// three failures are all silent in a browser — an unknown animation name is
// not an error, it simply does nothing — so they are worth catching in CI.
describe('index.css is the one motion vocabulary', () => {
  const css = readFileSync(join(__dirname, '../../index.css'), 'utf8')

  test('the size-named duration tier is gone', () => {
    expect(css).not.toMatch(/--duration-(micro|base|enter)\s*:/)
  })

  test('every animation named in the file has a keyframe to run', () => {
    const referenced = [
      ...css.matchAll(/animation:\s*([A-Za-z][\w-]*)/g),
      ...css.matchAll(/--animate-[\w-]+:\s*([A-Za-z][\w-]*)/g),
    ]
      .map((m) => m[1]!)
      // `animation: none` in the reduced-motion block is a keyword, not a name.
      .filter((name) => !['none', 'inherit', 'initial', 'unset', 'revert'].includes(name))
    const defined = new Set([...css.matchAll(/@keyframes\s+([A-Za-z][\w-]*)/g)].map((m) => m[1]!))
    expect(referenced.length).toBeGreaterThan(0)
    expect([...new Set(referenced)].filter((name) => !defined.has(name))).toEqual([])
  })

  // Regression guard for a measured trap: Tailwind v4 emits the `@theme`
  // variables the CSS references and drops the rest. `--motion-stagger`'s only
  // consumer builds its calc() at runtime, so in
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
