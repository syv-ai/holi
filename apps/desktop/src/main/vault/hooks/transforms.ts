/**
 * The commit transforms, and the vault's say over which of them run.
 *
 * **This is not a hook framework.** Designing a config surface before a second
 * hook has asked for one is the argument that killed `manifest.json` in D74, and
 * it applies here unchanged. A new transform gets added to this array; it does
 * not get a plugin system. (This comment used to say "exactly three", and had
 * been listing four for a while.)
 */
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { readVaultSettings } from '../settings'
import { archiveDone } from './archive-done'
import { memoryIndex } from './memory-index'
import { normalizeMd } from './normalize-md'
import { scaffoldMd } from './scaffold-md'
import { relink } from './relink'
import type { HookSettings, Transform } from './runner'

/** Order matters: `relink` first, because `archive-done` moves files and both
 *  rewrite links — running the rename fix-ups before the archive move keeps
 *  each one reasoning about a tree the other has finished with. `scaffold-md`
 *  goes before `normalize-md` so the block it writes is tidied by the same pass
 *  as everything else, rather than being the one region nothing has checked.
 *  `memory-index` is **last**, because it is the only one that reads the whole
 *  tree rather than the staged set: it has to see the tree the four before it
 *  left behind, including a memory file `relink` just rewrote links in and one
 *  `normalize-md` just tidied. */
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
 * Restated from `@holi/shared`'s `VAULT_SETTING_DEFAULTS` rather than written
 * out again: the seed, the onboarding step and this const all have to agree on
 * what a vault does by default, and three literals agreeing is a coincidence
 * that expires.
 *
 * `archive-done` is **off**: it moves task files, which changes what the board
 * shows, and a transform that rearranges someone's work is opt-in. `relink` and
 * `normalize-md` only ever make a change the author would not have noticed
 * making. `scaffold-md` is the one that IS visible — it writes four lines at the
 * top of a note — and it is on anyway, because it only ever fires on a file's
 * first commit and the alternative is the note losing its "N chars · Last
 * updated" bar and its `created` date for good.
 */
export const DEFAULT_HOOKS: HookSettings = { ...VAULT_SETTING_DEFAULTS.hooks }

/**
 * Read the enable list from the vault's settings.
 *
 * **Data, never code** (D76). This file says *which* transforms run; it can
 * never say what one is. A vault-tracked script pointed at by `core.hooksPath`
 * would mean a teammate's push runs on your laptop every commit — which is why
 * the hook body ships in the binary and lives in `.git/hooks/`, where nothing
 * can push it at all.
 *
 * Unreadable or malformed settings fall back to the defaults rather than to
 * "everything off": a typo in an unrelated key should not silently disable
 * link rewriting. That contract now lives in `resolveVaultSettings` and is
 * tested there.
 *
 * **Reads the local override too**, unlike the hand-rolled reader this replaced.
 * `.holi/settings/app.local.json` can turn a transform off on *this machine* — which
 * is not a D76 concern, because a local file is written by you and can still only
 * say *whether* one of Holi's own transforms runs, never what one is. It is what
 * lets you keep `archive-done` off while the vault you share says on.
 */
export async function readHookSettings(root: string): Promise<HookSettings> {
  return (await readVaultSettings(root)).hooks
}
