/**
 * @-mention autocomplete (notes-editor PRD FR-8). The pure core is a headless
 * function over a CompletionContext → CompletionResult, so it is unit-testable
 * without a view; `mentionSource` wraps it as a CodeMirror CompletionSource fed
 * live data (closures over the renderer's atoms).
 *
 * A task mention is an ordinary path wiki-link to the task file — there is no
 * opaque id and no `related[]` edge to maintain (D27/D60).
 */
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import { formatWikiLink, type TaskStatus } from '@holi/shared'

export interface MentionData {
  notes: { path: string }[]
  tasks: { path: string; title: string; status: TaskStatus }[]
}

/** Trigger: `@` and any following path/word chars, anchored at the `@`. */
const MENTION_RE = /@[\w.\-/]*/

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
  const noteOptions: Completion[] = data.notes
    .filter((n) => n.path.toLowerCase().includes(query))
    .map((n) => ({ label: n.path, type: 'text', apply: formatWikiLink(n.path) }))
  const taskOptions: Completion[] = data.tasks
    .filter((t) => t.title.toLowerCase().includes(query))
    .map((t) => ({
      label: t.title,
      detail: t.status,
      type: 'keyword',
      apply: formatWikiLink(t.path),
    }))
  return { from: match.from, options: [...noteOptions, ...taskOptions], filter: false }
}

/** The CodeMirror source: pulls live data on each `@`. A picked task inserts a
 * plain path link like any note — no side-effect to fire. */
export function mentionSource(getData: () => MentionData): CompletionSource {
  return (context) => mentionCompletions(context, getData())
}
