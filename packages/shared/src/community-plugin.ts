/**
 * What a community plugin says about itself, and what a vault pins of it.
 *
 * A community plugin is a third-party *process plugin*: a `holi-plugin.json`
 * in a git repository, at its root or in a top-level folder named after the
 * plugin's id, so one repository can hold several. Holi installs it on this
 * machine, sets it up once with the manifest's `setup` command, and runs it
 * with its `serve` command for each file it opens, framing the local server it
 * starts. Its code never loads into Holi's own processes. A vault that uses one
 * commits a **pin**, `.holi/plugins/<id>/manifest.json`: the manifest plus the
 * repository, folder and commit it came from, so every member is offered the
 * same code.
 * See docs/features/community-plugins.md.
 *
 * Main reads this grammar when it installs and pins; the renderer reads it to
 * know which files a plugin opens. Pure and browser-safe.
 */
import { PLUGINS_FILE, PLUGINS_LOCAL_FILE } from './plugin-settings'
import { isPluginId } from './plugins'
import type { FileMeta } from './types'

/** The manifest's name, in the plugin's folder. */
export const PLUGIN_MANIFEST_FILE = 'holi-plugin.json'

/**
 * Where a plugin is in its repository: `''` for a manifest at the root, a
 * repository of one plugin, or the top-level folder named after its id, one of
 * several. The folder is its id, so a pin, an install and a release tag can
 * never name the folder and the plugin differently.
 */
export function isPluginPath(value: unknown): value is string {
  return value === '' || isPluginId(value)
}

/** The manifest's path in the repository, for a plugin at `path`. */
export function pluginManifestPath(path: string): string {
  return path === '' ? PLUGIN_MANIFEST_FILE : `${path}/${PLUGIN_MANIFEST_FILE}`
}

/** The tag a release of the plugin at `path` is fetched at: `v<version>` at
 *  the root, `<id>-v<version>` in a folder, so each plugin in a repository has
 *  its own releases. */
export function releaseTag(path: string, version: string): string {
  return path === '' ? `v${version}` : `${path}-v${version}`
}

/** A tag read back: which plugin's release it is (`''` for the root) and its
 *  version, or null for a tag that is no release. */
export function parseReleaseTag(tag: string): { path: string; version: string } | null {
  const m = RELEASE_TAG.exec(tag)
  if (m === null) return null
  const path = m[1] ?? ''
  return isPluginPath(path) ? { path, version: m[2]! } : null
}

/** Where a vault keeps its pins. */
export const PLUGIN_PINS_DIR = '.holi/plugins'

/**
 * What on disk decides which community plugins run in a vault, as one string
 * that changes when it does: the pins and the two plugins settings files.
 */
export function communityPluginsSignature(files: readonly FileMeta[]): string {
  return files
    .filter(
      (f) =>
        f.path.startsWith(`${PLUGIN_PINS_DIR}/`) ||
        f.path === PLUGINS_FILE ||
        f.path === PLUGINS_LOCAL_FILE,
    )
    .map((f) => `${f.path}@${f.updatedAt}`)
    .join('|')
}

/** A pin's path in the vault. */
export function pluginPinPath(id: string): string {
  return `${PLUGIN_PINS_DIR}/${id}/manifest.json`
}

/** The placeholders a command may carry, filled in by main for each run. */
export const COMMAND_PLACEHOLDERS = ['{file}', '{vault}', '{port}'] as const

export interface PluginManifest {
  id: string
  name: string
  /** Semver; a release is fetched at `releaseTag(path, version)`. */
  version: string
  description?: string
  /** The oldest Holi it runs on. */
  minHoliVersion?: string
  /** The files it opens, by name: an exact basename (`notes.board`) or an
   *  extension (`*.board`). No globs, because the file tree asks for every row.
   *  Empty when it opens folders only. */
  opens: string[]
  /** The folders it opens, each one document in the file tree as a vault
   *  app's `.app` is: a folder whose name ends in `suffix` and holds `entry`.
   *  The server is given the entry file. */
  folder?: { suffix: string; entry: string }
  /** Run once after install or update, in the plugin's own folder. An argv,
   *  never a shell string. */
  setup?: string[]
  /** Run for each opened file; must carry `{port}`, where it must listen on
   *  the loopback (127.0.0.1 or ::1), never a public address. An argv.
   *  Required when the plugin opens files or folders, and absent when it only
   *  ships apps and skills. */
  serve?: string[]
  /** Folders in the plugin, each a vault app (`Notes.app`, with its
   *  `index.html` and `app.yaml`), copied to the vault's root once, when a
   *  vault runs the plugin: then the vault's, never overwritten, since an app
   *  keeps its records inside it. A `.local.app` is copied on each machine. */
  apps?: string[]
  /** Lines for the vault's managed `.gitignore` block: what the server writes
   *  beside a file that must not sync. */
  ignore?: string[]
  /** Folders in the plugin's repository, each a Claude Code skill (a
   *  `SKILL.md` and what it references), copied to the vault's
   *  `.claude/skills/<folder name>/` when the vault turns the plugin on. */
  skills?: string[]
  /** Commands for the vault's agent, by name: each an executable file in the
   *  plugin, linked into `PLUGIN_COMMANDS_DIR` while the plugin runs in the
   *  vault. That folder comes last on the agent's `PATH`, so a plugin can add
   *  a command but never stand in for one the machine already has. */
  bin?: Record<string, string>
  /** Whether the plugin can do its work now, beyond being set up: `run` is an
   *  argv run in the plugin's folder, passing when it exits 0, and `hint` is
   *  what to tell the person when it fails ("Switch on Let other agents
   *  control Dash in Dash"). A failing check does not stop the plugin. */
  check?: PluginCheck
}

export interface PluginCheck {
  run: string[]
  hint: string
}

/** The longest a check's hint may be: one short line in a settings row. */
export const CHECK_HINT_MAX = 200

/** Where a vault links its running plugins' commands, on the agent's `PATH`:
 *  machine state, and `.local.` so it never syncs, since each link points at
 *  this machine's copy of the plugin. */
export const PLUGIN_COMMANDS_DIR = '.holi/state/commands.local.d'

/** Holi's own command, which no plugin may name one of its own. */
const RESERVED_COMMANDS = ['holi']

/** A name fit for a command on `PATH`: lowercase, no path, no shell meaning. */
const COMMAND_NAME = /^[a-z0-9][a-z0-9._-]*$/

/** Can a plugin's command be called `name`? */
export function isCommandName(name: unknown): name is string {
  return typeof name === 'string' && COMMAND_NAME.test(name) && !RESERVED_COMMANDS.includes(name)
}

export interface PluginPin extends PluginManifest {
  /** `owner/repo` on GitHub. */
  repo: string
  /** Where in it, `isPluginPath`. */
  path: string
  /** The full commit the vault's members are offered. */
  commit: string
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] }

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const RELEASE_TAG = /^(?:([a-z][a-z0-9-]*)-)?v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/
const BASENAME = /^[^/\\*?[\]{}]+$/
const EXTENSION = /^\*\.[A-Za-z0-9][A-Za-z0-9.-]*$/
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
const COMMIT = /^[0-9a-f]{40}$/
const FOLDER_SUFFIX = /^\.[a-z0-9][a-z0-9-]*$/
/** An app folder's own name: anything ending in `.app` (`Home.local.app` too). */
const APP_FOLDER = /(^|\/)[^/]+\.app$/
const PLACEHOLDER = /\{[^}]*\}/g

/** Is `value` a GitHub `owner/repo`? */
export function isRepoName(value: unknown): value is string {
  return typeof value === 'string' && REPO.test(value) && !value.endsWith('.git')
}

/** Can a community plugin be called `id`? Not the name of a plugin built into
 *  Holi: the vault's `plugins:` map would then switch both. */
export function isCommunityPluginId(id: unknown, firstPartyIds: Iterable<string>): id is string {
  if (!isPluginId(id)) return false
  for (const taken of firstPartyIds) if (taken === id) return false
  return true
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string')

function commandProblems(field: string, argv: unknown, required: readonly string[]): string[] {
  if (!isStringList(argv) || argv.length === 0 || argv.some((s) => s.length === 0))
    return [`${field} must be a non-empty list of arguments`]
  const problems: string[] = []
  if (argv.length === 1 && /\s/.test(argv[0]!))
    problems.push(`${field} is an argv, not a shell string: split "${argv[0]}" into its arguments`)
  for (const arg of argv)
    for (const found of arg.match(PLACEHOLDER) ?? [])
      if (!(COMMAND_PLACEHOLDERS as readonly string[]).includes(found))
        problems.push(
          `${field} uses ${found}; only ${COMMAND_PLACEHOLDERS.join(', ')} are filled in`,
        )
  for (const placeholder of required)
    if (!argv.some((arg) => arg.includes(placeholder)))
      problems.push(`${field} must pass ${placeholder}`)
  return problems
}

/** A path inside the plugin's folder: relative, `/`-separated, no `.` or
 *  `..` segment, so a manifest cannot name a folder outside its own. */
function isPluginRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

/** Read a `holi-plugin.json`, already parsed from JSON, found at `path`
 *  (`isPluginPath`): in a folder, the id must be the folder's name. */
export function parsePluginManifest(json: unknown, path = ''): Parsed<PluginManifest> {
  if (!isRecord(json)) return { ok: false, problems: ['the manifest must be a JSON object'] }
  const problems: string[] = []
  const {
    id,
    name,
    version,
    description,
    minHoliVersion,
    setup,
    serve,
    ignore,
    skills,
    folder,
    apps,
    bin,
    check,
  } = json
  const opens = json.opens ?? []

  if (!isPluginId(id)) problems.push('id must be kebab-case, starting with a letter')
  else if (path !== '' && id !== path)
    problems.push(`a plugin in the folder ${path}/ must have the id ${path}`)
  if (typeof name !== 'string' || name.trim() === '')
    problems.push('name must be a non-empty string')
  if (typeof version !== 'string' || !SEMVER.test(version))
    problems.push('version must be semver, like 1.2.0')
  if (description !== undefined && typeof description !== 'string')
    problems.push('description must be a string')
  if (
    minHoliVersion !== undefined &&
    (typeof minHoliVersion !== 'string' || !SEMVER.test(minHoliVersion))
  )
    problems.push('minHoliVersion must be semver')
  if (!isStringList(opens)) problems.push('opens must be a list of file names')
  else
    for (const pattern of opens)
      if (!BASENAME.test(pattern) && !EXTENSION.test(pattern))
        problems.push(`opens: "${pattern}" is neither a file name nor *.extension`)
  if (folder !== undefined) {
    const f = isRecord(folder) ? folder : {}
    if (typeof f.suffix !== 'string' || !FOLDER_SUFFIX.test(f.suffix))
      problems.push('folder.suffix must be a name ending such as .deck')
    if (typeof f.entry !== 'string' || !BASENAME.test(f.entry))
      problems.push('folder.entry must be a file name, such as slides.md')
  }
  const opensSomething = (isStringList(opens) && opens.length > 0) || folder !== undefined
  if (
    apps !== undefined &&
    (!isStringList(apps) || apps.some((p) => !isPluginRelativePath(p) || !APP_FOLDER.test(p)))
  )
    problems.push(
      'apps must be a list of folders inside the plugin ending in .app, like apps/Notes.app',
    )
  if (!opensSomething && apps === undefined && skills === undefined && bin === undefined)
    problems.push(
      'the plugin must do something: list opens, give a folder, or ship apps, skills or commands',
    )
  if (setup !== undefined) problems.push(...commandProblems('setup', setup, []))
  if (opensSomething || serve !== undefined)
    problems.push(...commandProblems('serve', serve, ['{port}']))
  if (
    ignore !== undefined &&
    (!isStringList(ignore) || ignore.some((l) => l.trim() === '' || l.includes('\n')))
  )
    problems.push('ignore must be a list of single .gitignore lines')
  if (
    skills !== undefined &&
    (!isStringList(skills) || skills.some((p) => !isPluginRelativePath(p)))
  )
    problems.push('skills must be a list of folders inside the plugin, like skills/prezzi')
  if (bin !== undefined) {
    if (!isRecord(bin) || Object.keys(bin).length === 0)
      problems.push(
        'bin must map command names to files in the plugin, like {"dashctl": "bin/dashctl"}',
      )
    else
      for (const [name, file] of Object.entries(bin)) {
        if (!isCommandName(name))
          problems.push(
            name === 'holi'
              ? "bin: holi is Holi's own command"
              : `bin: "${name}" is not a command name (lowercase letters, digits, . _ -)`,
          )
        if (typeof file !== 'string' || !isPluginRelativePath(file))
          problems.push(`bin: ${name} must name a file inside the plugin, like bin/${name}`)
      }
  }

  if (check !== undefined) {
    if (!isRecord(check))
      problems.push('check must be an object, like {"run": ["tool", "version"], "hint": "..."}')
    else {
      problems.push(...commandProblems('check.run', check.run, []))
      const hint = check.hint
      if (
        typeof hint !== 'string' ||
        hint.trim() === '' ||
        hint.includes('\n') ||
        hint.length > CHECK_HINT_MAX
      )
        problems.push(`check.hint must be one line of text, at most ${CHECK_HINT_MAX} characters`)
    }
  }

  if (problems.length > 0) return { ok: false, problems }
  const manifest: PluginManifest = {
    id: id as string,
    name: name as string,
    version: version as string,
    opens: opens as string[],
  }
  if (serve !== undefined) manifest.serve = serve as string[]
  if (apps !== undefined) manifest.apps = apps as string[]
  if (description !== undefined) manifest.description = description as string
  if (minHoliVersion !== undefined) manifest.minHoliVersion = minHoliVersion as string
  if (setup !== undefined) manifest.setup = setup as string[]
  if (ignore !== undefined) manifest.ignore = ignore as string[]
  if (skills !== undefined) manifest.skills = skills as string[]
  if (bin !== undefined) manifest.bin = { ...(bin as Record<string, string>) }
  if (check !== undefined) {
    const c = check as { run: string[]; hint: string }
    manifest.check = { run: [...c.run], hint: c.hint.trim() }
  }
  if (folder !== undefined) {
    const f = folder as { suffix: string; entry: string }
    manifest.folder = { suffix: f.suffix, entry: f.entry }
  }
  return { ok: true, value: manifest }
}

/** Read a vault's pin, already parsed from JSON. */
export function parsePluginPin(json: unknown): Parsed<PluginPin> {
  const record = isRecord(json) ? json : {}
  const path = isPluginPath(record.path) ? record.path : ''
  const manifest = parsePluginManifest(json, path)
  const problems = manifest.ok ? [] : [...manifest.problems]
  if (!isRepoName(record.repo)) problems.push('repo must be owner/repo')
  if (!isPluginPath(record.path))
    problems.push("path must be '' for the repository's root or the plugin's folder")
  if (typeof record.commit !== 'string' || !COMMIT.test(record.commit))
    problems.push('commit must be a full 40-character commit')
  if (!manifest.ok || problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    value: {
      ...manifest.value,
      repo: record.repo as string,
      path,
      commit: record.commit as string,
    },
  }
}

/** Where a plugin's server for one file is framed: `localhost`, which is
 *  the loopback whichever of 127.0.0.1 or ::1 the server took (Vite takes
 *  ::1 on macOS). Main registers this origin with the window guard and the
 *  renderer frames it, so the two cannot disagree. */
export function pluginServerOrigin(port: number): string {
  return `http://localhost:${port}`
}

/** Is the folder at vault path `path` one the plugin opens, by its name?
 *  Whether it holds the entry is the file tree's to check. */
export function isPluginFolder(manifest: Pick<PluginManifest, 'folder'>, path: string): boolean {
  if (manifest.folder === undefined) return false
  const base = path.slice(path.lastIndexOf('/') + 1)
  const { suffix } = manifest.folder
  return base.length > suffix.length && base.endsWith(suffix)
}

/** The file the plugin's server is given for vault path `path`: a folder's
 *  entry, the file itself, or null when the plugin opens neither. */
export function servedFile(
  manifest: Pick<PluginManifest, 'opens' | 'folder'>,
  path: string,
): string | null {
  if (isPluginFolder(manifest, path)) return `${path}/${manifest.folder!.entry}`
  return opensPath(manifest, path) ? path : null
}

/** Does the plugin open the file at vault path `path`? */
export function opensPath(manifest: Pick<PluginManifest, 'opens'>, path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return manifest.opens.some((pattern) =>
    pattern.startsWith('*.')
      ? base.length > pattern.length - 1 && base.endsWith(pattern.slice(1))
      : base === pattern,
  )
}
