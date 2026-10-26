/**
 * Comment threads in the document editor (docs/features/note-comments.md).
 *
 * A thread's anchor is a quote of the file's markdown, which is what the
 * agent quotes and `holi comments` places; the editor holds rich text. The
 * two are joined by marking the ends of a range with private-use characters,
 * which no person types and markdown passes through as text: marked in the
 * editor's document and serialised, they say where a selection is in the
 * markdown (`selectionAnchor`); marked in the markdown and parsed, they say
 * where each thread's passage is in the editor (`placeThreads`). Either way
 * the marks come out again before anything is kept.
 *
 * `DocumentComments` draws the open threads' passages as a tint, the one the
 * panel is on stronger, and reports a press on one. Between placements the
 * tints follow the document's edits.
 */
import { Extension, type Editor } from "@tiptap/react"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import {
  anchorAt,
  locateAnchor,
  type CommentAnchor,
  type CommentThread,
  type LineRange,
} from "@holi/shared"

/** The first private-use code point; a range `i` is marked by `BASE + 2i`
 *  at its start and `BASE + 2i + 1` at its end. */
const BASE = 0xe000
/** As many ranges as the private-use area holds pairs of marks. */
const MAX_RANGES = (0xf8ff - BASE + 1) / 2
const MARKS = /[-]/g

/** A passage's place in the editor's document. */
export interface PlacedRange {
  id: string
  from: number
  to: number
}

function markdownOf(editor: Editor, doc: PMNode): string | null {
  const manager = editor.markdown
  if (!manager) return null
  return manager.serialize(doc.toJSON())
}

/**
 * Where the editor's selection is in the file it saves: `head` (the
 * frontmatter, kept aside) and the editor's markdown, as `text` and the
 * selection's offsets in it. Null when the selection is empty or its ends
 * cannot be told apart in the markdown (inside something the codec writes as
 * one, an image or a raw HTML block).
 */
function selectionInFile(
  editor: Editor,
  head: string
): { text: string; from: number; to: number } | null {
  const { from, to } = editor.state.selection
  if (from >= to) return null
  const tr = editor.state.tr
  // The end first, so the start's position still holds.
  tr.insertText(String.fromCharCode(BASE + 1), to)
  tr.insertText(String.fromCharCode(BASE), from)
  const marked = markdownOf(editor, tr.doc)
  if (marked === null) return null
  const start = marked.indexOf(String.fromCharCode(BASE))
  const end = marked.indexOf(String.fromCharCode(BASE + 1))
  if (start === -1 || end === -1 || end < start) return null
  const body = marked.replace(MARKS, "")
  // Between the marks, less the start's own.
  if (end - 1 <= start) return null
  return {
    text: head + body,
    from: head.length + start,
    to: head.length + end - 1,
  }
}

/** The anchor for the editor's selection, quoted from the file it saves. */
export function selectionAnchor(
  editor: Editor,
  head: string
): CommentAnchor | null {
  const at = selectionInFile(editor, head)
  return at === null ? null : anchorAt(at.text, at.from, at.to)
}

/**
 * The file's lines the selection covers, 1-based and inclusive as `Read`
 * numbers them (docs/features/agent-config.md): a selection that ends at the
 * start of a line does not count that line. Null for a caret.
 */
export function selectionLines(editor: Editor, head: string): LineRange | null {
  const at = selectionInFile(editor, head)
  if (at === null) return null
  const lineOf = (offset: number) => at.text.slice(0, offset).split("\n").length
  const endsAtLineStart = at.to > at.from && at.text[at.to - 1] === "\n"
  const startLine = lineOf(at.from)
  const endLine = Math.max(
    startLine,
    lineOf(endsAtLineStart ? at.to - 1 : at.to)
  )
  return { startLine, endLine }
}

/** Block syntax at a line's start: a mark before it would end the block. */
const LINE_SYNTAX =
  /^(?: {0,3}(?:#{1,6} |>\s?|[-*+] (?:\[[ xX]\] )?|\d{1,9}[.)] ))+/

/** Where to put a range's start mark: past the block syntax a line begins
 *  with, so the heading or list item stays one. */
function startAt(body: string, at: number): number {
  if (at !== 0 && body[at - 1] !== "\n") return at
  const syntax = LINE_SYNTAX.exec(body.slice(at, at + 64))
  return syntax ? at + syntax[0].length : at
}

/** Where to put a range's end mark: before the line breaks it ends on, so it
 *  never begins the next block. */
function endAt(body: string, at: number, from: number): number {
  let end = at
  while (end > from && body[end - 1] === "\n") end--
  return end
}

/**
 * Where each thread's passage is in the editor's document: the threads
 * located in the file (`head` and the editor's markdown, as it saves them),
 * then their ends marked and the markdown parsed again. A thread that is
 * detached, in the frontmatter, or whose ends the parse cannot keep in text
 * is left out.
 */
export function placeThreads(
  editor: Editor,
  head: string,
  threads: readonly CommentThread[]
): PlacedRange[] {
  const manager = editor.markdown
  if (!manager || threads.length === 0) return []
  const body = editor.getMarkdown()
  const text = head + body
  const marks: { at: number; char: string }[] = []
  const ids: string[] = []
  for (const thread of threads.slice(0, MAX_RANGES)) {
    const found = locateAnchor(text, thread.anchor)
    if (found === null || found.from < head.length) continue
    const from = startAt(body, found.from - head.length)
    const to = endAt(body, found.to - head.length, from)
    if (to <= from) continue
    const i = ids.length
    ids.push(thread.id)
    marks.push({ at: from, char: String.fromCharCode(BASE + 2 * i) })
    marks.push({ at: to, char: String.fromCharCode(BASE + 2 * i + 1) })
  }
  if (ids.length === 0) return []

  // Last first, so every earlier offset still holds.
  let marked = body
  for (const mark of [...marks].sort((a, b) => b.at - a.at)) {
    marked = marked.slice(0, mark.at) + mark.char + marked.slice(mark.at)
  }
  let doc: PMNode
  try {
    doc = editor.schema.nodeFromJSON(manager.parse(marked))
  } catch {
    return []
  }

  // A mark is one position in the parsed document; the marks before it are
  // not in the editor's, so each takes away one more.
  const starts = new Map<number, number>()
  const ends = new Map<number, number>()
  let seen = 0
  doc.descendants((node, pos) => {
    if (!node.isText || node.text === undefined) return
    const value = node.text
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (code < BASE || code > 0xf8ff) continue
      const range = (code - BASE) >> 1
      const at = pos + i - seen
      if ((code - BASE) % 2 === 0) starts.set(range, at)
      else ends.set(range, at)
      seen++
    }
  })

  const size = editor.state.doc.content.size
  const placed: PlacedRange[] = []
  ids.forEach((id, i) => {
    const from = starts.get(i)
    const to = ends.get(i)
    if (from === undefined || to === undefined || to <= from) return
    if (to > size) return
    placed.push({ id, from, to })
  })
  return placed
}

// -------------------------------------------------------------- decorations

interface CommentsState {
  ranges: readonly PlacedRange[]
  active: string | null
  decorations: DecorationSet
}

type CommentsMeta = { ranges?: readonly PlacedRange[]; active?: string | null }

const documentCommentsKey = new PluginKey<CommentsState>(
  "documentComments"
)

function decorate(
  doc: PMNode,
  ranges: readonly PlacedRange[],
  active: string | null
): DecorationSet {
  return DecorationSet.create(
    doc,
    ranges.map((range) =>
      Decoration.inline(
        range.from,
        range.to,
        {
          class:
            range.id === active
              ? "holi-comment holi-comment-active"
              : "holi-comment",
          "data-comment-thread": range.id,
        },
        { id: range.id }
      )
    )
  )
}

/** Show `ranges` (the open threads' passages) and mark `active`. */
export function setCommentRanges(editor: Editor, meta: CommentsMeta): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(documentCommentsKey, meta))
}

/**
 * The threads whose passage covers `pos`, innermost last.
 * @public exported for its test
 */
export function threadsAt(state: EditorState, pos: number): string[] {
  const set = documentCommentsKey.getState(state)?.decorations
  if (!set) return []
  return set
    .find(pos, pos)
    .filter((d) => d.from <= pos && pos < d.to)
    .map((d) => (d.spec as { id: string }).id)
}

export const DocumentComments = Extension.create<{
  onPress: (id: string) => void
}>({
  name: "documentComments",

  addOptions() {
    return { onPress: () => undefined }
  },

  addProseMirrorPlugins() {
    const onPress = (id: string) => this.options.onPress(id)
    return [
      new Plugin<CommentsState>({
        key: documentCommentsKey,
        state: {
          init: () => ({
            ranges: [],
            active: null,
            decorations: DecorationSet.empty,
          }),
          apply(tr, value, _old, state) {
            const meta = tr.getMeta(documentCommentsKey) as
              CommentsMeta | undefined
            if (meta !== undefined) {
              const ranges = meta.ranges ?? value.ranges
              const active =
                meta.active === undefined ? value.active : meta.active
              return {
                ranges,
                active,
                decorations: decorate(state.doc, ranges, active),
              }
            }
            if (!tr.docChanged) return value
            const decorations = value.decorations.map(tr.mapping, tr.doc)
            return {
              active: value.active,
              decorations,
              ranges: decorations.find().map((d) => ({
                id: (d.spec as { id: string }).id,
                from: d.from,
                to: d.to,
              })),
            }
          },
        },
        props: {
          decorations(state) {
            return documentCommentsKey.getState(state)?.decorations
          },
          handleClick(view, pos) {
            const ids = threadsAt(view.state, pos)
            const id = ids.at(-1)
            if (id === undefined) return false
            onPress(id)
            // The caret still lands where it was pressed.
            return false
          },
        },
      }),
    ]
  },
})
