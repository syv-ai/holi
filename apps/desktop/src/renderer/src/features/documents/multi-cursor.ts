/**
 * ⌘D, as in VS Code: with a selection, add the next occurrence of its text
 * as another selection; with a caret, first select the word under it.
 *
 * ProseMirror draws one selection, so the editor's own selection is the main
 * one (the newest occurrence, which the view scrolls to and the format bubble
 * would follow) and the earlier ones are kept here as ranges, drawn as
 * decorations. Typing, Backspace, Delete, ← → and a one-line paste act on
 * every range at once, in one undo step. Anything else (Enter, Tab, a click,
 * ↑ ↓, a composition) lets the extra ranges go first and then acts on the main
 * selection alone, so a block-level key never runs at a place it cannot see.
 * Escape collapses back to the main selection.
 */
import { Extension } from "@tiptap/react"
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import { SearchQuery } from "prosemirror-search"

export interface Range {
  from: number
  to: number
}

interface MultiCursorState {
  /** The selections besides the editor's own, in document order. */
  extras: readonly Range[]
  /** The occurrences are whole words: the first ⌘D started from a caret. */
  wholeWord: boolean
}

const EMPTY: MultiCursorState = { extras: [], wholeWord: false }

const multiCursorKey = new PluginKey<MultiCursorState>("multiCursor")

/** The selections besides the main one, for tests and the format bubble. */
export function extraSelections(state: EditorState): readonly Range[] {
  return multiCursorKey.getState(state)?.extras ?? EMPTY.extras
}

const WORD = /[\p{L}\p{N}_]/u

/** The word around a caret, within its textblock; null between words. */
function wordAt(state: EditorState, pos: number): Range | null {
  const $pos = state.doc.resolve(pos)
  const parent = $pos.parent
  if (!parent.isTextblock) return null
  const text = parent.textBetween(0, parent.content.size, undefined, "￼")
  let start = $pos.parentOffset
  let end = start
  while (start > 0 && WORD.test(text[start - 1]!)) start--
  while (end < text.length && WORD.test(text[end]!)) end++
  if (start === end) return null
  const base = $pos.start()
  return { from: base + start, to: base + end }
}

const overlaps = (a: Range, b: Range) => a.from < b.to && b.from < a.to

/** The next occurrence of the main selection's text after it, wrapping, that
 *  is not already selected. */
function nextOccurrence(
  state: EditorState,
  ranges: readonly Range[],
  wholeWord: boolean
): Range | null {
  const { from, to, $from, $to } = state.selection
  if (!$from.sameParent($to)) return null
  const search = state.doc.textBetween(from, to, undefined, "￼")
  if (search === "") return null
  const query = new SearchQuery({
    search,
    caseSensitive: true,
    literal: true,
    wholeWord,
  })
  const end = state.doc.content.size
  for (const [start, stop] of [
    [to, end],
    [0, from],
  ] as const) {
    let pos = start
    for (;;) {
      const found = query.findNext(state, pos, stop)
      if (!found) break
      const range = { from: found.from, to: found.to }
      if (!ranges.some((taken) => overlaps(taken, range))) return range
      pos = Math.max(found.to, pos + 1)
    }
  }
  return null
}

/** ⌘D: select the caret's word, or add the next occurrence of the selection. */
const selectNextOccurrence: Command = (state, dispatch) => {
  const { selection } = state
  if (!(selection instanceof TextSelection)) return false
  const current = multiCursorKey.getState(state) ?? EMPTY

  if (selection.empty) {
    const word = wordAt(state, selection.from)
    if (!word) return true
    dispatch?.(
      state.tr
        .setSelection(TextSelection.create(state.doc, word.from, word.to))
        .setMeta(multiCursorKey, { extras: [], wholeWord: true })
        .scrollIntoView()
    )
    return true
  }

  const main = { from: selection.from, to: selection.to }
  const ranges = [...current.extras, main]
  const next = nextOccurrence(state, ranges, current.wholeWord)
  if (!next) return true
  dispatch?.(
    state.tr
      .setSelection(TextSelection.create(state.doc, next.from, next.to))
      .setMeta(multiCursorKey, {
        extras: [...ranges].sort((a, b) => a.from - b.from),
        wholeWord: current.wholeWord,
      })
      .scrollIntoView()
  )
  return true
}

/** One edit at every selection. `op` edits the range in `tr` (whose doc is
 *  untouched up to the range's end) and says where its caret lands. */
function editAll(
  state: EditorState,
  op: (tr: Transaction, range: Range) => number
): Transaction {
  const main = state.selection
  const ranges = [
    ...extraSelections(state).map((range) => ({ ...range, main: false })),
    { from: main.from, to: main.to, main: true },
  ].sort((a, b) => b.from - a.from)

  const tr = state.tr
  // Back to front, so each range's positions still hold when it is edited;
  // each caret is then carried through the edits before it.
  const carets = ranges.map((range) => {
    const caret = op(tr, range)
    return { caret, step: tr.steps.length, main: range.main }
  })
  const placed = carets.map(({ caret, step, main }) => ({
    pos: tr.mapping.slice(step).map(caret),
    main,
  }))

  const mainPos = placed.find((caret) => caret.main)!.pos
  const extras: Range[] = []
  for (const { pos, main } of placed) {
    if (main || pos === mainPos) continue
    if (extras.some((range) => range.from === pos)) continue
    extras.push({ from: pos, to: pos })
  }
  extras.sort((a, b) => a.from - b.from)

  return tr
    .setSelection(TextSelection.create(tr.doc, mainPos))
    .setMeta(multiCursorKey, { extras, wholeWord: false })
    .scrollIntoView()
}

function insertEverywhere(view: EditorView, text: string): boolean {
  view.dispatch(
    editAll(view.state, (tr, { from, to }) => {
      tr.insertText(text, from, to)
      return from + text.length
    }).setMeta("uiEvent", "input")
  )
  return true
}

function deleteEverywhere(view: EditorView, dir: -1 | 1): boolean {
  view.dispatch(
    editAll(view.state, (tr, { from, to }) => {
      if (from < to) {
        tr.delete(from, to)
        return from
      }
      const $pos = tr.doc.resolve(from)
      // A caret at its block's edge stays put: joining blocks is one
      // selection's business.
      if (dir < 0 && $pos.parentOffset === 0) return from
      if (dir > 0 && $pos.parentOffset === $pos.parent.content.size) return from
      if (dir < 0) {
        tr.delete(from - 1, from)
        return from - 1
      }
      tr.delete(from, from + 1)
      return from
    })
  )
  return true
}

function moveEverywhere(view: EditorView, dir: -1 | 1): boolean {
  view.dispatch(
    editAll(view.state, (tr, { from, to }) => {
      if (from < to) return dir < 0 ? from : to
      const $pos = tr.doc.resolve(from)
      if (dir < 0) return $pos.parentOffset === 0 ? from : from - 1
      return $pos.parentOffset === $pos.parent.content.size ? from : from + 1
    })
  )
  return true
}

function dropExtras(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(multiCursorKey, EMPTY))
}

const caret = () => {
  const element = document.createElement("span")
  element.className = "rich-text-extra-caret"
  element.setAttribute("aria-hidden", "true")
  return element
}

export const MultiCursor = Extension.create({
  name: "multiCursor",
  // Ahead of the slash menu, Space-to-ask and the list keys, so a key with
  // several selections is seen here first.
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      "Mod-d": ({ editor }) =>
        selectNextOccurrence(editor.state, editor.view.dispatch),
      Escape: ({ editor }) => {
        if (extraSelections(editor.state).length === 0) return false
        dropExtras(editor.view)
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<MultiCursorState>({
        key: multiCursorKey,
        state: {
          init: () => EMPTY,
          apply(tr, value, before, after) {
            const meta = tr.getMeta(multiCursorKey) as
              MultiCursorState | undefined
            if (meta !== undefined) return meta
            if (value.extras.length === 0) return value
            // The main selection moved by other means: the rest let go.
            if (!after.selection.eq(before.selection.map(tr.doc, tr.mapping)))
              return EMPTY
            if (!tr.docChanged) return value
            const extras = value.extras.map((range) => ({
              from: tr.mapping.map(range.from, 1),
              to: tr.mapping.map(range.to, -1),
            }))
            return {
              ...value,
              extras: extras.filter((range) => range.from <= range.to),
            }
          },
        },
        props: {
          decorations(state) {
            const extras = extraSelections(state)
            if (extras.length === 0) return null
            return DecorationSet.create(
              state.doc,
              extras.map((range) =>
                range.from === range.to
                  ? Decoration.widget(range.from, caret, {
                      side: -1,
                      key: "extra-caret",
                    })
                  : Decoration.inline(range.from, range.to, {
                      class: "rich-text-extra-selection",
                    })
              )
            )
          },
          handleKeyDown(view, event) {
            if (extraSelections(view.state).length === 0) return false
            if (!view.editable || event.isComposing) return false
            const mod = event.metaKey || event.ctrlKey
            const plain = !mod && !event.altKey

            if (plain && !event.shiftKey && event.key === "Backspace")
              return deleteEverywhere(view, -1)
            if (plain && !event.shiftKey && event.key === "Delete")
              return deleteEverywhere(view, 1)
            if (plain && !event.shiftKey && event.key === "ArrowLeft")
              return moveEverywhere(view, -1)
            if (plain && !event.shiftKey && event.key === "ArrowRight")
              return moveEverywhere(view, 1)
            // A printable character (⌥ types them too on a Mac).
            if (!mod && [...event.key].length === 1)
              return insertEverywhere(view, event.key)
            // ⌘D, Escape, the marks and undo are keys the main selection
            // keeps; anything else is for one selection.
            if (mod || event.key === "Escape") return false
            if (["Shift", "Alt", "Meta", "Control"].includes(event.key))
              return false
            dropExtras(view)
            return false
          },
          handleTextInput(view, _from, _to, text) {
            if (extraSelections(view.state).length === 0) return false
            return insertEverywhere(view, text)
          },
          handlePaste(view, event) {
            if (extraSelections(view.state).length === 0) return false
            const text = event.clipboardData?.getData("text/plain") ?? ""
            if (text !== "" && !/[\r\n]/.test(text))
              return insertEverywhere(view, text)
            dropExtras(view)
            return false
          },
          handleDOMEvents: {
            compositionstart(view) {
              if (extraSelections(view.state).length > 0) dropExtras(view)
              return false
            },
          },
        },
      }),
    ]
  },
})
