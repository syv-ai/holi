/**
 * The commit transforms, and the vault's say over which of them run.
 *
 * **This is not a hook framework** (the same argument that keeps vault apps free of a `manifest.json` layer).
 * Core's transforms are this list; a plugin's are code in the build
 * (`MainPlugin.transforms`), slotted in after `relink`, never a script a vault
 * carries.
 */
import { VAULT_SETTING_DEFAULTS, type SnapshotClaim } from '@holi/shared'
import { readVaultSettings } from '../settings'
import { memoryIndex } from './memory-index'
import { normalizeMd } from './normalize-md'
import { relink } from './relink'
import { shrinkImages } from './shrink-images'
import type { HookSettings, Transform } from './runner'

/** The transforms for a vault whose plugins claim `claims` and add
 *  `plugins` (`MainPlugin.transforms`, core parts' first): `normalize-md`
 *  puts claimed files in their claim's canonical form.
 *
 *  Order matters: `relink` runs before the plugins' (`archive-done`) because
 *  both move links, and each should see a tree the other has finished with.
 *  `memory-index` is **last** because it indexes the whole tree the
 *  others left behind. */
export function vaultTransforms(
  claims: readonly SnapshotClaim[],
  plugins: readonly Transform[],
): Transform[] {
  return [
    { name: 'relink', run: relink },
    ...plugins,
    { name: 'normalize-md', run: (root, staged) => normalizeMd(root, staged, claims) },
    { name: 'shrink-images', run: shrinkImages },
    { name: 'memory-index', run: memoryIndex },
  ]
}

/**
 * Holi's defaults, merged under whatever the vault's settings files say.
 *
 * Taken from `VAULT_SETTING_DEFAULTS` so the seed, onboarding and this const
 * cannot disagree. `archive-done` is **off**: a transform that rearranges
 * someone's work is opt-in.
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
