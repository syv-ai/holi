/**
 * A session's conversation, read from Claude Code's transcript for the chat
 * view (docs/features/agent-sessions.md, The chat).
 *
 * The transcript (`<configDir>/projects/<cwd>/<sessionId>.jsonl`) is Claude
 * Code's own file and not a documented interface, so it is read the way a
 * stranger's file is: line by line, every line classified (`classify.ts`) into
 * entries, a named hidden reason, or a visible `unknown` row, and never a
 * throw. It is read incrementally, from a byte offset, because a long
 * conversation is megabytes and the chat asks again every second while a turn
 * runs; the first read is the tail, and an earlier part is read backwards on
 * request.
 *
 * Offsets are bytes of the file and every chunk ends at a line end: a line
 * still being written is left for the next read.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  classifyLine,
  MAX_LINE_BYTES,
  oversizeLine,
  shapeKey,
  type ClassifyOptions,
} from './classify'
import type { ChatEntry, DriftReport, EarlierChunk, TranscriptChunk } from './entries'

export type {
  ChatEntry,
  Disposition,
  DriftReport,
  EarlierChunk,
  HiddenReason,
  ImageRef,
  LineResult,
  NoticeSource,
  Plain,
  TranscriptChunk,
} from './entries'
export { classifyLine, shapeKey, type ClassifyOptions }
export { isVerifiedVersion, VERIFIED_CLAUDE_VERSIONS } from './known'

/** The most of a transcript's tail read when the chat first opens it. */
const FIRST_READ_BYTES = 768 * 1024
/** How much of a sub-agent's file the first read takes: its card is opened to
 *  read it, and nothing asks for the part before. */
const SUBAGENT_READ_BYTES = 4 * 1024 * 1024
/** The part before `start` that `readEarlier` takes. */
const EARLIER_BYTES = 512 * 1024
/** A window grows to find a line start; past this it gives up. */
const MAX_WINDOW_BYTES = 8 * 1024 * 1024
/** Distinct unknown shapes kept per read: a hostile file cannot grow it. */
const MAX_SHAPES = 100

export interface ReadOptions {
  /** The file is a sub-agent's own: its lines are `isSidechain` by design. */
  sidechain?: boolean
  /** How much of the tail the first read takes. */
  firstReadBytes?: number
  /** The `fingerprint` of the chunk that gave the `offset` being read from. */
  fingerprint?: string
}

// ---- finding files ---------------------------------------------------------

const SESSION_ID = /^[0-9a-f-]{8,64}$/i
const AGENT_ID = /^[A-Za-z0-9_-]{4,64}$/

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  )

/** A regular file that is where its own name says: not a symlink, and no
 *  directory above it under `root` is one that leads elsewhere. A link in the
 *  sub-agent directory must not make the chat read some other file. */
async function isFileInside(root: string, path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isFile()) return false
    const [realRoot, real] = await Promise.all([realpath(root), realpath(path)])
    return real === join(realRoot, relative(root, path))
  } catch {
    return false
  }
}

/** Where a conversation's transcript is, or null. Searched by name under every
 *  project directory: a session may have moved into a subdirectory, and the
 *  directory's spelling of a path is Claude Code's to change. */
export async function findTranscript(configDir: string, sessionId: string): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null
  const projects = join(configDir, 'projects')
  const dirs = await readdir(projects).catch(() => [] as string[])
  for (const dir of dirs) {
    const path = join(projects, dir, `${sessionId}.jsonl`)
    if (await isFile(path)) return path
  }
  return null
}

/** Where a sub-agent's own conversation is, or null:
 *  `<projects>/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`, or under a
 *  workflow's directory in `subagents/workflows/`. `agentId` is checked, so a
 *  tool card's id cannot name a path outside. */
export async function findSubagentTranscript(
  configDir: string,
  sessionId: string,
  agentId: string,
): Promise<string | null> {
  if (!SESSION_ID.test(sessionId) || !AGENT_ID.test(agentId)) return null
  const projects = join(configDir, 'projects')
  const dirs = await readdir(projects).catch(() => [] as string[])
  for (const dir of dirs) {
    const base = join(projects, dir, sessionId, 'subagents')
    const plain = join(base, `agent-${agentId}.jsonl`)
    if (await isFileInside(projects, plain)) return plain
    const runs = await readdir(join(base, 'workflows')).catch(() => [] as string[])
    for (const run of runs) {
      if (!/^wf_[A-Za-z0-9_-]{1,64}$/.test(run)) continue
      const inRun = join(base, 'workflows', run, `agent-${agentId}.jsonl`)
      if (await isFileInside(projects, inRun)) return inRun
    }
  }
  return null
}

// ---- reading lines ---------------------------------------------------------

/** One transcript line as chat entries. Pure. */
export function parseTranscriptLine(line: string): ChatEntry[] {
  return classifyLine(line).entries
}

/** The lines of `buffer`, which starts at file offset `base`, as entries and a
 *  drift report. Every line in it is whole (a final one without its newline is
 *  read too: the caller cut the buffer where it wanted). */
function readLines(
  buffer: Buffer,
  base: number,
  options: ReadOptions,
): { entries: ChatEntry[]; drift: DriftReport } {
  const entries: ChatEntry[] = []
  const unknown = new Map<string, number>()
  const drift: DriftReport = { lines: 0, unknown: [], oversize: 0, unparseable: 0 }
  let pos = 0
  while (pos < buffer.length) {
    const nl = buffer.indexOf(0x0a, pos)
    const end = nl === -1 ? buffer.length : nl
    const from = pos
    const at = base + from
    const length = end - from
    pos = end + 1
    if (length === 0) continue
    const classify: ClassifyOptions = {
      at,
      ...(options.sidechain === true ? { sidechain: true } : {}),
    }
    const result =
      length > MAX_LINE_BYTES
        ? oversizeLine(length, classify)
        : classifyLine(buffer.toString('utf8', from, from + length), classify)
    drift.lines += 1
    for (const entry of result.entries) entries.push(entry)
    if (result.disposition.kind !== 'unknown') continue
    const shape = result.disposition.shape
    if (shape === 'oversize') drift.oversize += 1
    else if (shape === 'unparseable') drift.unparseable += 1
    else {
      const key = unknown.has(shape) || unknown.size < MAX_SHAPES ? shape : '…other'
      unknown.set(key, (unknown.get(key) ?? 0) + 1)
    }
  }
  drift.unknown = [...unknown].map(([shape, count]) => ({ shape, count }))
  noteDrift(drift)
  return { entries, drift }
}

// ---- telling about lines nothing knows -------------------------------------

let logger: ((message: string) => void) | null = null
const told = new Set<string>()

/** Where the one-line notices about unknown shapes go. Without one they go to
 *  the console, except under a test run. */
export function setTranscriptLogger(log: ((message: string) => void) | null): void {
  logger = log
}

/** Forget which shapes were told about (a test starts clean). */
export function resetToldShapes(): void {
  told.clear()
}

/** Once per process per shape, one line: the shape and how many, never what
 *  was in them. */
function noteDrift(drift: DriftReport): void {
  for (const { shape, count } of drift.unknown) {
    if (told.has(shape) || told.size >= 200) continue
    told.add(shape)
    const message = `transcript: no rule for line shape "${shape}" (${count} ${count === 1 ? 'line' : 'lines'})`
    try {
      if (logger !== null) logger(message)
      else if (process.env['VITEST'] === undefined) console.warn(`[agent] ${message}`)
    } catch {
      // A logger that throws must not cost the chat its messages.
    }
  }
}

// ---- reading the file ------------------------------------------------------

async function readRange(file: FileHandle, from: number, to: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, to - from))
  let filled = 0
  while (filled < buffer.length) {
    const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, from + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return filled === buffer.length ? buffer : buffer.subarray(0, filled)
}

/**
 * The bytes ending at `end` (a line start, or the end of the file) and
 * beginning at a line start at least `want` bytes back where the file allows.
 * `start` is that line start. Null `start` when the window found none within
 * `MAX_WINDOW_BYTES` (one line longer than that).
 */
async function windowBefore(
  file: FileHandle,
  end: number,
  want: number,
): Promise<{ start: number; buffer: Buffer } | { start: null; from: number }> {
  let from = Math.max(0, end - want)
  for (;;) {
    if (from === 0) return { start: 0, buffer: await readRange(file, 0, end) }
    // One byte earlier tells whether `from` is itself a line start.
    const buffer = await readRange(file, from - 1, end)
    if (buffer[0] === 0x0a) return { start: from, buffer: buffer.subarray(1) }
    const nl = buffer.indexOf(0x0a, 1)
    if (nl !== -1) return { start: from + nl, buffer: buffer.subarray(nl + 1) }
    if (end - from >= MAX_WINDOW_BYTES) return { start: null, from }
    from = Math.max(0, end - (end - from) * 2)
  }
}

/** How much of each end of the consumed part the fingerprint reads. */
const FINGERPRINT_BYTES = 64

const digest = (bytes: Buffer): string =>
  createHash('sha1').update(bytes).digest('hex').slice(0, 12)

/**
 * A cheap stand-in for "the first `offset` bytes of this file": a digest of
 * its first bytes and of the bytes just before `offset`. Appending leaves it
 * unchanged; a file replaced by another, shorter or longer, does not match.
 * `offset` must not be past the end of the file.
 */
async function fingerprintAt(file: FileHandle, offset: number): Promise<string> {
  const head = await readRange(file, 0, Math.min(FINGERPRINT_BYTES, offset))
  const tail = await readRange(file, Math.max(0, offset - FINGERPRINT_BYTES), offset)
  return `${digest(head)}.${digest(tail)}`
}

/**
 * The transcript from `offset` on, whole lines only: a line still being
 * written is left for the next read. With no offset, the tail of the file,
 * and `start` says where it began.
 *
 * `options.fingerprint` is the one the chunk that gave `offset` carried. If
 * the file no longer starts with what it summarises (or is shorter than
 * `offset`, or `offset` is nonsense), the file was replaced: the answer is a
 * fresh tail read with `reset: true`.
 */
export async function readTranscript(
  path: string,
  sessionId: string,
  offset?: number,
  options: ReadOptions = {},
): Promise<TranscriptChunk> {
  const file = await open(path, 'r').catch(() => null)
  if (file === null) return { sessionId, entries: [], offset: offset ?? 0 }
  try {
    const { size } = await file.stat()
    const tail = async (reset: boolean): Promise<TranscriptChunk> => {
      const window = await windowBefore(file, size, options.firstReadBytes ?? FIRST_READ_BYTES)
      const chunk: TranscriptChunk =
        window.start === null
          ? { sessionId, entries: [], offset: window.from, start: window.from }
          : finish(sessionId, window.buffer, window.start, options, true)
      if (reset) chunk.reset = true
      chunk.fingerprint = await fingerprintAt(file, chunk.offset)
      return chunk
    }
    if (offset === undefined) return await tail(false)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) return await tail(true)
    const fingerprint = await fingerprintAt(file, offset)
    if (options.fingerprint !== undefined && options.fingerprint !== fingerprint)
      return await tail(true)
    if (offset >= size) return { sessionId, entries: [], offset: size, fingerprint }
    const chunk = finish(sessionId, await readRange(file, offset, size), offset, options, false)
    chunk.fingerprint =
      chunk.offset === offset ? fingerprint : await fingerprintAt(file, chunk.offset)
    return chunk
  } finally {
    await file.close()
  }
}

/** Entries of the whole lines in `buffer` (which starts at `from`). */
function finish(
  sessionId: string,
  buffer: Buffer,
  from: number,
  options: ReadOptions,
  first: boolean,
): TranscriptChunk {
  const last = buffer.lastIndexOf(0x0a)
  const start = first ? { start: from } : {}
  if (last === -1) return { sessionId, entries: [], offset: from, ...start }
  const { entries, drift } = readLines(buffer.subarray(0, last + 1), from, options)
  return { sessionId, entries, offset: from + last + 1, drift, ...start }
}

/**
 * The part of the file before `before` (a line start: a chunk's `start`),
 * about half a megabyte of it, from a line start. `start` 0 means the file's
 * start was reached.
 */
export async function readEarlier(
  path: string,
  _sessionId: string,
  before: number,
  options: ReadOptions = {},
): Promise<EarlierChunk> {
  const file = await open(path, 'r').catch(() => null)
  if (file === null) return { entries: [], start: 0 }
  try {
    const { size } = await file.stat()
    const end = Math.min(Math.max(0, Math.floor(before)), size)
    if (end === 0) return { entries: [], start: 0 }
    const window = await windowBefore(file, end, EARLIER_BYTES)
    if (window.start === null) return { entries: [], start: window.from }
    // `before` should be a line start, so the window ends at a newline; if it
    // is not, the cut line is not read, and not lost: it is past `start`.
    const last = window.buffer.lastIndexOf(0x0a)
    if (last === -1) return { entries: [], start: window.start }
    const { entries, drift } = readLines(window.buffer.subarray(0, last + 1), window.start, options)
    return { entries, start: window.start, drift }
  } finally {
    await file.close()
  }
}

/** A sub-agent's own conversation from `offset` on (the tail without one), or
 *  null when its file is not there. */
export async function readSubagent(
  configDir: string,
  sessionId: string,
  agentId: string,
  offset?: number,
  fingerprint?: string,
): Promise<TranscriptChunk | null> {
  const path = await findSubagentTranscript(configDir, sessionId, agentId)
  if (path === null) return null
  return readTranscript(path, sessionId, offset, {
    sidechain: true,
    firstReadBytes: SUBAGENT_READ_BYTES,
    ...(fingerprint === undefined ? {} : { fingerprint }),
  })
}
