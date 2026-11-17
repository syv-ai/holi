import { rewriteWikiLinksLosslessly } from '@holi/shared/wiki-links'
import type { NativeFiles, StorageCheckpointCallback } from './native-files'

function utf8Encode(value: string): Uint8Array {
  return new Uint8Array(
    Array.from(unescape(encodeURIComponent(value)), (character) => character.charCodeAt(0)),
  )
}

function utf8Decode(value: Uint8Array): string {
  return decodeURIComponent(
    Array.from(value, (byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
  )
}

function createOperationId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16)
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16)
  })
}

const prefix = 'move-'
const suffix = '.json'
const maxJournalBytes = 16 * 1024 * 1024

type Change = { path: string; before: number[] | null; after: number[] | null }
type Journal = { schema: 1; root: string; operationId: string; changes: Change[] }

const bytes = (value: Uint8Array | null) => (value === null ? null : Array.from(value))
const decode = (value: number[] | null) => (value === null ? null : new Uint8Array(value))
const equal = (a: Uint8Array | null, b: Uint8Array | null) =>
  a === null
    ? b === null
    : b !== null && a.length === b.length && a.every((byte, i) => byte === b[i])
const journalName = (id: string) => `${prefix}${id}${suffix}`

function validateJournal(raw: Uint8Array, root: string, name: string): Journal {
  if (raw.length > maxJournalBytes) throw new Error('Move recovery journal is too large')
  let value: unknown
  try {
    value = JSON.parse(utf8Decode(raw))
  } catch {
    throw new Error('Malformed move recovery journal')
  }
  if (!value || typeof value !== 'object') throw new Error('Malformed move recovery journal')
  const journal = value as Journal
  if (
    journal.schema !== 1 ||
    journal.root !== root ||
    typeof journal.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      journal.operationId,
    ) ||
    name !== journalName(journal.operationId) ||
    !Array.isArray(journal.changes) ||
    journal.changes.length < 2 ||
    journal.changes.length > 100000
  )
    throw new Error('Invalid move recovery journal identity')
  const seen = new Set<string>()
  for (const item of journal.changes) {
    if (!item || typeof item.path !== 'string' || seen.has(item.path))
      throw new Error('Invalid move recovery paths')
    seen.add(item.path)
    for (const image of [item.before, item.after]) {
      if (
        image !== null &&
        (!Array.isArray(image) ||
          image.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
      )
        throw new Error('Invalid move recovery image')
    }
    if (equal(decode(item.before), decode(item.after)))
      throw new Error('No-op move recovery change')
  }
  return journal
}

async function checkpoint(
  callback: StorageCheckpointCallback | undefined,
  phase: 'journal' | 'file' | 'cleanup',
  direction: 'before' | 'after',
  operationId: string,
  path?: string,
) {
  if (callback)
    await callback({
      phase: `${phase}-${direction}` as
        | 'journal-before'
        | 'journal-after'
        | 'file-before'
        | 'file-after'
        | 'cleanup-before'
        | 'cleanup-after',
      direction,
      operationId,
      path,
    })
}

async function apply(
  adapter: NativeFiles,
  root: string,
  change: Change,
  journal: Journal,
  callback?: StorageCheckpointCallback,
) {
  const wanted = decode(change.after)
  const current = await adapter.readOptional(root, change.path)
  if (equal(current, wanted)) return
  if (!equal(current, decode(change.before)))
    throw new Error(`Move recovery conflict at ${change.path}`)
  await checkpoint(callback, 'file', 'before', journal.operationId, change.path)
  if (wanted === null) await adapter.remove(root, change.path, current!)
  else if (change.before === null) await adapter.create(root, change.path, wanted)
  else await adapter.publish(root, change.path, wanted, current)
  const verified = await adapter.readOptional(root, change.path)
  if (!equal(verified, wanted)) throw new Error(`Move publication did not verify at ${change.path}`)
  await checkpoint(callback, 'file', 'after', journal.operationId, change.path)
}

/** Owns durable move planning and idempotent recovery; callers serialize it with storage access. */
export async function recoverMoves(
  adapter: NativeFiles,
  root: string,
  validatePath: (path: string) => string,
  callback?: StorageCheckpointCallback,
): Promise<void> {
  const names = await adapter.privateList(root)
  const pending: { name: string; journal: Journal }[] = []
  const paths = new Set<string>()
  for (const name of names.sort()) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix))
      throw new Error('Unknown private vault storage artifact')
    const journal = validateJournal(await adapter.privateRead(root, name), root, name)
    const validatedPaths = new Set<string>()
    for (const change of journal.changes) {
      const validated = validatePath(change.path)
      if (validated !== change.path || validatedPaths.has(validated) || paths.has(validated))
        throw new Error('Invalid or duplicate move recovery path')
      validatedPaths.add(validated)
      paths.add(validated)
    }
    // Check every operation's precondition before any recovery mutation.
    const states = await Promise.all(
      journal.changes.map((change) => adapter.readOptional(root, change.path)),
    )
    journal.changes.forEach((change, index) => {
      const state = states[index] ?? null
      if (!equal(state, decode(change.before)) && !equal(state, decode(change.after)))
        throw new Error(`Move recovery conflict at ${change.path}`)
    })
    pending.push({ name, journal })
  }
  for (const { name, journal } of pending) {
    for (const change of journal.changes) await apply(adapter, root, change, journal, callback)
    await checkpoint(callback, 'cleanup', 'before', journal.operationId, name)
    const raw = await adapter.privateRead(root, name)
    await adapter.privateRemove(root, name, raw)
    await checkpoint(callback, 'cleanup', 'after', journal.operationId, name)
  }
}

export async function moveNote(
  adapter: NativeFiles,
  root: string,
  from: string,
  to: string,
  expectedRevision: string,
  validatePath: (path: string) => string,
  revision: (bytes: Uint8Array) => string,
  callback?: StorageCheckpointCallback,
): Promise<{ path: string; bytes: Uint8Array; revision: string }> {
  const source = validatePath(from)
  const target = validatePath(to)
  if (
    source === target ||
    !source.toLowerCase().endsWith('.md') ||
    !target.toLowerCase().endsWith('.md')
  )
    throw new Error('Move requires two distinct markdown notes')
  if (
    source.startsWith('.') ||
    target.startsWith('.') ||
    source.split('/').some((part) => part.startsWith('.')) ||
    target.split('/').some((part) => part.startsWith('.'))
  )
    throw new Error('Move note path is not public')
  const sourceBytes = await adapter.read(root, source)
  if (revision(sourceBytes) !== expectedRevision) throw new Error('Stale document revision')
  const entries = await adapter.list(root)
  const files = entries.filter(
    (entry) => entry.kind === 'file' && entry.path.toLowerCase().endsWith('.md'),
  )
  const folded = (path: string) => path.normalize('NFD').toLowerCase()
  const directories = new Set(
    entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path),
  )
  const parent = target.split('/').slice(0, -1).join('/')
  if (parent && !directories.has(parent))
    throw new Error('Move destination directory must already exist')
  if (
    files.some((entry) => folded(entry.path) === folded(target)) ||
    entries.some((entry) => folded(entry.path) === folded(target))
  )
    throw new Error('Move destination already exists or aliases an existing path')
  const changes: Change[] = [
    { path: source, before: bytes(sourceBytes), after: null },
    { path: target, before: null, after: bytes(sourceBytes) },
  ]
  for (const entry of files) {
    if (entry.path === source) continue
    const before = await adapter.read(root, entry.path)
    const text = utf8Decode(before)
    const rewritten = rewriteWikiLinksLosslessly(text, source, target)
    if (rewritten.count)
      changes.push({
        path: entry.path,
        before: bytes(before),
        after: bytes(utf8Encode(rewritten.text)),
      })
  }
  const operationId = createOperationId()
  const journal: Journal = { schema: 1, root, operationId, changes }
  const journalBytes = utf8Encode(JSON.stringify(journal))
  if (journalBytes.length > maxJournalBytes) throw new Error('Move recovery journal is too large')
  await checkpoint(callback, 'journal', 'before', operationId)
  await adapter.privatePublish(root, journalName(operationId), journalBytes, null)
  await checkpoint(callback, 'journal', 'after', operationId)
  // Revalidate the complete plan immediately before mutation.
  for (const change of changes) {
    const current = await adapter.readOptional(root, change.path)
    if (!equal(current, decode(change.before)))
      throw new Error(`Move precondition changed at ${change.path}`)
  }
  await recoverMoves(adapter, root, validatePath, callback)
  return { path: target, bytes: sourceBytes, revision: revision(sourceBytes) }
}
