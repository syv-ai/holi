/**
 * The vendored foliate-js keeps a book's script from running only because its
 * iframes are sandboxed without `allow-scripts` (renderer/vendor/foliate/vendored.md).
 * An update that brings upstream's sandbox back must fail here, not in a book.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../renderer/vendor/foliate')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith('.js')
        ? [join(dir, entry.name)]
        : [],
  )
}

describe('the vendored foliate-js', () => {
  it('sandboxes every frame it makes to allow-same-origin and nothing more', () => {
    const sandboxes = sources(ROOT).flatMap((file) =>
      [
        ...readFileSync(file, 'utf8').matchAll(
          /setAttribute\(\s*['"`]sandbox['"`]\s*,\s*['"`]([^'"`]*)['"`]/g,
        ),
      ].map((match) => match[1]),
    )
    expect(sandboxes.length).toBeGreaterThanOrEqual(2)
    expect(new Set(sandboxes)).toEqual(new Set(['allow-same-origin']))
  })

  it('sandboxes every frame it creates', () => {
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8')
      const frames = text.match(/createElement\(\s*['"`]iframe['"`]\s*\)/g)?.length ?? 0
      const sandboxes = text.match(/setAttribute\(\s*['"`]sandbox['"`]/g)?.length ?? 0
      expect(sandboxes, file).toBeGreaterThanOrEqual(frames)
    }
  })

  it('never sets a sandbox any other way', () => {
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/\.sandbox\s*=|sandbox\.(add|value)/)
    }
  })

  it('copies only a chapter’s background colour into the host document', () => {
    const paginator = readFileSync(join(ROOT, 'paginator.js'), 'utf8')
    const body = /const getBackground = doc => \{([\s\S]*?)\n\}/.exec(paginator)?.[1] ?? ''
    expect(body).toContain('backgroundColor')
    expect(body).not.toMatch(/\.background(?!Color)\b|backgroundImage/)
  })
})
