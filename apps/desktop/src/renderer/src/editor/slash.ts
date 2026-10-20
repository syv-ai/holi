/**
 * The slash menu (docs/features/editor.md), after ReUI's
 * `rich-text-slash-menu`: its items, groups, hints and matching, on Holi's
 * completion popup. Pure, headless cores over a CompletionContext →
 * CompletionResult; `slashCommands` is the block list and `tableSizes` is the
 * second level Table opens. Every item rewrites markdown: a block made from the
 * menu is the same text you could have typed (the shortcut on each row).
 */
import { pickedCompletion, startCompletion } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { insertNewlineAndIndent } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import {
  ChangeSet,
  EditorSelection,
  type EditorState,
  type TransactionSpec,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { blockAt, turnInto, type TurnIntoKind } from './blocks'
import type { HoliCompletion } from './completion'
import { frontmatterRegion } from './frontmatter-region'

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

/** What a slash item makes of the caret's block. */
export type SlashKind = TurnIntoKind | 'divider' | 'contents'

/** A slash menu row: its group, its one-line hint, the words it answers to,
 *  and the markdown that makes the same block by hand. */
export interface SlashItem {
  id: SlashKind | 'table'
  group: 'Basic blocks' | 'Advanced'
  title: string
  hint: string
  keywords: readonly string[]
  markdown?: string
}

/** ReUI's items, in its order and groups. `/todo` and `/table` still type
 *  straight to theirs: `todo` is a keyword, `table` the title. */
export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'text',
    group: 'Basic blocks',
    title: 'Text',
    hint: 'Plain paragraph',
    keywords: ['paragraph', 'plain'],
  },
  {
    id: 'heading-1',
    group: 'Basic blocks',
    title: 'Heading 1',
    hint: 'Large section heading',
    keywords: ['h1', 'title', 'heading'],
    markdown: '#',
  },
  {
    id: 'heading-2',
    group: 'Basic blocks',
    title: 'Heading 2',
    hint: 'Medium section heading',
    keywords: ['h2', 'subtitle', 'heading'],
    markdown: '##',
  },
  {
    id: 'heading-3',
    group: 'Basic blocks',
    title: 'Heading 3',
    hint: 'Small section heading',
    keywords: ['h3', 'heading'],
    markdown: '###',
  },
  {
    id: 'bullet-list',
    group: 'Basic blocks',
    title: 'Bullet list',
    hint: 'Unordered points',
    keywords: ['unordered', 'list', 'ul'],
    markdown: '-',
  },
  {
    id: 'numbered-list',
    group: 'Basic blocks',
    title: 'Numbered list',
    hint: 'Ordered steps',
    keywords: ['ordered', 'list', 'ol', 'steps'],
    markdown: '1.',
  },
  {
    id: 'task-list',
    group: 'Basic blocks',
    title: 'To-do list',
    hint: 'Track tasks with checkboxes',
    keywords: ['todo', 'task', 'checkbox', 'check'],
    markdown: '[ ]',
  },
  {
    id: 'quote',
    group: 'Basic blocks',
    title: 'Quote',
    hint: 'Set a passage apart',
    keywords: ['blockquote', 'citation'],
    markdown: '>',
  },
  {
    id: 'code-block',
    group: 'Basic blocks',
    title: 'Code block',
    hint: 'Monospaced snippet or command',
    keywords: ['code', 'snippet', 'pre'],
    markdown: '```',
  },
  {
    id: 'divider',
    group: 'Basic blocks',
    title: 'Divider',
    hint: 'A line between sections',
    keywords: ['separator', 'rule', 'hr', 'line'],
    markdown: '---',
  },
  {
    id: 'table',
    group: 'Advanced',
    title: 'Table',
    hint: 'Rows and columns with a header',
    keywords: ['grid', 'rows', 'columns', 'spreadsheet'],
  },
  {
    id: 'contents',
    group: 'Advanced',
    title: 'Contents',
    hint: 'Jump links to every heading',
    keywords: ['outline', 'toc', 'headings', 'summary'],
    markdown: '[toc]',
  },
]

/** Title contains the query, or a keyword starts with it (ReUI's rule). */
export function matchesSlash(item: SlashItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return item.title.toLowerCase().includes(q) || item.keywords.some((k) => k.startsWith(q))
}

const SECTIONS = {
  'Basic blocks': { name: 'Basic blocks', rank: 0 },
  Advanced: { name: 'Advanced', rank: 1 },
} as const

/** The row drawn when nothing matches. The menu holds Enter while it is open,
 *  so Enter on this row is a plain Enter. */
const EMPTY: HoliCompletion = {
  label: 'No matching blocks',
  type: 'holi-empty',
  apply: (view: EditorView) => void insertNewlineAndIndent(view),
}

/** The prefix an empty line takes for each kind. */
const EMPTY_LINE_PREFIX: Record<TurnIntoKind, string> = {
  text: '',
  'heading-1': '# ',
  'heading-2': '## ',
  'heading-3': '### ',
  'bullet-list': '- ',
  'numbered-list': '1. ',
  'task-list': '- [ ] ',
  quote: '> ',
  'code-block': '',
}

/**
 * The edit a slash item makes: the typed `/query` goes, and the caret's block
 * turns into `kind` as Turn into would turn it; on an empty line the block is
 * made fresh. A divider or a contents line is a block of its own, put on its
 * own line with the blank lines markdown needs around it (`text\n---` would be
 * a heading), with the caret on the line after. One transaction, so one undo
 * gives back what was typed.
 */
export function applySlash(
  state: EditorState,
  from: number,
  to: number,
  kind: SlashKind,
): TransactionSpec {
  const removal = ChangeSet.of({ from, to }, state.doc.length)
  const mid = state.update({ changes: removal }).state
  const caret = removal.mapPos(from)
  const line = mid.doc.lineAt(caret)
  const blank = line.text.trim() === ''
  let second: TransactionSpec
  if (kind === 'divider' || kind === 'contents') {
    const mark = kind === 'divider' ? '---' : '[toc]'
    if (blank) {
      const prevBlank = line.number === 1 || mid.doc.line(line.number - 1).text.trim() === ''
      const hasNext = line.number < mid.doc.lines
      const nextBlank = !hasNext || mid.doc.line(line.number + 1).text.trim() === ''
      const insert = `${prevBlank ? '' : '\n'}${mark}\n${nextBlank ? '' : '\n'}`
      second = {
        changes: { from: line.from, to: line.to, insert },
        selection: EditorSelection.cursor(line.from + insert.length - (nextBlank ? 0 : 1)),
      }
    } else {
      const end = blockAt(mid, caret)?.to ?? line.to
      const insert = `\n\n${mark}\n\n`
      second = {
        changes: { from: end, insert },
        selection: EditorSelection.cursor(end + insert.length),
      }
    }
  } else {
    const block = blank ? null : blockAt(mid, caret)
    if (block === null) {
      const lead = /^\s*/.exec(line.text)![0]
      const insert =
        kind === 'code-block'
          ? `${lead}\`\`\`\n${lead}\n${lead}\`\`\``
          : lead + EMPTY_LINE_PREFIX[kind]
      const at = kind === 'code-block' ? line.from + lead.length * 2 + 4 : line.from + insert.length
      second = {
        changes: { from: line.from, to: line.to, insert },
        selection: EditorSelection.cursor(at),
      }
    } else {
      second = turnInto(mid, block, kind) ?? {}
    }
  }
  const tr = mid.update(second)
  return {
    changes: removal.compose(tr.changes),
    selection: tr.newSelection,
    scrollIntoView: true,
    userEvent: 'input.complete',
  }
}

function completionFor(item: SlashItem, index: number): HoliCompletion {
  const base = {
    label: item.title,
    detail: item.hint,
    type: `holi-block-${item.id}`,
    section: SECTIONS[item.group],
    // Keeps ReUI's order inside each group.
    boost: 99 - index,
    ...(item.markdown === undefined ? {} : { meta: item.markdown }),
  }
  if (item.id === 'table') {
    return {
      ...base,
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
    }
  }
  const kind = item.id
  return {
    ...base,
    apply: (view: EditorView, completion: Completion, from: number, to: number) => {
      view.dispatch({
        ...applySlash(view.state, from, to, kind),
        annotations: pickedCompletion.of(completion),
      })
    },
  }
}

/** Where a `/` may open the menu: not in code, and not in the frontmatter. */
function slashAllowed(state: EditorState, pos: number): boolean {
  if (pos < (frontmatterRegion(state.doc.toString())?.to ?? 0)) return false
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode') return false
  }
  return true
}

export function slashCommands(context: CompletionContext): CompletionResult | null {
  // `\p{L}` with the `u` flag rather than `\w`, which is ASCII-only: `/æ` would
  // return null and dismiss the menu.
  const match = context.matchBefore(/\/[\p{L}\p{N}_-]*/u)
  if (!match) return null
  // Only a `/` that starts a line or follows whitespace is a command — otherwise
  // it's a path (`foo/bar`), a URL (`http://`) or a date, and must not trigger.
  const before = match.from > 0 ? context.state.sliceDoc(match.from - 1, match.from) : ''
  if (before && !/\s/.test(before)) return null
  if (!slashAllowed(context.state, match.from)) return null
  // Filter ourselves and disable CM's filter — `from` sits at the `/`, so the
  // `/`-prefixed query would never match the labels.
  const query = match.text.slice(1)
  const options = SLASH_ITEMS.flatMap((item, i) =>
    matchesSlash(item, query) ? [completionFor(item, i)] : [],
  )
  return { from: match.from, options: options.length === 0 ? [EMPTY] : options, filter: false }
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
