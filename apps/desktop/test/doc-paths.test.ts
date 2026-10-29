import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

/**
 * Every repository file a docs page names in backticks exists. The docs go
 * stale when a file moves; this fails the move instead of a reader later.
 *
 * Only tokens that look like a path to a file are checked: a `/`, a file
 * extension, and none of the characters that make it a pattern, a URL or a
 * placeholder. A path is found if it resolves from the repository root, from
 * one of the source roots below, or beside the page that names it. Paths inside
 * a vault (`.holi/…`, `vault/…`) and the refactor notes, which record files that
 * were deleted, are not checked.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const docs = join(root, 'docs')

// A feature page names a plugin file from inside the plugin (`main/seed.ts`) or a
// renderer file from inside its layer (`state/inbox.ts`), so each plugin and each
// renderer layer is a root too.
const PLUGINS = readdirSync(join(root, 'apps/desktop/src/plugins')).flatMap((id) => [
  `apps/desktop/src/plugins/${id}`,
  `apps/desktop/src/plugins/${id}/main`,
  `apps/desktop/src/plugins/${id}/renderer`,
])
const LAYERS = ['composites', 'features', 'lib', 'state'].map(
  (l) => `apps/desktop/src/renderer/src/${l}`,
)
const ROOTS = [
  '',
  'apps/desktop',
  'apps/desktop/src',
  'apps/desktop/src/main',
  'apps/desktop/src/renderer/src',
  'apps/desktop/src/plugins',
  'apps/desktop/test',
  'packages/shared',
  'packages/shared/src',
  'docs',
  ...LAYERS,
  ...PLUGINS,
]
const EXTENSIONS = /\.(?:tsx?|mts|mjs|cjs|jsx?|json|jsonc|md|css|ya?ml|sh|svg|png|html)$/
const SKIPPED =
  /^(?:docs\/refactor\/|\.holi\/|\.claude\/|vault\/|seed\/|notes\/|userData\/|memory\/|~)/

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? pages(path) : name.endsWith('.md') ? [path] : []
  })
}

function named(text: string): string[] {
  const found = new Set<string>()
  for (const [, token] of text.matchAll(/`([^`\n]+)`/g)) {
    const path = token!.replace(/:\d+(?:-\d+)?$/, '')
    if (!path.includes('/') || !EXTENSIONS.test(path)) continue
    if (/[\s*{}<>…$()|]|^https?:|^@|\.\.\./.test(path)) continue
    found.add(path)
  }
  return [...found]
}

describe('docs name files that exist', () => {
  const missing: string[] = []
  for (const page of [join(root, 'README.md'), join(root, 'AGENTS.md'), ...pages(docs)]) {
    const rel = relative(root, page)
    if (SKIPPED.test(rel)) continue
    for (const path of named(readFileSync(page, 'utf8'))) {
      if (SKIPPED.test(path)) continue
      const candidates = [...ROOTS.map((r) => join(root, r, path)), join(dirname(page), path)]
      if (!candidates.some(existsSync)) missing.push(`${rel}: ${path}`)
    }
  }

  test('no page cites a file that is not there', () => {
    expect(missing).toEqual([])
  })
})
