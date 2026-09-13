/**
 * Slash-command autocomplete (notes-editor PRD FR-9). Pure, headless cores over a
 * CompletionContext → CompletionResult; `slashCommands` is the command list and
 * `tableSizes` is the second level `/table` opens. `/task` (task creation) is
 * deferred until the create-from-editor UX is settled.
 */
import { pickedCompletion, startCompletion } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { HoliCompletion } from './completion'

/** A markdown checkbox line.
 *
 * Called `/subtask` until it wasn't: the name promised a parent task to be a subtask *of*,
 * and there is never one. This editor only ever opens notes — a task's description is a
 * plain textarea, not CodeMirror — so the command could not mean what it said anywhere it
 * could actually be typed. It inserts a checkbox; it is now called one. (Real task
 * creation is `/task`, still deferred.)
 */
const TODO = '- [ ] '

/**
 * A table's shape, as columns by BODY rows. The header row is implied, because
 * every GFM table has one — which is why "3×2 with a header" is not an option
 * here: there is no table without one.
 */
export interface TableSize {
  cols: number
  rows: number
}

/** `2 × 1` first, deliberately: it is exactly the skeleton `/table` used to
 *  insert outright, so `/table` Enter Enter is the behaviour people had. */
export const TABLE_SIZES: TableSize[] = [
  { cols: 2, rows: 1 },
  { cols: 2, rows: 3 },
  { cols: 3, rows: 3 },
]

/** Plain text, not a widget: the codemirror-markdown-tables widget renders any
 *  valid table, and inserting text keeps the edit on the ordinary edit path. */
export function buildTable({ cols, rows }: TableSize): string {
  const header = `| ${Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(' | ')} |`
  const delimiter = `|${' --- |'.repeat(cols)}`
  const body = Array.from({ length: rows }, () => `|${'  |'.repeat(cols)}`)
  return [header, delimiter, ...body].join('\n')
}

/** The trail line above the sizes. CodeMirror renders a section header as a
 *  `<completion-section>` inside the list, which its own base theme already
 *  gives `display: list-item`. */
const TABLE_SECTION = { name: 'table' }

const COMMAND_PREFIX = '/table '

const COMMANDS: HoliCompletion[] = [
  { label: '/todo', detail: 'checkbox', type: 'holi-list-todo', apply: TODO },
  {
    label: '/table',
    detail: 'pick a size…',
    type: 'holi-table',
    // **Not a string.** Picking this types the argument and re-opens the popup
    // on `tableSizes`, which is what the second level is: the panel stays and
    // its contents change. A flyout was rejected — see the design of record,
    // `docs/specs/2026-09-13-completion-popover-design.md`.
    apply: (view: EditorView, completion: Completion, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: COMMAND_PREFIX },
        selection: { anchor: from + COMMAND_PREFIX.length },
        // `apply` owns this annotation when it fires its own transaction.
        annotations: pickedCompletion.of(completion),
      })
      startCompletion(view)
    },
  },
]

export function slashCommands(context: CompletionContext): CompletionResult | null {
  // `\p{L}` with the `u` flag rather than `\w`, which is ASCII-only: `/æ` used
  // to return null and dismiss the menu instead of simply matching nothing.
  const match = context.matchBefore(/\/[\p{L}\p{N}_-]*/u)
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

/** `/table ` and whatever has been typed after it. The space is the trigger:
 *  without it `slashCommands` still owns the text, which is what makes
 *  backspacing out of the argument return you to the command list with no
 *  back-navigation code at all. */
const TABLE_ARGS = /\/table\s+[\p{L}\p{N}× x]*/u

export function tableSizes(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(TABLE_ARGS)
  if (match === null) return null
  const before = match.from > 0 ? context.state.sliceDoc(match.from - 1, match.from) : ''
  if (before !== '' && !/\s/.test(before)) return null
  const typed = match.text.replace(/^\/table\s+/, '').toLowerCase()
  const options: HoliCompletion[] = TABLE_SIZES.filter((size) =>
    `${size.cols}x${size.rows}`.startsWith(typed.replace(/[×\s]/g, 'x')),
  ).map((size) => ({
    label: `${size.cols} × ${size.rows}`,
    detail: size.rows === 1 ? '1 row' : `${size.rows} rows`,
    type: 'holi-table',
    section: TABLE_SECTION,
    apply: buildTable(size),
  }))
  // `from` at the `/`, so picking a size replaces the whole command rather than
  // leaving `/table ` in the document in front of the table.
  return { from: match.from, options, filter: false }
}
