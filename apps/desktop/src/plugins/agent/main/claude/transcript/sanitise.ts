/**
 * Making what a transcript carries safe to send to the chat: every string
 * clipped, base64 and huge lists replaced by a marker saying what was there.
 * Tool inputs and the structured twin of a tool result (`toolUseResult`) are
 * free-form JSON written by someone else's code, so none of it is trusted to
 * be small, flat or well-typed. Pure: no I/O, never throws.
 */
import { LONG_INPUT_KEYS, LONG_INPUT_TOOLS, SUMMARY_KEYS } from './known'
import type { ImageRef, Plain } from './entries'

export const LIMITS = {
  /** Any string in a tool's input or result data. */
  string: 4000,
  /** Text a tool was asked to write, replace or plan. */
  longString: 20000,
  /** A tool result's text. */
  resultText: 30000,
  /** The `raw` of an `unknown` entry. */
  raw: 2000,
  /** Items kept of one array. */
  items: 50,
  /** Entries of a web search kept. */
  searchResults: 10,
  /** Keys kept of one object. */
  keys: 60,
  /** Nesting kept. */
  depth: 6,
  /** All the string text kept of one input / one result's data. */
  argsBudget: 160_000,
  dataBudget: 60_000,
} as const

/** Where a clipped string ends. Not in the middle of a surrogate pair. */
export function clipString(text: string, limit: number): string {
  if (text.length <= limit) return text
  let end = limit
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}\n…`
}

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/
const BASE64_KEY = /base64|b64/i

/** A long unbroken run of base64 characters: an image or a blob, not prose.
 *  Random bytes in base64 mix cases and digits; a run of one letter is text. */
export function isBase64Like(text: string): boolean {
  if (text.length < 512 || !BASE64.test(text)) return false
  const head = text.slice(0, 256)
  const classes =
    Number(/[A-Z]/.test(head)) + Number(/[a-z]/.test(head)) + Number(/[0-9]/.test(head))
  return classes >= 2
}

/** The decoded size of a base64 string, in bytes. */
const decodedBytes = (base64Length: number): number => Math.floor((base64Length * 3) / 4)

interface Walk {
  clipped: boolean
  budget: number
  /** The keys whose text may run to the long limit. */
  long: ReadonlySet<string> | null
}

/** Set `key` on `out` as an own property, even when it is `__proto__`. */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

function walkString(text: string, key: string | null, w: Walk): string {
  if ((key !== null && BASE64_KEY.test(key) && text.length > 64) || isBase64Like(text)) {
    w.clipped = true
    return `<base64 ${text.length} chars>`
  }
  const limit = Math.max(
    200,
    Math.min(
      w.long !== null && key !== null && w.long.has(key) ? LIMITS.longString : LIMITS.string,
      w.budget,
    ),
  )
  if (text.length > limit) w.clipped = true
  const kept = clipString(text, limit)
  w.budget -= kept.length
  return kept
}

function walk(value: unknown, key: string | null, depth: number, w: Walk): unknown {
  if (typeof value === 'string') return walkString(value, key, w)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) {
    if (depth >= LIMITS.depth) {
      w.clipped = true
      return `<${value.length} items>`
    }
    const out = value.slice(0, LIMITS.items).map((item) => walk(item, key, depth + 1, w))
    if (value.length > LIMITS.items) {
      w.clipped = true
      out.push(`<${value.length - LIMITS.items} more items>`)
    }
    return out
  }
  if (typeof value === 'object') {
    if (depth >= LIMITS.depth) {
      w.clipped = true
      return '<object>'
    }
    const out: Record<string, unknown> = {}
    let kept = 0
    for (const k of Object.keys(value)) {
      if (kept >= LIMITS.keys) {
        w.clipped = true
        break
      }
      kept += 1
      put(out, k, walk((value as Record<string, unknown>)[k], k, depth + 1, w))
    }
    return out
  }
  // undefined, functions, symbols, bigint: not JSON, so not from a transcript.
  return null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** A tool call's input as the chat gets it. `clipped`: something was cut. */
export function sanitiseArgs(toolName: string, input: unknown): { args: Plain; clipped: boolean } {
  if (!isRecord(input)) return { args: {}, clipped: false }
  const w: Walk = {
    clipped: false,
    budget: LIMITS.argsBudget,
    long: LONG_INPUT_TOOLS.has(toolName) ? LONG_INPUT_KEYS : null,
  }
  return { args: walk(input, null, 0, w) as Plain, clipped: w.clipped }
}

/** Keys of a result's structured twin that only repeat what the call's input
 *  or the result text already holds, so they are not carried. */
const DUPLICATE_KEYS: ReadonlySet<string> = new Set([
  'originalFile',
  'oldString',
  'newString',
  'content',
  'rawOutput',
])

/** What of a Read's `file` is kept: where it is, not what it holds. */
const FILE_KEYS = [
  'filePath',
  'numLines',
  'startLine',
  'totalLines',
  'type',
  'originalSize',
  'truncatedByTokenCap',
] as const

/** The one text of a result's data that runs long: a plan. */
const DATA_LONG_KEYS: ReadonlySet<string> = new Set(['plan'])

const PATCH_HUNKS = 20
const PATCH_LINES = 400
const PATCH_LINE_CHARS = 400

function patch(value: unknown, w: Walk): unknown {
  if (!Array.isArray(value)) return walk(value, 'structuredPatch', 1, w)
  if (value.length > PATCH_HUNKS) w.clipped = true
  return value.slice(0, PATCH_HUNKS).map((hunk) => {
    if (!isRecord(hunk)) return walk(hunk, null, 2, w)
    const out: Record<string, unknown> = {}
    for (const k of ['oldStart', 'oldLines', 'newStart', 'newLines'] as const) {
      if (typeof hunk[k] === 'number') put(out, k, hunk[k])
    }
    const lines = Array.isArray(hunk['lines']) ? (hunk['lines'] as unknown[]) : []
    if (lines.length > PATCH_LINES) w.clipped = true
    put(
      out,
      'lines',
      lines.slice(0, PATCH_LINES).map((line) => {
        const text = typeof line === 'string' ? line : ''
        if (text.length > PATCH_LINE_CHARS) w.clipped = true
        return clipString(text, PATCH_LINE_CHARS)
      }),
    )
    return out
  })
}

/**
 * A tool result's structured twin (`toolUseResult`), reduced to what the chat
 * can draw: a Bash result's stdout and stderr, an edit's patch, a Read's place
 * in its file, an agent's id and totals, a task, the answers to a question, a
 * plan, a search's first results. Nothing says which tool it was, so this
 * goes by the keys present. A string or a list (an error's text, an MCP
 * server's raw content) is the result text again and yields nothing.
 */
export function sanitiseResultData(twin: unknown): { data?: Plain; clipped: boolean } {
  if (!isRecord(twin)) return { clipped: false }
  const w: Walk = { clipped: false, budget: LIMITS.dataBudget, long: DATA_LONG_KEYS }
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(twin)) {
    if (Object.keys(out).length >= LIMITS.keys) {
      w.clipped = true
      break
    }
    const value = twin[k]
    if (DUPLICATE_KEYS.has(k)) {
      // Dropped, and said so when it was big: the chat shows a patch or the
      // call's input for these.
      if (typeof value === 'string' && value.length > LIMITS.string) w.clipped = true
      continue
    }
    if (k === 'file' && isRecord(value)) {
      const file: Record<string, unknown> = {}
      for (const fk of FILE_KEYS) {
        const fv = value[fk]
        if (typeof fv === 'string' || typeof fv === 'number' || typeof fv === 'boolean') {
          put(file, fk, walk(fv, fk, 2, w))
        }
      }
      if (value['base64'] !== undefined || value['content'] !== undefined) w.clipped = true
      put(out, k, file)
    } else if (k === 'structuredPatch') {
      put(out, k, patch(value, w))
    } else if (k === 'results' && Array.isArray(value)) {
      if (value.length > LIMITS.searchResults) w.clipped = true
      put(
        out,
        k,
        value.slice(0, LIMITS.searchResults).map((item) => walk(item, null, 2, w)),
      )
    } else {
      put(out, k, walk(value, k, 1, w))
    }
  }
  return { data: out as Plain, clipped: w.clipped }
}

/** A value as short JSON for an `unknown` entry: strings cut hard, then the
 *  whole cut at `LIMITS.raw`. */
export function rawJson(value: unknown): string {
  try {
    const w: Walk = { clipped: false, budget: LIMITS.raw, long: null }
    const text = JSON.stringify(walk(value, null, 0, w)) ?? 'undefined'
    return clipString(text, LIMITS.raw)
  } catch {
    return '<unreadable>'
  }
}

/** A tool call's one line about itself. */
export function toolSummary(input: unknown): string {
  if (!isRecord(input)) return ''
  for (const key of SUMMARY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim().split('\n')[0]!.slice(0, 160)
    }
  }
  return ''
}

/** A picture block, as the chat refers to it. Its bytes are not carried. */
export function imageRef(block: Record<string, unknown>): ImageRef {
  const source = isRecord(block['source']) ? block['source'] : {}
  const mediaType = source['media_type']
  const data = source['data']
  return {
    mediaType:
      typeof mediaType === 'string' && mediaType.length <= 100 ? mediaType : 'image/unknown',
    bytes: typeof data === 'string' ? decodedBytes(data.length) : 0,
  }
}
