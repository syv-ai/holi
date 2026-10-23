/**
 * The composer's `/` and `@` tokens: which one the caret is in, what fills
 * its menu, and the text once a row is picked. Pure, so it is tested alone.
 *
 * Ported from MonoCode's `features/skills/model/slashCommands.ts`,
 * `features/files/model/fileMentions.ts` and `shared/lib/fuzzy.ts`
 * (https://github.com/hardbeat920/monocode), MIT License, Copyright (c) 2026
 * Nick; see NOTICE.md. Holi's changes: commands are Claude Code's as the
 * vault offers them (`ChatCommand`), references are vault documents, and a
 * path with a space is quoted the way Claude Code reads it (`@"a b.md"`).
 */
import type { ChatCommand } from '../shared/chat'

/** A `/command` or `@reference` being typed: where it sits, and what has
 *  been typed after its sigil. */
export interface Token {
  start: number
  end: number
  query: string
}

const MAX_QUERY = 200
const MAX_ROWS = 50

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r'
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** The start of the word the caret is in. */
function wordStart(text: string, cursor: number): number {
  let start = clamp(cursor, 0, text.length)
  while (start > 0 && !isSpace(text[start - 1]!)) start -= 1
  return start
}

function wordEnd(text: string, from: number): number {
  let end = from
  while (end < text.length && !isSpace(text[end]!)) end += 1
  return end
}

/** A line starting `>` is a quote: a `/` or `@` in it is the quoted text's. */
function inQuote(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  return /^\s*>/.test(text.slice(lineStart, at + 1))
}

/** The `/command` the caret is in, if one is being typed. */
export function slashTokenAt(text: string, cursor: number): Token | null {
  const i = clamp(cursor, 0, text.length)
  const start = wordStart(text, i)
  if (text[start] !== '/') return null
  if (start > 0 && text[start - 1] === ':') return null
  if (inQuote(text, start)) return null
  const typed = text.slice(start + 1, i)
  // A path (`/usr/bin`) is not a command.
  if (typed.includes('/') || typed.includes('\\')) return null
  if (!/^[a-zA-Z0-9_.:-]*$/.test(typed)) return null
  return { start, end: wordEnd(text, start + 1), query: typed }
}

/** The `@reference` the caret is in, if one is being typed. */
export function mentionTokenAt(text: string, cursor: number): Token | null {
  const i = clamp(cursor, 0, text.length)
  const start = wordStart(text, i)
  if (text[start] !== '@') return null
  if (inQuote(text, start)) return null
  const typed = text.slice(start + 1, i)
  if (typed.includes('@') || typed.length > MAX_QUERY) return null
  return { start, end: wordEnd(text, start + 1), query: typed }
}

/** The text with `token` replaced by `sigil + value` and one space after;
 *  `caret` is where typing goes on. */
export function replaceToken(
  text: string,
  token: Token,
  sigil: '/' | '@',
  value: string,
): { text: string; caret: number } {
  const rest = text.slice(token.end)
  const spacer = rest.startsWith(' ') ? '' : ' '
  const head = `${text.slice(0, token.start)}${sigil}${value}`
  return { text: `${head}${spacer}${rest}`, caret: head.length + 1 }
}

/** A vault path as Claude Code reads it after `@`: quoted when it has a space. */
export function mentionValue(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path
}

// ------------------------------------------------------------------ fuzzy

export interface FuzzyHit {
  score: number
  positions: number[]
}

function isBreak(ch: string | undefined): boolean {
  return (
    ch === '/' || ch === '\\' || ch === '-' || ch === '_' || ch === '.' || ch === ' ' || ch === ':'
  )
}

function isUpper(ch: string | undefined): boolean {
  return ch !== undefined && ch >= 'A' && ch <= 'Z'
}

function matchToken(query: string, text: string): FuzzyHit | null {
  if (!query) return { score: 0, positions: [] }
  const needle = query.toLowerCase()
  const hay = text.toLowerCase()
  const positions: number[] = []
  let score = 0
  let consecutive = 0
  let qi = 0
  for (let i = 0; i < hay.length && qi < needle.length; i++) {
    if (hay[i] !== needle[qi]) {
      consecutive = 0
      continue
    }
    positions.push(i)
    consecutive += 1
    score += 1 + consecutive * 4
    if (i === 0 || isBreak(text[i - 1])) score += 14
    else if (isUpper(text[i]) && !isUpper(text[i - 1])) score += 10
    qi += 1
  }
  if (qi !== needle.length) return null
  score -= hay.length - needle.length
  return { score, positions }
}

/** Sequential fuzzy match: every query character in order, with bonuses for
 *  runs, word breaks and camelCase. Space-separated words all have to hit. */
export function fuzzyMatch(query: string, text: string): FuzzyHit | null {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { score: 0, positions: [] }
  if (words.length === 1) return matchToken(words[0]!, text)
  const positions: number[] = []
  let score = 0
  for (const word of words) {
    const hit = matchToken(word, text)
    if (hit === null) return null
    score += hit.score
    positions.push(...hit.positions)
  }
  positions.sort((a, b) => a - b)
  return { score, positions }
}

// ---------------------------------------------------------------- ranking

const SCOPE_RANK: Record<ChatCommand['scope'], number> = {
  vault: 0,
  user: 1,
  plugin: 2,
  builtin: 3,
}

/** The commands for `query`: by scope then name when empty, else names
 *  that match first, then descriptions. */
export function rankCommands(commands: readonly ChatCommand[], query: string): ChatCommand[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return [...commands]
      .sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || a.name.localeCompare(b.name))
      .slice(0, MAX_ROWS)
  }
  const scored: { command: ChatCommand; score: number }[] = []
  for (const command of commands) {
    const nameHit = fuzzyMatch(needle, command.name)
    const descHit = nameHit ? null : fuzzyMatch(needle, command.description ?? '')
    const hit = nameHit ?? descHit
    if (hit === null) continue
    scored.push({ command, score: nameHit ? hit.score + 400 : hit.score })
  }
  scored.sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name))
  return scored.slice(0, MAX_ROWS).map((row) => row.command)
}

/** A path the `@` menu offers, with what of it matched. */
export interface RankedPath {
  path: string
  name: string
  /** The folder it is in, or empty at the vault's root. */
  folder: string
  /** Matched positions in `name`. */
  positions: number[]
}

function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1
    ? { name: path, folder: '' }
    : { name: path.slice(slash + 1), folder: path.slice(0, slash) }
}

/**
 * The documents for `query`, a file's name over its folder (after MonoCode's
 * `scorePath`). `recent` is the order to show with nothing typed: the most
 * recently changed first.
 */
export function rankPaths(recent: readonly string[], query: string): RankedPath[] {
  const needle = query.trim()
  if (needle === '') {
    return recent.slice(0, MAX_ROWS).map((path) => ({ path, ...splitPath(path), positions: [] }))
  }
  const scored: { row: RankedPath; score: number }[] = []
  for (const path of recent) {
    const { name, folder } = splitPath(path)
    const nameHit = fuzzyMatch(needle, name)
    const hit = nameHit ?? fuzzyMatch(needle, path)
    if (hit === null) continue
    scored.push({
      row: { path, name, folder, positions: nameHit ? nameHit.positions : [] },
      score: nameHit ? hit.score + 400 : hit.score,
    })
  }
  scored.sort((a, b) => b.score - a.score || a.row.path.localeCompare(b.row.path))
  return scored.slice(0, MAX_ROWS).map((s) => s.row)
}
