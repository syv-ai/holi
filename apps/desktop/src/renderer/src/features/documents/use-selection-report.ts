import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import type { Editor } from '@tiptap/react'

import { editorSelectionAtom } from '@/state/ui-report'

import { selectionLines } from './document-comments'

// How long a selection holds still before its lines are worked out.
const SELECTION_DELAY_MS = 250

/** `head` is the frontmatter and anything else the editor does not hold. */
export function useSelectionReport(
  editor: Editor | null,
  path: string,
  head: React.RefObject<string>,
): void {
  // The lines selected, for the agent's per-turn context: worked out once
  // the selection holds still, since it serialises the document. A caret
  // clears what this document reported, never another's.
  const setEditorSelection = useSetAtom(editorSelectionAtom)
  useEffect(() => {
    if (!editor) return
    let timer: number | undefined
    const report = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (editor.isDestroyed) return
        const lines = selectionLines(editor, head.current)
        setEditorSelection((was) => {
          if (lines === null) return was?.path === path ? null : was
          const same =
            was?.path === path &&
            was.lines.startLine === lines.startLine &&
            was.lines.endLine === lines.endLine
          return same ? was : { path, lines }
        })
      }, SELECTION_DELAY_MS)
    }
    editor.on('selectionUpdate', report)
    return () => {
      editor.off('selectionUpdate', report)
      window.clearTimeout(timer)
    }
  }, [editor, path, head, setEditorSelection])
}
