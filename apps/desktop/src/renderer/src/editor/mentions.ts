/**
 * @-mention autocomplete. The pure core is a headless function over a
 * CompletionContext → CompletionResult; `mentionSource` wraps it as a
 * CompletionSource fed live data.
 *
 * A task mention is an ordinary path wiki-link to the task file: no opaque id
 * and no `related[]` edge. A person is `@login`, their GitHub username, as
 * text: on a task it names who it is for (`assignees` holds the assignment;
 * quick add reads its title's `@login`s into it).
 */
import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import { formatWikiLink, isHiddenPath, type TaskStatus } from '@holi/shared'
import { shortStamp } from '@/lib/date-presets'
import type { HoliCompletion } from './completion'

export interface MentionData {
  notes: { path: string; icon?: string }[]
  tasks: { path: string; title: string; status: TaskStatus; due?: string }[]
  /** The vault's members by GitHub login. */
  people?: string[]
}

/** Shared objects, as CodeMirror recommends: a section is matched by identity
 *  of name, and `rank` is what keeps People above Notes above Tasks rather
 *  than the alphabet. People are few, so they lead. */
const PEOPLE = { name: 'People', rank: 0 }
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
  // Done tasks are left out; an ordinary `[[link]]` still reaches them.
  const taskOptions: HoliCompletion[] = data.tasks
    .filter((t) => t.status !== 'done' && t.title.toLowerCase().includes(query))
    .map((t) => ({
      label: t.title,
      type: TASK_TYPE[t.status],
      section: TASKS,
      ...(t.due === undefined ? {} : { meta: `due ${shortStamp(t.due)}` }),
      apply: formatWikiLink(t.path),
    }))
  const personOptions: HoliCompletion[] = (data.people ?? [])
    .filter((login) => login.toLowerCase().includes(query))
    .map((login) => ({
      label: `@${login}`,
      type: 'holi-person',
      section: PEOPLE,
      apply: `@${login} `,
    }))
  return {
    from: match.from,
    options: [...personOptions, ...noteOptions, ...taskOptions],
    filter: false,
  }
}

/** The CodeMirror source: pulls live data on each `@`. */
export function mentionSource(getData: () => MentionData): CompletionSource {
  return (context) => mentionCompletions(context, getData())
}
