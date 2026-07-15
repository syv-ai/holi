/**
 * @-mention autocomplete (notes-editor PRD FR-8). The pure core is a headless
 * function over a CompletionContext → CompletionResult, so it is unit-testable
 * without a view; `mentionSource` wraps it as a CodeMirror CompletionSource fed
 * live data (the docExistsFacet pattern — closures over the renderer's atoms).
 */
import {
  insertCompletionText,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { formatWikiLink, TASK_REF_PREFIX } from '@holi/shared'

export interface MentionData {
  notes: { path: string }[]
  tasks: { id: string; title: string; status: string }[]
}

/** A completion carrying the task id it inserts, so the source can fire the
 * `related[]` side-effect (D27: the note is linked by stable doc id, not path). */
type MentionCompletion = Completion & { taskId?: string }

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
  const noteOptions: MentionCompletion[] = data.notes
    .filter((n) => n.path.toLowerCase().includes(query))
    .map((n) => ({ label: n.path, type: 'text', apply: formatWikiLink(n.path) }))
  const taskOptions: MentionCompletion[] = data.tasks
    .filter((t) => t.title.toLowerCase().includes(query))
    .map((t) => ({
      label: t.title,
      detail: t.status,
      type: 'keyword',
      apply: formatWikiLink(`${TASK_REF_PREFIX}${t.id}`),
      taskId: t.id,
    }))
  return { from: match.from, options: [...noteOptions, ...taskOptions], filter: false }
}

/**
 * The CodeMirror source: pulls live data on each `@` and, when a task is picked,
 * fires `onTaskMention` so the current note is added to that task's `related[]`.
 * Thin view-touching glue over the tested pure core — verified live, not in unit
 * tests.
 */
export function mentionSource(
  getData: () => MentionData,
  onTaskMention?: (taskId: string) => void,
): CompletionSource {
  return (context) => {
    const result = mentionCompletions(context, getData())
    if (!result || !onTaskMention) return result
    const options = result.options.map((o) => {
      const taskId = (o as MentionCompletion).taskId
      if (!taskId) return o
      const text = o.apply as string
      return {
        ...o,
        apply: (view: EditorView, _c: Completion, from: number, to: number) => {
          view.dispatch(insertCompletionText(view.state, text, from, to))
          onTaskMention(taskId)
        },
      }
    })
    return { ...result, options }
  }
}
