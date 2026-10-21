/**
 * Slash-command autocomplete (docs/features/editor.md). Pure, headless cores over
 * a CompletionContext → CompletionResult; `slashCommands` is the command list and
 * `tableSizes` is the second level `/table` opens. There is no `/task`.
 *
 * A plugin adds commands of its own (`SlashCommand`, through
 * `RendererPlugin.slashCommands`): the vault apps' commands are these. The
 * editor runs one and applies what it answers; what a command is, and where
 * it runs, is the plugin's.
 */
import { pickedCompletion, startCompletion } from '@codemirror/autocomplete'
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import {
  EditorSelection,
  StateEffect,
  StateField,
  type ChangeSpec,
  type Extension,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { hasAskAgent, openAskAgent } from './askAgent'
import type { HoliCompletion } from './completion'

/** A markdown checkbox line. Not a subtask: a checkbox has no parent task. */
const TODO = '- [ ] '

/** A table's shape, as columns by BODY rows. Every GFM table has a header row. */
export interface TableSize {
  cols: number
  rows: number
}

/** `2 × 1` first, so `/table` Enter Enter gives the smallest skeleton. */
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
    // Not a string: picking this types the argument and re-opens the popup on
    // `tableSizes`, so the panel stays and its contents change. A flyout was
    // rejected (docs/features/editor.md).
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

/** Built-in commands' names, which a plugin's command of the same name does
 *  not replace. */
const BUILT_IN = new Set(COMMANDS.map((c) => c.label.slice(1)))

export function slashCommands(
  context: CompletionContext,
  added: readonly HoliCompletion[] = [],
): CompletionResult | null {
  // `\p{L}` with the `u` flag rather than `\w`, which is ASCII-only: `/æ` would
  // return null and dismiss the menu.
  const match = context.matchBefore(/\/[\p{L}\p{N}_-]*/u)
  if (!match) return null
  // Only a `/` that starts a line or follows whitespace is a command — otherwise
  // it's a path (`foo/bar`), a URL (`http://`) or a date, and must not trigger.
  const before = match.from > 0 ? context.state.sliceDoc(match.from - 1, match.from) : ''
  if (before && !/\s/.test(before)) return null
  // Filter ourselves and disable CM's filter — `from` sits at the `/`, so the
  // `/`-prefixed query would never match the labels.
  const query = match.text.slice(1).toLowerCase()
  const options = [...COMMANDS, ...added]
    .filter((c) => c.label.slice(1).toLowerCase().startsWith(query))
    .map((c) => ({ ...c }))
  return { from: match.from, options, filter: false }
}

/** What a plugin's slash command is given when it is picked. */
export interface SlashInput {
  /** The text the command was typed over: what was selected when `/` was
   *  typed, else empty. */
  text: string
  /** The caret's line as it was before the command was typed. */
  line: string
  /** The note's vault path. */
  path: string
}

/**
 * What a command does to the note. `replace`: its text takes the place of
 * what the command was typed over. `insert`: that stays, and the text follows
 * it. `agent`: the ask-the-agent popover opens with this instruction, over the
 * text. Null leaves the note as it was.
 */
export type SlashResult = { replace: string } | { insert: string } | { agent: string } | null

/** A command a plugin adds to the slash menu. */
export interface SlashCommand {
  /** What follows the `/`. A built-in's name stays the built-in's. */
  name: string
  /** Beside the name, in the menu. */
  detail?: string
  /** At the row's end: where the command comes from. */
  meta?: string
  /** Whether the menu offers it in the note at `path`; absent, everywhere.
   *  The command's plugin decides: an app's command is given the note's text
   *  and may write into it, so the apps plugin offers one only where an app
   *  may read and write. */
  offeredIn?(path: string): boolean
  /** Rejects when it failed; the plugin says where (an app's log). */
  run(input: SlashInput): Promise<SlashResult>
}

/**
 * The selection a `/` was typed over, and where that `/` is. Typing replaces a
 * selection, so this is how a command still gets it: CodeMirror marks a typed
 * replacement `input.type`. Kept while the caret stays in the command, mapped
 * through edits; gone once the `/` is.
 */
const typedOver = StateField.define<{ from: number; text: string } | null>({
  create: () => null,
  update(value, tr) {
    if (tr.docChanged && tr.isUserEvent('input.type')) {
      let found: { from: number; text: string } | null = null
      tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
        if (toA > fromA && inserted.toString().startsWith('/')) {
          found = { from: fromB, text: tr.startState.sliceDoc(fromA, toA) }
        }
      })
      if (found !== null) return found
    }
    if (value === null) return null
    const from = tr.changes.mapPos(value.from, 1)
    const head = tr.state.selection.main.head
    const sameLine = tr.state.doc.lineAt(from).number === tr.state.doc.lineAt(head).number
    if (tr.state.sliceDoc(from, from + 1) !== '/' || head <= from || !sameLine) return null
    return from === value.from ? value : { from, text: value.text }
  },
})

/** Where a picked command's text is while it runs, by run, mapped through
 *  whatever is typed meanwhile, so its answer lands on the text it was given. */
const running = StateField.define<ReadonlyMap<number, { from: number; to: number }>>({
  create: () => new Map(),
  update(value, tr) {
    // Mapped first: an effect's range is already in the new document.
    let next = value
    if (tr.docChanged) {
      const mapped = new Map<number, { from: number; to: number }>()
      for (const [id, { from, to }] of value) {
        const a = tr.changes.mapPos(from, 1)
        mapped.set(id, { from: a, to: Math.max(a, tr.changes.mapPos(to, -1)) })
      }
      next = mapped
    }
    for (const effect of tr.effects) {
      if (!effect.is(trackRun)) continue
      const copy = new Map(next)
      if (effect.value.range === null) copy.delete(effect.value.id)
      else copy.set(effect.value.id, effect.value.range)
      next = copy
    }
    return next
  },
})

const trackRun = StateEffect.define<{ id: number; range: { from: number; to: number } | null }>()

let runIds = 0

/**
 * Pick `command`: put back what it was typed over, selected, then run it and
 * apply its answer there. An error leaves the note as it was put back.
 */
async function runCommand(
  view: EditorView,
  command: SlashCommand,
  path: string,
  completion: Completion,
  from: number,
  to: number,
): Promise<void> {
  const over = view.state.field(typedOver, false)
  const text = over !== null && over !== undefined && over.from === from ? over.text : ''
  const id = ++runIds
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.range(from, from + text.length),
    annotations: pickedCompletion.of(completion),
    effects: trackRun.of({ id, range: { from, to: from + text.length } }),
    userEvent: 'input.complete',
  })
  const input = { text, line: view.state.doc.lineAt(from).text, path }
  let result: SlashResult = null
  try {
    result = await command.run(input)
  } catch {
    // The plugin has said where; the note stays as it was put back.
  }
  const range = view.state.field(running, false)?.get(id)
  // Gone when the editor's state was replaced while the command ran. A
  // closed editor still has its state, and a dispatch to it shows nothing.
  if (range === undefined) return
  const done = trackRun.of({ id, range: null })
  if (result === null || view.state.readOnly) {
    view.dispatch({ effects: done })
    return
  }
  if ('agent' in result) {
    if (!view.state.facet(hasAskAgent)) {
      console.warn(`/${command.name}: no agent is running in this vault`)
      view.dispatch({ effects: done })
      return
    }
    view.dispatch({
      selection: EditorSelection.range(range.from, range.to),
      effects: [done, openAskAgent.of(result.agent)],
    })
    return
  }
  // A replace takes the place of the text the command was given, and only
  // that: what was typed into it while the command ran is the person's, so
  // the answer then goes after it instead.
  const replace = 'replace' in result && view.state.sliceDoc(range.from, range.to) === text
  const inserted = 'replace' in result ? result.replace : result.insert
  const change: ChangeSpec = replace
    ? { from: range.from, to: range.to, insert: inserted }
    : { from: range.to, insert: inserted }
  const end = (replace ? range.from : range.to) + inserted.length
  view.dispatch({
    changes: change,
    selection: EditorSelection.cursor(end),
    effects: done,
    userEvent: 'input.complete',
    scrollIntoView: true,
  })
}

/**
 * The slash menu with `commands()` added, read each time it opens so a
 * command appears or goes without the editor being rebuilt.
 */
export function slashCommandsWith(
  commands: () => readonly SlashCommand[],
  path: string,
): { source: CompletionSource; extension: Extension } {
  const source: CompletionSource = (context) => {
    const added = commands()
      .filter((c) => !BUILT_IN.has(c.name) && (c.offeredIn?.(path) ?? true))
      .map((command): HoliCompletion => ({
        label: `/${command.name}`,
        ...(command.detail === undefined ? {} : { detail: command.detail }),
        ...(command.meta === undefined ? {} : { meta: command.meta }),
        type: 'holi-command',
        apply: (view, completion, from, to) =>
          void runCommand(view, command, path, completion, from, to),
      }))
    return slashCommands(context, added)
  }
  return { source, extension: [typedOver, running] }
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
