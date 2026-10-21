/**
 * The commands community plugins give the vault's agent
 * (docs/features/community-plugins.md): each running plugin's `bin` entries,
 * linked into the vault's `PLUGIN_COMMANDS_DIR`, which comes last on the
 * agent's `PATH`. Rebuilt whole whenever what runs in the vault may have
 * changed, so a plugin switched off, removed or updated leaves no stale link.
 * The folder is the same path for the vault's whole life, so a session already
 * running sees the change without a restart.
 *
 * A command is refused, not shadowed, when its name is taken: by a command the
 * machine already has on the agent's `PATH` (the folder comes last, so it
 * would never be reached), or by another running plugin (the first by id
 * keeps it). Refusals come back, for the settings tab to say. So does a
 * plugin whose folder can't be read: one broken plugin never keeps the
 * others' commands from linking.
 *
 * Rebuilds of one vault run one at a time, each reading what runs once its
 * turn comes: two at once would share the staging folder, and the slower
 * could link what ran before the faster one's change.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { constants } from 'node:fs'
import { access, mkdir, realpath, rename, rm, stat, symlink } from 'node:fs/promises'
import { delimiter, join, relative, sep } from 'node:path'
import { PLUGIN_COMMANDS_DIR } from '@holi/shared'

export interface PluginCommands {
  id: string
  bin: Record<string, string>
  /** The plugin's code on this machine. */
  codeDir: string
}

export interface RefusedCommand {
  id: string
  name: string
  reason: string
}

export interface LinkedCommands {
  /** Command names now on the agent's `PATH`. */
  linked: string[]
  refused: RefusedCommand[]
  /** Why the folder could not be rebuilt at all; what was linked stays. */
  error?: string
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && rel !== path
}

/** Where `name` already runs from on `searchPath`, leaving out `except`. */
async function onPath(name: string, searchPath: string, except: string): Promise<string | null> {
  for (const dir of searchPath.split(delimiter)) {
    if (dir === '' || dir === except) continue
    const candidate = join(dir, name)
    const ok = await access(candidate, constants.X_OK)
      .then(() => stat(candidate))
      .then((s) => s.isFile())
      .catch(() => false)
    if (ok) return candidate
  }
  return null
}

/** Why the plugin's `file` can't be a command, or its resolved path. */
async function targetOf(
  codeDir: string,
  file: string,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const root = await realpath(codeDir).catch(() => null)
  if (root === null) return { ok: false, reason: `the plugin's folder ${codeDir} can't be read` }
  const path = await realpath(join(root, file)).catch(() => null)
  if (path === null) return { ok: false, reason: `${file} is not in the plugin` }
  if (!inside(root, path)) return { ok: false, reason: `${file} points outside the plugin` }
  const s = await stat(path).catch(() => null)
  if (s === null || !s.isFile() || (s.mode & 0o111) === 0)
    return { ok: false, reason: `${file} is not an executable file` }
  return { ok: true, path }
}

/** Each vault's rebuild under way, by root. */
const rebuilding = new Map<string, Promise<unknown>>()

/** Each vault's last rebuild, by root, for the settings tab's rows. */
const lastLinked = new Map<string, LinkedCommands>()

/** What the vault at `root` linked last, or null before its first rebuild. */
export function linkedIn(root: string): LinkedCommands | null {
  return lastLinked.get(root) ?? null
}

/**
 * Link `plugins`' commands into the vault at `root`, replacing whatever was
 * linked before, after any rebuild of it under way. `plugins` is read when
 * this rebuild's turn comes. `searchPath` is the `PATH` the agent inherits,
 * before Holi's folders.
 */
export function linkCommands(
  root: string,
  plugins: readonly PluginCommands[] | (() => Promise<readonly PluginCommands[]>),
  searchPath: string,
): Promise<LinkedCommands> {
  const run = (rebuilding.get(root) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      try {
        const result = await rebuild(
          root,
          typeof plugins === 'function' ? await plugins() : plugins,
          searchPath,
        )
        lastLinked.set(root, result)
        return result
      } catch (err) {
        lastLinked.set(root, {
          linked: [],
          refused: [],
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    })
  rebuilding.set(root, run)
  void run
    .catch(() => {})
    .finally(() => {
      if (rebuilding.get(root) === run) rebuilding.delete(root)
    })
  return run
}

async function rebuild(
  root: string,
  plugins: readonly PluginCommands[],
  searchPath: string,
): Promise<LinkedCommands> {
  const dir = join(root, PLUGIN_COMMANDS_DIR)
  const staging = `${dir}.next`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const owner = new Map<string, string>()
  const refused: RefusedCommand[] = []
  for (const plugin of [...plugins].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const [name, file] of Object.entries(plugin.bin)) {
      const refuse = (reason: string) => refused.push({ id: plugin.id, name, reason })
      const taken = owner.get(name)
      if (taken !== undefined) {
        refuse(`${taken} already adds ${name}`)
        continue
      }
      const existing = await onPath(name, searchPath, dir)
      if (existing !== null) {
        refuse(`${existing} already answers to ${name}`)
        continue
      }
      const target = await targetOf(plugin.codeDir, file)
      if (!target.ok) {
        refuse(target.reason)
        continue
      }
      await symlink(target.path, join(staging, name))
      owner.set(name, plugin.id)
    }
  }
  await rm(dir, { recursive: true, force: true })
  await rename(staging, dir)
  return { linked: [...owner.keys()].sort(), refused }
}

/** Take every command away: the community plugin itself is off in the vault. */
export function unlinkCommands(root: string): Promise<LinkedCommands> {
  return linkCommands(root, [], '')
}
