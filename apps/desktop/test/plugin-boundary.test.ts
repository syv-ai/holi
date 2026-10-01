/**
 * Core never imports a plugin. ESLint holds the renderer to that; main,
 * preload and shared are not linted, so this scans them. The composition root
 * (`src/main/index.ts`) is the one file that installs the plugin list.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const desktop = fileURLToPath(new URL('..', import.meta.url))
const plugins = join(desktop, 'src/plugins')
const scanned = [
  join(desktop, 'src/main'),
  join(desktop, 'src/preload'),
  join(desktop, '../../packages/shared/src'),
]
const allowed = new Set([join(desktop, 'src/main/index.ts')])

async function sources(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await sources(path)))
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) out.push(path)
  }
  return out
}

const SPECIFIER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g

it('only the composition root imports from src/plugins', async () => {
  const offenders: string[] = []
  for (const dir of scanned) {
    for (const file of await sources(dir)) {
      if (allowed.has(file)) continue
      const text = await readFile(file, 'utf8')
      for (const [, spec] of text.matchAll(SPECIFIER)) {
        if (!spec!.startsWith('.')) continue
        const target = resolve(dirname(file), spec!)
        if (target === plugins || target.startsWith(`${plugins}/`)) {
          offenders.push(`${relative(desktop, file)} -> ${spec}`)
        }
      }
    }
  }
  expect(offenders).toEqual([])
})
