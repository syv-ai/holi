/**
 * What a community plugin writes into a vault that runs it
 * (docs/features/community-plugins.md):
 *
 * - **Skills**: each folder its manifest's `skills` names is copied to
 *   `.claude/skills/<folder name>/`, so the vault's agent can work with the
 *   plugin's files. A newer pin writes them again, replacing what the plugin
 *   wrote before, the way a shipped skill is updated.
 * - **Apps**: each folder its manifest's `apps` names is copied to the vault's
 *   root once, and is the vault's from then on: never overwritten, since an
 *   app keeps its records inside it. A `.local.app` never syncs, so each
 *   machine that runs the plugin gets its own.
 *
 * Symlinks inside a copied folder are followed, so a plugin can share files
 * between its repository's own folders and the ones it ships, but only to
 * files inside the plugin: a link out of it is refused.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { basename } from 'node:path'
import { isAppBundlePath, type PluginManifest } from '@holi/shared'
import { CapabilityError } from '../../../main/plugin-api'
import { transactSkillRefresh, type SkillSnapshot } from './skill-transaction'
import { publishApps } from './app-publication'

/** Refresh only declared skill folders after preflighting every source and destination. */
export async function refreshSkills(
  manifest: Pick<PluginManifest, 'skills'>,
  codeDir: string,
  vaultRoot: string,
  options: {
    force: boolean
    guard: () => void | Promise<void>
    expectedSnapshots?: readonly SkillSnapshot[]
    validateSnapshot?: (snapshots: readonly SkillSnapshot[]) => Promise<void> | void
    retainOriginals?: boolean
  },
): Promise<string[]> {
  const names = (manifest.skills ?? []).map((path) => basename(path))
  if (new Set(names.map((name) => name.toLocaleLowerCase('en-US'))).size !== names.length)
    throw new CapabilityError('BAD_REQUEST', 'skill paths have colliding destination names')
  return transactSkillRefresh(
    (manifest.skills ?? []).map((path) => ({ path, name: basename(path) })),
    codeDir,
    vaultRoot,
    options,
  )
}

/**
 * Copy the plugin's skills from its code folder `codeDir` into the vault at
 * `vaultRoot`. Returns the vault paths written, one folder per skill.
 */
export async function writeSkills(
  manifest: Pick<PluginManifest, 'skills'>,
  codeDir: string,
  vaultRoot: string,
  options: {
    guard?: () => void | Promise<void>
    expectedSnapshots?: readonly SkillSnapshot[]
    validateSnapshot?: (snapshots: readonly SkillSnapshot[]) => Promise<void> | void
  } = {},
): Promise<string[]> {
  // Plugins without skills must not create skill transaction state.
  if ((manifest.skills ?? []).length === 0) return []
  // Use the same bounded snapshot, canonical-path and rollback safeguards as
  // the explicit CLI refresh. A pin/update can replace complete folders, but
  // never by deleting the only copy before the replacement is ready.
  return refreshSkills(manifest, codeDir, vaultRoot, {
    force: true,
    guard: options.guard ?? (() => {}),
    retainOriginals: true,
    ...(options.expectedSnapshots === undefined
      ? {}
      : { expectedSnapshots: options.expectedSnapshots }),
    ...(options.validateSnapshot === undefined
      ? {}
      : { validateSnapshot: options.validateSnapshot }),
  })
}

/**
 * Copy the plugin's apps into the vault's root, each only when the vault has
 * nothing there by that name. Returns the vault paths written.
 */
export async function seedApps(
  manifest: Pick<PluginManifest, 'apps'>,
  codeDir: string,
  vaultRoot: string,
  options: {
    guard?: () => void | Promise<void>
    signal?: AbortSignal
    release?: { root: string; commit: string; sourcePath: string }
  } = {},
): Promise<string[]> {
  const apps = manifest.apps ?? []
  if (!apps.length) return []
  for (const app of apps) {
    if (!isAppBundlePath(basename(app)))
      throw new CapabilityError('BAD_REQUEST', `${app} is not a vault app's folder`)
  }
  return publishApps(apps, codeDir, vaultRoot, options)
}
