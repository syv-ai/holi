/**
 * Canonical grammar for vault references in note markdown (ports the shape of
 * the old `vaultRefs.ts` — one parser, thin renderers, D12/D22/D27):
 *
 *  - `[[vault-relative/path.md]]` wiki-links, optionally `[[path|Label]]`
 *  - `[[task:<id>]]` task chips (stable-ID machine refs, D27)
 *
 * Framework-free by design: no React/CodeMirror imports. Consumed by the
 * editor renderer, the server's link_index + rename rewrite, and the agent's
 * link authoring.
 */

/**
 * Inner body of a wiki-link: everything between `[[` and `]]` that isn't a
 * closing bracket or a newline. **Greedy** (`+`, not `+?`) — the authoritative
 * behaviour of the old editor's live-typed surface.
 */
const WIKI_LINK_BODY = '\\[\\[([^\\]\\n]+)\\]\\]'

/**
 * Fresh `RegExp` (with the `g` flag) per call — a shared module-level instance
 * would leak `lastIndex` state across `.exec()` loops at different call sites.
 */
export function wikiLinkRegex(): RegExp {
  return new RegExp(WIKI_LINK_BODY, 'g')
}

/** Prefix marking a task chip body: `[[task:<id>]]`. */
export const TASK_REF_PREFIX = 'task:'

/** A single wiki-link match within some text. */
export interface WikiLinkMatch {
  /** The whole matched token, e.g. `[[notes/a.md|Label]]`. */
  raw: string
  /** `note` for path links, `task` for `[[task:<id>]]` chips. */
  kind: 'note' | 'task'
  /** The vault-relative path (note) or the task id (task), trimmed. */
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
    let target = (pipe >= 0 ? body.slice(0, pipe) : body).trim()
    const label = pipe >= 0 ? body.slice(pipe + 1).trim() || undefined : undefined
    if (!target) continue
    let kind: WikiLinkMatch['kind'] = 'note'
    if (target.startsWith(TASK_REF_PREFIX)) {
      kind = 'task'
      target = target.slice(TASK_REF_PREFIX.length).trim()
      if (!target) continue
    }
    out.push({
      raw: m[0],
      kind,
      target,
      label,
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return out
}

/** Build a wiki-link token; inverse of the parser for note links. */
export function formatWikiLink(target: string, label?: string): string {
  return label ? `[[${target}|${label}]]` : `[[${target}]]`
}

/**
 * Rewrite every note link targeting `fromPath` to `toPath`, preserving labels
 * (the D12 rename primitive — the server applies this to each affected doc's
 * text). Task chips and other targets are untouched. Matching uses the same
 * trimming as the parser, and rewritten tokens come out normalized.
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
    if (link.kind !== 'note' || link.target !== fromPath) continue
    out += text.slice(cursor, link.start) + formatWikiLink(toPath, link.label)
    cursor = link.end
    count += 1
  }
  if (count === 0) return { text, count: 0 }
  return { text: out + text.slice(cursor), count }
}

/**
 * Rewrite every note link whose target is a key of `moves` to that key's value,
 * in ONE pass over the ORIGINAL map — the batch-move primitive (spec §Backend).
 *
 * The single pass is the correctness. A link `[[a.md]]` under a map that also
 * moves `b.md` must resolve to `map.get('a.md')` and stop there, even when that
 * value is itself a key (`a→b`, `b→c`): chaining it on to `c` is precisely the
 * double-rewrite that applying N single-target `rewriteWikiLinks` in sequence
 * produces. Labels are preserved; task chips and untargeted links are untouched.
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
    if (link.kind !== 'note') continue
    const to = moves.get(link.target)
    if (to === undefined) continue
    out += text.slice(cursor, link.start) + formatWikiLink(to, link.label)
    cursor = link.end
    count += 1
  }
  return count === 0 ? { text, count: 0 } : { text: out + text.slice(cursor), count }
}
