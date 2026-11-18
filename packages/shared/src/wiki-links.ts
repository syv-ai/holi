/**
 * Canonical grammar for vault references in note markdown: one parser, thin
 * renderers (docs/features/wiki-links.md).
 *
 *  - `[[vault-relative/path.md]]` wiki-links, optionally `[[path|Label]]`
 *
 * There is one grammar: a link to a task is a link to its file like any other.
 * Framework-free by design: no React/CodeMirror imports. Consumed by the editor
 * renderer, the rename rewrite, and PDF export.
 */

/**
 * Inner body of a wiki-link: everything between `[[` and `]]` that isn't a
 * closing bracket or a newline. **Greedy** (`+`, not `+?`).
 */
const WIKI_LINK_BODY = '\\[\\[([^\\]\\n]+)\\]\\]'

/**
 * Fresh `RegExp` (with the `g` flag) per call: a shared module-level instance
 * would leak `lastIndex` state across `.exec()` loops at different call sites.
 */
export function wikiLinkRegex(): RegExp {
  return new RegExp(WIKI_LINK_BODY, 'g')
}

/** A single wiki-link match within some text. */
export interface WikiLinkMatch {
  /** The whole matched token, e.g. `[[notes/a.md|Label]]`. */
  raw: string
  /** The vault-relative path, trimmed. */
  target: string
  /** Display label after `|`, trimmed; undefined when absent. */
  label: string | undefined
  /** Start offset of the token within the source text. */
  start: number
  /** End offset (exclusive) of the token within the source text. */
  end: number
}

/** Parse every wiki-link in `text`, with positions (the editor places chip
 * widgets by index range). Empty/whitespace-only bodies are skipped. */
export function parseWikiLinks(text: string): WikiLinkMatch[] {
  const re = wikiLinkRegex()
  const out: WikiLinkMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const body = m[1]?.trim()
    if (!body) continue
    const pipe = body.indexOf('|')
    const target = (pipe >= 0 ? body.slice(0, pipe) : body).trim()
    const label = pipe >= 0 ? body.slice(pipe + 1).trim() || undefined : undefined
    if (!target) continue
    out.push({ raw: m[0], target, label, start: m.index, end: m.index + m[0].length })
  }
  return out
}

/** Build a wiki-link token; inverse of the parser for note links. */
export function formatWikiLink(target: string, label?: string): string {
  return label ? `[[${target}|${label}]]` : `[[${target}]]`
}

/** The prose a wiki-link should read as where there is no chip and no link (a
 *  rendered document, PDF export): the explicit label, else the target's file
 *  name without a trailing `.md`. */
export function wikiLinkDisplay(link: WikiLinkMatch): string {
  if (link.label) return link.label
  const base = link.target.split('/').at(-1) ?? link.target
  return base.replace(/\.md$/i, '')
}

/** What an editor chip reads as: the explicit label, else the target's whole
 *  path, which tells two `plan.md`s apart, less a trailing `.md`, which says
 *  nothing about a link to a note. */
export function wikiLinkChipText(link: WikiLinkMatch): string {
  return link.label ?? link.target.replace(/\.md$/i, '')
}

/**
 * Replace every wiki-link with its display text (`wikiLinkDisplay`), for
 * pipelines that render note markdown *outside* the editor (PDF export), where
 * `[[a/b.md|X]]` must read as prose. Returns the input unchanged when there are
 * no links.
 */
export function wikiLinksToText(text: string): string {
  const links = parseWikiLinks(text)
  if (links.length === 0) return text
  let out = ''
  let cursor = 0
  for (const link of links) {
    out += text.slice(cursor, link.start) + wikiLinkDisplay(link)
    cursor = link.end
  }
  return out + text.slice(cursor)
}

/**
 * Rewrite only the target span of links matching `fromPath`, preserving every
 * other character in the text and token. Matching uses the parser's trimmed
 * target; the replacement itself is exact and does not normalize the token.
 */
export function rewriteWikiLinksLosslessly(
  text: string,
  fromPath: string,
  toPath: string,
): { text: string; count: number } {
  const links = parseWikiLinks(text)
  const replacements = links
    .filter((link) => link.target === fromPath)
    .map((link) => {
      const body = link.raw.slice(2, -2)
      const pipe = body.indexOf('|')
      const rawTarget = pipe < 0 ? body : body.slice(0, pipe)
      const leadingWhitespace = rawTarget.length - rawTarget.trimStart().length
      const trailingWhitespace = rawTarget.length - rawTarget.trimEnd().length
      const start = link.start + 2 + leadingWhitespace
      const end = link.start + 2 + rawTarget.length - trailingWhitespace
      return { start, end }
    })

  if (replacements.length === 0) return { text, count: 0 }

  let result = ''
  let cursor = 0
  for (const replacement of replacements) {
    result += text.slice(cursor, replacement.start) + toPath
    cursor = replacement.end
  }
  return { text: result + text.slice(cursor), count: replacements.length }
}

/**
 * Rewrite matching links as normalized wiki-link tokens, preserving labels.
 * Matching uses the same trimming as the parser.
 */
export function rewriteWikiLinks(
  text: string,
  fromPath: string,
  toPath: string,
): { text: string; count: number } {
  const links = parseWikiLinks(text)
  let out = ''
  let cursor = 0
  let count = 0
  for (const link of links) {
    if (link.target !== fromPath) continue
    out += text.slice(cursor, link.start) + formatWikiLink(toPath, link.label)
    cursor = link.end
    count += 1
  }
  if (count === 0) return { text, count: 0 }
  return { text: out + text.slice(cursor), count }
}

/**
 * Rewrite every note link whose target is a key of `moves` to that key's value,
 * in ONE pass over the ORIGINAL map: the batch-move primitive.
 *
 * The single pass is the correctness. A link `[[a.md]]` must resolve to
 * `map.get('a.md')` and stop there, even when that value is itself a key
 * (`a→b`, `b→c`); applying N single-target `rewriteWikiLinks` in sequence would
 * chain it on to `c`. Labels are preserved; untargeted links are untouched.
 */
export function rewriteWikiLinksMulti(
  text: string,
  moves: Map<string, string>,
): { text: string; count: number } {
  const links = parseWikiLinks(text)
  let out = ''
  let cursor = 0
  let count = 0
  for (const link of links) {
    const to = moves.get(link.target)
    if (to === undefined) continue
    out += text.slice(cursor, link.start) + formatWikiLink(to, link.label)
    cursor = link.end
    count += 1
  }
  return count === 0 ? { text, count: 0 } : { text: out + text.slice(cursor), count }
}
