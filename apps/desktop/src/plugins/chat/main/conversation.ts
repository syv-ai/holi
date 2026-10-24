/**
 * A background run's conversation, read back from Claude Code's own
 * transcript and folded into the chat's transcript items, so a Holi's or an
 * automation's session can be read with the same steps, diffs and cards as a
 * chat (docs/features/chat.md, Background runs).
 *
 * Claude Code writes each session to
 * `<config dir>/projects/<cwd slug>/<conversation id>.jsonl`, one record per
 * line: the person's prompts and each content block of the model's messages,
 * in the shapes stream-json prints (`toolUseResult` for its
 * `tool_use_result`), among bookkeeping records Holi skips. A subagent's own
 * steps are in `<conversation id>/subagents/agent-<agent id>.jsonl`.
 *
 * Read only: nothing here answers a prompt or writes the file. The fold is
 * pure; reading the files is `readConversation`.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyChatEvent, type ChatEvent, type TranscriptItem } from '../shared/chat'
import { newClaudeReader, parseLine, readClaudeRecord, type JsonRecord } from './claude-stream'

/** Claude Code's folder name for a working directory: every character
 *  outside `[A-Za-z0-9]` becomes `-`. */
export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

/** A conversation id as Claude Code makes them: nothing that walks a path. */
export const isConversationId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(id)

const rec = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null

const time = (r: JsonRecord): number | undefined => {
  const t = r['timestamp']
  if (typeof t !== 'string') return undefined
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : undefined
}

/** The person's own words in a `user` record, or null for a tool result,
 *  a command's echo or what Claude Code added itself. */
function promptOf(r: JsonRecord): string | null {
  if (r['isMeta'] === true || r['isCompactSummary'] === true) return null
  const content = rec(r['message'])?.['content']
  let text: string
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    if (content.some((b) => rec(b)?.['type'] === 'tool_result')) return null
    text = content
      .map((b) => (rec(b)?.['type'] === 'text' ? String(rec(b)?.['text'] ?? '') : ''))
      .join('')
  } else return null
  const t = text.trim()
  // `<command-name>/compact…`, `<local-command-stdout>…`, interruptions.
  if (t === '' || t.startsWith('<') || t.startsWith('[Request interrupted')) return null
  return t
}

/** A transcript record as stream-json prints it. */
function asStream(r: JsonRecord, parent?: string): JsonRecord {
  return {
    ...r,
    parent_tool_use_id: parent ?? null,
    ...(r['toolUseResult'] === undefined ? {} : { tool_use_result: r['toolUseResult'] }),
  }
}

export interface FoldOptions {
  /** The vault clone: tool paths are shown relative to it. */
  root: string
  /** A subagent's own records, by its agent id, when they can be read. */
  subagent?: (agentId: string) => JsonRecord[] | null
  /** The run is still going: its last turn is left open. */
  live?: boolean
}

/** Claude Code's transcript records, folded into transcript items. */
export function foldConversation(
  records: readonly JsonRecord[],
  opts: FoldOptions,
): TranscriptItem[] {
  let at = 0
  const reader = newClaudeReader(() => at)
  let items: TranscriptItem[] = []
  let turn = 0
  let open = false
  let lastAt = 0
  let model: string | undefined
  const apply = (e: ChatEvent): void => {
    items = applyChatEvent(items, e, opts.root).items
  }
  const close = (): void => {
    if (!open) return
    open = false
    apply({ type: 'turn-end', at: lastAt, ...(model === undefined ? {} : { model }) })
  }
  const read = (r: JsonRecord, parent?: string): void => {
    for (const e of readClaudeRecord(reader, asStream(r, parent)).events) apply(e)
  }

  for (const r of records) {
    const type = r['type']
    if (type !== 'user' && type !== 'assistant' && type !== 'system') continue
    if (r['isSidechain'] === true) continue
    at = time(r) ?? at
    const prompt = type === 'user' ? promptOf(r) : null
    if (prompt !== null) {
      close()
      turn++
      apply({ type: 'user', id: `bg-u${turn}`, text: prompt, at })
      apply({ type: 'turn-start', id: `bg-t${turn}`, at })
      open = true
      model = undefined
      lastAt = at
      continue
    }
    if (type === 'assistant') {
      const m = rec(r['message'])?.['model']
      if (typeof m === 'string' && m !== '<synthetic>') model = m
    }
    // A subagent's steps go in before its call's end, under its call.
    const result = rec(r['toolUseResult'])
    const agentId = result?.['agentId']
    if (type === 'user' && typeof agentId === 'string' && opts.subagent !== undefined) {
      const content = rec(r['message'])?.['content']
      const call = Array.isArray(content)
        ? content.map((b) => rec(b)).find((b) => b?.['type'] === 'tool_result')?.['tool_use_id']
        : undefined
      const inner = typeof call === 'string' ? opts.subagent(agentId) : null
      for (const s of inner ?? []) {
        if (s['type'] === 'assistant' || s['type'] === 'user') read(s, call as string)
      }
    }
    read(r)
    lastAt = at
  }
  if (!opts.live) close()
  return items
}

/** Read a background run's conversation from Claude Code's config directory. */
export async function readConversation(args: {
  configDir: string
  root: string
  conversationId: string
  live?: boolean
}): Promise<TranscriptItem[] | null> {
  if (!isConversationId(args.conversationId)) return null
  const dir = join(args.configDir, 'projects', projectSlug(args.root))
  const text = await readFile(join(dir, `${args.conversationId}.jsonl`), 'utf8').catch(() => null)
  if (text === null) return null
  const lines = (t: string): JsonRecord[] =>
    t
      .split('\n')
      .map((l) => parseLine(l))
      .filter((r): r is JsonRecord => r !== null)
  const subagents = new Map<string, JsonRecord[] | null>()
  const records = lines(text)
  // Subagents' files, read up front: the fold itself stays synchronous.
  for (const r of records) {
    const id = rec(r['toolUseResult'])?.['agentId']
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id) || subagents.has(id)) continue
    const sub = await readFile(
      join(dir, args.conversationId, 'subagents', `agent-${id}.jsonl`),
      'utf8',
    ).catch(() => null)
    subagents.set(id, sub === null ? null : lines(sub))
  }
  return foldConversation(records, {
    root: args.root,
    subagent: (id) => subagents.get(id) ?? null,
    ...(args.live === undefined ? {} : { live: args.live }),
  })
}
