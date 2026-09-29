/**
 * The commit transforms, and the vault's say over which of them run.
 *
 * **This is not a hook framework** (the same argument that keeps vault apps free of a `manifest.json` layer).
 * A new transform gets added to this array; it does not get a plugin system.
 */
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { readVaultSettings } from '../settings'
import { archiveDone } from './archive-done'
import { memoryIndex } from './memory-index'
import { normalizeMd } from './normalize-md'
import { scaffoldMd } from './scaffold-md'
import { relink } from './relink'
import type { HookSettings, Transform } from './runner'

/** Order matters: `relink` runs before `archive-done` because both move links,
 *  and each should see a tree the other has finished with. `scaffold-md` goes
 *  before `normalize-md` so its block is tidied by the same pass. `memory-index`
 *  is **last** because it indexes the whole tree the others left behind. */
export const VAULT_TRANSFORMS: Transform[] = [
  { name: 'relink', run: relink },
  { name: 'archive-done', run: (root, staged) => archiveDone(root, staged) },
  { name: 'scaffold-md', run: (root, staged) => scaffoldMd(root, staged) },
  { name: 'normalize-md', run: normalizeMd },
  { name: 'memory-index', run: memoryIndex },
]

/**
 * Holi's defaults, merged under whatever the vault's settings files say.
 *
 * Taken from `VAULT_SETTING_DEFAULTS` so the seed, onboarding and this const
 * cannot disagree. `archive-done` is **off**: a transform that rearranges
 * someone's work is opt-in. `scaffold-md` is visible but on, because it only
 * fires on a file's first commit.
 */
export const DEFAULT_HOOKS: HookSettings = { ...VAULT_SETTING_DEFAULTS.hooks }

/**
 * Read the enable list from the vault's settings.
 *
 * **Data, never code**. Settings say *which* transforms run, never what
 * one is: a vault-tracked script behind `core.hooksPath` would let a teammate's
 * push run code on your laptop, so the hook body ships in the binary.
 *
 * Malformed settings fall back to the defaults, not "everything off"
 * (`resolveVaultSettings` owns that). `.holi/settings/app.local.yaml` can turn a
 * transform off on this machine only.
 */
export async function readHookSettings(root: string): Promise<HookSettings> {
  return (await readVaultSettings(root)).hooks
}
