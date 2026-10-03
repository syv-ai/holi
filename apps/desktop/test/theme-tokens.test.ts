import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { THEME_TOKENS } from '@holi/shared'

// The token vocabulary is stored twice by necessity: the whitelist here (TS,
// what a theme is allowed to set) and Holi's own theme file (CSS, the default
// every token takes), which `index.css` imports. They must agree, and nothing
// at runtime forces it: a slug whitelisted without a default is accepted by the
// resolver and themes nothing outside a vault, silently. This guard turns that
// drift into a red build.
const INDEX_CSS = fileURLToPath(new URL('../src/renderer/src/index.css', import.meta.url))
const HOLI_THEME = fileURLToPath(
  new URL('../src/main/vault/seed/vault/once/.holi/settings/theme.css', import.meta.url),
)

describe('theme token vocabulary stays in sync with the CSS layer', () => {
  it('every whitelisted token has a --slug definition in Holi’s theme', async () => {
    const css = await readFile(HOLI_THEME, 'utf8')
    // A definition is `--slug:`. The trailing `:` distinguishes it from a
    // `var(--slug)` reference and stops `--radius` matching `--radius-sm:` or
    // `--primary` matching `--primary-foreground:`.
    const missing = THEME_TOKENS.filter((slug) => !new RegExp(`--${slug}\\s*:`).test(css))
    expect(missing).toEqual([])
  })

  it('index.css takes those definitions from Holi’s theme', async () => {
    const css = await readFile(INDEX_CSS, 'utf8')
    expect(css).toMatch(/@import '[^']*\/\.holi\/settings\/theme\.css';/)
  })
})
