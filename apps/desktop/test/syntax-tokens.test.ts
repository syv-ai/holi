/**
 * Every syntax colour the code editor asks for is defined in **both** themes.
 *
 * A source scan, like `focus-treatment.test.ts`, and for the same reason a
 * render test would not do: an undefined `var(--syntax-x)` does not throw and
 * does not fall back to anything sensible. CodeMirror simply paints the
 * inherited colour, so a missing token shows up as "this one token is the same
 * colour as the text" in one theme only, which is exactly the class of bug that
 * shipped when these were hardcoded hexes tuned for dark.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (rel: string) => readFileSync(join(__dirname, '..', 'src', rel), 'utf8')

const css = src('renderer/src/index.css')
const editorTheme = src('renderer/src/editor/theme.ts')

/** The token names `editor/theme.ts` actually references. */
const referenced = [...editorTheme.matchAll(/var\(--(syntax-[a-z-]+)\)/g)].map((m) => m[1]!)

/** The custom properties declared inside one CSS block, by selector. */
function declaredIn(selector: string): Set<string> {
  const start = css.indexOf(selector)
  expect(start, `${selector} block not found`).toBeGreaterThan(-1)
  const end = css.indexOf('\n}', start)
  const block = css.slice(start, end)
  return new Set([...block.matchAll(/--(syntax-[a-z-]+)\s*:/g)].map((m) => m[1]!))
}

describe('syntax colour tokens', () => {
  it('the editor references some', () => {
    // Guards the guard: a refactor that stopped using tokens would otherwise
    // make every assertion below vacuously true.
    expect(referenced.length).toBeGreaterThan(5)
  })

  it('defines every referenced token in the dark theme', () => {
    const dark = declaredIn(":root,\n[data-theme='dark'] {")
    for (const name of referenced) expect([...dark]).toContain(name)
  })

  it('defines every referenced token in the light theme', () => {
    // The half that was missing. Light shipped with the editor still painting
    // 300-tint colours chosen to glow on near-black.
    const light = declaredIn("[data-theme='light'] {")
    for (const name of referenced) expect([...light]).toContain(name)
  })

  it('gives the two themes different values, not the same ramp twice', () => {
    const darkStart = css.indexOf(":root,\n[data-theme='dark'] {")
    const lightStart = css.indexOf("[data-theme='light'] {")
    const valuesIn = (from: number) => {
      const block = css.slice(from, css.indexOf('\n}', from))
      return Object.fromEntries(
        [...block.matchAll(/--(syntax-[a-z-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
      )
    }
    const dark = valuesIn(darkStart)
    const light = valuesIn(lightStart)
    // `comment` is deliberately the same mid-grey in both: it is the one colour
    // that reads on either surface. Everything else must move.
    const moved = referenced.filter((n) => dark[n] !== light[n])
    expect(moved.length).toBeGreaterThanOrEqual(referenced.length - 1)
  })

  it('leaves no hardcoded hex colours in the highlight style', () => {
    const style = editorTheme.slice(editorTheme.indexOf('HighlightStyle.define'))
    expect(style).not.toMatch(/color: '#[0-9a-f]{3,8}'/i)
  })
})
