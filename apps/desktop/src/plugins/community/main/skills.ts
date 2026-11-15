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
import { cp, mkdir, readdir, realpath, rm, stat, lstat, readFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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

/** Refresh only declared skill folders after preflighting every source and destination. */
export async function refreshSkills(
  manifest: Pick<PluginManifest, 'skills'>,
  codeDir: string,
  vaultRoot: string,
  options: { force: boolean; guard: () => void },
): Promise<string[]> {
  const root = await realpath(codeDir)
  const destination = join(vaultRoot, SKILLS_DIR)
  const names = (manifest.skills ?? []).map((skill) => basename(skill))
  if (new Set(names.map((name) => name.toLocaleLowerCase('en-US'))).size !== names.length)
    throw new CapabilityError('BAD_REQUEST', 'declared skills have colliding destination names')
  const stage = join(vaultRoot, '.holi', 'state', `community-skills.local.${randomUUID()}`)
  const plans: { name: string; exists: boolean; equal: boolean }[] = []
  const inspect = async (path: string, target: string, allowedRoot: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      throw new CapabilityError('BAD_REQUEST', `unsafe special file in skill: ${path}`)
    if (info.isDirectory()) {
      for (const entry of await readdir(path))
        await inspect(join(path, entry), join(target, entry), allowedRoot)
    } else {
      const real = await realpath(path)
      if (!inside(allowedRoot, real))
        throw new CapabilityError('BAD_REQUEST', `${path} points outside its allowed root`)
    }
  }
  const equalTree = async (left: string, right: string): Promise<boolean> => {
    const a = await lstat(left).catch(() => null)
    const b = await lstat(right).catch(() => null)
    if (
      !a ||
      !b ||
      a.isSymbolicLink() ||
      b.isSymbolicLink() ||
      a.isDirectory() !== b.isDirectory() ||
      a.isFile() !== b.isFile()
    )
      return false
    if (a.isFile()) return (await readFile(left)).equals(await readFile(right))
    const ae = (await readdir(left)).sort(),
      be = (await readdir(right)).sort()
    return (
      ae.length === be.length &&
      ae.every((entry, i) => entry === be[i]) &&
      (
        await Promise.all(ae.map((entry) => equalTree(join(left, entry), join(right, entry))))
      ).every(Boolean)
    )
  }
  for (const skill of manifest.skills ?? []) {
    const source = join(root, skill)
    await inspect(source, source, root)
    const required = await lstat(join(source, 'SKILL.md')).catch(() => null)
    if (!required?.isFile() || required.isSymbolicLink())
      throw new CapabilityError('BAD_REQUEST', `skill ${skill} has no regular SKILL.md`)
    const dest = join(destination, basename(skill))
    const present = await lstat(dest).catch(() => null)
    if (present?.isSymbolicLink() || (present && !present.isDirectory()))
      throw new CapabilityError('BAD_REQUEST', `unsafe skill destination: ${dest}`)
    if (present) await inspect(dest, dest, await realpath(vaultRoot))
    plans.push({
      name: basename(skill),
      exists: Boolean(present),
      equal: present ? await equalTree(source, dest) : false,
    })
  }
  if (!options.force && plans.some((p) => p.exists && !p.equal))
    throw new CapabilityError(
      'CONFLICT',
      'one or more skill folders differ; use --force to replace complete folders',
    )
  options.guard()
  const changed = plans.filter((p) => !p.exists || !p.equal)
  if (!changed.length) return []
  await mkdir(stage, { recursive: true })
  const backups: string[] = []
  const published: string[] = []
  try {
    for (const plan of changed) {
      options.guard()
      const source = join(
        root,
        (manifest.skills ?? []).find((s) => basename(s) === plan.name)!,
      )
      await cp(source, join(stage, plan.name), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
      })
      await inspect(join(stage, plan.name), join(stage, plan.name), await realpath(vaultRoot))
    }
    options.guard()
    await mkdir(destination, { recursive: true })
    for (const plan of changed) {
      options.guard()
      const target = join(destination, plan.name)
      const backup = join(stage, `${plan.name}.backup`)
      if (await lstat(target).catch(() => null)) {
        await rename(target, backup)
        backups.push(backup)
      }
      await rename(join(stage, plan.name), target)
      published.push(target)
    }
    options.guard()
    await rm(stage, { recursive: true, force: true })
    return changed.map(({ name }) => `.claude/skills/${name}`)
  } catch (error) {
    for (const target of published.reverse())
      await rm(target, { recursive: true, force: true }).catch(() => undefined)
    for (const backup of backups.reverse()) {
      const target = join(destination, basename(backup).replace(/\\.backup$/, ''))
      await rename(backup, target).catch(() => undefined)
    }
    await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
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
