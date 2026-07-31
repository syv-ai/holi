/**
 * A read-only unified diff, rendered with `@codemirror/merge`'s `unifiedMergeView`
 * in **inline + compact** mode:
 *  - `allowInlineDiffs` — small in-line edits render inline (solid green/red) rather
 *    than as the default gradient-underlined separate lines.
 *  - `collapseUnchanged` — long unchanged runs fold away, so the change is the focus.
 *
 * Read-only: `mergeControls: false` drops the accept/reject affordances (this is a
 * view of history, not a merge to resolve) and the editor is non-editable. `original`
 * is the before-content; the doc is the after.
 */
import { unifiedMergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { editorTheme } from '../editor/theme'

/**
 * `{ dark: true }` marks the editor dark so `@codemirror/merge`'s own `&dark`
 * rules apply — `editorTheme` is a `baseTheme` with no dark flag, so without this
 * the merge view falls back to its LIGHT variants (a white "N unchanged lines"
 * bar on our dark UI). The `.cm-collapsedLines` override then replaces that bar's
 * hardcoded gradient with a flat, subtle strip that reads on any background.
 */
const diffTheme = EditorView.theme(
  {
    '.cm-collapsedLines': {
      background: 'none',
      backgroundColor: '#0a0a0a', // neutral-950, the app's standard background
      color: '#888',
      border: 'none',
    },
    '.cm-collapsedLines:hover': { color: '#aaa' },
    // The package marks changed/deleted text with a 2px bottom gradient — it reads
    // as an underline. Replace it with a full solid background: green for
    // insertions, red for deletions, the way a diff normally shades text.
    '.cm-changedText': { background: 'rgba(34,197,94,0.28)' },
    '.cm-deletedChunk .cm-deletedText, .cm-deletedText': { background: 'rgba(239,68,68,0.30)' },
  },
  { dark: true },
)

export function DiffView({ before, after }: { before: string; after: string }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (host.current === null) return
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: after,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          editorTheme,
          diffTheme,
          unifiedMergeView({
            original: before,
            mergeControls: false,
            allowInlineDiffs: true,
            gutter: true,
            collapseUnchanged: { margin: 2 },
          }),
        ],
      }),
    })
    return () => view.destroy()
  }, [before, after])

  return <div ref={host} className="h-full overflow-auto text-[11px]" />
}
