import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { markdownTableAutocompleter, markdownTables } from 'codemirror-markdown-tables'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { selectNextOccurrence } from '@codemirror/search'
import { drawSelection, dropCursor, EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { EditorState, type Extension } from '@codemirror/state'
import { formattingKeymap } from './formatting'
import { linkClickHandler, type LinkNav } from './links'
import { frontmatterExtension } from './frontmatter'
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

/**
 * The trimmed stack (notes-editor PRD FR-1).
 *
 * **CodeMirror's own history is back.** It was deliberately absent while
 * `Y.UndoManager` owned undo, and the CRDT went with D60 — so without this,
 * ⌘Z did nothing at all. Whether an external reload should be undoable is a
 * separate and still-open question (`notes-editor.md` §Open question 3): a
 * `merge3` result arriving as one big change is undoable here, which is not
 * obviously right, but silently having no undo is obviously wrong.
 *
 * One shared `autocompletion` instance hosts every completion source.
 */
export function baseEditorExtensions(deps: EditorDeps): Extension[] {
  return [
    history(),
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
    // After livePreview: the block-replace owns the frontmatter region, and
    // livePreview is told to skip it (FR-2 hide / FR-16 reveal).
    frontmatterExtension,
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
      // Before defaultKeymap, which binds Mod-z to a no-op undo when no history
      // extension is present — the shape this file shipped in while the CRDT
      // owned undo.
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    editorTheme,
  ]
}

/**
 * The editor stack for a plain (non-markdown) text file — a `.json`, `.csv`,
 * `.env` and the like (spec §Arbitrary files). Same theme and editing keymap as
 * the notes editor, but NONE of the markdown-specific layers: no live-preview
 * decorations, no frontmatter widget, no wiki-link chips, no `@`/slash/table
 * completion, no ⌘B-style markdown formatting. It is just text.
 */
export function plainTextExtensions(): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    indentUnit.of('    '),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    keymap.of([
      { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
      indentWithTab,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    editorTheme,
  ]
}
