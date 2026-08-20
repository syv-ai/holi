/**
 * The three transforms, and the vault's say over which of them run.
 *
 * **Exactly three, and this is not a hook framework.** Designing a config
 * surface before a second hook has asked for one is the argument that killed
 * `manifest.json` in D74, and it applies here unchanged. A fourth transform
 * gets added to this array; it does not get a plugin system.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { archiveDone } from './archive-done'
import { normalizeMd } from './normalize-md'
import { relink } from './relink'
import type { HookSettings, Transform } from './runner'

/** Order matters: `relink` first, because `archive-done` moves files and both
 *  rewrite links — running the rename fix-ups before the archive move keeps
 *  each one reasoning about a tree the other has finished with. */
export const VAULT_TRANSFORMS: Transform[] = [
  { name: 'relink', run: relink },
  { name: 'archive-done', run: (root, staged) => archiveDone(root, staged) },
  { name: 'normalize-md', run: normalizeMd },
]

/**
 * Holi's defaults, merged under whatever `.holi/settings.json` says.
 *
 * `archive-done` is **off**: it moves task files, which changes what the board
 * shows, and a transform that rearranges someone's work is opt-in. The other
 * two only ever make a change the author would not have noticed making.
 */
export const DEFAULT_HOOKS: HookSettings = {
  relink: true,
  'archive-done': false,
  'normalize-md': true,
}

/**
 * Read the enable list from the vault's committed settings.
 *
 * **Data, never code** (D76). This file says *which* transforms run; it can
 * never say what one is. A vault-tracked script pointed at by `core.hooksPath`
 * would mean a teammate's push runs on your laptop every commit — which is why
 * the hook body ships in the binary and lives in `.git/hooks/`, where nothing
 * can push it at all.
 *
 * Unreadable or malformed settings fall back to the defaults rather than to
 * "everything off": a typo in an unrelated key should not silently disable
 * link rewriting.
 */
export async function readHookSettings(root: string): Promise<HookSettings> {
  const text = await readFile(join(root, '.holi/settings.json'), 'utf8').catch(() => null)
  if (text === null) return { ...DEFAULT_HOOKS }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ...DEFAULT_HOOKS }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_HOOKS }
  }

  const hooks = (parsed as Record<string, unknown>).hooks
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    return { ...DEFAULT_HOOKS }
  }

  const settings: HookSettings = { ...DEFAULT_HOOKS }
  for (const transform of VAULT_TRANSFORMS) {
    const value = (hooks as Record<string, unknown>)[transform.name]
    if (typeof value === 'boolean') settings[transform.name] = value
  }
  return settings
}
