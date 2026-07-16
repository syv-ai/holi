/**
 * Slash-command autocomplete (notes-editor PRD FR-9). Pure, headless core over a
 * CompletionContext → CompletionResult; `slashSource` wraps it as a CodeMirror
 * source. `/task` (task creation) is deferred until the create-from-editor UX is
 * settled — this ships the pure text-insert commands.
 */
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'

/** A markdown checkbox line.
 *
 * Called `/subtask` until it wasn't: the name promised a parent task to be a subtask *of*,
 * and there is never one. This editor only ever opens notes — a task's description is a
 * plain textarea, not CodeMirror — so the command could not mean what it said anywhere it
 * could actually be typed. It inserts a checkbox; it is now called one. (Real task
 * creation is `/task`, still deferred below.)
 */
const TODO = '- [ ] '

/** A 2×2 markdown table skeleton — the codemirror-markdown-tables widget renders
 * any valid table, and inserting plain text keeps the edit on the yCollab path. */
const TABLE = ['| Column 1 | Column 2 |', '| --- | --- |', '|  |  |'].join('\n')

interface SlashCommand {
  label: string
  detail: string
  apply: string
}

const COMMANDS: SlashCommand[] = [
  { label: '/todo', detail: 'checkbox', apply: TODO },
  { label: '/table', detail: 'markdown table', apply: TABLE },
]

export function slashCommands(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\/[\w-]*/)
  if (!match) return null
  // Only a `/` that starts a line or follows whitespace is a command — otherwise
  // it's a path (`foo/bar`), a URL (`http://`) or a date, and must not trigger.
  const before = match.from > 0 ? context.state.sliceDoc(match.from - 1, match.from) : ''
  if (before && !/\s/.test(before)) return null
  // Filter ourselves and disable CM's filter — `from` sits at the `/`, so the
  // `/`-prefixed query would never match the labels.
  const query = match.text.slice(1).toLowerCase()
  const options = COMMANDS.filter((c) => c.label.slice(1).toLowerCase().startsWith(query)).map(
    (c) => ({ ...c }),
  )
  return { from: match.from, options, filter: false }
}
