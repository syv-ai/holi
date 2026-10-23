/**
 * The one place Claude Code's transcript shapes are known (see `entries.ts`
 * for what comes out, `known.ts` for the tables). Total: it never throws, and
 * a line it cannot place becomes an `unknown` entry or a named hidden reason,
 * never nothing and never a crash. A format change costs one row.
 *
 * One line in, one result out. Nothing here looks at a neighbouring line:
 * Claude Code writes one line per content block and interleaves them, so the
 * chat joins by id (a tool call and its result share the call's id), and the
 * order is the file's. Timestamps and `parentUuid` are never read.
 */
import type { ChatEntry, Disposition, HiddenReason, LineResult, NoticeSource } from './entries'
import {
  ASSISTANT_BLOCKS,
  HIDDEN_LINE_TYPES,
  INTERRUPT_TEXT,
  isHarnessText,
  MODEL_FACING_ATTACHMENTS,
  READ_ATTACHMENTS,
  READ_SYSTEM_SUBTYPES,
  USER_BLOCKS,
} from './known'
import {
  clipString,
  imageRef,
  LIMITS,
  rawJson,
  sanitiseArgs,
  sanitiseResultData,
  toolSummary,
} from './sanitise'

/** A line longer than this is not parsed: a placeholder stands for it. The
 *  largest in a scan of real sessions was 1.3 MB (a screenshot). */
export const MAX_LINE_BYTES = 4 * 1024 * 1024

export interface ClassifyOptions {
  /** The line is from a sub-agent's own file: its `isSidechain` is expected. */
  sidechain?: boolean
  /** Where the line starts in its file, in bytes. Names a line that has no
   *  `uuid` of its own, so its id is the same on every read. */
  at?: number
}

type Row = Record<string, unknown>

const isRecord = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** A value in a shape key: structure only, so safe to log. */
function tidy(value: unknown): string {
  if (typeof value === 'string') return value.replace(/[^\w.:-]/g, '?').slice(0, 48) || 'empty'
  if (value === undefined) return 'none'
  return `<${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}>`
}

/**
 * A line's signature: the fields that decide how it is read, never its
 * content. `attachment|queued_command`, `system|turn_duration`, `mode`.
 * Stable, so the drift report can count by it and a log can name it.
 */
export function shapeKey(row: unknown): string {
  if (!isRecord(row)) return `json|${tidy(row).replace(/[<>]/g, '')}`
  const type = row['type']
  if (type === 'system') return `system|${tidy(row['subtype'])}`
  if (type === 'attachment') {
    const attachment = row['attachment']
    return `attachment|${isRecord(attachment) ? tidy(attachment['type']) : 'none'}`
  }
  return typeof type === 'string' ? tidy(type) : `untyped|${tidy(type).replace(/[<>]/g, '')}`
}

const blockShape = (row: Row, block: unknown): string =>
  `${tidy(row['type'])}|block:${isRecord(block) ? tidy(block['type']) : tidy(block).replace(/[<>]/g, '')}`

/** A cheap stable hash, for naming a line that has neither `uuid` nor place. */
function hash(text: string): string {
  let h = 0x811c9dc5
  const end = Math.min(text.length, 4096)
  for (let i = 0; i < end; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36) + text.length.toString(36)
}

// ---- results -------------------------------------------------------------

const hidden = (reason: HiddenReason, version?: string): LineResult => ({
  entries: [],
  disposition: { kind: 'hidden', reason },
  ...(version === undefined ? {} : { version }),
})

/** A line only counted: it is not drawn, and the drift report names it. */
const countedHidden = (shape: string, version?: string): LineResult => ({
  entries: [],
  disposition: { kind: 'unknown', shape },
  ...(version === undefined ? {} : { version }),
})

function unknownEntry(id: string, shape: string, raw: string, version?: string): ChatEntry {
  return { kind: 'unknown', id, shape, raw, ...(version === undefined ? {} : { version }) }
}

/** What an oversize line (see `MAX_LINE_BYTES`) becomes, without parsing it. */
export function oversizeLine(bytes: number, options: ClassifyOptions = {}): LineResult {
  const id = options.at === undefined ? `oversize:${bytes}` : `L${options.at}`
  return {
    entries: [unknownEntry(id, 'oversize', `<line of ${bytes} bytes, not read>`)],
    disposition: { kind: 'unknown', shape: 'oversize' },
  }
}

/** What accumulates while one line is read. */
class Acc {
  entries: ChatEntry[] = []
  /** The first thing on the line this reader has no rule for. */
  unknownShape: string | undefined
  /** Why nothing was drawn, if nothing was. */
  reason: HiddenReason = 'empty'
  constructor(readonly version: string | undefined) {}

  push(entry: ChatEntry): void {
    this.entries.push(entry)
  }
  unknown(id: string, shape: string, value: unknown): void {
    this.unknownShape ??= shape
    this.entries.push(unknownEntry(id, shape, rawJson(value), this.version))
  }
  hide(reason: HiddenReason): void {
    this.reason = reason
  }
  done(): LineResult {
    const disposition: Disposition =
      this.unknownShape !== undefined
        ? { kind: 'unknown', shape: this.unknownShape }
        : this.entries.length > 0
          ? { kind: 'rendered' }
          : { kind: 'hidden', reason: this.reason }
    return {
      entries: this.entries,
      disposition,
      ...(this.version === undefined ? {} : { version: this.version }),
    }
  }
}

// ---- text wrappers ---------------------------------------------------------

/** The text between `<name>` and `</name>`, or undefined. Linear: indexOf,
 *  never a backtracking pattern, so hostile text costs one pass. */
function tagText(text: string, name: string): string | undefined {
  const open = `<${name}>`
  const from = text.indexOf(open)
  if (from === -1) return undefined
  const to = text.indexOf(`</${name}>`, from + open.length)
  return to === -1 ? undefined : text.slice(from + open.length, to)
}

/** `text` without its `<name>…</name>` blocks. An unclosed one is left. */
function stripTag(text: string, name: string): string {
  const open = `<${name}>`
  const close = `</${name}>`
  let out = ''
  let at = 0
  for (;;) {
    const from = text.indexOf(open, at)
    if (from === -1) break
    const to = text.indexOf(close, from + open.length)
    if (to === -1) break
    out += text.slice(at, from)
    at = to + close.length
  }
  return out + text.slice(at)
}

/** A first line to stand for a longer text, with tags taken out. */
function headline(text: string, limit = 240): string {
  const line = text
    .slice(0, limit * 4)
    .replace(/<[^>]{1,80}>/g, ' ')
    .trim()
    .split('\n')[0]!
    .trim()
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

const clipDetail = (text: string): string => clipString(text, LIMITS.string)

type TextPart =
  | { part: 'plain'; text: string }
  | { part: 'entry'; entry: ChatEntry }
  | { part: 'hidden'; reason: HiddenReason }

const LEADING_TAG = /^<([a-z][a-z-]{0,40})[\s>]/

/**
 * The words of one piece of user-side text: the person's own, or a wrapper
 * Claude Code put around something else. `origin` is the line's
 * `origin.kind`, when it has one. `machinery` says the line cannot be the
 * person's (a sub-agent's own file, no human origin): only then is text in
 * one of the harness's exact formats hidden. An unknown leading tag is the
 * person's text, kept (they may have pasted markup).
 */
function readText(
  raw: string,
  id: string,
  origin: string | undefined,
  machinery: boolean,
): TextPart {
  const trimmed = raw.trim()
  if (trimmed === '') return { part: 'hidden', reason: 'empty' }

  if (trimmed.startsWith(INTERRUPT_TEXT) && trimmed.length < 100 && trimmed.endsWith(']')) {
    return {
      part: 'entry',
      entry: { kind: 'interrupt', id, forTool: trimmed.includes('for tool use') },
    }
  }
  if (machinery && isHarnessText(trimmed)) {
    return { part: 'hidden', reason: 'machinery' }
  }

  const text = stripTag(trimmed, 'system-reminder').trim()
  if (text === '') return { part: 'hidden', reason: 'machinery' }

  const lead = LEADING_TAG.exec(text)?.[1]
  switch (lead) {
    case 'local-command-caveat':
      return { part: 'hidden', reason: 'machinery' }
    case 'command-name':
    case 'command-message':
    case 'command-args': {
      const name = (tagText(text, 'command-name') ?? tagText(text, 'command-message') ?? '').trim()
      if (name === '') break
      return {
        part: 'entry',
        entry: {
          kind: 'command',
          id,
          name: clipString(name, 200),
          args: clipString((tagText(text, 'command-args') ?? '').trim(), LIMITS.string),
        },
      }
    }
    case 'local-command-stdout':
    case 'local-command-stderr':
    case 'bash-input':
    case 'bash-stdout':
    case 'bash-stderr': {
      const command = tagText(text, 'bash-input')
      const stdout = tagText(text, 'local-command-stdout') ?? tagText(text, 'bash-stdout')
      const stderr = tagText(text, 'local-command-stderr') ?? tagText(text, 'bash-stderr')
      const field = (v: string | undefined): string | undefined =>
        v === undefined || v.trim() === '' ? undefined : clipString(v.trim(), LIMITS.resultText)
      const entry: ChatEntry = { kind: 'shell', id }
      const c = field(command)
      const o = field(stdout)
      const e = field(stderr)
      if (c !== undefined) entry.command = c
      if (o !== undefined) entry.stdout = o
      if (e !== undefined) entry.stderr = e
      if (c === undefined && o === undefined && e === undefined) {
        return { part: 'hidden', reason: 'empty' }
      }
      return { part: 'entry', entry }
    }
    case 'task-notification': {
      const get = (name: string): string | undefined => {
        const v = tagText(text, name)?.trim()
        return v === undefined || v === '' ? undefined : clipString(v, LIMITS.string)
      }
      const taskId = get('task-id')
      const toolUseId = get('tool-use-id')
      const status = get('status') ?? (tagText(text, 'event') === undefined ? 'update' : 'event')
      const entry: ChatEntry = {
        kind: 'task-note',
        id,
        status,
        summary: get('summary') ?? get('event') ?? '',
      }
      if (taskId !== undefined) entry.taskId = taskId
      if (toolUseId !== undefined) entry.toolUseId = toolUseId
      return { part: 'entry', entry }
    }
    default:
      break
  }

  if (lead === 'agent-message' || origin === 'peer' || origin === 'coordinator') {
    return notice(id, 'peer', 'info', headline(text) || 'A message from another agent', text)
  }
  if (origin === 'task-notification') {
    return notice(id, 'task', 'info', headline(text) || 'A background task reported', text)
  }
  return { part: 'plain', text }
}

function notice(
  id: string,
  source: NoticeSource,
  tone: 'info' | 'warn' | 'error',
  text: string,
  detail?: string,
): TextPart {
  const entry: ChatEntry = { kind: 'notice', id, source, tone, text: clipString(text, 400) }
  if (detail !== undefined && detail.trim() !== '' && detail.trim() !== text) {
    entry.detail = clipString(detail.trim(), LIMITS.resultText)
  }
  return { part: 'entry', entry }
}

// ---- user lines ------------------------------------------------------------

/** Plain text of a message's content, for a summary or an error. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) =>
      isRecord(b) && b['type'] === 'text' && typeof b['text'] === 'string' ? b['text'] : '',
    )
    .filter((t) => t !== '')
    .join('\n')
}

/** What a tool result's `content` says, and the pictures in it. */
function readResultContent(content: unknown): {
  text: string
  images: ReturnType<typeof imageRef>[]
} {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const texts: string[] = []
  const images: ReturnType<typeof imageRef>[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string') texts.push(block['text'])
    else if (block['type'] === 'image') images.push(imageRef(block))
    else if (block['type'] === 'tool_reference' && typeof block['tool_name'] === 'string') {
      texts.push(clipString(block['tool_name'], 200))
    } else texts.push(`[unsupported block: ${tidy(block['type'])}]`)
  }
  return { text: texts.join('\n'), images }
}

const TOOL_ERROR = /^<tool_use_error>([\s\S]*)<\/tool_use_error>\s*$/

function readToolResult(block: Row, twin: unknown): ChatEntry | undefined {
  const id = block['tool_use_id']
  if (typeof id !== 'string' || id === '') return undefined
  const { text: whole, images } = readResultContent(block['content'])
  const flag = block['is_error']
  // Claude Code leaves `is_error` out of most results; an absent flag is "no",
  // except for the two failures it words the same way every time.
  const sniffedFailure = /^<tool_use_error>/.test(whole) || /^Exit code [1-9]\d*\b/.test(whole)
  const ok = flag === true ? false : flag === false ? true : !sniffedFailure
  const unwrapped = TOOL_ERROR.exec(whole)
  const body = unwrapped === null ? whole : unwrapped[1]!
  const text = clipString(body, LIMITS.resultText)
  const { data, clipped: dataClipped } = sanitiseResultData(twin)
  const entry: ChatEntry = { kind: 'tool-result', id, ok, text }
  if (images.length > 0) entry.images = images
  if (data !== undefined) entry.data = data
  if (text.length < body.length || dataClipped) entry.clipped = true
  return entry
}

function classifyUser(row: Row, base: string, acc: Acc, sidechain: boolean): void {
  if (row['isCompactSummary'] === true) {
    const message = row['message']
    const summary = textOf(isRecord(message) ? message['content'] : undefined)
    acc.push({
      kind: 'notice',
      id: base,
      source: 'compact-summary',
      tone: 'info',
      text: 'The earlier conversation was summarised.',
      ...(summary.trim() === '' ? {} : { detail: clipString(summary.trim(), LIMITS.resultText) }),
    })
    return
  }
  if (row['isMeta'] === true) {
    acc.hide('machinery')
    return
  }
  const message = row['message']
  if (!isRecord(message)) {
    acc.unknown(base, 'user|no-message', row)
    return
  }
  const content = message['content']
  const origin = isRecord(row['origin']) ? row['origin']['kind'] : undefined
  const originKind = typeof origin === 'string' ? origin : undefined
  // Harness text is only hidden where the person cannot have written it.
  const machinery = sidechain && originKind !== 'human'

  if (typeof content === 'string') {
    const part = readText(content, base, originKind, machinery)
    if (part.part === 'plain') acc.push({ kind: 'user', id: base, text: part.text })
    else if (part.part === 'entry') acc.push(part.entry)
    else acc.hide(part.reason)
    return
  }
  if (!Array.isArray(content)) {
    acc.unknown(base, `user|content:${tidy(content).replace(/[<>]/g, '')}`, message)
    return
  }

  const twin = row['toolUseResult']
  const results = content.filter((b) => isRecord(b) && b['type'] === 'tool_result').length
  const typed: string[] = []
  let images = 0
  content.forEach((block: unknown, i) => {
    const id = `${base}:${i}`
    if (!isRecord(block) || typeof block['type'] !== 'string' || !USER_BLOCKS.has(block['type'])) {
      acc.unknown(id, blockShape(row, block), block)
      return
    }
    if (block['type'] === 'image') {
      images += 1
    } else if (block['type'] === 'text') {
      if (typeof block['text'] !== 'string') {
        acc.unknown(id, `user|block:text-malformed`, block)
        return
      }
      const part = readText(block['text'], id, originKind, machinery)
      if (part.part === 'plain') typed.push(part.text)
      else if (part.part === 'entry') acc.push(part.entry)
      else acc.hide(part.reason)
    } else {
      const entry = readToolResult(block, results === 1 ? twin : undefined)
      if (entry === undefined) acc.unknown(id, 'user|block:tool_result-malformed', block)
      else acc.push(entry)
    }
  })
  if (typed.length > 0 || images > 0) {
    const text = typed.join('\n\n')
    const entry: ChatEntry = { kind: 'user', id: base, text }
    if (images > 0) entry.images = images
    acc.entries.unshift(entry)
  }
}

// ---- assistant lines -------------------------------------------------------

function classifyAssistant(row: Row, base: string, acc: Acc): void {
  const message = row['message']
  const content = isRecord(message) ? message['content'] : undefined

  if (row['isApiErrorMessage'] === true) {
    const said = textOf(content).trim()
    acc.push({
      kind: 'notice',
      id: base,
      source: 'api-error',
      tone: 'error',
      text: clipString(said === '' ? 'The API returned an error.' : said, 400),
      ...(typeof row['error'] === 'string' ? { detail: clipString(row['error'], 400) } : {}),
    })
    return
  }
  if (!isRecord(message)) {
    acc.unknown(base, 'assistant|no-message', row)
    return
  }
  // A string is not what Claude Code writes, but it is only text.
  const blocks: unknown[] | null =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content
        : null
  if (blocks === null) {
    acc.unknown(base, `assistant|content:${tidy(content).replace(/[<>]/g, '')}`, message)
    return
  }

  blocks.forEach((block, i) => {
    const id = `${base}:${i}`
    if (
      !isRecord(block) ||
      typeof block['type'] !== 'string' ||
      !ASSISTANT_BLOCKS.has(block['type'])
    ) {
      acc.unknown(id, blockShape(row, block), block)
      return
    }
    switch (block['type']) {
      case 'text': {
        const text = block['text']
        if (typeof text !== 'string') acc.unknown(id, 'assistant|block:text-malformed', block)
        else if (text.trim() === '') acc.hide('empty')
        else acc.push({ kind: 'assistant', id, text })
        return
      }
      case 'thinking': {
        const text = block['thinking']
        if (typeof text !== 'string') acc.unknown(id, 'assistant|block:thinking-malformed', block)
        else if (text.trim() === '') acc.hide('empty')
        else acc.push({ kind: 'thinking', id, text })
        return
      }
      case 'redacted_thinking':
        acc.hide('empty')
        return
      default: {
        // tool_use. The call's own id is the entry's: its result names it.
        const callId = block['id']
        const name =
          typeof block['name'] === 'string' && block['name'] !== '' ? block['name'] : 'tool'
        const { args, clipped } = sanitiseArgs(name, block['input'])
        acc.push({
          kind: 'tool',
          id: typeof callId === 'string' && callId !== '' ? callId : id,
          name: clipString(name, 200),
          summary: toolSummary(block['input']),
          args,
          ...(clipped ? { clipped: true } : {}),
        })
      }
    }
  })
  if (row['isAbortedMidStream'] === true) {
    acc.push({ kind: 'interrupt', id: `${base}:aborted`, forTool: false })
  }
}

// ---- attachment lines ------------------------------------------------------

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

function classifyAttachment(row: Row, base: string, acc: Acc, sidechain: boolean): void {
  const attachment = row['attachment']
  const type = isRecord(attachment) ? attachment['type'] : undefined
  if (!isRecord(attachment) || typeof type !== 'string') {
    // No type to look up: counted, not drawn.
    acc.unknownShape = shapeKey(row)
    return
  }
  if (MODEL_FACING_ATTACHMENTS.has(type)) {
    acc.hide('model-facing')
    return
  }
  if (!READ_ATTACHMENTS.has(type)) {
    acc.unknownShape = shapeKey(row)
    return
  }

  switch (type) {
    case 'queued_command': {
      if (attachment['isMeta'] === true || typeof attachment['prompt'] !== 'string') {
        acc.hide('machinery')
        return
      }
      const originRow = attachment['origin']
      const kind = isRecord(originRow) ? str(originRow['kind']) : undefined
      const origin =
        kind ?? (attachment['commandMode'] === 'task-notification' ? 'task-notification' : 'human')
      const part = readText(
        attachment['prompt'],
        base,
        origin === 'human' ? undefined : origin,
        sidechain && origin !== 'human',
      )
      if (part.part === 'plain') {
        acc.push({ kind: 'user', id: base, text: part.text, queued: true })
      } else if (part.part === 'entry') acc.push(part.entry)
      else acc.hide(part.reason)
      return
    }
    case 'hook_non_blocking_error': {
      const name = str(attachment['hookName']) ?? str(attachment['hookEvent']) ?? 'hook'
      const code = attachment['exitCode']
      const detail = str(attachment['stderr'])?.trim() ?? str(attachment['stdout'])?.trim()
      acc.push({
        kind: 'notice',
        id: base,
        source: 'hook',
        tone: 'warn',
        text: clipString(`${name} failed${typeof code === 'number' ? ` (exit ${code})` : ''}`, 400),
        ...(detail === undefined || detail === '' ? {} : { detail: clipDetail(detail) }),
      })
      return
    }
    case 'hook_system_message': {
      const content = str(attachment['content'])
      if (content === undefined) {
        acc.hide('empty')
        return
      }
      const part = notice(base, 'hook', 'info', headline(content, 300), content)
      if (part.part === 'entry') acc.push(part.entry)
      return
    }
    default: {
      // task_status
      const description =
        str(attachment['description']) ?? str(attachment['taskId']) ?? 'A background task'
      const status = str(attachment['status']) ?? 'update'
      const delta = str(attachment['deltaSummary'])
      const part = notice(
        base,
        'task',
        'info',
        `${headline(description, 200)}: ${tidy(status)}`,
        delta,
      )
      if (part.part === 'entry') acc.push(part.entry)
    }
  }
}

// ---- system lines ----------------------------------------------------------

const toneOf = (level: unknown): 'info' | 'warn' | 'error' =>
  level === 'error' ? 'error' : level === 'warning' || level === 'warn' ? 'warn' : 'info'

/** `text` with the wrappers of a local command's output taken off. */
function unwrapLocal(text: string): string {
  let out = text
  for (const tag of ['local-command-stdout', 'local-command-stderr', 'command-message']) {
    out = out.split(`<${tag}>`).join('').split(`</${tag}>`).join('')
  }
  return out.trim()
}

function classifySystem(row: Row, base: string, acc: Acc): void {
  const subtype = row['subtype']
  if (typeof subtype !== 'string' || !READ_SYSTEM_SUBTYPES.has(subtype)) {
    acc.unknown(base, shapeKey(row), row)
    return
  }
  const content = typeof row['content'] === 'string' ? row['content'] : ''

  switch (subtype) {
    case 'away_summary': {
      const text = content.trim()
      if (text === '') acc.hide('empty')
      else
        acc.push({
          kind: 'notice',
          id: base,
          source: 'away',
          tone: 'info',
          text: clipString(text, LIMITS.string),
        })
      return
    }
    case 'model_refusal_fallback': {
      const explanation = str(row['apiRefusalExplanation'])
      acc.push({
        kind: 'notice',
        id: base,
        source: 'refusal',
        tone: 'warn',
        text: clipString(content.trim() || 'The model declined, so another model was used.', 400),
        ...(explanation === undefined ? {} : { detail: clipDetail(explanation) }),
      })
      return
    }
    case 'compact_boundary': {
      const meta = isRecord(row['compactMetadata']) ? row['compactMetadata'] : {}
      const num = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined
      const entry: ChatEntry = { kind: 'compaction', id: base }
      if (typeof meta['trigger'] === 'string') entry.trigger = clipString(meta['trigger'], 40)
      const pre = num(meta['preTokens'])
      const post = num(meta['postTokens'])
      if (pre !== undefined) entry.preTokens = pre
      if (post !== undefined) entry.postTokens = post
      acc.push(entry)
      return
    }
    case 'turn_duration': {
      const ms = row['durationMs']
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
        acc.unknown(base, 'system|turn_duration', row)
      } else acc.push({ kind: 'turn-end', id: base, durationMs: ms })
      return
    }
    case 'local_command': {
      const run = isRecord(row['commandRun']) ? row['commandRun'] : undefined
      const command = run === undefined ? undefined : str(run['command'])
      const inner = unwrapLocal(content)
      if (command !== undefined) {
        const args = str(run?.['args'])
        acc.push({
          kind: 'notice',
          id: base,
          source: 'local-command',
          tone: toneOf(row['level']),
          text: clipString(args === undefined ? command : `${command} ${args}`, 400),
          ...(inner === '' ? {} : { detail: clipString(inner, LIMITS.resultText) }),
        })
      } else if (inner === '') acc.hide('empty')
      else {
        acc.push({
          kind: 'notice',
          id: base,
          source: 'local-command',
          tone: toneOf(row['level']),
          text: clipString(headline(inner, 400), 400),
          ...(inner === headline(inner, 400)
            ? {}
            : { detail: clipString(inner, LIMITS.resultText) }),
        })
      }
      return
    }
    case 'informational': {
      const text = content.trim()
      if (text === '') acc.hide('empty')
      else {
        acc.push({
          kind: 'notice',
          id: base,
          source: 'info',
          tone: toneOf(row['level']),
          text: clipString(headline(text, 400), 400),
          ...(text === headline(text, 400) ? {} : { detail: clipString(text, LIMITS.string) }),
        })
      }
      return
    }
    default: {
      // stop_hook_summary: a quiet success is machinery; an error is not.
      const errors = row['hookErrors']
      if (!Array.isArray(errors) || errors.length === 0) {
        acc.hide('machinery')
        return
      }
      const lines = errors.map((e) => (typeof e === 'string' ? e : rawJson(e)))
      acc.push({
        kind: 'notice',
        id: base,
        source: 'hook',
        tone: 'warn',
        text: 'A hook reported an error.',
        detail: clipDetail(lines.join('\n')),
      })
    }
  }
}

// ---- the entry point -------------------------------------------------------

function classify(line: string, options: ClassifyOptions): LineResult {
  if (typeof line !== 'string') {
    return {
      entries: [unknownEntry(`h${hash(String(line))}`, 'unparseable', '')],
      disposition: { kind: 'unknown', shape: 'unparseable' },
    }
  }
  if (line.length > MAX_LINE_BYTES) return oversizeLine(line.length, options)
  if (line.trim() === '') return hidden('empty')

  const fallbackId = options.at === undefined ? `h${hash(line)}` : `L${options.at}`
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return {
      entries: [unknownEntry(fallbackId, 'unparseable', clipString(line, LIMITS.raw))],
      disposition: { kind: 'unknown', shape: 'unparseable' },
    }
  }
  if (!isRecord(parsed)) {
    const shape = shapeKey(parsed)
    return {
      entries: [unknownEntry(fallbackId, shape, rawJson(parsed))],
      disposition: { kind: 'unknown', shape },
    }
  }

  const row = parsed
  const version =
    typeof row['version'] === 'string' && row['version'].length <= 40 ? row['version'] : undefined
  const type = row['type']

  if (type !== 'user' && type !== 'assistant' && type !== 'attachment' && type !== 'system') {
    const reason = typeof type === 'string' ? HIDDEN_LINE_TYPES.get(type) : undefined
    return reason === undefined ? countedHidden(shapeKey(row), version) : hidden(reason, version)
  }
  // A sub-agent's line in the main file is that sub-agent's conversation.
  if (row['isSidechain'] === true && options.sidechain !== true) return hidden('sidechain', version)

  const uuid = row['uuid']
  const base = typeof uuid === 'string' && uuid !== '' ? uuid : fallbackId
  const sidechain = row['isSidechain'] === true || options.sidechain === true
  const acc = new Acc(version)
  switch (type) {
    case 'user':
      classifyUser(row, base, acc, sidechain)
      break
    case 'assistant':
      classifyAssistant(row, base, acc)
      break
    case 'attachment':
      classifyAttachment(row, base, acc, sidechain)
      break
    default:
      classifySystem(row, base, acc)
  }
  return acc.done()
}

/**
 * One transcript line as a result: the entries it draws, and why if none.
 * Total: whatever `line` is, this returns. A line the reader cannot place
 * costs one `unknown` entry (or a count, if it is not conversation).
 */
export function classifyLine(line: string, options: ClassifyOptions = {}): LineResult {
  try {
    return classify(line, options)
  } catch {
    // A bug in a rule above must not take the chat with it.
    const id = options.at === undefined ? 'internal-error' : `L${options.at}`
    return {
      entries: [unknownEntry(id, 'internal-error', '')],
      disposition: { kind: 'unknown', shape: 'internal-error' },
    }
  }
}
