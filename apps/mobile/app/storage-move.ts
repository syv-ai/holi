import {
  isInIgnoredDir,
  isLocalOnlyPath,
  isSecretPath,
  vaultRelPath,
} from '@holi/shared/mobile-path-safety'
import { formatWikiLink, parseWikiLinks, rewriteWikiLinksLosslessly } from '@holi/shared/wiki-links'
import type { NativeFiles, StorageCheckpointCallback } from './native-files'

function utf8Encode(value: string): Uint8Array {
  return new Uint8Array(
    Array.from(unescape(encodeURIComponent(value)), (character) => character.charCodeAt(0)),
  )
}

function utf8Decode(value: Uint8Array): string {
  const hasBom = value[0] === 0xef && value[1] === 0xbb && value[2] === 0xbf
  const content = hasBom ? value.subarray(3) : value
  return `${hasBom ? '\uFEFF' : ''}${decodeURIComponent(
    Array.from(content, (byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
  )}`
}

const prefix = 'move-'
const suffix = '.json'
const maxJournalBytes = 16 * 1024 * 1024

type Change = { path: string; before: number[] | null; after: number[] | null }
type Journal = {
  schema: 2
  root: string
  operationId: string
  from: string
  to: string
  changes: Change[]
}

const bytes = (value: Uint8Array | null) => (value === null ? null : Array.from(value))
const decode = (value: number[] | null) => (value === null ? null : new Uint8Array(value))
const equal = (a: Uint8Array | null, b: Uint8Array | null) =>
  a === null
    ? b === null
    : b !== null && a.length === b.length && a.every((byte, i) => byte === b[i])
const rewriteDocumentLinks = (text: string, from: string, to: string) => {
  const bom = text.startsWith('\uFEFF')
  const rewritten = rewriteWikiLinksLosslessly(bom ? text.slice(1) : text, from, to)
  return { ...rewritten, text: `${bom ? '\uFEFF' : ''}${rewritten.text}` }
}
const journalName = (id: string) => `${prefix}${id}${suffix}`
const comparePaths = (left: string, right: string) => {
  const a = Array.from(left, (character) => character.codePointAt(0)!)
  const b = Array.from(right, (character) => character.codePointAt(0)!)
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.length - b.length
}
const isPublicNote = (path: string) =>
  !path.split('/').some((segment) => segment.startsWith('.')) &&
  !isLocalOnlyPath(path) &&
  !isSecretPath(path) &&
  !isInIgnoredDir(path) &&
  path.toLowerCase().endsWith('.md')
const isRoundTripTarget = (path: string) => {
  const parsed = parseWikiLinks(formatWikiLink(path))
  return parsed.length === 1 && parsed[0]?.target === path && parsed[0]?.label === undefined
}

function validateJournal(raw: Uint8Array, root: string, name: string): Journal {
  if (!(raw instanceof Uint8Array) || raw.length > maxJournalBytes)
    throw new Error('Move recovery journal is too large or invalid')
  let value: unknown
  try {
    value = JSON.parse(utf8Decode(raw))
  } catch {
    throw new Error('Malformed move recovery journal')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed move recovery journal')
  const candidate = value as Partial<Journal>
  if (
    Object.keys(value).sort().join(',') !== 'changes,from,operationId,root,schema,to' ||
    candidate.schema !== 2 ||
    candidate.root !== root ||
    typeof candidate.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate.operationId,
    ) ||
    name !== journalName(candidate.operationId) ||
    typeof candidate.from !== 'string' ||
    typeof candidate.to !== 'string' ||
    !Array.isArray(candidate.changes) ||
    candidate.changes.length < 2 ||
    candidate.changes.length > 100000
  )
    throw new Error('Invalid move recovery journal identity')
  const from = vaultRelPath(candidate.from)
  const to = vaultRelPath(candidate.to)
  if (
    from !== candidate.from ||
    to !== candidate.to ||
    from === to ||
    from.normalize('NFD').toLowerCase() === to.normalize('NFD').toLowerCase() ||
    !isPublicNote(from) ||
    !isPublicNote(to) ||
    !isRoundTripTarget(from) ||
    !isRoundTripTarget(to)
  )
    throw new Error('Invalid move recovery identity paths')
  const changes = candidate.changes as unknown[]
  const seen = new Set<string>()
  const foldedPaths = new Set<string>()
  for (const item of changes) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Invalid move recovery change')
    const change = item as Partial<Change>
    if (
      Object.keys(item).sort().join(',') !== 'after,before,path' ||
      typeof change.path !== 'string' ||
      (!Array.isArray(change.before) && change.before !== null) ||
      (!Array.isArray(change.after) && change.after !== null) ||
      seen.has(change.path)
    )
      throw new Error('Invalid move recovery paths')
    const canonical = vaultRelPath(change.path)
    const folded = canonical.normalize('NFD').toLowerCase()
    if (
      canonical !== change.path ||
      !isPublicNote(canonical) ||
      !isRoundTripTarget(canonical) ||
      foldedPaths.has(folded)
    )
      throw new Error('Invalid move recovery path spelling')
    seen.add(change.path)
    foldedPaths.add(folded)
    for (const image of [change.before, change.after]) {
      if (
        image !== null &&
        (!Array.isArray(image) ||
          image.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
      )
        throw new Error('Invalid move recovery image')
    }
    if (equal(decode(change.before as number[] | null), decode(change.after as number[] | null)))
      throw new Error('No-op move recovery change')
  }
  if (
    (changes[0] && (changes[0] as Change).path !== from) ||
    (changes[0] &&
      ((changes[0] as Change).before === null || (changes[0] as Change).after !== null)) ||
    (changes[1] &&
      ((changes[1] as Change).path !== to ||
        (changes[1] as Change).before !== null ||
        (changes[1] as Change).after === null))
  )
    throw new Error('Invalid move source/destination plan')
  const sourceBefore = decode((changes[0] as Change).before!)!
  const sourceText = utf8Decode(sourceBefore)
  const moved = rewriteDocumentLinks(sourceText, from, to)
  if (!equal(decode((changes[1] as Change).after), utf8Encode(moved.text)))
    throw new Error('Invalid moved-note postimage')
  for (const item of changes.slice(2) as Change[]) {
    if (!item.path.toLowerCase().endsWith('.md') || item.before === null || item.after === null)
      throw new Error('Invalid backlink plan')
    const rewritten = rewriteDocumentLinks(utf8Decode(decode(item.before)!), from, to)
    if (!rewritten.count || !equal(decode(item.after), utf8Encode(rewritten.text)))
      throw new Error('Invalid backlink postimage')
  }
  return candidate as Journal
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
  if (equal(current, wanted)) {
    await adapter.confirm(root, change.path, wanted)
    return
  }
  if (!equal(current, decode(change.before)))
    throw new Error(`Move recovery conflict at ${change.path}`)
  await checkpoint(callback, 'file', 'before', journal.operationId, change.path)
  if (wanted === null) await adapter.remove(root, change.path, current!)
  else if (change.before === null) await adapter.create(root, change.path, wanted)
  else await adapter.publish(root, change.path, wanted, current)
  const verified = await adapter.readOptional(root, change.path)
  if (!equal(verified, wanted)) throw new Error(`Move publication did not verify at ${change.path}`)
  await adapter.confirm(root, change.path, wanted)
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
  const pending: { name: string; journal: Journal; raw: Uint8Array }[] = []
  const foldedPaths = new Set<string>()
  for (const name of names.sort()) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix))
      throw new Error('Unknown private vault storage artifact')
    const raw = await adapter.privateRead(root, name)
    const journal = validateJournal(raw, root, name)
    await adapter.privateConfirm(root, name, raw)
    const validatedPaths = new Set<string>()
    for (const change of journal.changes) {
      const validated = validatePath(change.path)
      const folded = validated.normalize('NFD').toLowerCase()
      if (validated !== change.path || validatedPaths.has(validated) || foldedPaths.has(folded))
        throw new Error('Invalid or duplicate move recovery path')
      validatedPaths.add(validated)
      foldedPaths.add(folded)
    }
    // Check move-specific namespace constraints before any pending journal can mutate files.
    for (const change of journal.changes) await adapter.checkMovePath(root, change.path)
    // Reject journals that omit any currently visible inbound-link file.
    const changedPaths = new Set(journal.changes.map(({ path }) => path))
    for (const entry of await adapter.list(root)) {
      if (
        entry.kind !== 'file' ||
        !isPublicNote(entry.path) ||
        entry.path === journal.from ||
        entry.path === journal.to ||
        changedPaths.has(entry.path)
      )
        continue
      const current = await adapter.read(root, entry.path)
      if (rewriteDocumentLinks(utf8Decode(current), journal.from, journal.to).count)
        throw new Error(`Move recovery omitted backlink at ${entry.path}`)
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
    pending.push({ name, journal, raw })
  }
  for (const { name, journal, raw } of pending) {
    for (const change of journal.changes) await apply(adapter, root, change, journal, callback)
    const verifyPostimages = async () => {
      await adapter.privateConfirm(root, name, raw)
      for (const change of journal.changes) {
        const current = await adapter.readOptional(root, change.path)
        if (!equal(current, decode(change.after)))
          throw new Error(`Move recovery postimage changed at ${change.path}`)
        await adapter.confirm(root, change.path, decode(change.after))
      }
    }
    await verifyPostimages()
    await checkpoint(callback, 'cleanup', 'before', journal.operationId, name)
    await verifyPostimages()
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
    !isPublicNote(source) ||
    !isPublicNote(target) ||
    !isRoundTripTarget(source) ||
    !isRoundTripTarget(target) ||
    source === target
  )
    throw new Error('Move requires two distinct markdown notes')
  const sourceBytes = await adapter.read(root, source)
  if (revision(sourceBytes) !== expectedRevision) throw new Error('Stale document revision')
  const entries = await adapter.list(root)
  const files = entries
    .filter((entry) => entry.kind === 'file' && isPublicNote(entry.path))
    .sort((left, right) => comparePaths(left.path, right.path))
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
  const sourceText = utf8Decode(sourceBytes)
  const movedSource = rewriteDocumentLinks(sourceText, source, target)
  const changes: Change[] = [
    { path: source, before: bytes(sourceBytes), after: null },
    { path: target, before: null, after: bytes(utf8Encode(movedSource.text)) },
  ]
  for (const entry of files) {
    if (entry.path === source) continue
    const before = await adapter.read(root, entry.path)
    const rewritten = rewriteDocumentLinks(utf8Decode(before), source, target)
    if (rewritten.count)
      changes.push({
        path: entry.path,
        before: bytes(before),
        after: bytes(utf8Encode(rewritten.text)),
      })
  }
  const operationId = adapter.operationId()
  const journal: Journal = { schema: 2, root, operationId, from: source, to: target, changes }
  const name = journalName(operationId)
  const journalBytes = utf8Encode(JSON.stringify(journal))
  if (journalBytes.length > maxJournalBytes) throw new Error('Move recovery journal is too large')
  // Validate the exact serialized evidence before publishing anything recoverMoves cannot accept.
  validateJournal(journalBytes, root, name)
  const checkPreconditions = async () => {
    for (const change of changes) {
      await adapter.checkMovePath(root, change.path)
      const current = await adapter.readOptional(root, change.path)
      if (!equal(current, decode(change.before)))
        throw new Error(`Move precondition changed at ${change.path}`)
    }
  }
  // Enumeration omits symlinks; inspect every path before recording a move.
  await checkPreconditions()
  await checkpoint(callback, 'journal', 'before', operationId)
  await adapter.privatePublish(root, name, journalBytes, null)
  await adapter.privateConfirm(root, name, journalBytes)
  await checkpoint(callback, 'journal', 'after', operationId)
  // Revalidate the complete plan immediately before mutation.
  await checkPreconditions()
  await recoverMoves(adapter, root, validatePath, callback)
  const movedBytes = await adapter.read(root, target)
  return { path: target, bytes: movedBytes, revision: revision(movedBytes) }
}
