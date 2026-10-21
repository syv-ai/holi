/**
 * A Holi's memory and soul on disk (docs/features/holis.md, Memory): the
 * commands its runs keep their memory with (`holi holis remember`, `revise`,
 * `forget`, `recall`, `search`) and the Holi page's reads and hash-checked
 * saves, after MonoCode's `mono_load`/`mono_save`.
 *
 * Every write is a read, an edit in `@holi/shared/holi-memory` and a write,
 * one at a time per file: two runs remembering at once must not lose a line.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  addMemoryEntry,
  archiveMemoryEntries,
  fitMemoryBudget,
  MEMORY_ARCHIVE,
  MEMORY_FILE,
  MEMORY_TOPICS_DIR,
  memoryDate,
  memoryEntry,
  removeMemoryEntry,
  searchMemory,
  sinceDate,
  SOUL_FILE,
  supersedeMemoryEntry,
  topicName,
  vaultRelPath,
  type MemoryHit,
} from '@holi/shared'
import { CapabilityError, writeAtomic } from '../../../main/plugin-api'

/** A file this big is not memory: refused rather than loaded. */
const FILE_MAX = 256 * 1024

/** How a run is told to keep its memory, after MonoCode's memory rules. */
export const MEMORY_RULES = (id: string, dir: string): string =>
  [
    `Your memory is ${dir}/${MEMORY_FILE}: one dated fact a line, loaded below at the start of every run.`,
    'Keep what is worth knowing next time (a preference, a decision, where something lives), not a log of what this run did.',
    `Save a fact with \`holi holis remember ${id} "fact"\` (\`--until 2026-11-01\` for one that expires, \`--topic <name>\` for detail read on demand).`,
    `Correct one with \`holi holis revise ${id} "text in the old line" "new fact"\`, drop a wrong one with \`holi holis forget ${id} "text"\`.`,
    `Read a topic note with \`holi holis recall ${id} <topic>\`, and look back with \`holi holis search ${id} "words"\` (\`--since 7d\`).`,
    'Never save a secret, a password or a token. Write your memory only through these commands.',
  ].join('\n')

export const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A file's text, '' when it is missing. Only a regular file under the cap. */
export async function readText(abs: string): Promise<string> {
  const info = await lstat(abs).catch(() => null)
  if (info === null || !info.isFile()) return ''
  if (info.size > FILE_MAX) throw new CapabilityError('BAD_REQUEST', `${abs} is too large`)
  return readFile(abs, 'utf8')
}

/** The topic notes in a Holi's `memory/`, archive aside. */
export async function memoryTopics(root: string, dir: string): Promise<string[]> {
  const names = await readdir(join(root, dir, MEMORY_TOPICS_DIR)).catch(() => [] as string[])
  return names
    .filter((n) => n.endsWith('.md') && n !== `${MEMORY_ARCHIVE}.md`)
    .map((n) => n.slice(0, -3))
    .sort()
}

/** One write at a time per file. */
const chains = new Map<string, Promise<unknown>>()
function serial<T>(key: string, step: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(step, step)
  chains.set(
    key,
    next.catch(() => {}),
  )
  return next
}

const rel = (path: string) => vaultRelPath(path)

async function write(root: string, path: string, text: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeAtomic(root, rel(path), text)
}

const fail = (err: unknown): never => {
  if (err instanceof CapabilityError) throw err
  throw new CapabilityError('BAD_REQUEST', err instanceof Error ? err.message : String(err))
}

/** Where a fact goes: `MEMORY.md`, or a topic note. */
const fileFor = (dir: string, topic?: string): string =>
  topic === undefined
    ? `${dir}/${MEMORY_FILE}`
    : `${dir}/${MEMORY_TOPICS_DIR}/${topicName(topic)}.md`

/**
 * Remember a fact. `MEMORY.md` is kept within what loads: the oldest dated
 * entries move to the archive (`fitMemoryBudget`). A fact already there is
 * not written twice.
 */
export function remember(
  root: string,
  dir: string,
  args: { fact: string; until?: string; topic?: string },
  today: Date,
): Promise<string> {
  return serial(`${root}/${dir}`, async () => {
    try {
      const date = memoryDate(today)
      const entry = memoryEntry(args.fact, date, args.until)
      const path = fileFor(dir, args.topic)
      const { text, added } = addMemoryEntry(await readText(join(root, path)), entry)
      if (!added) return 'already remembered'
      if (args.topic !== undefined) {
        await write(root, path, text)
        return `remembered in ${args.topic}`
      }
      const fitted = fitMemoryBudget(text, entry, date)
      if (fitted.moved.length > 0) {
        const archive = `${dir}/${MEMORY_TOPICS_DIR}/${MEMORY_ARCHIVE}.md`
        const old = await readText(join(root, archive))
        await write(root, archive, archiveMemoryEntries(old, fitted.moved, date))
      }
      await write(root, path, fitted.text)
      return fitted.moved.length > 0
        ? `remembered; ${fitted.moved.length} older moved to the archive`
        : 'remembered'
    } catch (err) {
      return fail(err)
    }
  })
}

/** Strike the one live line containing `find` through, and add the new fact
 *  after it. */
export function revise(
  root: string,
  dir: string,
  args: { find: string; fact: string; topic?: string },
  today: Date,
): Promise<string> {
  return serial(`${root}/${dir}`, async () => {
    try {
      const date = memoryDate(today)
      const path = fileFor(dir, args.topic)
      const text = await readText(join(root, path))
      await write(
        root,
        path,
        supersedeMemoryEntry(text, args.find, memoryEntry(args.fact, date), date),
      )
      return 'revised'
    } catch (err) {
      return fail(err)
    }
  })
}

/** Take the one live line containing `find` out. */
export function forget(
  root: string,
  dir: string,
  args: { find: string; topic?: string },
): Promise<string> {
  return serial(`${root}/${dir}`, async () => {
    try {
      const path = fileFor(dir, args.topic)
      const { text, removed } = removeMemoryEntry(await readText(join(root, path)), args.find)
      await write(root, path, text)
      return `forgot: ${removed}`
    } catch (err) {
      return fail(err)
    }
  })
}

/** `MEMORY.md`, or a topic note. */
export async function recall(root: string, dir: string, topic?: string): Promise<string> {
  try {
    const text = await readText(join(root, fileFor(dir, topic)))
    return text.trim() === '' ? '(nothing remembered here yet)' : text
  } catch (err) {
    return fail(err)
  }
}

/** Lines across the memory, the topic notes and the archive that share words
 *  with `query`. */
export async function search(
  root: string,
  dir: string,
  args: { query: string; since?: string },
  today: Date,
): Promise<MemoryHit[]> {
  try {
    const topics = await memoryTopics(root, dir)
    const files = [
      { file: MEMORY_FILE, path: `${dir}/${MEMORY_FILE}` },
      ...[...topics, MEMORY_ARCHIVE].map((t) => ({
        file: `${MEMORY_TOPICS_DIR}/${t}.md`,
        path: `${dir}/${MEMORY_TOPICS_DIR}/${t}.md`,
      })),
    ]
    const texts = await Promise.all(
      files.map(async (f) => ({ file: f.file, text: await readText(join(root, f.path)) })),
    )
    return searchMemory(texts, args.query, {
      ...(args.since === undefined ? {} : { since: sinceDate(args.since, today) }),
    })
  } catch (err) {
    return fail(err)
  }
}

/** A Holi's soul and memory as its page shows them, each with the hash a
 *  save must name. */
export interface HoliFiles {
  soul: string
  soulHash: string
  memory: string
  memoryHash: string
  topics: string[]
}

export async function readFiles(root: string, dir: string): Promise<HoliFiles> {
  const [soul, memory, topics] = await Promise.all([
    readText(join(root, dir, SOUL_FILE)),
    readText(join(root, dir, MEMORY_FILE)),
    memoryTopics(root, dir),
  ])
  return { soul, soulHash: hashOf(soul), memory, memoryHash: hashOf(memory), topics }
}

/**
 * Save the page's soul or memory, but only over the text it opened: a run or
 * a pull that wrote it since is a conflict, answered with what is there now,
 * so the page can offer theirs or yours (after MonoCode's hash-checked save).
 */
export function saveFile(
  root: string,
  dir: string,
  file: 'soul' | 'memory',
  text: string,
  expected: string,
): Promise<{ ok: true; hash: string } | { ok: false; text: string; hash: string }> {
  return serial(`${root}/${dir}`, async () => {
    const path = `${dir}/${file === 'soul' ? SOUL_FILE : MEMORY_FILE}`
    const now = await readText(join(root, path))
    if (hashOf(now) !== expected) return { ok: false, text: now, hash: hashOf(now) }
    if (Buffer.byteLength(text) > FILE_MAX) {
      throw new CapabilityError('BAD_REQUEST', 'That is more than a Holi can keep.')
    }
    await write(root, path, text)
    return { ok: true, hash: hashOf(text) }
  })
}
