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
