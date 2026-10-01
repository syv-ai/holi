/**
 * What a synced vault holds of a vault app's state, whether or not this
 * machine runs the apps plugin: where its records and its log live, and how
 * two edits of one record merge. Core's fences and the record merge driver
 * read these; the rest of the store's rules are the plugin's
 * (`src/plugins/apps/shared/store.ts`).
 *
 * A record is one JSON object in one file, `<bundle>/data/<collection>/<id>.json`,
 * keys sorted, so app state is as readable, diffable and mergeable as a note.
 *
 * Browser-safe: no `node:` imports.
 */

/** The folder inside a bundle that holds its records. Never served to the app. */
export const DATA_DIR = 'data'

/**
 * Is a path inside a bundle (`rest`, relative to the bundle) in its `data/`?
 * Case-insensitive, because macOS's default filesystem is: `Data/x.json` is the
 * same file. Records are reached through the store only, never read as files.
 */
export function isAppDataPath(rest: string): boolean {
  return rest.split('/')[0]!.toLowerCase() === DATA_DIR
}

/**
 * The app's log, at its bundle's root: what went wrong while it ran, for the
 * vault's agent to read when someone says the app is broken. `.local.`, so it
 * never syncs; written by main from what the app's frame reports; never
 * served to the app, and trimmed to the last day as it is written.
 */
export const APP_LOG_FILE = 'log.local.txt'

/**
 * Is a path inside a bundle (`rest`) one that is Holi's to reach, not the
 * app's as a file: its records, and its log. Case-insensitive like
 * `isAppDataPath`.
 */
export function isAppPrivatePath(rest: string): boolean {
  return isAppDataPath(rest) || rest.toLowerCase() === APP_LOG_FILE
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isPlainObject(value)) return value
  // `fromEntries` defines own properties, so a `__proto__` key in the JSON
  // stays a field instead of becoming the object's prototype.
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys(value[k])]),
  )
}

/**
 * A record's file text: keys sorted at every depth, two-space indent, a
 * trailing newline. Equal values are always equal bytes, which is what makes
 * a diff show only what changed and what the merge compares.
 */
export function formatRecord(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Three-way merge of one record, field by field: the git merge driver's body.
 *
 * A field changed on one side only takes that side, a field removed counts as
 * a change, and a field both sides changed alike is taken once. Only a field
 * both sides changed differently is a conflict, which goes to the ordinary
 * reconcile. `base` is null when both sides added the same id, so the merge
 * holds only where they agree or do not overlap.
 */
export function mergeRecordText(
  base: string | null,
  ours: string,
  theirs: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  const b = base === null ? {} : parseObject(base)
  const o = parseObject(ours)
  const t = parseObject(theirs)
  if (b === null || o === null || t === null) return { ok: false, reason: 'not a JSON object' }

  // Own fields only: `constructor` absent on one side is absent, not a function.
  const field = (x: Record<string, unknown>, k: string) => (Object.hasOwn(x, k) ? x[k] : undefined)
  const merged: [string, unknown][] = []
  const conflicts: string[] = []
  const keys = [...new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])].sort()
  for (const key of keys) {
    const [bv, ov, tv] = [field(b, key), field(o, key), field(t, key)]
    let pick: unknown
    if (sameJson(ov, tv) || sameJson(tv, bv)) pick = ov
    else if (sameJson(ov, bv)) pick = tv
    else {
      conflicts.push(key)
      continue
    }
    if (pick !== undefined) merged.push([key, pick])
  }
  if (conflicts.length > 0) return { ok: false, reason: `both changed: ${conflicts.join(', ')}` }
  return { ok: true, text: formatRecord(Object.fromEntries(merged)) }
}
