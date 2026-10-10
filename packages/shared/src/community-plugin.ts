/**
 * What a community plugin says about itself, and what a vault pins of it.
 *
 * A community plugin is a third-party *process plugin*: a git repository with
 * a `holi-plugin.json` at its root, which Holi installs on this machine, sets
 * up once with the manifest's `setup` command, and runs with its `serve`
 * command for each file it opens, framing the local server it starts. Its code
 * never loads into Holi's own processes. A vault that uses one commits a
 * **pin**, `.holi/plugins/<id>/manifest.json`: the manifest plus the repository
 * and commit it came from, so every member is offered the same code.
 * See docs/features/community-plugins.md.
 *
 * Main reads this grammar when it installs and pins; the renderer reads it to
 * know which files a plugin opens. Pure and browser-safe.
 */
import { isPluginId } from './plugins'

/** The manifest's name at a plugin repository's root. */
export const PLUGIN_MANIFEST_FILE = 'holi-plugin.json'

/** Where a vault keeps its pins. */
export const PLUGIN_PINS_DIR = '.holi/plugins'

/** A pin's path in the vault. */
export function pluginPinPath(id: string): string {
  return `${PLUGIN_PINS_DIR}/${id}/manifest.json`
}

/** The placeholders a command may carry, filled in by main for each run. */
export const COMMAND_PLACEHOLDERS = ['{file}', '{vault}', '{port}'] as const

export interface PluginManifest {
  id: string
  name: string
  /** Semver, and the tag a release is fetched at is `v<version>`. */
  version: string
  description?: string
  /** The oldest Holi it runs on. */
  minHoliVersion?: string
  /** The files it opens, by name: an exact basename (`slides.md`) or an
   *  extension (`*.deck`). No globs, because the file tree asks for every row. */
  opens: string[]
  /** Run once after install or update, in the plugin's own folder. An argv,
   *  never a shell string. */
  setup?: string[]
  /** Run for each opened file; must carry `{port}`, where it must listen on
   *  127.0.0.1. An argv. */
  serve: string[]
  /** Lines for the vault's managed `.gitignore` block: what the server writes
   *  beside a file that must not sync. */
  ignore?: string[]
}

export interface PluginPin extends PluginManifest {
  /** `owner/repo` on GitHub. */
  repo: string
  /** The full commit the vault's members are offered. */
  commit: string
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] }

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const BASENAME = /^[^/\\*?[\]{}]+$/
const EXTENSION = /^\*\.[A-Za-z0-9][A-Za-z0-9.-]*$/
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
const COMMIT = /^[0-9a-f]{40}$/
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

/** Read a `holi-plugin.json`, already parsed from JSON. */
export function parsePluginManifest(json: unknown): Parsed<PluginManifest> {
  if (!isRecord(json)) return { ok: false, problems: ['the manifest must be a JSON object'] }
  const problems: string[] = []
  const { id, name, version, description, minHoliVersion, opens, setup, serve, ignore } = json

  if (!isPluginId(id)) problems.push('id must be kebab-case, starting with a letter')
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
  if (!isStringList(opens) || opens.length === 0)
    problems.push('opens must list at least one file name')
  else
    for (const pattern of opens)
      if (!BASENAME.test(pattern) && !EXTENSION.test(pattern))
        problems.push(`opens: "${pattern}" is neither a file name nor *.extension`)
  if (setup !== undefined) problems.push(...commandProblems('setup', setup, []))
  problems.push(...commandProblems('serve', serve, ['{port}']))
  if (
    ignore !== undefined &&
    (!isStringList(ignore) || ignore.some((l) => l.trim() === '' || l.includes('\n')))
  )
    problems.push('ignore must be a list of single .gitignore lines')

  if (problems.length > 0) return { ok: false, problems }
  const manifest: PluginManifest = {
    id: id as string,
    name: name as string,
    version: version as string,
    opens: opens as string[],
    serve: serve as string[],
  }
  if (description !== undefined) manifest.description = description as string
  if (minHoliVersion !== undefined) manifest.minHoliVersion = minHoliVersion as string
  if (setup !== undefined) manifest.setup = setup as string[]
  if (ignore !== undefined) manifest.ignore = ignore as string[]
  return { ok: true, value: manifest }
}

/** Read a vault's pin, already parsed from JSON. */
export function parsePluginPin(json: unknown): Parsed<PluginPin> {
  const manifest = parsePluginManifest(json)
  const problems = manifest.ok ? [] : [...manifest.problems]
  const record = isRecord(json) ? json : {}
  if (!isRepoName(record.repo)) problems.push('repo must be owner/repo')
  if (typeof record.commit !== 'string' || !COMMIT.test(record.commit))
    problems.push('commit must be a full 40-character commit')
  if (!manifest.ok || problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    value: { ...manifest.value, repo: record.repo as string, commit: record.commit as string },
  }
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
