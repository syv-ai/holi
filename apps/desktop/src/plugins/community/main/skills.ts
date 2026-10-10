/**
 * A community plugin's skills, written into a vault that turns it on
 * (docs/features/community-plugins.md): each folder its manifest's `skills`
 * names is copied to `.claude/skills/<folder name>/`, so the vault's agent can
 * work with the plugin's files. A newer pin writes them again, replacing what
 * the plugin wrote before, the way a shipped skill is updated.
 *
 * Symlinks inside a skill folder are followed, so a plugin can share
 * references between its repository's own skills and the ones it ships, but
 * only to files inside the plugin: a link out of it is refused.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { cp, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { PluginManifest } from '@holi/shared'
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
    await assertContained(root, from)
    const name = basename(skill)
    const to = join(vaultRoot, SKILLS_DIR, name)
    await rm(to, { recursive: true, force: true })
    await mkdir(join(vaultRoot, SKILLS_DIR), { recursive: true })
    await cp(from, to, { recursive: true, dereference: true })
    written.push(`.claude/skills/${name}`)
  }
  return written
}
