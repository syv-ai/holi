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
import { isRecordId, type CollectionSchema } from './app-store'

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
}

/** The reads an app must opt into, because what they return is one person's,
 *  not the vault's: an app can keep it in synced records or send it anywhere.
 *  `location` is the browser's geolocation, allowed to that app's frame only. */
export const APP_AFFORDANCES = ['mail', 'calendar', 'location'] as const

export type AppAffordance = (typeof APP_AFFORDANCES)[number]

function parseAffordances(raw: unknown): AppAffordance[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const known = raw.filter((v): v is AppAffordance =>
    (APP_AFFORDANCES as readonly unknown[]).includes(v),
  )
  return known.length > 0 ? [...new Set(known)] : undefined
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
  const allow = parseAffordances((raw as Record<string, unknown>)['dangerously-allow'])
  if (allow !== undefined) manifest.dangerouslyAllow = allow
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
    `# One person\u2019s data this app reads, approved by each person before it runs:`,
    `# any of ${APP_AFFORDANCES.join(', ')}.`,
    'dangerously-allow:',
    '',
  ].join('\n')
}

/** A file of nothing but comments parses to `null` like an empty one does, and
 *  means the same thing — the author wrote a manifest and left it blank. */
function isCommentOnly(yaml: string): boolean {
  return yaml.split('\n').every((line) => line.trim() === '' || line.trim().startsWith('#'))
}
