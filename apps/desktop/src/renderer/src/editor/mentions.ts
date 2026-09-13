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
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import { formatWikiLink, type TaskStatus } from '@holi/shared'
import { shortStamp } from '@/lib/date-presets'
import type { HoliCompletion } from './completion'

export interface MentionData {
  notes: { path: string; icon?: string }[]
  tasks: { path: string; title: string; status: TaskStatus; due?: string }[]
}

/** Shared objects, as CodeMirror recommends: a section is matched by identity
 *  of name, and `rank` is what keeps Notes above Tasks rather than the
 *  alphabet. */
const NOTES = { name: 'Notes', rank: 1 }
const TASKS = { name: 'Tasks', rank: 2 }

/** The explorer's `TaskIcon` vocabulary, by status. */
const TASK_TYPE: Record<TaskStatus, string> = {
  todo: 'holi-task-todo',
  doing: 'holi-task-doing',
  done: 'holi-task-done',
}

/**
 * Trigger: `@` and any following path/word chars, anchored at the `@`.
 *
 * **`\p{L}` and the `u` flag, not `\w`.** `\w` is ASCII-only in JavaScript, so
 * `@mø` stopped matching at the `ø`, this source returned null, and CodeMirror
 * closed the popup — reported in the running app, where a Danish note name
 * dismissed the list as you typed it. CodeMirror's `matchBefore` rebuilds the
 * expression through `ensureAnchor`, which carries the flags over, so `u`
 * survives.
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
  const noteOptions: HoliCompletion[] = data.notes
    .filter((n) => n.path.toLowerCase().includes(query))
    .map((n) => ({
      label: n.path,
      type: 'holi-note',
      section: NOTES,
      ...(n.icon === undefined ? {} : { emoji: n.icon }),
      apply: formatWikiLink(n.path),
    }))
  const taskOptions: HoliCompletion[] = data.tasks
    .filter((t) => t.title.toLowerCase().includes(query))
    .map((t) => ({
      label: t.title,
      // No `detail: t.status` any more: the glyph on the left says the status,
      // and a row should not say one thing twice.
      type: TASK_TYPE[t.status],
      section: TASKS,
      ...(t.due === undefined ? {} : { meta: `due ${shortStamp(t.due)}` }),
      apply: formatWikiLink(t.path),
    }))
  return { from: match.from, options: [...noteOptions, ...taskOptions], filter: false }
}

/** The CodeMirror source: pulls live data on each `@`. A picked task inserts a
 * plain path link like any note — no side-effect to fire. */
export function mentionSource(getData: () => MentionData): CompletionSource {
  return (context) => mentionCompletions(context, getData())
}
