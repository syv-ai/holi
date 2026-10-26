/**
 * The rules of a vault app's store and log: what a schema may say, what an id
 * may be, where a record lives, and how the log is trimmed. Main does every
 * write (`../main/store.ts`, `../main/log.ts`); this module is the pure part.
 * Where records and the log live, and how a record is formatted and merged,
 * are core's (`@holi/shared`), because a synced vault holds them whatever
 * this machine runs.
 *
 * Browser-safe: no `node:` imports.
 */
import { DATA_DIR, formatRecord } from '@holi/shared'

/** How long a log entry is kept, and the most the file holds. */
const APP_LOG_TTL_MS = 24 * 60 * 60 * 1000
export const APP_LOG_MAX_ENTRIES = 500
/** The most of those that may be `info` (the console's log and info): a
 *  chatty app's own output never pushes its errors out. */
const APP_LOG_MAX_INFO = 200
/** One entry's text past this is cut: a log line, not a dump. */
export const APP_LOG_MAX_TEXT = 4000

/** `load` is the frame starting a document: where `holi apps console` starts
 *  reading. */
export const APP_LOG_LEVELS = ['error', 'warn', 'info', 'load'] as const
export type AppLogLevel = (typeof APP_LOG_LEVELS)[number]

export interface AppLogEntry {
  level: AppLogLevel
  text: string
  /** When the frame reported it. */
  at: Date
}

const levelOf = (entry: string): string | undefined => entry.split(' ', 2)[1]

/** The log's entries, oldest first: a line starting with its ISO time and
 *  level, and a multi-line text's indented continuation lines with it. */
export function appLogEntries(log: string | null): string[] {
  const entries: string[] = []
  for (const line of (log ?? '').split('\n')) {
    if (line === '') continue
    if (/^\d{4}-\d\d-\d\dT/.test(line) || entries.length === 0) entries.push(line)
    else entries[entries.length - 1] += `\n${line}`
  }
  return entries
}

/** The entries since the app last loaded, its load line first; the whole log
 *  when no load is in it. */
export function appLogSinceLoad(log: string | null): string[] {
  const entries = appLogEntries(log)
  for (let at = entries.length - 1; at >= 0; at--) {
    if (levelOf(entries[at]!) === 'load') return entries.slice(at)
  }
  return entries
}

/**
 * The log with `added` appended (oldest first) and what is past its day, or
 * over the caps, dropped: the oldest `info` past its own cap, then the oldest
 * of anything past the log's. An entry is a line starting with its ISO time
 * and level; a multi-line text (a stack) continues on lines indented by two
 * spaces, so it stays one entry when the log is trimmed.
 */
export function appendAppLog(
  existing: string | null,
  added: readonly AppLogEntry[],
  now: Date,
): string {
  const cutoff = now.getTime() - APP_LOG_TTL_MS
  const kept = appLogEntries(existing).filter((e) => {
    const at = Date.parse(e.slice(0, e.indexOf(' ')))
    return Number.isFinite(at) && at >= cutoff
  })
  for (const entry of added) {
    const text = entry.text.slice(0, APP_LOG_MAX_TEXT).replace(/\r\n?/g, '\n')
    const [first = '', ...rest] = text.split('\n')
    kept.push(
      [`${entry.at.toISOString()} ${entry.level} ${first}`, ...rest.map((l) => `  ${l}`)].join(
        '\n',
      ),
    )
  }
  let info = kept.filter((e) => levelOf(e) === 'info').length
  const trimmed = kept.filter((e) => levelOf(e) !== 'info' || info-- <= APP_LOG_MAX_INFO)
  return `${trimmed.slice(-APP_LOG_MAX_ENTRIES).join('\n')}\n`
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

/** Equal values, whatever their keys' order. */
const sameJson = (a: unknown, b: unknown): boolean => formatRecord(a) === formatRecord(b)

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
