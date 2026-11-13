import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('runtime vault theme palette', () => {
  it('statically exports Tailwind palette variables used by vault themes', async () => {
    const css = await readFile('src/renderer/src/index.css', 'utf8')

    expect(css).toMatch(/@import\s+['"]tailwindcss['"]\s+theme\(static\)\s*;/)
  })
})
