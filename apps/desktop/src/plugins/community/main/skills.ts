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
import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { isAppBundlePath, type PluginManifest } from '@holi/shared'
import { CapabilityError } from '../../../main/plugin-api'
import { transactSkillRefresh, type SkillSnapshot } from './skill-transaction'

const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== path)
}

/** Every path under `dir`, resolved, must stay inside `root`. */
async function assertContained(root: string, dir: string): Promise<void> {
  const real = await realpath(dir)
  if (!inside(root, real))
    throw new CapabilityError('BAD_REQUEST', `${dir} points outside the plugin`)
  if (!(await stat(real)).isDirectory()) return
  for (const entry of await readdir(real)) await assertContained(root, join(real, entry))
}

/** Copy `from`, a folder inside the plugin at `root`, to `to`. */
async function copyFromPlugin(root: string, from: string, to: string): Promise<void> {
  await assertContained(root, from)
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { recursive: true, dereference: true })
}

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
  options: { guard?: () => void | Promise<void> } = {},
): Promise<string[]> {
  if ((manifest.apps ?? []).length === 0) return []
  const root = await realpath(codeDir)
  const staged: { name: string; stage: string; target: string }[] = []
  const published: string[] = []
  const vault = await realpath(vaultRoot)
  const stateParent = join(vault, '.holi/state')
  for (const rel of ['.holi', '.holi/state']) {
    const path = join(vault, rel)
    let info = await lstat(path).catch(() => null)
    if (!info) {
      await mkdir(path)
      info = await lstat(path)
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new CapabilityError('BAD_REQUEST', 'unsafe app staging path')
  }
  const stageRoot = join(stateParent, `community-apps.local.${randomUUID()}`)
  await mkdir(stageRoot, { mode: 0o700 })
  try {
    for (const app of manifest.apps ?? []) {
      const name = basename(app)
      if (!isAppBundlePath(name))
        throw new CapabilityError('BAD_REQUEST', `${app} is not a vault app's folder`)
      const from = join(root, app)
      if ((await stat(join(from, 'index.html')).catch(() => null)) === null)
        throw new CapabilityError('BAD_REQUEST', `app ${app} has no index.html`)
      const target = join(vaultRoot, name)
      if ((await lstat(target).catch(() => null)) !== null) continue
      const stage = join(stageRoot, name)
      await copyFromPlugin(root, from, stage)
      staged.push({ name, stage, target })
    }
    for (const item of staged) {
      await options.guard?.()
      if ((await lstat(item.target).catch(() => null)) !== null) continue
      await rename(item.stage, item.target)
      published.push(item.name)
    }
    return published
  } catch (error) {
    // Remove only this operation's staged material. Published folders are valid
    // complete copies and are deliberately left intact for a safe retry.
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
  }
}
