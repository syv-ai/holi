/**
 * @-mention autocomplete. The pure core is a headless function over a
 * CompletionContext → CompletionResult; `mentionSource` wraps it as a
 * CompletionSource fed live data.
 *
 * Every mention is an ordinary path wiki-link: a claimed file (a task) is
 * offered in its claim's group, with no opaque id and no `related[]` edge.
 */
import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import type { IconNode } from 'lucide'
import { formatWikiLink, isHiddenPath } from '@holi/shared'
import type { HoliCompletion } from './completion'

/** One thing the `@` menu offers, which inserts a link to `path`. */
export interface MentionItem {
  path: string
  label: string
  /** Drawn at the row's start, in `color` (a CSS value) when given. */
  glyph?: IconNode
  color?: string
  /** Trailing text, such as a due date. */
  meta?: string
}

/** A section of the `@` menu after the vault's notes, which a claim adds
 *  (`PathClaim.editor`). */
export interface MentionGroup {
  name: string
  items: readonly MentionItem[]
}

export interface MentionData {
  notes: { path: string; icon?: string }[]
  groups: readonly MentionGroup[]
}

/** Shared objects, as CodeMirror recommends: a section is matched by identity
 *  of name, and `rank` is what keeps Notes above the groups rather than the
 *  alphabet. */
const NOTES = { name: 'Notes', rank: 1 }

/**
 * Trigger: `@` and any following path/word chars, anchored at the `@`.
 *
 * `\p{L}` and the `u` flag, not `\w`, which is ASCII-only: `@mø` would stop
 * matching at the `ø` and close the popup. `matchBefore` rebuilds the
 * expression through `ensureAnchor`, which keeps the flags.
 */
const MENTION_RE = /@[\p{L}\p{N}_.\-/]*/u

export function mentionCompletions(
  context: CompletionContext,
  data: MentionData,
): CompletionResult | null {
  const match = context.matchBefore(MENTION_RE)
  if (!match) return null
  // Don't hijack email addresses: a word char immediately before the @ (foo@bar)
  // means this is not a mention trigger.
  const before = match.from > 0 ? context.state.sliceDoc(match.from - 1, match.from) : ''
  if (/\w/.test(before)) return null
  // The query is what follows the `@`. We filter ourselves and set filter:false —
  // `from` sits at the `@`, so CM's own fuzzy filter would match the `@`-prefixed
  // text against the labels and drop everything.
  const query = match.text.slice(1).toLowerCase()
  // `isHiddenPath` is the file tree's rule, so dot-paths like `.claude/` stay out.
  const noteOptions: HoliCompletion[] = data.notes
    .filter((n) => !isHiddenPath(n.path) && n.path.toLowerCase().includes(query))
    .map((n) => ({
      label: n.path,
      type: 'holi-note',
      section: NOTES,
      ...(n.icon === undefined ? {} : { emoji: n.icon }),
      apply: formatWikiLink(n.path),
    }))
  // What a group leaves out (done tasks) an ordinary `[[link]]` still reaches.
  const groupOptions: HoliCompletion[] = data.groups.flatMap((group, i) => {
    const section = { name: group.name, rank: 2 + i }
    return group.items
      .filter((item) => item.label.toLowerCase().includes(query))
      .map((item) => ({
        label: item.label,
        type: 'holi-claimed',
        section,
        ...(item.glyph === undefined ? {} : { glyph: item.glyph }),
        ...(item.color === undefined ? {} : { color: item.color }),
        ...(item.meta === undefined ? {} : { meta: item.meta }),
        apply: formatWikiLink(item.path),
      }))
  })
  return { from: match.from, options: [...noteOptions, ...groupOptions], filter: false }
}

/** The CodeMirror source: pulls live data on each `@`. */
export function mentionSource(getData: () => MentionData): CompletionSource {
  return (context) => mentionCompletions(context, getData())
}
