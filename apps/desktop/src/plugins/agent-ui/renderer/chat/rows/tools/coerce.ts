/**
 * Reading a tool call defensively. A transcript is Claude Code's and the model's:
 * an input drifts in type (an offset arrives as a list, a flag as the string
 * "true", Write sends `path` for `file_path`), a structured result is optional,
 * and a tool's name can be anything. Every renderer reads through these, never
 * by a type it assumed from the tool's name, and none of them throws.
 *
 * Pure: no React, no Electron.
 */
import type { ToolItem } from '../../../../../agent/renderer/public'

export type Rec = Record<string, unknown>

export function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An own property only: a model-supplied key such as `constructor` or
 *  `__proto__` must not resolve to something on the prototype. */
export function get(rec: unknown, key: string): unknown {
  return isRec(rec) && Object.hasOwn(rec, key) ? rec[key] : undefined
}

export function nameOf(item: ToolItem): string {
  const name: unknown = item?.name
  return typeof name === 'string' ? name : String(name ?? '')
}

export function argsOf(item: ToolItem): Rec {
  const args: unknown = item?.args
  return isRec(args) ? args : {}
}

/** The structured twin of the result (`toolUseResult`), or an empty record. */
export function dataOf(item: ToolItem): Rec {
  const data: unknown = item?.result?.data
  return isRec(data) ? data : {}
}

export function textOf(item: ToolItem): string {
  const text: unknown = item?.result?.text
  return typeof text === 'string' ? text : ''
}

/** A string, or a number or boolean spelt out; anything else is not a value. */
export function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return undefined
}

/** The first of these keys that holds a non-blank string. */
export function firstStr(rec: unknown, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = get(rec, key)
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/** A count: a number, a numeric string, or the first of a list of them. */
export function num(value: unknown): number | undefined {
  if (Array.isArray(value)) return num(value[0])
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** A flag: `true`, or the string "true". Anything else is false. */
export function flag(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true')
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function recs(value: unknown): Rec[] {
  return arr(value).filter(isRec)
}

export function strings(value: unknown): string[] {
  return arr(value).filter((v): v is string => typeof v === 'string')
}

/** The last segments of a path, so a long one still says where it is. */
export function shortPath(path: string, segments = 3): string {
  const clean = path.replace(/\\/g, '/')
  const parts = clean.split('/').filter((p) => p !== '')
  if (parts.length <= segments) return clean
  return `…/${parts.slice(-segments).join('/')}`
}

export function baseName(path: string): string {
  const parts = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '')
  return parts[parts.length - 1] ?? path
}

/** `host/path` of a URL, or the text as given when it is not one. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}`
    return `${u.host}${rest}`
  } catch {
    return url
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Only web links are ever opened from a tool's output. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

export function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '')
  return line === undefined ? '' : line.trim()
}

export function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

export function countLabel(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '?'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

const WRAPPERS = [
  /<\/?tool_use_error>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>\s*$/g,
  /<\/?persisted-output>/g,
]

/** A result's text without the harness's wrappers (`<tool_use_error>`, a
 *  trailing `<system-reminder>`, `<persisted-output>`). */
export function unwrap(text: string): string {
  let out = text
  for (const wrapper of WRAPPERS) out = out.replace(wrapper, '')
  return out.trim()
}

/** Read's `N<TAB>line` prefixes, taken off. Returns the line numbers too when
 *  every line had one, so a gutter can show them. */
export function stripLineNumbers(text: string): { text: string; first: number | null } {
  const lines = text.split('\n')
  let first: number | null = null
  const out: string[] = []
  for (const line of lines) {
    const m = /^\s*(\d+)\t(.*)$/.exec(line)
    if (m === null) {
      // A trailing blank line, or a text that is not numbered at all.
      if (line === '' && out.length > 0) {
        out.push(line)
        continue
      }
      return { text, first: null }
    }
    first ??= Number(m[1])
    out.push(m[2] ?? '')
  }
  return { text: out.join('\n'), first }
}

/** An input as one line of text: a scalar, or a short note on a list or object. */
export function scalarLabel(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.length} ${value.length === 1 ? 'item' : 'items'}]`
  if (isRec(value)) return `{${Object.keys(value).length} keys}`
  return undefined
}

/** A string that is mostly base64 or otherwise not meant to be read. */
export function looksBinary(value: string): boolean {
  if (value.length < 200) return false
  const head = value.slice(0, 400)
  return /^[A-Za-z0-9+/=_-]+$/.test(head) || head.includes('\u0000')
}

/** Parse JSON text, for a result that is JSON. Never throws. */
export function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}
