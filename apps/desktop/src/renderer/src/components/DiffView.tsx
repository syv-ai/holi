/**
 * A read-only side-by-side diff (before | after), rendered with `@codemirror/merge`'s
 * `MergeView` — the DiffEditor shape: two panes, deletions shaded red on the left,
 * insertions green on the right, unchanged runs collapsed.
 *
 * Read-only: no `revertControls`, both sides non-editable — this is a view of
 * history, not a merge to resolve. The theme override drops the package default
 * `.cm-changedText` gradient (which reads as an underline) in favour of clean
 * line backgrounds.
 */
import { MergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { editorTheme } from '../editor/theme'

const diffTheme = EditorView.theme({
  // Kill the default changed-text gradient — it renders as an underline.
  '.cm-changedText': { background: 'none' },
  '.cm-changedText, .cm-deletedText, .cm-insertedText': { textDecoration: 'none' },
  // Whole-line backgrounds do the work: red on the before side, green on the after.
  '&.cm-merge-a .cm-changedLine, &.cm-merge-a .cm-deletedLine': {
    backgroundColor: 'rgba(220, 70, 70, 0.18)',
  },
  '&.cm-merge-b .cm-changedLine, &.cm-merge-b .cm-insertedLine': {
    backgroundColor: 'rgba(70, 180, 90, 0.18)',
  },
  '.cm-deletedChunk': { backgroundColor: 'rgba(220, 70, 70, 0.10)' },
})

const side = (doc: string) => ({
  doc,
  extensions: [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping,
    editorTheme,
    diffTheme,
  ],
})

export function DiffView({ before, after }: { before: string; after: string }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (host.current === null) return
    const view = new MergeView({
      parent: host.current,
      orientation: 'a-b',
      a: side(before),
      b: side(after),
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 2 },
    })
    return () => view.destroy()
  }, [before, after])

  return <div ref={host} className="h-full overflow-auto text-[11px]" />
}
