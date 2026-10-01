/**
 * What core seeds into every vault, whatever else runs: the vault marker,
 * `AGENTS.md` (a vault file every agent reads, so not the agent's), the icons
 * file, the settings and theme pairs, the memory index, and the `.gitignore`
 * that keeps machine-local files local.
 *
 * The plain files live in `vault/once/` beside this module. The settings,
 * theme and memory files are computed from shared's vocabularies, so the
 * seed and the code that reads them cannot drift apart.
 */
import {
  applyThemePatch,
  LOCAL_ONLY_IGNORE_LINES,
  MEMORY_INDEX,
  MEMORY_INDEX_EMPTY,
  seedSettings,
  seedSettingsText,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  THEME_FILE,
  THEME_LOCAL_FILE,
} from '@holi/shared'
import { seedFolder } from './folder'
import type { SeedContribution } from './types'

const folder = seedFolder(
  import.meta.glob(['./vault/**', '!**/.DS_Store'], {
    query: '?raw',
    import: 'default',
    eager: true,
    exhaustive: true,
  }),
)

/**
 * The theme files ship with the whole token vocabulary commented out, not
 * empty, so the file itself names what can be set. Shared overrides go in
 * `theme.css` (committed), personal ones in `theme.local.css` (gitignored).
 */
const THEME_SKELETON = applyThemePatch(null, {})

export const GITIGNORE = '.gitignore'

/**
 * The `.gitignore` text this vault should have, or **null** if it already has
 * every line it needs: core's `*.local.*` lines plus any a contribution adds
 * as a fragment (a list of lines).
 *
 * Merged rather than create-if-missing: an adopted repo usually already has
 * one, and the sync engine commits with `git add -A`, so skipping it would let
 * the first commit carry a `*.local.*` file to every collaborator. Line-wise,
 * because an adopted repo's existing ignores are not ours to replace. A missing
 * trailing newline is added first, or the append would produce
 * `node_modules*.local.*`, which ignores nothing.
 */
export function gitignoreWith(existing: string | null, lines: readonly string[]): string | null {
  const present = new Set((existing ?? '').split('\n').map((l) => l.trim()))
  const missing = [...new Set(lines)].filter((line) => !present.has(line))
  if (missing.length === 0) return null

  if (existing === null || existing.trim() === '') {
    return `# Machine-local — never committed. Managed by Holi.\n${missing.join('\n')}\n`
  }
  const base = existing.endsWith('\n') ? existing : `${existing}\n`
  return `${base}\n# Machine-local — never committed. Managed by Holi.\n${missing.join('\n')}\n`
}

export const coreSeed: SeedContribution = {
  id: 'core',
  once: {
    ...folder.once,
    // Built from `VAULT_SETTING_DESCRIPTORS`, the list that drives the
    // onboarding questions. The local half is gitignored by `*.local.*`.
    [SETTINGS_FILE]: seedSettingsText(seedSettings('committed'), 'committed'),
    [SETTINGS_LOCAL_FILE]: seedSettingsText(seedSettings('local'), 'local'),
    [THEME_FILE]: THEME_SKELETON,
    [THEME_LOCAL_FILE]: THEME_SKELETON,
    // The memory directory exists and is tracked from a vault's first commit,
    // in its empty-state form; after that the `memory-index` transform owns
    // the file, which is why it is once and not shipped.
    [MEMORY_INDEX]: MEMORY_INDEX_EMPTY,
  },
  shipped: folder.shipped,
  merge: {
    [GITIGNORE]: async (existing, fragments) =>
      gitignoreWith(existing, [...LOCAL_ONLY_IGNORE_LINES, ...(fragments as string[][]).flat()]),
  },
}
