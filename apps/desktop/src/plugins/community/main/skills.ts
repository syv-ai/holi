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
import { cp, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { isAppBundlePath, type PluginManifest } from '@holi/shared'
import { CapabilityError } from '../../../main/plugin-api'

/** Where a vault keeps Claude Code's skills. */
const SKILLS_DIR = join('.claude', 'skills')

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

/**
 * Copy the plugin's skills from its code folder `codeDir` into the vault at
 * `vaultRoot`. Returns the vault paths written, one folder per skill.
 */
export async function writeSkills(
  manifest: Pick<PluginManifest, 'skills'>,
  codeDir: string,
  vaultRoot: string,
): Promise<string[]> {
  const root = await realpath(codeDir)
  const written: string[] = []
  for (const skill of manifest.skills ?? []) {
    const from = join(root, skill)
    const present = await stat(join(from, 'SKILL.md')).catch(() => null)
    if (present === null) throw new CapabilityError('BAD_REQUEST', `skill ${skill} has no SKILL.md`)
    const name = basename(skill)
    const to = join(vaultRoot, SKILLS_DIR, name)
    await rm(to, { recursive: true, force: true })
    await copyFromPlugin(root, from, to)
    written.push(`.claude/skills/${name}`)
  }
  return written
}

/**
 * Copy the plugin's apps into the vault's root, each only when the vault has
 * nothing there by that name. Returns the vault paths written.
 */
export async function seedApps(
  manifest: Pick<PluginManifest, 'apps'>,
  codeDir: string,
  vaultRoot: string,
): Promise<string[]> {
  const root = await realpath(codeDir)
  const written: string[] = []
  for (const app of manifest.apps ?? []) {
    const name = basename(app)
    if (!isAppBundlePath(name))
      throw new CapabilityError('BAD_REQUEST', `${app} is not a vault app's folder`)
    const from = join(root, app)
    if ((await stat(join(from, 'index.html')).catch(() => null)) === null)
      throw new CapabilityError('BAD_REQUEST', `app ${app} has no index.html`)
    const to = join(vaultRoot, name)
    if ((await stat(to).catch(() => null)) !== null) continue
    await copyFromPlugin(root, from, to)
    written.push(name)
  }
  return written
}
