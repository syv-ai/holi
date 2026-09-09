/**
 * A ```mermaid fence draws as a diagram, and shows its source when the caret is
 * in it (#6).
 *
 * **A StateField, not a case in `livePreview`.** The plan called for one more
 * branch in the decoration builder, and that is not buildable: CodeMirror
 * refuses block decorations from a `ViewPlugin` — `RangeError: Block decorations
 * may not be specified via plugins` — and it refuses them by aborting
 * `EditorView` construction, so a note with a diagram in it would open blank
 * rather than open wrong. `frontmatter.ts` learned this first and its own
 * docstring records it; the table widget provides its block decorations the same
 * way. This is the third instance of the same rule.
 *
 * That split turns out to cost nothing. `livePreview` is untouched: it still
 * paints every fence's lines as code, and when a diagram replaces those lines
 * they are simply not rendered. The reveal rule is not reimplemented either — a
 * fence holds no inline elements, so "the selection is on this element" is
 * exactly `touches`, which is the same predicate D91 gave the rest of the editor.
 *
 * The whole document rather than the viewport, because a StateField has no
 * viewport. That is the shape the frontmatter and table fields already have.
 */
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { fenceLanguageId } from './fence-languages'
import { touches } from './livePreview'
import { MermaidWidget } from './mermaidWidget'

/**
 * The diagrams, as decorations. Pure over the state, so it is unit-testable
 * without a DOM exactly as `buildDecorations` and `frontmatterDecorations` are.
 */
export function mermaidDecorations(state: EditorState): DecorationSet {
  const sel = state.selection.main
  const ranges: { from: number; to: number; deco: Decoration }[] = []

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return
      // The info string from the TREE rather than from the line's text, so
      // ```mermaid title="x" resolves the way a fence's language resolves
      // everywhere else in this editor.
      const info = node.node.getChild('CodeInfo')
      if (info === null) return
      if (fenceLanguageId(state.sliceDoc(info.from, info.to)) !== 'mermaid') return

      const first = state.doc.lineAt(node.from)
      const last = state.doc.lineAt(node.to)
      // An empty fence has nothing to draw, and a fence still being typed has no
      // closing line yet — leaving both as source is what a diagram degrading
      // gracefully looks like at the moment of writing one.
      if (last.number <= first.number + 1) return
      // The caret in it means you are editing it. Whole lines at both ends: a
      // block decoration covering part of a line makes CodeMirror throw.
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
 * Recomputed on a document change and on a selection change, and on nothing
 * else — a viewport scroll cannot open or close a diagram, and rebuilding on one
 * would re-run mermaid while you scroll.
 *
 * No `atomicRanges`, deliberately, unlike the frontmatter block: a diagram is
 * meant to be walked into. The caret entering the replaced range is exactly what
 * turns it back into the source you came to edit, and an atomic range would step
 * the caret over it and leave no way in but the mouse.
 */
export const mermaidExtension = StateField.define<DecorationSet>({
  create: (state) => mermaidDecorations(state),
  update(deco, tr) {
    if (tr.docChanged || tr.selection !== undefined) return mermaidDecorations(tr.state)
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})
