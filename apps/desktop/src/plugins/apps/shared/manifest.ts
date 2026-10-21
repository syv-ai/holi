/**
 * `app.yaml`: the file that makes a vault app real.
 *
 * An app is written file by file by an agent, and without a marker it would
 * register the moment its first byte lands, so a half-written app would appear
 * in the sidebar and open to a broken page. The manifest is written **last**,
 * and registration waits for it.
 *
 * YAML rather than JSON: it takes comments and does not fail on a trailing
 * comma, which matters for a file written unattended by a model.
 *
 * The parser is forgiving inside the mapping: a typo costs a field, never the
 * app, because an app that silently does not appear is the worst failure. Only
 * text that is not a mapping at all (a list, a number, a bare scalar) is refused.
 */
import { parse as parseYaml } from 'yaml'
import { isAppPrivatePath, vaultRelPath } from '@holi/shared'
import { isRecordId, type CollectionSchema } from './store'

/** The registration marker, at the app's own root. */
export const APP_MANIFEST_FILE = 'app.yaml'

export interface AppManifest {
  /** Free text, for the launchers. The name is the bundle's folder name,
   *  and the icon is the vault icon map's, as for any row. */
  description?: string
  /** The collections the app's store may use, by name, each with an optional
   *  schema main validates writes against. An undeclared collection is
   *  refused, so the data's shape is known up front. */
  collections?: Record<string, { schema?: CollectionSchema }>
  /**
   * The risky reads this app opts into, like Claude Code's
   * `--dangerously-skip-permissions`: without the flag the call fails, and with
   * it each person on each machine still approves the app before it runs them.
   * Keyed `dangerously-allow` in the YAML.
   */
  dangerouslyAllow?: AppAffordance[]
  /**
   * Why, in the app's own words, per affordance: shown in the approval
   * dialog, quoted and attributed to the app. Written as the map form of
   * `dangerously-allow` (`{ calendar: To show your next meeting }`).
   */
  allowReasons?: Partial<Record<AppAffordance, string>>
  /**
   * The secrets it needs, by name (`OPENAI_API_KEY`): the only keys
   * `holi.env` gives it from the vault's `.env` (docs/features/vault-apps.md).
   */
  env?: string[]
  /**
   * The hosts `holi.fetch` may reach (`network`), exactly: `api.example.com`
   * does not cover `example.com` or `x.api.example.com`. Keyed `hosts` in the
   * YAML. Anything that is not a plain hostname is dropped, and so are IP
   * addresses and `localhost`.
   */
  hosts?: string[]
  /**
   * The slash commands it adds to the notes editor, by name (what follows the
   * `/`): each a script in the bundle, run in a hidden frame of the app's own
   * origin when picked (docs/features/vault-apps.md).
   */
  commands?: Record<string, AppCommandSpec>
}

/** One slash command an app declares. */
export interface AppCommandSpec {
  /** The script, a `.js` file in the bundle, by its path there. */
  script: string
  /** Beside the name, in the slash menu. */
  description?: string
}

/** What a command's name may be: lower case, digits, `-` and `_`, as typed
 *  after the `/`. */
export const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/

/** A script path inside the bundle, or null: relative, a `.js` file, and not
 *  one the protocol refuses to serve (the records, the log). */
function commandScript(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const path = raw.trim().replace(/^\.\//, '')
  try {
    vaultRelPath(path)
  } catch {
    return null
  }
  if (!/\.js$/i.test(path) || isAppPrivatePath(path)) return null
  return path
}

/**
 * `commands:` as a map from each name to `{ script, description }`. An entry
 * whose name or script is wrong is dropped on its own.
 */
function parseCommands(raw: unknown): AppManifest['commands'] | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, AppCommandSpec> = {}
  for (const [name, spec] of Object.entries(raw)) {
    if (!COMMAND_NAME.test(name) || spec === null || typeof spec !== 'object') continue
    const { script, description } = spec as Record<string, unknown>
    const path = commandScript(script)
    if (path === null) continue
    out[name] =
      typeof description === 'string' && description.trim() !== ''
        ? { script: path, description: description.trim() }
        : { script: path }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** What a secret's name may be: an environment variable's, upper case. */
export const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

/** `env:` as a list of names; anything else in it is dropped. */
function parseEnv(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const names = raw.filter((n): n is string => typeof n === 'string' && ENV_NAME.test(n))
  return names.length > 0 ? [...new Set(names)] : undefined
}

/** A plain hostname: letters, digits, dots and dashes, no port or path. */
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

/** A name, not an address (no top-level domain is all digits), and not this
 *  machine: `holi.fetch` refuses both (`main/net.ts`), so they are dropped here
 *  too. */
const isReachableName = (host: string): boolean =>
  HOST.test(host) &&
  !/(^|\.)\d+$/.test(host) &&
  host !== 'localhost' &&
  !host.endsWith('.localhost')

function parseHosts(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const hosts = raw
    .filter((h): h is string => typeof h === 'string')
    .map((h) => h.trim().toLowerCase())
    .filter(isReachableName)
  return hosts.length > 0 ? [...new Set(hosts)] : undefined
}

/** The longest reason the approval dialog shows: a sentence, not a pitch. */
export const MAX_ALLOW_REASON = 200

/** The reads an app must opt into, because what they return is one person's,
 *  not the vault's: an app can keep it in synced records or send it anywhere.
 *  There is no `location`: Electron's geolocation needs Google's network
 *  service and does not answer on macOS, so no app is offered it.
 *  `recording` is the microphone and the computer's sound, recorded by Holi
 *  for the app (`holi.record`). `network` is `holi.fetch` to the hosts the
 *  manifest lists, and no others. */
export const APP_AFFORDANCES = ['mail', 'calendar', 'recording', 'network'] as const

export type AppAffordance = (typeof APP_AFFORDANCES)[number]

const isAffordance = (v: unknown): v is AppAffordance =>
  (APP_AFFORDANCES as readonly unknown[]).includes(v)

/**
 * `dangerously-allow:` as a list (`[mail, location]`) or as a map from each
 * affordance to the app's reason for it. A reason that is not text is no
 * reason, and the affordance still counts; one too long is cut.
 */
function parseAffordances(raw: unknown): Pick<AppManifest, 'dangerouslyAllow' | 'allowReasons'> {
  if (Array.isArray(raw)) {
    const known = raw.filter(isAffordance)
    return known.length > 0 ? { dangerouslyAllow: [...new Set(known)] } : {}
  }
  if (raw === null || typeof raw !== 'object') return {}
  const allow: AppAffordance[] = []
  const reasons: Partial<Record<AppAffordance, string>> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!isAffordance(key)) continue
    allow.push(key)
    if (typeof value === 'string' && value.trim() !== '') {
      reasons[key] = value.trim().slice(0, MAX_ALLOW_REASON)
    }
  }
  if (allow.length === 0) return {}
  return Object.keys(reasons).length > 0
    ? { dangerouslyAllow: allow, allowReasons: reasons }
    : { dangerouslyAllow: allow }
}

const KNOWN_KEYS = ['description'] as const

/**
 * `collections:` as a map (`items: {schema: …}`) or, for an app that wants no
 * schemas, a list of names. A name that is not a safe filename segment, or a
 * schema that is not a mapping, is dropped on its own; the keywords inside a
 * schema are the validator's business, which ignores what it does not know.
 */
function parseCollections(raw: unknown): AppManifest['collections'] | undefined {
  const isMap = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
  const entries: [string, unknown][] = Array.isArray(raw)
    ? raw.filter((n): n is string => typeof n === 'string').map((n) => [n, {}])
    : isMap(raw)
      ? Object.entries(raw)
      : []
  const out: NonNullable<AppManifest['collections']> = {}
  for (const [name, spec] of entries) {
    // `__proto__` would set the object's prototype rather than name a collection.
    if (!isRecordId(name) || name === '__proto__') continue
    const schema = isMap(spec) ? spec.schema : undefined
    out[name] = isMap(schema) ? { schema: schema as CollectionSchema } : {}
  }
  return entries.length > 0 ? out : undefined
}

/**
 * Never throws. `{}` for an empty, comment-only, or malformed manifest; `null`
 * only when the document parses into something that is not a mapping.
 */
export function parseAppManifest(yaml: string): AppManifest | null {
  let raw: unknown
  try {
    raw = parseYaml(yaml)
  } catch {
    return {}
  }
  // An empty document parses to `null`, and so does the literal `null`. Both
  // are an empty manifest: the file existing is the assertion being made.
  if (raw === null || raw === undefined) {
    return yaml.trim() === '' || isCommentOnly(yaml) ? {} : null
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null

  const manifest: AppManifest = {}
  for (const key of KNOWN_KEYS) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === 'string') manifest[key] = value
  }
  const collections = parseCollections((raw as Record<string, unknown>).collections)
  if (collections !== undefined) manifest.collections = collections
  Object.assign(manifest, parseAffordances((raw as Record<string, unknown>)['dangerously-allow']))
  const env = parseEnv((raw as Record<string, unknown>).env)
  if (env !== undefined) manifest.env = env
  const hosts = parseHosts((raw as Record<string, unknown>).hosts)
  if (hosts !== undefined) manifest.hosts = hosts
  const commands = parseCommands((raw as Record<string, unknown>).commands)
  if (commands !== undefined) manifest.commands = commands
  return manifest
}

/**
 * A new app's manifest, every key written out and the unused ones blank, so
 * whoever opens it (a person or the agent) sees everything an app can say
 * without looking it up. A blank key parses as unused.
 */
export function appManifestText(description?: string): string {
  return [
    '# This app\u2019s manifest. It is what makes the app appear, so it is written',
    '# last. Every key is optional; a blank one is unused.',
    '',
    '# What the app is for, shown where apps are listed. Its name is the folder\u2019s.',
    `description:${description === undefined ? '' : ` ${JSON.stringify(description)}`}`,
    '',
    '# The collections holi.store(name) may use, each with an optional JSON Schema:',
    '#   items:',
    '#     schema: { type: object, required: [title], properties: { title: { type: string } } }',
    'collections:',
    '',
    `# One person\u2019s data this app reads, or recording, approved by each person before it runs:`,
    `# any of ${APP_AFFORDANCES.join(', ')}. As a map, each with a reason the approval shows:`,
    '#   { calendar: To show your next meeting }',
    'dangerously-allow:',
    '',
    '# The secrets holi.env(name) may read, by name, from the vault\u2019s .env:',
    '#   [OPENAI_API_KEY]',
    'env:',
    '# With network: the exact hosts holi.fetch may reach, as a list:',
    '#   [api.example.com]',
    'hosts:',
    '',
    '# The slash commands it adds to notes, each a script that calls holi.command(fn):',
    '#   uppercase: { script: commands/uppercase.js, description: Uppercase the selection }',
    'commands:',
    '',
  ].join('\n')
}

/** A file of nothing but comments parses to `null` like an empty one does, and
 *  means the same thing — the author wrote a manifest and left it blank. */
function isCommentOnly(yaml: string): boolean {
  return yaml.split('\n').every((line) => line.trim() === '' || line.trim().startsWith('#'))
}
