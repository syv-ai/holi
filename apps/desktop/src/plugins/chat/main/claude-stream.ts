/**
 * Claude Code's structured channel, read and written
 * (docs/features/chat.md).
 *
 * `claude -p --input-format stream-json --output-format stream-json` takes one
 * JSON message per line on stdin and prints one per line on stdout. With
 * `--permission-prompt-tool stdio`, whenever Claude Code's own permission
 * rules decide to **ask** (no allow rule covers the call, a hook said `ask`,
 * the mode asks) it sends a `control_request` of subtype `can_use_tool`
 * instead of drawing its TUI prompt, and waits for our `control_response`.
 * That is Claude Code's permission system answered from Holi's card: its deny
 * rules, allow rules and hooks run first exactly as in the terminal.
 *
 * The record shapes and the field fallbacks are after MonoCode's Claude
 * protocol (MIT, Copyright (c) 2026 Nick; see NOTICE.md), trimmed to what
 * Holi shows.
 *
 * No Electron import: pure, and loaded by the tests.
 */
import type {
  Attachment,
  ChatEvent,
  Effort,
  PermissionMode,
  Question,
  SessionInfo,
  TurnUsage,
} from '../shared/chat'
import { resultText } from '../shared/tool-views'

export type JsonRecord = Record<string, unknown>

const rec = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null

const str = (r: JsonRecord | null | undefined, key: string): string | undefined => {
  const v = r?.[key]
  return typeof v === 'string' && v !== '' ? v : undefined
}

const num = (r: JsonRecord | null | undefined, key: string): number => {
  const v = r?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function parseLine(line: string): JsonRecord | null {
  const t = line.trim()
  if (!t.startsWith('{')) return null
  try {
    return rec(JSON.parse(t))
  } catch {
    return null
  }
}

export interface ClaudeLaunch {
  model?: string
  effort?: Effort
  mode: PermissionMode
  /** A new conversation's id, chosen by Holi so it is known before the
   *  first line comes back. */
  sessionId?: string
  /** An existing conversation to continue. */
  resume?: string
}

/**
 * The argv for a chat session. Every mode here asks through Claude Code's
 * rules; Holi never passes `bypassPermissions` or
 * `--dangerously-skip-permissions`.
 */
export function claudeChatArgs(launch: ClaudeLaunch): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-prompt-tool',
    'stdio',
    '--permission-mode',
    launch.mode,
  ]
  if (launch.model !== undefined) args.push('--model', launch.model)
  if (launch.effort !== undefined) args.push('--effort', launch.effort)
  if (launch.resume !== undefined) args.push('--resume', launch.resume)
  else if (launch.sessionId !== undefined) args.push('--session-id', launch.sessionId)
  return args
}

/** A file sent with a message: its bytes, base64. */
export interface OutgoingFile {
  name: string
  mediaType: string
  data: string
}

/** Images Claude Code passes to the model as image blocks. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** How a file goes to Claude Code: an image block, a PDF as a document
 *  block, anything else as its text, named. */
export function attachmentKind(mediaType: string): Attachment['kind'] {
  if (IMAGE_TYPES.has(mediaType)) return 'image'
  if (mediaType === 'application/pdf') return 'document'
  return 'file'
}

/** A user turn, as a stdin line: the text, then each file as Claude Code's
 *  message content takes it. */
export function userMessage(text: string, files: readonly OutgoingFile[] = []): string {
  const content: JsonRecord[] = []
  for (const f of files) {
    const kind = attachmentKind(f.mediaType)
    if (kind === 'image') {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: f.mediaType, data: f.data },
      })
    } else if (kind === 'document') {
      content.push({
        type: 'document',
        title: f.name,
        source: { type: 'base64', media_type: f.mediaType, data: f.data },
      })
    } else {
      const body = Buffer.from(f.data, 'base64').toString('utf8')
      content.push({
        type: 'text',
        text: `<file name="${f.name.replace(/"/g, "'")}">\n${body}\n</file>`,
      })
    }
  }
  if (text.trim() !== '' || content.length === 0) content.push({ type: 'text', text })
  return JSON.stringify({
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content },
  })
}

/** An answer to a `control_request`, as a stdin line. */
export function controlResponse(requestId: string, response: JsonRecord): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  })
}

/** Ask Claude Code to stop the turn in flight, as a stdin line. */
export function interruptRequest(requestId: string): string {
  return JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'interrupt' },
  })
}

/** A permission request held until the person answers. */
export interface PendingPermission {
  requestId: string
  toolName: string
  input: JsonRecord
  /** Claude Code's own offer of a rule that would remember the answer, sent
   *  back as `updatedPermissions` for "Always allow". */
  suggestions: unknown[]
}

export type PermissionAnswer =
  /** `mode`: take Claude Code's offer to switch to that mode (`setMode`). */
  | { kind: 'allow'; always?: boolean; mode?: string }
  | { kind: 'deny'; message?: string }
  | { kind: 'answer'; answers: Record<string, string> }

/** The `control_response` body for an answer. */
export function permissionResult(pending: PendingPermission, answer: PermissionAnswer): JsonRecord {
  if (answer.kind === 'deny') {
    return { behavior: 'deny', message: answer.message ?? 'The person declined this.' }
  }
  if (answer.kind === 'answer') {
    return {
      behavior: 'allow',
      updatedInput: { questions: pending.input['questions'], answers: answer.answers },
    }
  }
  if (answer.mode !== undefined) {
    const offer = pending.suggestions.filter(
      (s) => rec(s)?.['type'] === 'setMode' && rec(s)?.['mode'] === answer.mode,
    )
    return {
      behavior: 'allow',
      updatedInput: pending.input,
      ...(offer.length > 0 ? { updatedPermissions: offer } : {}),
    }
  }
  return {
    behavior: 'allow',
    updatedInput: pending.input,
    ...(answer.always === true && pending.suggestions.length > 0
      ? { updatedPermissions: pending.suggestions }
      : {}),
  }
}

/** The modes a permission request offers to switch to. */
export function offeredModes(suggestions: readonly unknown[]): string[] {
  return suggestions
    .map((s) => rec(s))
    .filter((s) => s?.['type'] === 'setMode' && typeof s['mode'] === 'string')
    .map((s) => s!['mode'] as string)
}

/** AskUserQuestion's questions, read defensively. */
export function questionsOf(input: JsonRecord): Question[] {
  const raw = Array.isArray(input['questions']) ? input['questions'] : []
  const out: Question[] = []
  for (const q of raw) {
    const r = rec(q)
    const question = str(r, 'question')
    if (question === undefined) continue
    const options = (Array.isArray(r?.['options']) ? r['options'] : [])
      .map((o) => {
        const or = rec(o)
        const label = str(or, 'label') ?? (typeof o === 'string' ? o : undefined)
        if (label === undefined) return null
        const description = str(or, 'description')
        return description === undefined ? { label } : { label, description }
      })
      .filter((o): o is { label: string; description?: string } => o !== null)
    const header = str(r, 'header')
    out.push({
      question,
      ...(header === undefined ? {} : { header }),
      options,
      multiSelect: r?.['multiSelect'] === true,
    })
  }
  return out
}

/** What one stdout line means to the session around the transcript. */
export interface ClaudeLineResult {
  events: ChatEvent[]
  /** Claude Code's conversation id, from `init` and every later record. */
  sessionId?: string
  /** A permission request to hold for the person. */
  permission?: PendingPermission
  /** A request that needs an empty success answer and nothing else. */
  ackRequestId?: string
  /** Claude Code withdrew a request (a hook decided first). */
  cancelRequestId?: string
  /** The turn ended: how, the model that answered and what it cost. */
  turnEnded?: {
    failed: boolean
    interrupted?: boolean
    error?: string
    model?: string
    usage?: TurnUsage
  }
  /** What Claude Code offers as `/` commands in this session, from its
   *  `init`: its built-ins, the vault's commands and skills, its plugins'.
   *  Commands only its TUI can run are left out. */
  commands?: { names: string[]; skills: string[] }
  /** How full the context is now, 0 to 100. */
  contextPercent?: number
  /** What the process runs with, from its `init`. */
  info?: SessionInfo
  /** Claude Code's permission mode, when it reports one. */
  mode?: string
}

/** What the reader keeps between lines. */
export interface ClaudeReader {
  /** Tool calls being streamed, by content-block index. */
  toolsByIndex: Map<number, { id: string; name: string; json: string }>
  /** Content-block index of the text being streamed, or -1. */
  textIndex: number
  /** Assistant message ids whose text arrived as deltas. */
  streamedMessages: Set<string>
  currentMessage: string | null
  /** The last request's context use, in tokens. */
  usedTokens: number
  /** The model the last assistant message came from. */
  model: string | null
  /** Content-block index of the thinking being streamed, or -1. */
  thinkingIndex: number
  /** Assistant message ids whose thinking arrived as stream events. */
  streamedThinking: Set<string>
  /** Claude Code's permission mode as it last said. */
  mode: string | null
  /** Holi asked Claude Code to stop the turn in flight. */
  interrupting: boolean
  /** The clock events are stamped with. */
  now: () => number
}

export const newClaudeReader = (now: () => number = Date.now): ClaudeReader => ({
  toolsByIndex: new Map(),
  textIndex: -1,
  streamedMessages: new Set(),
  currentMessage: null,
  usedTokens: 0,
  model: null,
  thinkingIndex: -1,
  streamedThinking: new Set(),
  mode: null,
  interrupting: false,
  now,
})

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : []

/**
 * A turn's token accounting from its `result`, after MonoCode's
 * `turnMetricsFromResult` (MIT, Copyright (c) 2026 Nick; see NOTICE.md).
 * The cache hit is the share of all input (fresh, read from cache, written
 * to it) that was read from cache.
 */
export function turnUsage(r: JsonRecord): TurnUsage | undefined {
  const usage = rec(r['usage'])
  if (usage === null) return undefined
  const inputTokens = num(usage, 'input_tokens')
  const outputTokens = num(usage, 'output_tokens')
  const cacheReadTokens = num(usage, 'cache_read_input_tokens')
  const cacheWriteTokens = num(usage, 'cache_creation_input_tokens')
  const cacheReported = 'cache_read_input_tokens' in usage || 'cache_creation_input_tokens' in usage
  const cacheable = inputTokens + cacheReadTokens + cacheWriteTokens
  if (inputTokens === 0 && outputTokens === 0 && cacheable === 0) return undefined
  return {
    ...(inputTokens ? { inputTokens } : {}),
    ...(outputTokens ? { outputTokens } : {}),
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
    ...(cacheReported && cacheable ? { cacheHitPercent: (cacheReadTokens / cacheable) * 100 } : {}),
  }
}

/** The model that did most of a turn's writing, by `modelUsage`'s output
 *  tokens; the last assistant message's model when it has none. */
function turnModel(r: JsonRecord, fallback: string | null): string | undefined {
  let best: string | undefined
  let most = -1
  for (const [id, entry] of Object.entries(rec(r['modelUsage']) ?? {})) {
    const out = num(rec(entry), 'outputTokens')
    if (out > most) {
      most = out
      best = id
    }
  }
  return best ?? fallback ?? undefined
}

const usageTokens = (usage: JsonRecord | null): number =>
  num(usage, 'input_tokens') +
  num(usage, 'cache_creation_input_tokens') +
  num(usage, 'cache_read_input_tokens') +
  num(usage, 'output_tokens')

/** Lifecycle chatter Claude Code reports as status, which is not news. */
const QUIET_STATUS = /^(requesting|responding|thinking|working|running|idle|done|compact)/i

const tokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)

const clockTime = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })

/** Whether Claude Code's rules, a hook or the person refused a call, from
 *  the result's `tool_result_meta`. */
function refused(r: JsonRecord, callId: string): boolean {
  const meta = Array.isArray(r['tool_result_meta']) ? (r['tool_result_meta'] as unknown[]) : []
  return meta.some((m) => {
    const entry = rec(m)
    return (
      str(entry, 'id') === callId &&
      str(rec(entry?.['permission_decision']), 'decision') === 'reject'
    )
  })
}

/** Whether the call was cut off by the person stopping the turn. */
function stopped(r: JsonRecord, callId: string): boolean {
  const meta = Array.isArray(r['tool_result_meta']) ? (r['tool_result_meta'] as unknown[]) : []
  return meta.some(
    (m) => str(rec(m), 'id') === callId && str(rec(m), 'non_execution_kind') === 'user-rejected',
  )
}

/** What a slash command printed, from its `<local-command-stdout>`. */
function commandOutput(content: unknown): string | undefined {
  const raw = typeof content === 'string' ? content : resultText(content)
  const m = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(raw)
  if (m === null) return undefined
  const out = m[1]!.trim()
  // `/compact` says it has; the compaction's own line says more.
  return out === '' || /^compacted\b/i.test(out) ? undefined : out
}

/** A `user` record's tool results, as the calls' ends. */
function toolResults(r: JsonRecord): ChatEvent[] {
  const events: ChatEvent[] = []
  const content = rec(r['message'])?.['content']
  const blocks = Array.isArray(content) ? content : []
  const results = blocks.filter((b) => str(rec(b), 'type') === 'tool_result')
  for (const block of results) {
    const b = rec(block)
    const callId = str(b, 'tool_use_id')
    if (callId === undefined) continue
    // Claude Code's structured result belongs to the record's one result.
    const structured = results.length === 1 ? r['tool_use_result'] : undefined
    events.push({
      type: 'tool-end',
      callId,
      ok: b?.['is_error'] !== true,
      // A call the person stopped says so in a page of advice to the model.
      detail: stopped(r, callId) ? 'Stopped before it finished.' : resultText(b?.['content']),
      ...(structured === undefined || stopped(r, callId) ? {} : { result: structured }),
    })
    if (refused(r, callId)) events.push({ type: 'tool-denied', callId })
  }
  return events
}

/**
 * Read one stdout record. Subagents' own messages (`parent_tool_use_id` set)
 * give only their tool calls, marked with the parent's call id so the
 * transcript draws them under it; their prose read in the main transcript
 * would look like the agent itself talking.
 */
export function readClaudeRecord(reader: ClaudeReader, r: JsonRecord): ClaudeLineResult {
  const out: ClaudeLineResult = { events: [] }
  const type = str(r, 'type')
  const subtype = str(r, 'subtype')
  const parent = r['parent_tool_use_id']
  const sub = typeof parent === 'string' && parent !== ''
  const sid = str(r, 'session_id')
  if (sid !== undefined && !sub && !(type === 'system' && subtype?.startsWith('hook_'))) {
    out.sessionId = sid
  }

  if (type === 'control_request') {
    const request = rec(r['request'])
    const requestId = str(r, 'request_id') ?? str(request, 'request_id')
    const kind = str(request, 'subtype')
    if (requestId === undefined) return out
    if (kind !== 'can_use_tool') {
      out.ackRequestId = requestId
      return out
    }
    const toolName = str(request, 'tool_name') ?? 'tool'
    const input = rec(request?.['input']) ?? {}
    const suggestions = Array.isArray(request?.['permission_suggestions'])
      ? (request['permission_suggestions'] as unknown[])
      : []
    out.permission = { requestId, toolName, input, suggestions }
    if (toolName === 'AskUserQuestion') {
      out.events.push({ type: 'question', requestId, questions: questionsOf(input) })
    } else {
      const callId = str(request, 'tool_use_id')
      const modes = offeredModes(suggestions)
      out.events.push({
        type: 'approval',
        requestId,
        name: toolName,
        input,
        canAlways: suggestions.length > 0,
        ...(callId === undefined ? {} : { callId }),
        ...(modes.length === 0 ? {} : { modes }),
      })
    }
    return out
  }

  if (type === 'control_cancel_request') {
    const id = str(r, 'request_id') ?? str(rec(r['request']), 'request_id')
    if (id !== undefined) {
      out.cancelRequestId = id
      out.events.push({ type: 'resolved', requestId: id, status: 'cancelled' })
    }
    return out
  }

  if (sub) {
    const parentId = parent as string
    if (type === 'assistant') {
      const content = rec(r['message'])?.['content']
      for (const block of Array.isArray(content) ? content : []) {
        const b = rec(block)
        const callId = str(b, 'id')
        const name = str(b, 'name')
        if (str(b, 'type') === 'tool_use' && callId !== undefined && name !== undefined) {
          out.events.push({
            type: 'tool-input',
            callId,
            name,
            input: rec(b?.['input']) ?? {},
            parentId,
          })
        }
      }
    } else if (type === 'user') {
      out.events.push(...toolResults(r))
    }
    return out
  }

  if (type === 'stream_event') {
    const event = rec(r['event'])
    const etype = str(event, 'type')
    const index = typeof event?.['index'] === 'number' ? (event['index'] as number) : -1
    if (etype === 'message_start') {
      const message = rec(event?.['message'])
      reader.currentMessage = str(message, 'id') ?? null
      return out
    }
    if (etype === 'content_block_start') {
      const block = rec(event?.['content_block'])
      const btype = str(block, 'type')
      if (btype === 'tool_use' || btype === 'server_tool_use' || btype === 'mcp_tool_use') {
        const id = str(block, 'id')
        const name = str(block, 'name')
        if (id !== undefined && name !== undefined) {
          reader.toolsByIndex.set(index, { id, name, json: '' })
          out.events.push({
            type: 'tool-start',
            callId: id,
            name,
            input: rec(block?.['input']) ?? {},
          })
        }
      } else if (btype === 'text') {
        reader.textIndex = index
      } else if (btype === 'thinking' || btype === 'redacted_thinking') {
        reader.thinkingIndex = index
        if (reader.currentMessage !== null) reader.streamedThinking.add(reader.currentMessage)
        out.events.push({ type: 'reasoning', delta: '', at: reader.now() })
      }
      return out
    }
    if (etype === 'content_block_delta') {
      const delta = rec(event?.['delta'])
      const dtype = str(delta, 'type')
      if (dtype === 'text_delta') {
        const text = typeof delta?.['text'] === 'string' ? (delta['text'] as string) : ''
        if (text !== '') {
          out.events.push({ type: 'text', delta: text })
          if (reader.currentMessage !== null) reader.streamedMessages.add(reader.currentMessage)
        }
      } else if (dtype === 'thinking_delta') {
        const text = typeof delta?.['thinking'] === 'string' ? (delta['thinking'] as string) : ''
        if (text !== '') out.events.push({ type: 'reasoning', delta: text, at: reader.now() })
      } else if (dtype === 'input_json_delta') {
        const tool = reader.toolsByIndex.get(index)
        const partial =
          typeof delta?.['partial_json'] === 'string' ? (delta['partial_json'] as string) : ''
        if (tool !== undefined && partial !== '') {
          tool.json += partial
          try {
            const input = rec(JSON.parse(tool.json))
            if (input !== null)
              out.events.push({ type: 'tool-input', callId: tool.id, name: tool.name, input })
          } catch {
            // Not a whole object yet.
          }
        }
      }
      return out
    }
    if (etype === 'content_block_stop') {
      if (index === reader.textIndex) {
        reader.textIndex = -1
        out.events.push({ type: 'text-done' })
      }
      if (index === reader.thinkingIndex) {
        reader.thinkingIndex = -1
        out.events.push({ type: 'reasoning-done', at: reader.now() })
      }
      reader.toolsByIndex.delete(index)
      return out
    }
    return out
  }

  if (type === 'assistant') {
    const message = rec(r['message'])
    const id = str(message, 'id')
    const content = Array.isArray(message?.['content']) ? (message['content'] as unknown[]) : []
    const streamed = id !== undefined && reader.streamedMessages.has(id)
    for (const block of content) {
      const b = rec(block)
      const btype = str(b, 'type')
      if (btype === 'tool_use') {
        const callId = str(b, 'id')
        const name = str(b, 'name')
        if (callId !== undefined && name !== undefined) {
          out.events.push({ type: 'tool-input', callId, name, input: rec(b?.['input']) ?? {} })
        }
      } else if (btype === 'text' && !streamed) {
        const text = str(b, 'text')
        if (text !== undefined) out.events.push({ type: 'text-done', text })
      } else if (btype === 'thinking' && !(id !== undefined && reader.streamedThinking.has(id))) {
        // Thinking that came whole, without stream events.
        const text = str(b, 'thinking')
        if (text !== undefined) {
          const at = reader.now()
          out.events.push({ type: 'reasoning', delta: text, at }, { type: 'reasoning-done', at })
        }
      }
    }
    const used = usageTokens(rec(message?.['usage']))
    if (used > 0) reader.usedTokens = used
    const model = str(message, 'model')
    if (model !== undefined && model !== '<synthetic>') reader.model = model
    return out
  }

  if (type === 'user') {
    out.events.push(...toolResults(r))
    const said = commandOutput(rec(r['message'])?.['content'])
    if (said !== undefined) out.events.push({ type: 'text-done', text: said })
    return out
  }

  if (type === 'rate_limit_event') {
    const info = rec(r['rate_limit_info'])
    const status = str(info, 'status')
    const resets = typeof info?.['resetsAt'] === 'number' ? (info['resetsAt'] as number) : undefined
    const when = resets === undefined ? '' : `; resets at ${clockTime(resets)}`
    if (status === 'rejected') {
      out.events.push({
        type: 'status',
        text: `Usage limit reached${when}`,
        icon: 'limit',
        tone: 'warning',
      })
    } else if (status === 'allowed_warning') {
      out.events.push({ type: 'status', text: `Close to the usage limit${when}`, icon: 'limit' })
    }
    return out
  }

  if (type === 'system') {
    if (subtype === 'init') {
      const model = str(r, 'model')
      if (model !== undefined) reader.model = model
      const tuiOnly = new Set(strings(r['terminal_slash_commands']))
      const names = strings(r['slash_commands']).filter((n) => !tuiOnly.has(n))
      if (names.length > 0) out.commands = { names, skills: strings(r['skills']) }
      const servers = (Array.isArray(r['mcp_servers']) ? (r['mcp_servers'] as unknown[]) : [])
        .map((m) => rec(m))
        .filter((m): m is JsonRecord => str(m, 'name') !== undefined)
        .map((m) => ({ name: str(m, 'name')!, status: str(m, 'status') ?? 'unknown' }))
      const version = str(r, 'claude_code_version')
      out.info = {
        tools: strings(r['tools']),
        mcpServers: servers,
        ...(version === undefined ? {} : { version }),
        ...(model === undefined ? {} : { model }),
      }
      const mode = str(r, 'permissionMode')
      if (mode !== undefined) {
        // Where a process starts is no change: only a switch after it is.
        reader.mode = mode
        out.mode = mode
      }
      return out
    }
    if (subtype === 'status') {
      const mode = str(r, 'permissionMode')
      if (mode !== undefined && mode !== reader.mode) {
        out.events.push({
          type: 'mode',
          mode,
          ...(reader.mode === null ? {} : { from: reader.mode }),
        })
        reader.mode = mode
        out.mode = mode
      }
      const text = (str(r, 'message') ?? '').trim()
      if (text !== '' && !QUIET_STATUS.test(text)) out.events.push({ type: 'status', text })
      return out
    }
    if (subtype === 'compact_boundary') {
      const meta = rec(r['compact_metadata'])
      const before = num(meta, 'pre_tokens')
      const after = num(meta, 'post_tokens')
      out.events.push({
        type: 'status',
        text:
          str(meta, 'trigger') === 'auto' ? 'Context compacted automatically' : 'Context compacted',
        icon: 'compact',
        ...(before > 0 ? { detail: `${tokens(before)} → ${tokens(after)} tokens` } : {}),
      })
      return out
    }
    if (subtype === 'api_retry') {
      const attempt = num(r, 'attempt')
      const max = num(r, 'max_retries')
      const status = num(r, 'error_status')
      const error = str(r, 'error')
      out.events.push({
        type: 'status',
        text: `Retrying the request${attempt > 0 ? ` (attempt ${attempt}${max > 0 ? ` of ${max}` : ''})` : ''}`,
        icon: 'retry',
        tone: 'warning',
        ...(error !== undefined || status > 0
          ? { detail: [status > 0 ? String(status) : '', error ?? ''].filter(Boolean).join(' ') }
          : {}),
      })
      return out
    }
    if (subtype === 'informational') {
      const text = (str(r, 'content') ?? '').trim()
      if (text !== '') {
        out.events.push({
          type: 'status',
          text,
          icon: /hook|says:/i.test(text) ? 'hook' : 'info',
          ...(str(r, 'level') === 'warning' ? { tone: 'warning' as const } : {}),
        })
      }
      return out
    }
    if (subtype === 'hook_response') {
      // A hook that ran and said nothing is no news; one that failed is.
      const code = r['exit_code']
      if (typeof code === 'number' && code !== 0 && str(r, 'hook_event') !== 'PreToolUse') {
        const said = (str(r, 'stderr') ?? str(r, 'output') ?? '').trim()
        out.events.push({
          type: 'status',
          text: `The ${str(r, 'hook_name') ?? 'hook'} hook failed`,
          icon: 'hook',
          tone: 'warning',
          ...(said === '' ? {} : { detail: said }),
        })
      }
      return out
    }
    return out
  }

  if (type === 'result') {
    // A replayed background-task note on resume belongs to no turn.
    if (str(rec(r['origin']), 'kind') === 'task-notification' && r['num_turns'] === 0) return out
    for (const d of Array.isArray(r['permission_denials'])
      ? (r['permission_denials'] as unknown[])
      : []) {
      const callId = str(rec(d), 'tool_use_id')
      if (callId !== undefined) out.events.push({ type: 'tool-denied', callId })
    }
    // The person stopped it: no failure to report.
    const interrupted = reader.interrupting
    reader.interrupting = false
    const failed =
      !interrupted && (r['is_error'] === true || (subtype !== undefined && subtype !== 'success'))
    const errors = Array.isArray(r['errors'])
      ? (r['errors'] as unknown[]).filter((e): e is string => typeof e === 'string')
      : []
    const error = failed ? (errors[0] ?? str(r, 'result') ?? 'The turn failed.') : undefined
    if (error !== undefined) out.events.push({ type: 'error', text: error })
    const model = turnModel(r, reader.model)
    const usageOfTurn = turnUsage(r)
    out.turnEnded = {
      failed,
      ...(interrupted ? { interrupted: true } : {}),
      ...(error === undefined ? {} : { error }),
      ...(model === undefined ? {} : { model }),
      ...(usageOfTurn === undefined ? {} : { usage: usageOfTurn }),
    }
    // The last request is what sits in the window; the model's window is the
    // CLI's to say, so no table of models is kept here.
    const usage = rec(r['usage'])
    const iterations = Array.isArray(usage?.['iterations'])
      ? (usage['iterations'] as unknown[])
      : []
    const used = usageTokens(rec(iterations.at(-1))) || reader.usedTokens
    let window = 0
    for (const entry of Object.values(rec(r['modelUsage']) ?? {})) {
      window = Math.max(window, num(rec(entry), 'contextWindow'))
    }
    if (used > 0 && window > 0)
      out.contextPercent = Math.min(100, Math.round((used / window) * 100))
    reader.streamedMessages.clear()
    return out
  }

  return out
}
