import { markdown } from '@codemirror/lang-markdown'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { drawSelection, dropCursor, EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import type { Extension } from '@codemirror/state'
import { formattingKeymap } from './formatting'
import { docExistsFacet, livePreview } from './livePreview'
import { editorTheme } from './theme'

/** The trimmed stack (notes-editor PRD FR-1) minus what other tasks add
 * (yCollab arrives per-doc in EditorPane). CM history is intentionally absent
 * — Y.UndoManager owns undo (FR-4). */
export function baseEditorExtensions(docExists: (path: string) => boolean): Extension[] {
  return [
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    indentUnit.of('    '),
    EditorView.lineWrapping,
    markdown(),
    docExistsFacet.of(docExists),
    livePreview,
    formattingKeymap,
    keymap.of([...defaultKeymap, indentWithTab]),
    editorTheme,
  ]
}
