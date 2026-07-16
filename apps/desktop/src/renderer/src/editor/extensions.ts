import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { markdownTableAutocompleter, markdownTables } from 'codemirror-markdown-tables'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { selectNextOccurrence } from '@codemirror/search'
import { drawSelection, dropCursor, EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { EditorState, type Extension } from '@codemirror/state'
import { formattingKeymap } from './formatting'
import { linkClickHandler, type LinkNav } from './links'
import { docExistsFacet, livePreview, taskInfoFacet, type TaskChipInfo } from './livePreview'
import { mentionSource, type MentionData } from './mentions'
import { slashCommands } from './slash'
import { editorTheme } from './theme'

/** Live seams the editor pulls on demand (the docExistsFacet pattern — closures
 * over the renderer's atoms, read when the user triggers `@`, never baked in). */
export interface EditorDeps {
  docExists: (path: string) => boolean
  /** Title + tombstone for a `[[task:<id>]]` chip (D27). */
  taskInfo: (id: string) => TaskChipInfo
  /** Notes + tasks for `@`-mention completion (FR-8). */
  mentionData: () => MentionData
  /** A picked task mention links the current note into the task's `related[]`. */
  onTaskMention: (taskId: string) => void
  /** Where a clicked link goes (FR-6/FR-7). */
  nav: () => LinkNav
}

/** The trimmed stack (notes-editor PRD FR-1) minus what other tasks add
 * (yCollab arrives per-doc in EditorPane). CM history is intentionally absent
 * — Y.UndoManager owns undo (FR-4). One shared `autocompletion` instance hosts
 * every completion source (mentions now; slash + tables join it). */
export function baseEditorExtensions(deps: EditorDeps): Extension[] {
  return [
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    indentUnit.of('    '),
    EditorView.lineWrapping,
    // GFM base — the codemirror-markdown-tables widget needs the Lezer GFM Table
    // grammar in the tree; plain markdown() defaults to CommonMark (no tables).
    markdown({ base: markdownLanguage }),
    docExistsFacet.of(deps.docExists),
    taskInfoFacet.of(deps.taskInfo),
    livePreview,
    linkClickHandler(deps.nav),
    // Nested in-cell editors mutate the same doc — verify live that these
    // transactions compose with yCollab (FR-10 risk), no binding bypass.
    markdownTables(),
    autocompletion({
      override: [
        mentionSource(deps.mentionData, deps.onTaskMention),
        slashCommands,
        markdownTableAutocompleter(),
      ],
    }),
    // Code-editor keys. Multi-cursor is off by default — enable it so ⌘D's
    // next-occurrence selections actually stack instead of collapsing to one.
    EditorState.allowMultipleSelections.of(true),
    formattingKeymap, // ⌘B / ⌘I / ⌘E / ⌘K / ⌘⇧X — higher precedence than defaults
    keymap.of([
      ...completionKeymap,
      // ⌘D: select the word, then each press adds the next matching occurrence.
      { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
      indentWithTab, // Tab indents the line/selection, ⇧Tab dedents
      ...defaultKeymap,
    ]),
    editorTheme,
  ]
}
