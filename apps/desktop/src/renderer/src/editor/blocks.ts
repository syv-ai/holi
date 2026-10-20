/**
 * Blocks as the page editor's gutter and block menu see them (after ReUI's
 * `rich-text-block-actions`, docs/features/editor.md), over markdown source.
 *
 * A block is a run of whole lines: the innermost list item at a position, with
 * its children, or else the top-level node there (a paragraph, a heading, a
 * fence, a quote, a table). Nothing here holds a node: every action reads the
 * syntax tree, rewrites the block's source lines, and returns a
 * `TransactionSpec`, so the file stays the markdown it was and every action is
 * one undo step. Pure over `EditorState`, so each is testable headless.
 */
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import {
  ChangeSet,
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type TransactionSpec,
} from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { frontmatterRegion } from './frontmatter-region'

/** What a block is, named as the slash menu names it. */
export type BlockKind =
  | 'text'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'
  | 'bullet-list'
  | 'numbered-list'
  | 'task-list'
  | 'quote'
  | 'code-block'
  | 'divider'
  | 'table'
  | 'contents'
  | 'html'

/** The kinds Turn into offers, in its order. */
export const TURN_INTO_KINDS = [
  'text',
  'heading-1',
  'heading-2',
  'heading-3',
  'bullet-list',
  'numbered-list',
  'task-list',
  'quote',
  'code-block',
] as const satisfies readonly BlockKind[]

export type TurnIntoKind = (typeof TURN_INTO_KINDS)[number]

export interface Block {
  /** Start of the block's first line. */
  from: number
  /** End of its last line, before the newline. */
  to: number
  kind: BlockKind
  /** A list item: it moves among its list's items and keeps its indentation. */
  listItem: boolean
  /** The leading whitespace of the first line, in columns. */
  indent: number
  /** The block's own lines: `from`/`to` but for an aligned block, whose range
   *  takes in its `<div align>` wrapper while this is the text inside it. */
  content: { from: number; to: number }
  /** An aligned block's alignment, read off its wrapper. */
  align?: Align
}

export const ALIGNS = ['left', 'center', 'right', 'justify'] as const
export type Align = (typeof ALIGNS)[number]

/** An alignment wrapper's tag lines (`marks.ts` writes them). */
export const ALIGN_OPEN = /^<div align="(left|center|right|justify)">\s*$/
export const ALIGN_CLOSE = /^<\/div>\s*$/

export interface AlignWrapper {
  align: Align
  /** The opening tag's line and the closing tag's line (1-based). */
  open: number
  close: number
}

/** The `<div align>` around the lines `from`..`to`: its tag one blank line
 *  above them and the closing tag one blank line below. */
export function wrapperAround(state: EditorState, from: number, to: number): AlignWrapper | null {
  const doc = state.doc
  const first = doc.lineAt(from).number
  const last = doc.lineAt(to).number
  if (first < 3 || last + 2 > doc.lines) return null
  const open = ALIGN_OPEN.exec(doc.line(first - 2).text)
  if (open === null || doc.line(first - 1).text.trim() !== '') return null
  if (doc.line(last + 1).text.trim() !== '' || !ALIGN_CLOSE.test(doc.line(last + 2).text))
    return null
  return { align: open[1] as Align, open: first - 2, close: last + 2 }
}

/** A `[toc]` line on its own: the Contents block (`contents.ts`). */
export const CONTENTS_LINE = /^\[toc\]$/i

const LIST_NODES = new Set(['BulletList', 'OrderedList', 'AlphaList'])

/** How long to wait on the parser before settling for what it has. */
const PARSE_BUDGET_MS = 50

function treeOf(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state)
}

/** Where the body starts: nothing before it is a block. */
function bodyFrom(state: EditorState): number {
  return frontmatterRegion(state.doc.toString())?.to ?? 0
}

/** The node's last character, so a node ending on a line break ends on the line before. */
function lastLineEnd(state: EditorState, node: { from: number; to: number }): number {
  const end =
    node.to > node.from && state.sliceDoc(node.to - 1, node.to) === '\n' ? node.to - 1 : node.to
  return state.doc.lineAt(end).to
}

function indentOf(text: string): number {
  let cols = 0
  for (const ch of text) {
    if (ch === ' ') cols++
    else if (ch === '\t') cols += 4
    else break
  }
  return cols
}

function kindOfNode(state: EditorState, node: SyntaxNode): BlockKind {
  const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name)
  if (heading !== null) return `heading-${heading[1]}` as BlockKind
  switch (node.name) {
    case 'ListItem': {
      const mark = node.firstChild
      const task = mark?.nextSibling
      if (task?.name === 'Task') return 'task-list'
      return node.parent?.name === 'BulletList' ? 'bullet-list' : 'numbered-list'
    }
    case 'Blockquote':
      return 'quote'
    case 'FencedCode':
    case 'CodeBlock':
      return 'code-block'
    case 'HorizontalRule':
      return 'divider'
    case 'Table':
      return 'table'
    case 'HTMLBlock':
    case 'CommentBlock':
    case 'ProcessingInstructionBlock':
      return 'html'
    case 'Paragraph':
      return CONTENTS_LINE.test(state.sliceDoc(node.from, node.to).trim()) ? 'contents' : 'text'
    default:
      return 'text'
  }
}

function toBlock(state: EditorState, node: SyntaxNode): Block {
  const first = state.doc.lineAt(node.from)
  return {
    from: first.from,
    to: lastLineEnd(state, node),
    kind: kindOfNode(state, node),
    listItem: node.name === 'ListItem',
    indent: indentOf(first.text),
    content: { from: first.from, to: lastLineEnd(state, node) },
  }
}

/** The tree node a block is read from at `pos`: the innermost list item outside
 *  a table, else the top-level node. */
function blockNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  if (pos < bodyFrom(state)) return null
  const line = state.doc.lineAt(pos)
  const lead = /^\s*/.exec(line.text)![0].length
  const at = line.from + lead
  let node: SyntaxNode | null = treeOf(state).resolveInner(at, 1)
  let item: SyntaxNode | null = null
  let top: SyntaxNode | null = null
  for (let n: SyntaxNode | null = node; n !== null; n = n.parent) {
    if (n.name === 'Table') item = null
    if (n.name === 'ListItem' && item === null) item = n
    if (n.parent !== null && n.parent.parent === null) top = n
    node = n
  }
  // A blank line between blocks resolves to the document itself.
  if (top === null) return null
  if (top.name === 'Table') return top
  return item ?? top
}

/**
 * The aligned block a line belongs to, its wrapper and the text inside taken
 * as one block: the gutter moves, copies and deletes them together, and a
 * `<div align>` line is never a block of its own. Null when the line is not
 * part of a wrapper.
 */
function wrappedAtLine(state: EditorState, n: number): Block | null {
  const doc = state.doc
  const text = doc.line(n).text
  let inner = n
  if (ALIGN_OPEN.test(text)) inner = n + 2
  else if (ALIGN_CLOSE.test(text)) inner = n - 2
  else if (text.trim() === '') {
    if (n > 1 && ALIGN_OPEN.test(doc.line(n - 1).text)) inner = n + 1
    else if (n < doc.lines && ALIGN_CLOSE.test(doc.line(n + 1).text)) inner = n - 1
    else return null
  }
  if (inner < 1 || inner > doc.lines) return null
  let node = blockNodeAt(state, doc.line(inner).from)
  // Only a top-level block is wrapped; an item inside a wrapped list is its own.
  if (node === null || (node.name === 'ListItem' && inner === n)) return null
  while (node.parent !== null && node.parent.parent !== null) node = node.parent
  const content = toBlock(state, node)
  const wrapper = wrapperAround(state, content.from, content.to)
  if (wrapper === null) return null
  const open = doc.line(wrapper.open)
  const close = doc.line(wrapper.close)
  if (n < wrapper.open || n > wrapper.close) return null
  return {
    ...content,
    from: open.from,
    to: close.to,
    content: { from: content.from, to: content.to },
    align: wrapper.align,
  }
}

/** The block that owns `pos`, or null on a blank line or in the frontmatter. */
export function blockAt(state: EditorState, pos: number): Block | null {
  if (pos < bodyFrom(state)) return null
  const wrapped = wrappedAtLine(state, state.doc.lineAt(pos).number)
  if (wrapped !== null) return wrapped
  const node = blockNodeAt(state, pos)
  return node === null ? null : toBlock(state, node)
}

/** The block on a line (1-based), or null. */
export function blockAtLine(state: EditorState, line: number): Block | null {
  if (line < 1 || line > state.doc.lines) return null
  return blockAt(state, state.doc.line(line).from)
}

/** The blocks that share a block's parent: a list's items, or the page's
 *  top-level blocks. */
export function siblingsOf(state: EditorState, block: Block): Block[] {
  const node = blockNodeAt(state, block.from)
  if (node === null) return []
  const parent = node.parent
  if (parent === null) return []
  const body = bodyFrom(state)
  const out: Block[] = []
  for (let c = parent.firstChild; c !== null; c = c.nextSibling) {
    if (c.from < body) continue
    if (block.listItem ? c.name !== 'ListItem' : false) continue
    // A list's mark children are not blocks.
    if (!block.listItem && /Mark$/.test(c.name)) continue
    // A wrapper's tags and text are one block, met at its opening tag.
    const prev = out[out.length - 1]
    if (prev !== undefined && c.from <= prev.to) continue
    const wrapped = block.listItem ? null : wrappedAtLine(state, state.doc.lineAt(c.from).number)
    out.push(wrapped ?? toBlock(state, c))
  }
  return out
}

function indexIn(siblings: Block[], block: Block): number {
  return siblings.findIndex((b) => b.from === block.from)
}

export function canMoveBlock(state: EditorState, block: Block, dir: -1 | 1): boolean {
  const siblings = siblingsOf(state, block)
  const i = indexIn(siblings, block)
  return i !== -1 && i + dir >= 0 && i + dir < siblings.length
}

/** Moves a block, list items and top-level blocks alike, by `move.line`, which
 *  the ordered-list renumbering filter (`lists.ts`) treats as a reshape. */
const MOVE_EVENT = 'move.line'

/** Where the selection lands when the text it sat in moved by `shift`. */
function carry(state: EditorState, block: Block, shift: number, fallback: number) {
  const sel = state.selection.main
  if (sel.from >= block.from && sel.to <= block.to) {
    return EditorSelection.single(sel.anchor + shift, sel.head + shift)
  }
  return EditorSelection.cursor(fallback)
}

/** Swaps a block with its previous or next sibling, the gap between them kept. */
export function moveBlock(state: EditorState, block: Block, dir: -1 | 1): TransactionSpec | null {
  const siblings = siblingsOf(state, block)
  const i = indexIn(siblings, block)
  const other = siblings[i + dir]
  if (i === -1 || other === undefined) return null
  const [a, b] = dir < 0 ? [other, block] : [block, other]
  const textA = state.sliceDoc(a.from, a.to)
  const textB = state.sliceDoc(b.from, b.to)
  const gap = state.sliceDoc(a.to, b.from)
  const insert = textB + gap + textA
  // The moved block's new start.
  const newFrom = dir < 0 ? a.from : a.from + textB.length + gap.length
  return {
    changes: { from: a.from, to: b.to, insert },
    selection: carry(state, block, newFrom - block.from, newFrom),
    scrollIntoView: true,
    userEvent: MOVE_EVENT,
  }
}

/** The separator a block keeps from its neighbours: a line break between list
 *  items, a blank line between top-level blocks. */
const sepFor = (block: Block): string => (block.listItem ? '\n' : '\n\n')

/** A copy right after the block; the caret moves into the copy. */
export function duplicateBlock(state: EditorState, block: Block): TransactionSpec {
  const text = state.sliceDoc(block.from, block.to)
  const sep = sepFor(block)
  const copyFrom = block.to + sep.length
  return {
    changes: { from: block.to, insert: sep + text },
    selection: carry(state, block, copyFrom - block.from, copyFrom),
    scrollIntoView: true,
    userEvent: MOVE_EVENT,
  }
}

/**
 * What removing a block takes: its lines and one line break, and a second one
 * where that would leave two blank lines in a row, so the blocks either side
 * keep exactly the gap they had.
 */
export function removalRange(state: EditorState, block: Block): { from: number; to: number } {
  const doc = state.doc
  let from = block.from
  let to = block.to
  if (to < doc.length) {
    to += 1 // the line break after it
    // Nothing above (the body's first block) counts as a gap above.
    const prevBlank = from <= bodyFrom(state) || doc.lineAt(from - 1).text.trim() === ''
    const nextLine = to <= doc.length ? doc.lineAt(to) : null
    if (prevBlank && nextLine !== null && nextLine.text.trim() === '' && nextLine.to < doc.length) {
      to = nextLine.to + 1
    }
  } else if (from > 0) {
    // The last block: the break before it goes, and a blank line above with it.
    from -= 1
    const prev = doc.lineAt(from)
    if (prev.text.trim() === '' && prev.from > bodyFrom(state)) from = Math.max(0, prev.from - 1)
  }
  return { from, to }
}

/** Removes a block; the caret lands at the end of the line above it. */
export function deleteBlock(state: EditorState, block: Block): TransactionSpec {
  const range = removalRange(state, block)
  const changes = ChangeSet.of({ from: range.from, to: range.to }, state.doc.length)
  const at = Math.min(changes.mapPos(range.from, -1), changes.newLength)
  return {
    changes,
    selection: EditorSelection.cursor(at),
    scrollIntoView: true,
    userEvent: 'delete.block',
  }
}

/** The marker a new sibling item starts with: the same bullet, the next
 *  number (the renumbering filter settles it), an open box for a task. */
function siblingMarker(firstLine: string): string {
  const m = /^(\s*)([-*+]|\d+[.)]|[A-Za-z][.)])(\s+)(\[[ xX]?\]\s+)?/.exec(firstLine)
  if (m === null) return ''
  const [, lead, marker, space, task] = m
  const box = task === undefined ? '' : '[ ] '
  return `${lead}${marker}${space}${box}`
}

/**
 * An empty row above or below the block, with the caret in it: a paragraph
 * between top-level blocks, an item where only items fit. An empty item is
 * reused rather than doubled.
 */
export function insertBlockRow(
  state: EditorState,
  block: Block,
  side: 'before' | 'after',
): TransactionSpec {
  const first = state.doc.lineAt(block.from)
  if (block.listItem) {
    const marker = siblingMarker(first.text)
    // `- ` on its own: already an empty row.
    if (marker !== '' && first.text.trimEnd() === marker.trimEnd() && block.to === first.to) {
      return { selection: EditorSelection.cursor(first.to) }
    }
    if (side === 'before') {
      return {
        changes: { from: block.from, insert: `${marker}\n` },
        selection: EditorSelection.cursor(block.from + marker.length),
        scrollIntoView: true,
        userEvent: MOVE_EVENT,
      }
    }
    return {
      changes: { from: block.to, insert: `\n${marker}` },
      selection: EditorSelection.cursor(block.to + 1 + marker.length),
      scrollIntoView: true,
      userEvent: MOVE_EVENT,
    }
  }
  if (side === 'before') {
    return {
      changes: { from: block.from, insert: '\n\n' },
      selection: EditorSelection.cursor(block.from),
      scrollIntoView: true,
      userEvent: 'input',
    }
  }
  return {
    changes: { from: block.to, insert: '\n\n' },
    selection: EditorSelection.cursor(block.to + 2),
    scrollIntoView: true,
    userEvent: 'input',
  }
}

/** Shifts every line of `text` from one indentation to another. */
function reindent(text: string, from: number, to: number): string {
  if (from === to) return text
  return text
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line
      const has = indentOf(line)
      const want = Math.max(0, has - from + to)
      return ' '.repeat(want) + line.replace(/^[ \t]*/, '')
    })
    .join('\n')
}

/** Gives a moved item the marker kind of the list it joins: a `-` dropped into
 *  `1.` items becomes a number (renumbered after), and back. */
function adoptMarker(text: string, targetFirstLine: string): string {
  const target = /^\s*([-*+]|\d+[.)]|[A-Za-z][.)])\s/.exec(targetFirstLine)?.[1]
  if (target === undefined) return text
  const toBullet = /^[-*+]$/.test(target)
  return text.replace(
    /^(\s*)([-*+]|\d+[.)]|[A-Za-z][.)])(?=\s)/,
    (all, lead: string, mine: string) =>
      // Two numbered lists keep their numbers: the renumbering settles them.
      !toBullet && !/^[-*+]$/.test(mine) ? all : `${lead}${target}`,
  )
}

/** The top-level block holding a list item: the list it is in, outermost. */
function topLevelOf(state: EditorState, block: Block): Block | null {
  let node = blockNodeAt(state, block.from)
  while (node !== null && node.parent !== null && node.parent.parent !== null) node = node.parent
  return node === null ? null : toBlock(state, node)
}

/**
 * Moves `source` beside `target`, by its lines: a list item with its children,
 * a fence whole. An item dropped beside another joins that list at the target's
 * depth and takes its marker kind; dropped beside a top-level block it becomes
 * its own list there. Any other block dropped onto a list item lands beside
 * that item's whole list, since a paragraph cannot sit between two items.
 * Null when the drop would leave it where it is.
 */
export function moveBlockTo(
  state: EditorState,
  source: Block,
  target: Block,
  side: 'before' | 'after',
): TransactionSpec | null {
  let dest = target
  if (!source.listItem && dest.listItem) {
    const top = topLevelOf(state, dest)
    if (top === null) return null
    dest = top
  }
  // Inside itself, or back where it is.
  if (dest.from >= source.from && dest.to <= source.to) return null
  if (side === 'before' && dest.from > source.to) {
    const between = state.sliceDoc(source.to, dest.from)
    if (between.trim() === '') return null
  }
  if (side === 'after' && dest.to < source.from) {
    const between = state.sliceDoc(dest.to, source.from)
    if (between.trim() === '') return null
  }

  let text = state.sliceDoc(source.from, source.to)
  let sep = '\n\n'
  if (source.listItem && dest.listItem) {
    text = adoptMarker(reindent(text, source.indent, dest.indent), state.doc.lineAt(dest.from).text)
    sep = '\n'
  } else if (source.listItem) {
    text = reindent(text, source.indent, 0)
  }
  const at = side === 'before' ? dest.from : dest.to
  const insert = side === 'before' ? text + sep : sep + text
  const removal = removalRange(state, source)
  const changes = ChangeSet.of(
    [{ from: at, insert } as ChangeSpec, { from: removal.from, to: removal.to }],
    state.doc.length,
  )
  const start = changes.mapPos(at, side === 'before' ? -1 : 1) - insert.length
  const textStart = side === 'before' ? start : start + sep.length
  return {
    changes,
    selection: EditorSelection.cursor(textStart + text.split('\n')[0]!.length),
    scrollIntoView: true,
    userEvent: MOVE_EVENT,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn into: rewriting a block's markdown prefix
// ─────────────────────────────────────────────────────────────────────────────

/** A line's block prefix: indentation, then any run of quote marks, a list
 *  marker, a task box and a heading's hashes. */
const PREFIX =
  /^([ \t]*)((?:>[ \t]?)*)((?:[-*+]|\d+[.)]|[A-Za-z][.)])[ \t]+)?(\[[ xX]?\][ \t]+)?(#{1,6}(?:[ \t]+|$))?/

function prefixLength(text: string): number {
  return PREFIX.exec(text)?.[0].length ?? 0
}

const FENCE = /^\s*(`{3,}|~{3,})/

/** The prefix a kind writes before a line's text. */
function prefixFor(kind: TurnIntoKind, indent: string): string {
  switch (kind) {
    case 'text':
      return ''
    case 'heading-1':
      return '# '
    case 'heading-2':
      return '## '
    case 'heading-3':
      return '### '
    case 'bullet-list':
      return `${indent}- `
    case 'numbered-list':
      return `${indent}1. `
    case 'task-list':
      return `${indent}- [ ] `
    case 'quote':
      return '> '
    case 'code-block':
      return ''
  }
}

/**
 * Rewrites the block's lines as `kind`, keeping their text: the old prefix
 * (`#`, `-`, `1.`, `- [ ]`, `>`) goes and the new one comes in, a fence is
 * added or taken away, and a heading joins its lines into one, since a markdown
 * heading is one line. A list item keeps its indentation as a list item and
 * leaves it as anything else. Only the item's own text turns; its children stay.
 * Edits only the prefixes, so the caret keeps its place in the text.
 */
export function turnInto(
  state: EditorState,
  block: Block,
  kind: TurnIntoKind,
): TransactionSpec | null {
  const doc = state.doc
  // An aligned block turns inside its wrapper.
  const { from, to } = block.content
  const firstNo = doc.lineAt(from).number
  let lastNo = doc.lineAt(to).number
  const changes: ChangeSpec[] = []

  // A list item's own text: its first line and its continuation lines, not
  // its sublists.
  if (block.listItem) {
    for (let n = firstNo + 1; n <= lastNo; n++) {
      const t = doc.line(n).text
      if (t.trim() === '' || /^\s*(?:[-*+]|\d+[.)]|[A-Za-z][.)])\s/.test(t)) {
        lastNo = n - 1
        break
      }
    }
  }

  // Lines of text, without fences or a setext underline.
  let textFirst = firstNo
  let textLast = lastNo
  if (block.kind === 'code-block' && FENCE.test(doc.line(firstNo).text)) {
    changes.push({
      from: doc.line(firstNo).from,
      to: Math.min(doc.line(firstNo).to + 1, doc.length),
    })
    textFirst++
    if (lastNo > firstNo && FENCE.test(doc.line(lastNo).text)) {
      changes.push({ from: doc.line(lastNo - 1).to, to: doc.line(lastNo).to })
      textLast--
    }
  }
  if (
    /^heading-/.test(block.kind) &&
    lastNo > firstNo &&
    /^\s*(=+|-+)\s*$/.test(doc.line(lastNo).text)
  ) {
    changes.push({ from: doc.line(lastNo - 1).to, to: doc.line(lastNo).to })
    textLast--
  }
  if (textLast < textFirst) {
    // An empty fence: nothing to keep, so it becomes one empty line of `kind`.
    return {
      changes: { from, to, insert: prefixFor(kind, '') },
      selection: EditorSelection.cursor(from + prefixFor(kind, '').length),
      userEvent: MOVE_EVENT,
    }
  }

  const keepIndent = kind === 'bullet-list' || kind === 'numbered-list' || kind === 'task-list'
  const indent = keepIndent && block.listItem ? ' '.repeat(block.indent) : ''
  const fromCode = block.kind === 'code-block'
  for (let n = textFirst; n <= textLast; n++) {
    const line = doc.line(n)
    // Code is literal: none of its text is a prefix.
    const old = fromCode ? 0 : prefixLength(line.text)
    let insert: string
    if (n === textFirst) insert = prefixFor(kind, indent)
    else if (kind === 'quote') insert = '> '
    else insert = ''
    if (/^heading-/.test(kind) && n > textFirst) {
      // One line: the break before this line becomes a space.
      changes.push({ from: doc.line(n - 1).to, to: line.from + old, insert: ' ' })
      continue
    }
    if (old > 0 || insert !== '') changes.push({ from: line.from, to: line.from + old, insert })
  }
  if (kind === 'code-block') {
    changes.push({ from: doc.line(textFirst).from, insert: '```\n' })
    changes.push({ from: doc.line(textLast).to, insert: '\n```' })
  }
  return { changes, userEvent: MOVE_EVENT }
}

/** The kinds `turnInto` can make of a block; empty for tables, rules and the like. */
export function turnIntoOptions(block: Block): readonly TurnIntoKind[] {
  return (TURN_INTO_KINDS as readonly string[]).includes(block.kind) || /^heading-/.test(block.kind)
    ? TURN_INTO_KINDS
    : []
}
