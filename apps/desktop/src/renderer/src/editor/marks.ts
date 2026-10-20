/**
 * The format bubble's marks that markdown has no syntax for, each in the
 * markdown-native form that GitHub and other renderers already read
 * (docs/features/editor.md). The colours and the bubble follow ReUI's
 * `rich-text-highlight` and `rich-text-format-bubble`.
 *
 * - **Highlight** is `==text==` (yellow, the common `mark` extension) or
 *   `<mark data-color="green">text</mark>` for the other colours. The first
 *   needs a parser extension, since CommonMark has no `==`; the second is
 *   inline HTML, which GFM keeps.
 * - **Underline** is `<u>text</u>`, inline HTML again.
 * - **Alignment** wraps a block in `<div align="center">` with a blank line
 *   inside each end, so what is inside stays markdown: without the blank line
 *   CommonMark reads the whole run as raw HTML and its links and emphasis die.
 *
 * Pure over `EditorState`, like `formatting.ts`.
 */
import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  StateField,
  type EditorState,
  type Range,
  type TransactionSpec,
} from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { MarkdownConfig } from '@lezer/markdown'
import {
  ALIGN_CLOSE,
  ALIGN_OPEN,
  wrapperAround,
  type Align,
  type AlignWrapper,
  type Block,
} from './blocks'

// ─────────────────────────────────────────────────────────────────────────────
// Highlight colours
// ─────────────────────────────────────────────────────────────────────────────

/** ReUI's five, in its order. Yellow is the default and the one `==` writes. */
export const HIGHLIGHT_COLORS = [
  { id: 'yellow', label: 'Yellow' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'pink', label: 'Pink' },
  { id: 'violet', label: 'Violet' },
] as const

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]['id']

const isColor = (value: string): value is HighlightColor =>
  HIGHLIGHT_COLORS.some((c) => c.id === value)

// ─────────────────────────────────────────────────────────────────────────────
// `==text==`
// ─────────────────────────────────────────────────────────────────────────────

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' }

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1‐-‧]/

/** `==text==` as a `Highlight` node with two `HighlightMark`s: the
 *  Strikethrough rule from `@lezer/markdown`, on `=`. */
export const highlightSyntax: MarkdownConfig = {
  defineNodes: ['Highlight', 'HighlightMark'],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1
        if (pos > cx.offset && cx.char(pos - 1) === 61) return -1
        const before = cx.slice(pos - 1, pos)
        const after = cx.slice(pos + 2, pos + 3)
        const sBefore = /\s|^$/.test(before)
        const sAfter = /\s|^$/.test(after)
        const pBefore = PUNCTUATION.test(before)
        const pAfter = PUNCTUATION.test(after)
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        )
      },
      after: 'Emphasis',
    },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline HTML pairs: `<u>…</u>`, `<mark …>…</mark>`
// ─────────────────────────────────────────────────────────────────────────────

/** A run of text between an opening and a closing inline tag, or `==`. */
export interface MarkSpan {
  kind: 'underline' | 'highlight'
  /** The opening mark's start and the closing mark's end. */
  from: number
  to: number
  /** The text between the marks. */
  innerFrom: number
  innerTo: number
  /** A highlight's colour. */
  color?: HighlightColor
}

const OPEN_TAG = /^<(u|mark)(?:\s+data-color="([a-z]+)")?\s*>$/i
const CLOSE_TAG = /^<\/(u|mark)\s*>$/i

/** Every `<u>`/`<mark>` pair and `==` highlight in `[from, to)`, paired within
 *  their paragraph. */
export function markSpans(state: EditorState, from = 0, to = state.doc.length): MarkSpan[] {
  const out: MarkSpan[] = []
  const open: {
    tag: string
    node: { from: number; to: number }
    color?: string
    parent: number
  }[] = []
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'Highlight') {
        out.push({
          kind: 'highlight',
          from: node.from,
          to: node.to,
          innerFrom: node.from + 2,
          innerTo: node.to - 2,
          color: 'yellow',
        })
        return
      }
      if (node.name !== 'HTMLTag') return
      const text = state.sliceDoc(node.from, node.to)
      const parent = node.node.parent?.from ?? -1
      const o = OPEN_TAG.exec(text)
      if (o !== null) {
        open.push({
          tag: o[1]!.toLowerCase(),
          node: { from: node.from, to: node.to },
          color: o[2],
          parent,
        })
        return
      }
      const c = CLOSE_TAG.exec(text)
      if (c === null) return
      const tag = c[1]!.toLowerCase()
      for (let i = open.length - 1; i >= 0; i--) {
        const start = open[i]!
        if (start.tag !== tag || start.parent !== parent) continue
        open.splice(i)
        const color = start.color !== undefined && isColor(start.color) ? start.color : 'yellow'
        out.push({
          kind: tag === 'u' ? 'underline' : 'highlight',
          from: start.node.from,
          to: node.to,
          innerFrom: start.node.to,
          innerTo: node.from,
          ...(tag === 'mark' ? { color } : {}),
        })
        break
      }
    },
  })
  return out.sort((a, b) => a.from - b.from)
}

/** The innermost span of `kind` holding the whole selection, if any. */
function spanAround(state: EditorState, kind: MarkSpan['kind']): MarkSpan | null {
  const { from, to } = state.selection.main
  const line = state.doc.lineAt(from)
  const found = markSpans(state, line.from, Math.max(line.to, to)).filter(
    (s) => s.kind === kind && s.innerFrom <= from && s.innerTo >= to,
  )
  return found.length === 0 ? null : found[found.length - 1]!
}

/** The selection, or the word at a bare caret. */
function target(state: EditorState): { from: number; to: number } | null {
  const sel = state.selection.main
  if (!sel.empty) return { from: sel.from, to: sel.to }
  return state.wordAt(sel.from)
}

function unwrap(span: MarkSpan, keepSelection: { from: number; to: number }): TransactionSpec {
  const openLen = span.innerFrom - span.from
  return {
    changes: [
      { from: span.from, to: span.innerFrom },
      { from: span.innerTo, to: span.to },
    ],
    selection: EditorSelection.single(keepSelection.from - openLen, keepSelection.to - openLen),
  }
}

/** ⌘U: `<u>` around the selection, or off when it is already inside one. */
export function toggleUnderline(state: EditorState): TransactionSpec | null {
  const around = spanAround(state, 'underline')
  const t = target(state)
  if (around !== null) return unwrap(around, t ?? { from: around.innerFrom, to: around.innerTo })
  if (t === null) return null
  return {
    changes: [
      { from: t.from, insert: '<u>' },
      { from: t.to, insert: '</u>' },
    ],
    selection: EditorSelection.single(t.from + 3, t.to + 3),
  }
}

/** The colour of the highlight holding the selection, or null. */
export function highlightAt(state: EditorState): HighlightColor | null {
  return spanAround(state, 'highlight')?.color ?? null
}

function wrapHighlight(color: HighlightColor): [open: string, close: string] {
  return color === 'yellow' ? ['==', '=='] : [`<mark data-color="${color}">`, '</mark>']
}

/**
 * Highlights the selection in `color`, recolours the highlight it is in, or
 * with `null` takes the highlight away. The text stays selected.
 */
export function setHighlight(
  state: EditorState,
  color: HighlightColor | null,
): TransactionSpec | null {
  const around = spanAround(state, 'highlight')
  if (around !== null) {
    const inner = state.sliceDoc(around.innerFrom, around.innerTo)
    if (color === null) {
      return {
        changes: { from: around.from, to: around.to, insert: inner },
        selection: EditorSelection.single(around.from, around.from + inner.length),
      }
    }
    const [open, close] = wrapHighlight(color)
    return {
      changes: { from: around.from, to: around.to, insert: open + inner + close },
      selection: EditorSelection.single(
        around.from + open.length,
        around.from + open.length + inner.length,
      ),
    }
  }
  if (color === null) return null
  const t = target(state)
  if (t === null) return null
  const [open, close] = wrapHighlight(color)
  return {
    changes: [
      { from: t.from, insert: open },
      { from: t.to, insert: close },
    ],
    selection: EditorSelection.single(t.from + open.length, t.to + open.length),
  }
}

/** Whether the selection sits inside an underline. */
export function underlineAt(state: EditorState): boolean {
  return spanAround(state, 'underline') !== null
}

// ─────────────────────────────────────────────────────────────────────────────
// Which marks hold the selection, for the bubble's pressed states
// ─────────────────────────────────────────────────────────────────────────────

export interface ActiveMarks {
  bold: boolean
  italic: boolean
  strike: boolean
  code: boolean
  underline: boolean
  highlight: HighlightColor | null
  link: boolean
}

const MARK_NODES: Record<string, keyof ActiveMarks> = {
  StrongEmphasis: 'bold',
  Emphasis: 'italic',
  Strikethrough: 'strike',
  InlineCode: 'code',
  Link: 'link',
}

/** What the selection is wrapped in: a toggle shows pressed when its mark holds
 *  the whole selection. */
export function activeMarks(state: EditorState): ActiveMarks {
  const { from, to } = state.selection.main
  const out: ActiveMarks = {
    bold: false,
    italic: false,
    strike: false,
    code: false,
    underline: underlineAt(state),
    highlight: highlightAt(state),
    link: false,
  }
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1); n; n = n.parent) {
    const key = MARK_NODES[n.name]
    if (key !== undefined && n.from <= from && n.to >= to) (out[key] as boolean) = true
  }
  // A selection that is exactly the text inside `**…**` sits outside the node
  // on the left; look from the inside too.
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(to, -1); n; n = n.parent) {
    const key = MARK_NODES[n.name]
    if (key !== undefined && n.from <= from && n.to >= to) (out[key] as boolean) = true
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Alignment
// ─────────────────────────────────────────────────────────────────────────────

export { ALIGNS, type Align } from './blocks'

/** The wrapper around a block: its own, read when the block was found, or one
 *  around its lines. */
function wrapperOf(state: EditorState, block: Block): AlignWrapper | null {
  return wrapperAround(state, block.content.from, block.content.to)
}

/** A block's alignment; `left` when it has none. */
export function alignOf(state: EditorState, block: Block): Align {
  return wrapperOf(state, block)?.align ?? 'left'
}

/** Only a top-level paragraph or heading can be aligned: a wrapper inside a
 *  list would end the list. */
export function canAlign(block: Block): boolean {
  return !block.listItem && (block.kind === 'text' || /^heading-/.test(block.kind))
}

/** Aligns a block: changes its wrapper, adds one, or with `left` takes it away. */
export function setAlign(state: EditorState, block: Block, align: Align): TransactionSpec | null {
  if (!canAlign(block)) return null
  const doc = state.doc
  const wrapper = wrapperOf(state, block)
  if (wrapper !== null) {
    if (wrapper.align === align) return null
    const openLine = doc.line(wrapper.open)
    if (align === 'left') {
      const closeLine = doc.line(wrapper.close)
      return {
        changes: [
          { from: openLine.from, to: doc.line(wrapper.open + 2).from },
          { from: doc.line(wrapper.close - 2).to, to: closeLine.to },
        ],
      }
    }
    return { changes: { from: openLine.from, to: openLine.to, insert: `<div align="${align}">` } }
  }
  if (align === 'left') return null
  return {
    changes: [
      { from: block.content.from, insert: `<div align="${align}">\n\n` },
      { from: block.content.to, insert: '\n\n</div>' },
    ],
  }
}

const alignTag = Decoration.line({ class: 'cm-align-tag' })
const alignGap = Decoration.line({ class: 'cm-align-gap' })
const alignLine = (align: Align) => Decoration.line({ class: `cm-align cm-align-${align}` })
/** A tag line and the blank line beside it, folded away. */
const alignFold = Decoration.replace({ block: true })

/** Every `<div align>` in the document, by its tag lines (1-based). */
function wrappersIn(state: EditorState): AlignWrapper[] {
  const doc = state.doc
  const out: AlignWrapper[] = []
  for (let n = 1; n <= doc.lines; n++) {
    const open = ALIGN_OPEN.exec(doc.line(n).text)
    if (open === null) continue
    let close = n + 1
    while (close <= doc.lines && !ALIGN_CLOSE.test(doc.line(close).text)) close++
    if (close > doc.lines) break
    out.push({ align: open[1] as Align, open: n, close })
    n = close
  }
  return out
}

/** Whether the selection touches a wrapper, which shows its tags. */
function revealed(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from)
}

/**
 * Paints aligned blocks: their lines take the alignment, and off the caret the
 * wrapper's tag lines fold away with the blank line beside each, so a centred
 * paragraph reads as just that. With the caret inside, the tags show, small
 * and quiet, to be edited like any other syntax under the caret. Only a
 * wrapper written the way `setAlign` writes it folds, so no text is hidden.
 */
export function alignDecorations(
  state: EditorState,
  wrappers: readonly AlignWrapper[] = wrappersIn(state),
): DecorationSet {
  const doc = state.doc
  const out: Range<Decoration>[] = []
  for (const w of wrappers) {
    const open = doc.line(w.open)
    const close = doc.line(w.close)
    const canonical =
      w.close - w.open >= 4 &&
      doc.line(w.open + 1).text.trim() === '' &&
      doc.line(w.close - 1).text.trim() === ''
    const fold = canonical && !revealed(state, open.from, close.to)
    if (fold) {
      out.push(alignFold.range(open.from, doc.line(w.open + 1).to))
      out.push(alignFold.range(doc.line(w.close - 1).from, close.to))
    }
    const first = fold ? w.open + 2 : w.open
    const last = fold ? w.close - 2 : w.close
    for (let k = first; k <= last; k++) {
      const line = doc.line(k)
      const deco =
        k === w.open || k === w.close
          ? alignTag
          : line.text.trim() === ''
            ? alignGap
            : alignLine(w.align)
      out.push(deco.range(line.from))
    }
  }
  return Decoration.set(out, true)
}

interface AlignPreview {
  wrappers: readonly AlignWrapper[]
  decorations: DecorationSet
}

/** A state field, since folding whole lines is a block decoration. */
export const alignPreview = StateField.define<AlignPreview>({
  create(state) {
    const wrappers = wrappersIn(state)
    return { wrappers, decorations: alignDecorations(state, wrappers) }
  },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value
    const wrappers = tr.docChanged ? wrappersIn(tr.state) : value.wrappers
    if (wrappers.length === 0 && value.wrappers.length === 0) return value
    return { wrappers, decorations: alignDecorations(tr.state, wrappers) }
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
})
