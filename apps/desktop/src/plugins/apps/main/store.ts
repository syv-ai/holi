/**
 * A vault app's store, on disk: one JSON file per record under
 * `<bundle>/data/<collection>/`.
 *
 * Main does every write, so every write is checked the same way whichever door
 * it came through: the collection is declared in `app.yaml`, the id is one
 * safe filename segment, the value fits its schema and the size cap. The file
 * is written in `formatRecord`'s canonical form, so a diff shows only what
 * changed and the merge driver can compare fields byte for byte.
 *
 * The manifest is re-read on every call: it is a few lines, and a cached copy
 * would go stale the moment the agent edits a schema.
 */
import { readFile, readdir, rm } from 'node:fs/promises'
import { DATA_DIR, formatRecord, vaultRelPath } from '@holi/shared'
import { APP_MANIFEST_FILE, parseAppManifest } from '../shared/manifest'
import {
  MAX_RECORD_BYTES,
  isRecordId,
  newRecordId,
  recordRel,
  validateRecord,
  type CollectionSchema,
} from '../shared/store'
import { exactPath } from '@holi/shared/path-safety-node'
import { CapabilityError, writeAtomic } from '../../../main/plugin-api'

export interface StoredRecord {
  id: string
  value: Record<string, unknown>
}

function relOrThrow(path: string) {
  try {
    return vaultRelPath(path)
  } catch (err) {
    throw new CapabilityError('BAD_REQUEST', (err as Error).message)
  }
}

/**
 * A store file's absolute path, refused unless its name is the file on disk.
 * A committed `data/items -> ../../memory` would otherwise let a record write
 * land in the agent surface, or out of the vault.
 */
async function onDisk(root: string, path: string): Promise<string> {
  const abs = await exactPath(root, relOrThrow(path))
  if (abs === null) throw new CapabilityError('FORBIDDEN', path)
  return abs
}

/** The collection's schema, or a refusal the agent can act on. */
async function collectionOf(
  root: string,
  bundle: string,
  collection: string,
): Promise<{ schema?: CollectionSchema }> {
  const text = await readFile(await onDisk(root, `${bundle}/${APP_MANIFEST_FILE}`), 'utf8').catch(
    () => null,
  )
  if (text === null) throw new CapabilityError('NOT_FOUND', `app is not finished: ${bundle}`)
  const collections = parseAppManifest(text)?.collections ?? {}
  // Own keys only: `constructor` or `toString` must not count as declared by
  // being on every object's prototype.
  const declared = Object.hasOwn(collections, collection) ? collections[collection] : undefined
  if (declared === undefined || !isRecordId(collection)) {
    throw new CapabilityError(
      'BAD_REQUEST',
      `undeclared collection: ${collection} (declare it under collections: in ${bundle}/${APP_MANIFEST_FILE})`,
    )
  }
  return declared
}

function idOrThrow(id: string): string {
  if (!isRecordId(id)) {
    throw new CapabilityError(
      'BAD_REQUEST',
      `bad id: ${id} (letters, digits, . _ -; no leading dot)`,
    )
  }
  return id
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

export async function storeList(
  root: string,
  bundle: string,
  collection: string,
): Promise<{ records: StoredRecord[]; skipped: string[] }> {
  await collectionOf(root, bundle, collection)
  const dir = await onDisk(root, `${bundle}/${DATA_DIR}/${collection}`)
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'))
  const records: StoredRecord[] = []
  const skipped: string[] = []
  for (const name of names.sort()) {
    const id = name.slice(0, -'.json'.length)
    const abs = await onDisk(root, recordRel(bundle, collection, id)).catch(() => null)
    const value = abs === null ? null : await readRecord(abs)
    // A hand edit that broke a file must not blank the app: list the rest, and
    // say which file was left out.
    if (value === null || !isRecordId(id)) skipped.push(name)
    else records.push({ id, value })
  }
  return { records, skipped }
}

async function readRecord(abs: string): Promise<Record<string, unknown> | null> {
  const text = await readFile(abs, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

export async function storeGet(
  root: string,
  bundle: string,
  collection: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  await collectionOf(root, bundle, collection)
  return readRecord(await onDisk(root, recordRel(bundle, collection, idOrThrow(id))))
}

export async function storePut(
  root: string,
  bundle: string,
  collection: string,
  id: string | undefined,
  value: unknown,
): Promise<string> {
  const { schema } = await collectionOf(root, bundle, collection)
  const recordId = idOrThrow(id ?? newRecordId())
  const problems = validateRecord(schema, value)
  if (problems.length > 0) throw new CapabilityError('BAD_REQUEST', problems.join('; '))
  const text = formatRecord(value)
  if (new TextEncoder().encode(text).length > MAX_RECORD_BYTES) {
    throw new CapabilityError('BAD_REQUEST', `record too large (over ${MAX_RECORD_BYTES} bytes)`)
  }
  const rel = recordRel(bundle, collection, recordId)
  await onDisk(root, rel)
  await writeAtomic(root, relOrThrow(rel), text)
  return recordId
}

export async function storeDelete(
  root: string,
  bundle: string,
  collection: string,
  id: string,
): Promise<boolean> {
  await collectionOf(root, bundle, collection)
  const abs = await onDisk(root, recordRel(bundle, collection, idOrThrow(id)))
  const existed = await readFile(abs).then(
    () => true,
    () => false,
  )
  if (existed) await rm(abs, { force: true })
  return existed
}

/**
 * The problems with one data file written by hand, for the agent's check hook.
 * `path` is vault-relative and must be `<bundle>/data/<collection>/<id>.json`.
 */
export async function storeCheck(root: string, bundle: string, rest: string): Promise<string[]> {
  const match = /^data\/([^/]+)\/([^/]+)\.json$/.exec(rest)
  if (match === null) return [`not a record file: ${bundle}/${rest}`]
  const [, collection, id] = match as unknown as [string, string, string]
  const { schema } = await collectionOf(root, bundle, collection)
  if (!isRecordId(id)) return [`bad id: ${id}`]
  const text = await readFile(await onDisk(root, `${bundle}/${rest}`), 'utf8').catch(() => null)
  if (text === null) throw new CapabilityError('NOT_FOUND', `${bundle}/${rest}`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return [`not valid JSON: ${(err as Error).message}`]
  }
  return validateRecord(schema, value)
}
