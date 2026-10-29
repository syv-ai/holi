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

const css = readFileSync(join(__dirname, '../../index.css'), 'utf8')
const editorTheme = readFileSync(join(__dirname, '../theme.ts'), 'utf8')

/** The token names `editor/theme.ts` actually references. */
const referenced = [...editorTheme.matchAll(/var\(--(syntax-[a-z-]+)\)/g)].map((m) => m[1]!)

/**
 * The `--syntax-*` values declared under one selector, across every block
 * with that selector (index.css has several `:root` blocks). Light is `:root`,
 * dark is `[data-theme='dark']`, as for every other token.
 */
function valuesUnder(selector: string): Record<string, string> {
  const blocks = [...css.matchAll(/(?:^|\n)([^\n{}]+)\{([^}]*)\}/g)].filter(
    (m) => m[1]!.trim() === selector,
  )
  expect(blocks.length, `${selector} block not found`).toBeGreaterThan(0)
  return Object.fromEntries(
    blocks.flatMap((m) =>
      [...m[2]!.matchAll(/--(syntax-[a-z-]+)\s*:\s*([^;]+);/g)].map((v) => [v[1]!, v[2]!.trim()]),
    ),
  )
}

describe('syntax colour tokens', () => {
  it('the editor references some', () => {
    // Guards the guard: a refactor that stopped using tokens would otherwise
    // make every assertion below vacuously true.
    expect(referenced.length).toBeGreaterThan(5)
  })

  it('defines every referenced token in the dark theme', () => {
    const dark = Object.keys(valuesUnder("[data-theme='dark']"))
    for (const name of referenced) expect(dark).toContain(name)
  })

  it('defines every referenced token in the light theme', () => {
    // The half that was missing. Light shipped with the editor still painting
    // 300-tint colours chosen to glow on near-black.
    const light = Object.keys(valuesUnder(':root'))
    for (const name of referenced) expect(light).toContain(name)
  })

  it('gives the two themes different values, not the same ramp twice', () => {
    const dark = valuesUnder("[data-theme='dark']")
    const light = valuesUnder(':root')
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
