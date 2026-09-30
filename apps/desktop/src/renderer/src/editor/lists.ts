/**
 * Alphabetic ordered lists: `a.`, `A.`, `a)`. CommonMark's ordered list is
 * decimal only, so a parser extension adds them to the tree: an `AlphaList`
 * holding ordinary `ListItem`s and `ListMark`s, nested by the same rules as
 * any other list. Live preview, Enter and renumbering all read that tree.
 */
import { isolateHistory } from '@codemirror/commands'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  Prec,
  type ChangeSpec,
  type StateCommand,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import type { BlockContext, Line as MarkdownLine, MarkdownConfig } from '@lezer/markdown'

/** The list types, decimal and alphabetic, whose items are counted. */
const COUNTED_LISTS = new Set(['OrderedList', 'AlphaList'])

/** Every list node, for depth. */
export function isListNode(name: string): boolean {
  return name === 'BulletList' || COUNTED_LISTS.has(name)
}

/** A letter and `.` or `)`, then a space: the marker's length, or -1. The
 *  space is required, so `A.` alone on a line is not an empty item. */
function alphaMarker(line: MarkdownLine): number {
  const letter = line.next
  const isLetter = (letter >= 65 && letter <= 90) || (letter >= 97 && letter <= 122)
  if (!isLetter) return -1
  const delim = line.text.charCodeAt(line.pos + 1)
  if (delim !== 46 && delim !== 41) return -1
  const after = line.text.charCodeAt(line.pos + 2)
  return after === 32 || after === 9 ? 2 : -1
}

/** The column an item's text starts at: past the marker and its spaces, or one
 *  past the marker when five or more follow (markdown's indented-code rule). */
function contentColumn(line: MarkdownLine, markEnd: number): number {
  const afterMark = line.countIndent(markEnd, line.pos, line.indent)
  const text = line.countIndent(line.skipSpace(markEnd), markEnd, afterMark)
  return text >= afterMark + 5 ? afterMark + 1 : text
}

function inListItem(cx: BlockContext): boolean {
  for (let d = cx.depth - 1; d >= 0; d--) if (cx.parentType(d).name === 'ListItem') return true
  return false
}

/**
 * The parser half. Deliberately fussier than a decimal list about where one
 * may start: inside a list (`a.` under `1.`), or at the start of a block. So
 * "A. Smith said" mid-paragraph stays a sentence, and `a) hello` in a fence
 * stays code.
 */
export const alphaLists: MarkdownConfig = {
  defineNodes: [
    {
      name: 'AlphaList',
      block: true,
      // Whether the list goes on at a new line; the item's own rule then
      // decides whether that line is more of the item. Mirrors markdown's
      // rule for its own lists: a blank line, a line indented as far as any
      // item's text, or the next marker with the same delimiter.
      composite(_cx, line, delim) {
        if (line.pos === line.text.length) return true
        if (line.indent >= line.baseIndent + 3) return true
        return alphaMarker(line) > 0 && line.text.charCodeAt(line.pos + 1) === delim
      },
    },
  ],
  parseBlock: [
    {
      name: 'AlphaList',
      after: 'OrderedList',
      parse(cx, line) {
        const size = alphaMarker(line)
        if (size < 0) return false
        if (cx.parentType().name !== 'AlphaList') {
          cx.startComposite('AlphaList', line.basePos, line.text.charCodeAt(line.pos + 1))
        }
        const column = contentColumn(line, line.pos + size)
        cx.startComposite('ListItem', line.basePos, column - line.baseIndent)
        cx.addElement(cx.elt('ListMark', cx.lineStart + line.pos, cx.lineStart + line.pos + size))
        line.moveBaseColumn(column)
        return null
      },
      endLeaf: (cx, line) => alphaMarker(line) > 0 && inListItem(cx),
    },
  ],
}

/** `a` → `b`. The end of the alphabet has nowhere to go, and repeating the
 *  letter beats emitting `{`. */
function nextLetter(letter: string): string {
  if (letter === 'z' || letter === 'Z') return letter
  return String.fromCharCode(letter.charCodeAt(0) + 1)
}

/** The item the caret is in, innermost, when it is a letter item or sits
 *  inside one; null otherwise, which the markdown keymap's Enter handles. */
function itemInLetterList(state: EditorState, pos: number): SyntaxNode | null {
  let item: SyntaxNode | null = null
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (node.name === 'ListItem') item ??= node
    if (node.name === 'AlphaList' && item !== null) return item
  }
  return null
}

/** Whatever sits before an item's marker on its line, as a new line's
 *  prefix: its indent kept, a quote's `>` kept, the rest (an outer marker)
 *  turned to spaces. */
function prefixOf(state: EditorState, item: SyntaxNode, mark: SyntaxNode): string {
  const line = state.doc.lineAt(mark.from)
  return state.sliceDoc(line.from, mark.from).replace(/[^\s>]/g, ' ')
}

/** The marker the item after this one opens with, space included. */
function nextMarker(state: EditorState, item: SyntaxNode, mark: SyntaxNode): string {
  const text = state.sliceDoc(mark.from, mark.to)
  const task = item.getChild('Task') === null ? '' : '[ ] '
  const number = /^(\d+)([.)])$/.exec(text)
  if (number !== null) return `${Number(number[1]) + 1}${number[2]} `
  if (/^[A-Za-z][.)]$/.test(text)) return `${nextLetter(text[0]!)}${text[1]} `
  return `${text} ${task}`
}

/**
 * Enter in a letter list, and in any list inside one: the next marker, at the
 * indent this one has. `insertNewlineContinueMarkup` does this for decimal
 * and bullet lists, but builds its indent only from lists it knows, so inside
 * a letter item it would drop that item's columns. An empty item steps out a
 * level, becoming the next item of the list around it, or ends the list.
 */
export const continueAlphaList: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main
  if (!range.empty) return false
  const item = itemInLetterList(state, range.head)
  const mark = item?.getChild('ListMark')
  if (item == null || mark == null) return false
  const line = state.doc.lineAt(range.head)
  // On the marker's own line, past the marker; elsewhere Enter is just Enter.
  if (mark.from < line.from || range.head <= mark.to) return false

  const taskMark = item.getChild('Task')?.getChild('TaskMarker')
  const textFrom = taskMark?.to ?? mark.to
  if (state.sliceDoc(textFrom, line.to).trim() === '') {
    const outer = item.parent?.parent
    const outerMark = outer?.name === 'ListItem' ? outer.getChild('ListMark') : null
    const insert =
      outer != null && outerMark != null
        ? prefixOf(state, outer, outerMark) + nextMarker(state, outer, outerMark)
        : ''
    dispatch(
      state.update(
        {
          changes: { from: line.from, to: line.to, insert },
          selection: EditorSelection.cursor(line.from + insert.length),
        },
        { scrollIntoView: true, userEvent: 'delete' },
      ),
    )
    return true
  }

  const insert = `\n${prefixOf(state, item, mark)}${nextMarker(state, item, mark)}`
  dispatch(
    state.update(
      {
        changes: { from: range.head, insert },
        selection: EditorSelection.cursor(range.head + insert.length),
      },
      { scrollIntoView: true, userEvent: 'input' },
    ),
  )
  return true
}

/** High precedence, before the markdown keymap's Enter; it declines elsewhere. */
export const alphaListKeymap = Prec.high(keymap.of([{ key: 'Enter', run: continueAlphaList }]))

/**
 * Ordered-list numbering, decimal and alphabetic, rewritten in the file after an edit that changes a
 * list's shape: Tab, Shift+Tab, Enter, deleting a marker or a line break,
 * moving a line. Each list touched counts up from its start, so a new sublist
 * reads 1, 2, 3 and the list it left closes the gap. Typing inside an item, a
 * number included, is the author's and is left alone, as are undo and redo.
 *
 * A list keeps its start only if its first item was already one before the
 * edit; otherwise it starts at 1. A nested decimal list with no blank line
 * above it always starts at 1: CommonMark reads `2.` under an item's text as
 * more of that text, so on GitHub anything else is not a list at all.
 *
 * Letters count the same way, in the case the list's first item has, and stop
 * at `z` rather than run into punctuation.
 */
export const renumberOrderedLists = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !reshapesLists(tr)) return tr
  const changes = renumberChanges(tr)
  return changes.length === 0 ? tr : [tr, { changes, sequential: true }]
})

function reshapesLists(tr: Transaction): boolean {
  if (tr.isUserEvent('input.indent') || tr.isUserEvent('delete.dedent')) return true
  if (tr.isUserEvent('move.line')) return true
  if (tr.isUserEvent(LIST_KIND_EVENT)) return false
  if (!tr.isUserEvent('input') && !tr.isUserEvent('delete')) return false
  const before = syntaxTree(tr.startState)
  let reshaped = false
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (reshaped) return
    if (inserted.lines > 1 || tr.startState.sliceDoc(fromA, toA).includes('\n')) {
      reshaped = true
      return
    }
    if (toA > fromA) {
      before.iterate({
        from: fromA,
        to: toA,
        enter: (node) => {
          if (node.name === 'ListMark' && node.from < toA && node.to > fromA) reshaped = true
          return !reshaped
        },
      })
    }
  })
  return reshaped
}

const ITEM_NUMBER = /^(?:\d+|[A-Za-z])(?=[.)])/

function renumberChanges(tr: Transaction): ChangeSpec[] {
  const state = tr.state
  let lo = state.doc.length
  let hi = 0
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    lo = Math.min(lo, fromB)
    hi = Math.max(hi, toB)
  })
  const tree = ensureSyntaxTree(state, hi, 50) ?? syntaxTree(state)

  // The lists an edit sits in, and the sublists of the items it sits in: a
  // dedented item carries the rest of its old sublist as its own.
  const lists = new Map<number, SyntaxNode>()
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    tree.iterate({
      from: fromB,
      to: toB,
      enter: (ref) => {
        if (COUNTED_LISTS.has(ref.name)) lists.set(ref.from, ref.node)
        if (ref.name === 'ListItem') {
          for (let child = ref.node.firstChild; child !== null; child = child.nextSibling) {
            if (COUNTED_LISTS.has(child.name)) lists.set(child.from, child)
          }
        }
      },
    })
  })
  if (lists.size === 0) return []
  for (const list of lists.values()) {
    lo = Math.min(lo, list.from)
    hi = Math.max(hi, list.to)
  }
  const wereFirst = firstItemsBefore(tr, lo, hi)

  const changes: ChangeSpec[] = []
  for (const list of lists.values()) {
    const first = list.getChild('ListItem')
    if (first === null) continue
    const firstNumber = numberOf(state, first)
    if (firstNumber === null) continue
    const nested = list.parent?.name === 'ListItem'
    const firstLine = state.doc.lineAt(first.from)
    // GitHub's rule, so decimal only: a letter list is Holi's either way.
    const interrupts =
      list.name === 'OrderedList' &&
      nested &&
      firstLine.number > 1 &&
      state.doc.line(firstLine.number - 1).text.trim() !== ''
    let n = !interrupts && wereFirst.has(firstNumber.from) ? firstNumber.value : 1
    for (const item of list.getChildren('ListItem')) {
      const current = numberOf(state, item)
      const want = current === null ? '' : write(n, firstNumber.upper)
      if (current !== null && current.text !== want) {
        changes.push({ from: current.from, to: current.to, insert: want })
      }
      n++
    }
  }
  return changes
}

/** Where each list's first item was before the edit, mapped into the new doc. */
function firstItemsBefore(tr: Transaction, lo: number, hi: number): Set<number> {
  const before: Tree = syntaxTree(tr.startState)
  const firsts = new Set<number>()
  before.iterate({
    from: tr.changes.invertedDesc.mapPos(lo, -1),
    to: tr.changes.invertedDesc.mapPos(hi, 1),
    enter: (ref) => {
      if (!COUNTED_LISTS.has(ref.name)) return
      const mark = ref.node.getChild('ListItem')?.getChild('ListMark')
      if (mark != null) firsts.add(tr.changes.mapPos(mark.from, 1))
    },
  })
  return firsts
}

/** An item's count and where it is written: a number, or a letter counted
 *  from `a` = 1. From the marker, not the item: a nested item starts at its
 *  parent's text column, inside the indent. */
function numberOf(
  state: EditorState,
  item: SyntaxNode,
): { value: number; text: string; upper: boolean | null; from: number; to: number } | null {
  const mark = item.getChild('ListMark')
  if (mark === null) return null
  const m = ITEM_NUMBER.exec(state.sliceDoc(mark.from, mark.to))
  if (m === null) return null
  const text = m[0]
  const upper = /\d/.test(text) ? null : text === text.toUpperCase()
  const value = upper === null ? Number(text) : text.toLowerCase().charCodeAt(0) - 96
  return { value, text, upper, from: mark.from, to: mark.from + text.length }
}

/** A count as a list writes it: digits, or a letter in the list's case. */
function write(n: number, upper: boolean | null): string {
  if (upper === null) return String(n)
  const letter = String.fromCharCode(96 + Math.min(n, 26))
  return upper ? letter.toUpperCase() : letter
}

/**
 * A list's kind, chosen by typing it: in the empty first item of a list,
 * typing `a.` after the marker makes the list a letter list (`1. a.` becomes
 * `a. `), and `1.` makes it decimal again. Any `A.`, `a)` or number works, the
 * letter or number being where the list starts. Only the first item decides:
 * a later one keeps its list's kind, and `2. a.` is text.
 *
 * Bullets are not offered: an empty `- ` under a line of text is that line's
 * setext underline, so the switch would turn the item above into a heading.
 *
 * Given the state just after `typed` went in, ending at `pos`: the switch, or
 * null.
 */
/** The switch writes its list's markers itself, start included, so the
 *  renumbering leaves it be. */
const LIST_KIND_EVENT = 'input.list-kind'

export function markerSwitch(
  state: EditorState,
  pos: number,
  typed: string,
): TransactionSpec | null {
  if (typed !== '.' && typed !== ')') return null
  const line = state.doc.lineAt(pos)
  if (state.sliceDoc(pos, line.to).trim() !== '') return null
  let item: SyntaxNode | null = null
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (node.name === 'ListItem') {
      item = node
      break
    }
  }
  // A typed `1.` is a marker already, of an empty item nested in this one.
  const typedMark = item?.getChild('ListMark')
  if (typedMark?.to === pos && item?.parent?.parent?.name === 'ListItem') {
    item = item.parent.parent
  }
  const list = item?.parent
  const mark = item?.getChild('ListMark')
  if (item == null || list == null || mark == null || !COUNTED_LISTS.has(list.name)) return null
  if (list.getChild('ListItem')?.from !== item.from || mark.from < line.from) return null
  const written = /^[ \t]+(\d{1,9}|[A-Za-z])$/.exec(state.sliceDoc(mark.to, pos - typed.length))
  if (written === null) return null
  const token = written[1]!
  if (`${token}${typed}` === state.sliceDoc(mark.from, mark.to)) return null

  const upper = /\d/.test(token) ? null : token === token.toUpperCase()
  const start = upper === null ? Number(token) : token.toLowerCase().charCodeAt(0) - 96
  const changes: ChangeSpec[] = []
  let n = start
  for (const each of list.getChildren('ListItem')) {
    const eachMark = each.getChild('ListMark')
    if (eachMark === null) continue
    const marker = `${write(n++, upper)}${typed}`
    if (each.from === item.from) {
      // The marker, the space, and what was typed after it become the new marker.
      changes.push({ from: mark.from, to: pos, insert: `${marker} ` })
    } else {
      changes.push({ from: eachMark.from, to: eachMark.to, insert: marker })
    }
  }
  const cursor = mark.from + write(start, upper).length + typed.length + 1
  return {
    changes,
    selection: EditorSelection.cursor(cursor),
    // Its own undo step, after the typing: one ⌘Z gives back `1. a.`, for
    // when `a.` was the start of a sentence.
    annotations: isolateHistory.of('before'),
    userEvent: LIST_KIND_EVENT,
  }
}

/** Types the character first, then switches the list, as two transactions. */
export const listKindByTyping = EditorView.inputHandler.of((view, from, to, text, insert) => {
  if (from !== to || view.state.selection.ranges.length > 1) return false
  const typed = insert()
  const change = markerSwitch(typed.state, from + text.length, text)
  if (change === null) return false
  view.dispatch(typed)
  view.dispatch(view.state.update(change))
  return true
})
