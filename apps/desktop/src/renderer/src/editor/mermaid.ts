/**
 * A ```mermaid fence draws as a diagram, and shows its source when the
 * selection touches it (`touches`).
 *
 * A StateField, not a case in `livePreview`: CodeMirror refuses block
 * decorations from a `ViewPlugin` (`RangeError: Block decorations may not be
 * specified via plugins`) by aborting `EditorView` construction, so the note
 * would open blank. A StateField has no viewport, so it covers the whole
 * document.
 */
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { fenceLanguageId } from './fence-languages'
import { touches } from './livePreview'
import { MermaidWidget } from './mermaidWidget'

/** The diagrams, as decorations. Pure over the state, so testable without a DOM. */
export function mermaidDecorations(state: EditorState): DecorationSet {
  const sel = state.selection.main
  const ranges: { from: number; to: number; deco: Decoration }[] = []

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return
      // The info string from the tree, resolved like any fence language.
      const info = node.node.getChild('CodeInfo')
      if (info === null) return
      if (fenceLanguageId(state.sliceDoc(info.from, info.to)) !== 'mermaid') return

      const first = state.doc.lineAt(node.from)
      const last = state.doc.lineAt(node.to)
      // Empty, or still being typed (no closing line yet): leave as source.
      if (last.number <= first.number + 1) return
      // Whole lines at both ends: a partial-line block decoration throws.
      if (touches(sel, { from: first.from, to: last.to })) return

      const body = state.sliceDoc(
        state.doc.line(first.number + 1).from,
        state.doc.line(last.number - 1).to,
      )
      ranges.push({
        from: first.from,
        to: last.to,
        deco: Decoration.replace({ widget: new MermaidWidget(body), block: true }),
      })
    },
  })

  return Decoration.set(ranges.map((r) => r.deco.range(r.from, r.to)))
}

/**
 * Recomputed on document and selection changes only; a scroll cannot open or
 * close a diagram.
 *
 * No `atomicRanges`, unlike the frontmatter block: the caret entering the range
 * is what reveals the source, and an atomic range would step over it.
 */
export const mermaidExtension = StateField.define<DecorationSet>({
  create: (state) => mermaidDecorations(state),
  update(deco, tr) {
    if (tr.docChanged || tr.selection !== undefined) return mermaidDecorations(tr.state)
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})
