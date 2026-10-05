/**
 * A session's conversation, read from Claude Code's transcript for the chat
 * view (docs/features/agent-sessions.md, The chat).
 *
 * The transcript (`<configDir>/projects/<cwd>/<sessionId>.jsonl`) is Claude
 * Code's own file and not a documented interface, so this reads it the way a
 * stranger's file is read: line by line, taking only the shapes it knows and
 * dropping every other line. A format change costs the chat its messages,
 * never a throw. It is read incrementally, from a byte offset, because a long
 * conversation is megabytes and the chat asks again every second while a turn
 * runs.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** One thing in the conversation, in the order it happened. */
export type ChatEntry =
  /** `images` counts the pictures sent with it (pasted ones are in the
   *  transcript as image blocks, which are not read, only counted). */
  | { kind: 'user'; id: string; text: string; images?: number }
  | { kind: 'assistant'; id: string; text: string }
  /** A tool the agent called: `id` is the call's, which its result names. */
  | { kind: 'tool'; id: string; name: string; summary: string; input: string }
  | { kind: 'tool-result'; id: string; ok: boolean; text: string }

export interface TranscriptChunk {
  /** The conversation these entries are from. A different one than the caller
   *  last had (a `/clear`) means its entries are stale. */
  sessionId: string
  entries: ChatEntry[]
  /** Where to read from next. */
  offset: number
}

/** The most of a transcript's tail read when the chat first opens it. */
const FIRST_READ_BYTES = 768 * 1024
/** The most of one tool's input or result kept: the chat shows a glimpse. */
const MAX_DETAIL = 4000

const clip = (text: string): string =>
  text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\n…` : text

/** Where a conversation's transcript is, or null. Searched by name under every
 *  project directory: a session may have moved into a subdirectory, and the
 *  directory's spelling of a path is Claude Code's to change. */
export async function findTranscript(configDir: string, sessionId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return null
  const projects = join(configDir, 'projects')
  const dirs = await readdir(projects).catch(() => [] as string[])
  for (const dir of dirs) {
    const path = join(projects, dir, `${sessionId}.jsonl`)
    if (
      await stat(path).then(
        (s) => s.isFile(),
        () => false,
      )
    )
      return path
  }
  return null
}

/** What Claude Code wraps around a prompt that the person did not type. */
const WRAPPERS =
  /<(system-reminder|local-command-caveat|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g

/** A person's message as they wrote it, or '' when the line is machinery. */
function userText(raw: string): string {
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(raw)
  if (command !== null) return ''
  return raw.replace(WRAPPERS, '').trim()
}

/** The one line that says what a tool call is about. */
function toolSummary(input: Record<string, unknown>): string {
  for (const key of [
    'description',
    'file_path',
    'path',
    'command',
    'pattern',
    'query',
    'url',
    'prompt',
    'skill',
  ]) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value.split('\n')[0]!.slice(0, 160)
  }
  return ''
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) =>
      block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n')
}

/** One transcript line as chat entries. Pure. */
export function parseTranscriptLine(line: string): ChatEntry[] {
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return []
  }
  if (row === null || typeof row !== 'object') return []
  const r = row as Record<string, unknown>
  // A subagent's own conversation, and what Claude Code injected, are not
  // this chat's.
  if (r['isSidechain'] === true || r['isMeta'] === true) return []
  if (r['type'] !== 'user' && r['type'] !== 'assistant') return []
  const uuid = typeof r['uuid'] === 'string' ? r['uuid'] : ''
  const message = r['message']
  if (uuid === '' || message === null || typeof message !== 'object') return []
  const content = (message as { content?: unknown }).content

  if (r['type'] === 'user') {
    if (typeof content === 'string') {
      const text = userText(content)
      return text === '' ? [] : [{ kind: 'user', id: uuid, text }]
    }
    if (!Array.isArray(content)) return []
    const entries: ChatEntry[] = []
    const typed: string[] = []
    let images = 0
    for (const block of content as unknown[]) {
      if (block === null || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b['type'] === 'image') images += 1
      else if (b['type'] === 'text' && typeof b['text'] === 'string')
        typed.push(userText(b['text']))
      else if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
        entries.push({
          kind: 'tool-result',
          id: b['tool_use_id'],
          ok: b['is_error'] !== true,
          text: clip(resultText(b['content'])),
        })
      }
    }
    const text = typed.filter((t) => t !== '').join('\n\n')
    if (text !== '' || images > 0) {
      entries.unshift({ kind: 'user', id: uuid, text, ...(images > 0 ? { images } : {}) })
    }
    return entries
  }

  if (!Array.isArray(content)) return []
  const entries: ChatEntry[] = []
  ;(content as unknown[]).forEach((block, i) => {
    if (block === null || typeof block !== 'object') return
    const b = block as Record<string, unknown>
    if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].trim() !== '') {
      entries.push({ kind: 'assistant', id: `${uuid}:${i}`, text: b['text'] })
    } else if (b['type'] === 'tool_use' && typeof b['id'] === 'string') {
      const input =
        b['input'] !== null && typeof b['input'] === 'object'
          ? (b['input'] as Record<string, unknown>)
          : {}
      entries.push({
        kind: 'tool',
        id: b['id'],
        name: typeof b['name'] === 'string' ? b['name'] : 'tool',
        summary: toolSummary(input),
        // A question's options are the question: clipped, they cannot be drawn.
        input:
          b['name'] === 'AskUserQuestion'
            ? JSON.stringify(input, null, 2)
            : clip(JSON.stringify(input, null, 2)),
      })
    }
  })
  return entries
}

/**
 * The transcript from `offset` on, whole lines only: a line still being
 * written is left for the next read. With no offset, the tail of the file.
 */
export async function readTranscript(
  path: string,
  sessionId: string,
  offset?: number,
): Promise<TranscriptChunk> {
  const file = await open(path, 'r').catch(() => null)
  if (file === null) return { sessionId, entries: [], offset: offset ?? 0 }
  try {
    const { size } = await file.stat()
    const first = offset === undefined
    // A file shorter than where we were has been rewritten: start over.
    let from = first ? Math.max(0, size - FIRST_READ_BYTES) : offset > size ? 0 : offset
    if (from >= size) return { sessionId, entries: [], offset: size }
    const buffer = Buffer.alloc(size - from)
    await file.read(buffer, 0, buffer.length, from)
    let text = buffer.toString('utf8')
    // Started mid-file: the first line is a fragment.
    if (first && from > 0) {
      const cut = buffer.indexOf(0x0a)
      if (cut === -1) return { sessionId, entries: [], offset: from }
      text = buffer.subarray(cut + 1).toString('utf8')
      from += cut + 1
    }
    const end = text.lastIndexOf('\n')
    if (end === -1) return { sessionId, entries: [], offset: from }
    const whole = text.slice(0, end)
    return {
      sessionId,
      entries: whole.split('\n').flatMap((line) => (line === '' ? [] : parseTranscriptLine(line))),
      offset: from + Buffer.byteLength(whole, 'utf8') + 1,
    }
  } finally {
    await file.close()
  }
}
