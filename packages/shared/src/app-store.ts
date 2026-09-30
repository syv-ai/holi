/**
 * The rules of a vault app's store: what a record is, where it lives, what a
 * schema may say, and how two edits of one record merge.
 *
 * A record is one JSON object in one file, `<bundle>/data/<collection>/<id>.json`,
 * so app state is as readable, diffable and portable as a note. Main does every
 * write (`apps/desktop/src/main/apps/app-store.ts`); this module is the pure part
 * both main and the tests read.
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

/** How long a log entry is kept, and the most the file holds. */
export const APP_LOG_TTL_MS = 24 * 60 * 60 * 1000
export const APP_LOG_MAX_ENTRIES = 500
/** One entry's text past this is cut: a log line, not a dump. */
export const APP_LOG_MAX_TEXT = 4000

export type AppLogLevel = 'error' | 'warn' | 'info'

/**
 * Is a path inside a bundle (`rest`) one that is Holi's to reach, not the
 * app's as a file: its records, and its log. Case-insensitive like
 * `isAppDataPath`.
 */
export function isAppPrivatePath(rest: string): boolean {
  return isAppDataPath(rest) || rest.toLowerCase() === APP_LOG_FILE
}

/**
 * The log with one entry added and what is past its day (or over the cap)
 * dropped. An entry is a line starting with its ISO time and level; a
 * multi-line text (a stack) continues on lines indented by two spaces, so it
 * stays one entry when the log is trimmed.
 */
export function appendAppLog(
  existing: string | null,
  entry: { level: AppLogLevel; text: string },
  now: Date,
): string {
  const entries: string[] = []
  for (const line of (existing ?? '').split('\n')) {
    if (line === '') continue
    if (/^\d{4}-\d\d-\d\dT/.test(line) || entries.length === 0) entries.push(line)
    else entries[entries.length - 1] += `\n${line}`
  }
  const cutoff = now.getTime() - APP_LOG_TTL_MS
  const kept = entries.filter((e) => {
    const at = Date.parse(e.slice(0, e.indexOf(' ')))
    return Number.isFinite(at) && at >= cutoff
  })
  const text = entry.text.slice(0, APP_LOG_MAX_TEXT).replace(/\r\n?/g, '\n')
  const [first = '', ...rest] = text.split('\n')
  kept.push(
    [`${now.toISOString()} ${entry.level} ${first}`, ...rest.map((l) => `  ${l}`)].join('\n'),
  )
  return `${kept.slice(-APP_LOG_MAX_ENTRIES).join('\n')}\n`
}

/** The largest record main will write, formatted. A record is a row, not a file store. */
export const MAX_RECORD_BYTES = 256 * 1024

type JsonType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

/**
 * The JSON Schema subset a collection may declare. The agent already knows
 * JSON Schema, so this is a subset of it rather than a language of Holi's own;
 * a keyword outside it is ignored, so a richer schema still loads.
 */
export interface CollectionSchema {
  type?: JsonType | JsonType[]
  properties?: Record<string, CollectionSchema>
  required?: string[]
  additionalProperties?: boolean
  enum?: unknown[]
  items?: CollectionSchema
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const TYPE_WORDS: Record<JsonType, string> = {
  object: 'an object',
  array: 'an array',
  string: 'a string',
  number: 'a number',
  integer: 'an integer',
  boolean: 'a boolean',
  null: 'null',
}

function hasType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
  }
}

function check(schema: CollectionSchema, value: unknown, path: string, out: string[]): void {
  const at = path === '' ? 'record' : path
  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(
      (t): t is JsonType => typeof t === 'string' && t in TYPE_WORDS,
    )
    if (types.length > 0 && !types.some((t) => hasType(value, t))) {
      out.push(`${at}: must be ${types.map((t) => TYPE_WORDS[t]).join(' or ')}`)
      return
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => sameJson(e, value))) {
    out.push(`${at}: must be one of ${schema.enum.map((e) => String(e)).join(', ')}`)
    return
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      out.push(`${at}: must be at least ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      out.push(`${at}: must be at most ${schema.maximum}`)
    }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      out.push(`${at}: must be at least ${schema.minLength} characters`)
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      out.push(`${at}: must be at most ${schema.maxLength} characters`)
    }
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((item, i) => check(schema.items!, item, `${path}[${i}]`, out))
  }
  if (isPlainObject(value)) {
    const child = (key: string) => (path === '' ? key : `${path}.${key}`)
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.hasOwn(value, key)) {
          out.push(`${child(key)}: is required`)
        }
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.hasOwn(value, key) && isPlainObject(sub)) check(sub, value[key], child(key), out)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) out.push(`${child(key)}: is not allowed`)
      }
    }
  }
}

/**
 * Every problem with `value` as a record of a collection with this schema, one
 * readable line each, naming where it is (`tags[1]: must be a string`). Empty
 * means valid. A record is always a plain object, schema or not: a merge works
 * field by field, so it needs fields.
 */
export function validateRecord(schema: CollectionSchema | undefined, value: unknown): string[] {
  if (!isPlainObject(value)) return ['record: must be an object']
  const out: string[] = []
  if (schema !== undefined) check(schema, value, '', out)
  return out
}

/** A record id, and a collection name: one filename segment, readable in the
 *  tree. No leading dot (hidden), no `.local.` (a record that silently never
 *  syncs), nothing that could leave the collection's folder. */
export function isRecordId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 128 &&
    /^[A-Za-z0-9._-]+$/.test(id) &&
    !id.startsWith('.') &&
    !id.includes('.local.')
  )
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * A ULID: 10 characters of millisecond time, then 16 of randomness, in
 * Crockford base 32. Ids made later sort later, so a collection's files list
 * in the order they were written.
 */
export function newRecordId(
  now: number = Date.now(),
  random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(10)),
): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time
    t = Math.floor(t / 32)
  }
  const bytes = random()
  let bits = 0
  let acc = 0
  let rand = ''
  for (let i = 0; i < 10; i++) {
    acc = (acc << 8) | (bytes[i] ?? 0)
    bits += 8
    while (bits >= 5) {
      bits -= 5
      rand += CROCKFORD[(acc >> bits) & 31]
    }
  }
  return time + rand
}

/** Where a record lives, vault-relative. */
export function recordRel(bundle: string, collection: string, id: string): string {
  return `${bundle}/${DATA_DIR}/${collection}/${id}.json`
}

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
