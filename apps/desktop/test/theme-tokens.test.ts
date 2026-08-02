import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { THEME_TOKENS } from '@holi/shared'

// The token vocabulary is stored twice by necessity: the whitelist here (TS,
// what a theme is allowed to set) and the default + consumer in `index.css`
// (CSS, what the value actually does). They must agree, and nothing at runtime
// forces it — a slug whitelisted without a `--slug` definition is accepted by
// the resolver and emitted onto the root, where it themes nothing, silently.
// This guard turns that drift into a red build.
const INDEX_CSS = fileURLToPath(new URL('../src/renderer/src/index.css', import.meta.url))

describe('theme token vocabulary stays in sync with the CSS layer', () => {
  it('every whitelisted token has a --slug definition in index.css', async () => {
    const css = await readFile(INDEX_CSS, 'utf8')
    // A definition is `--slug:` — the trailing `:` distinguishes it from a
    // `var(--slug)` reference and stops `--radius` matching `--radius-sm:` or
    // `--primary` matching `--primary-foreground:`.
    const missing = THEME_TOKENS.filter((slug) => !new RegExp(`--${slug}\\s*:`).test(css))
    expect(missing).toEqual([])
  })
})
