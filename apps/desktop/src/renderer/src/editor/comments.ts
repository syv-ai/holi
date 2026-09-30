/**
 * An HTML comment on lines of its own (`<!-- … -->`) draws as a quiet banner,
 * centred in the column, and shows its source when the selection touches it
 * (`touches`). A comment inside a paragraph stays text, in the comment's colour.
 *
 * A StateField, not a case in `livePreview`, for the reason `mermaid.ts` gives:
 * CodeMirror refuses block decorations from a `ViewPlugin`.
 */
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { frontmatterRegion } from './frontmatter-region'
import { touches } from './livePreview'

/** A comment's words: no `<!--` and `-->`, and its lines less the indent they
 *  share, so a comment written indented reads flush. */
export function commentText(source: string): string {
  const inner = source.replace(/^<!--/, '').replace(/-->$/, '')
  const lines = inner.split('\n')
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop()
  const indent = Math.min(
    ...lines.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)![0].length),
  )
  return lines
    .map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
    .join('\n')
    .trim()
}

/**
 * The first and last source lines, while the source shows: they take the
 * banner's padding, so opening a comment does not move the note.
 */
const sourceLine = (first: boolean, last: boolean) =>
  Decoration.line({
    class: `cm-comment-source${first ? ' cm-comment-source-first' : ''}${last ? ' cm-comment-source-last' : ''}`,
  })

class CommentWidget extends WidgetType {
  constructor(
    readonly text: string,
    /** Source lines beyond the banner's own (`<!--` and `-->` on lines of
     *  their own): the banner pads by as much, to stay the source's height. */
    readonly extraLines: number,
  ) {
    super()
  }

  override eq(other: CommentWidget): boolean {
    return other.text === this.text && other.extraLines === this.extraLines
  }

  override toDOM(view: EditorView): HTMLElement {
    const block = document.createElement('div')
    block.className = 'cm-comment'
    const body = document.createElement('div')
    body.className = 'cm-comment-body'
    body.style.setProperty('--comment-extra-lines', String(this.extraLines))
    body.textContent = this.text
    block.append(body)
    // A press opens the source, with the caret just inside the `<!--`.
    block.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const pos = view.posAtDOM(block)
      view.dispatch({ selection: { anchor: pos + 4 } })
      view.focus()
    })
    return block
  }

  override ignoreEvent(): boolean {
    return true
  }
}

/** The banners, as decorations. Pure over the state, so testable without a DOM. */
export function commentDecorations(state: EditorState): DecorationSet {
  const sel = state.selection.main
  const fmEnd = frontmatterRegion(state.doc.toString())?.to ?? 0
  const ranges: { from: number; to: number; deco: Decoration }[] = []

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'CommentBlock') return
      const first = state.doc.lineAt(node.from)
      const last = state.doc.lineAt(node.to)
      // Whole lines only (a partial-line block decoration throws), and nothing
      // after the `-->` that the banner would swallow.
      if (node.from !== first.from || state.sliceDoc(node.to, last.to).trim() !== '') return
      if (first.from < fmEnd) return
      // Not closed yet: markdown runs the comment to the end of the document,
      // and a banner would swallow whatever is being written below it.
      const source = state.sliceDoc(node.from, node.to)
      if (!source.trimEnd().endsWith('-->')) return
      const text = commentText(source)
      if (text === '') return
      if (touches(sel, { from: first.from, to: last.to })) {
        ranges.push({
          from: first.from,
          to: first.from,
          deco: sourceLine(true, last.number === first.number),
        })
        if (last.number !== first.number)
          ranges.push({ from: last.from, to: last.from, deco: sourceLine(false, true) })
        return
      }
      const extraLines = last.number - first.number + 1 - text.split('\n').length
      ranges.push({
        from: first.from,
        to: last.to,
        deco: Decoration.replace({ widget: new CommentWidget(text, extraLines), block: true }),
      })
    },
  })

  return Decoration.set(ranges.map((r) => r.deco.range(r.from, r.to)))
}

/** Recomputed on document and selection changes; a scroll cannot open one. */
export const commentExtension = StateField.define<DecorationSet>({
  create: (state) => commentDecorations(state),
  update(deco, tr) {
    if (tr.docChanged || tr.selection !== undefined) return commentDecorations(tr.state)
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})
