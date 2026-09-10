import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { markdownTableAutocompleter, markdownTables } from 'codemirror-markdown-tables'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { selectNextOccurrence } from '@codemirror/search'
import { drawSelection, dropCursor, EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { EditorState, type Extension } from '@codemirror/state'
import { fenceLanguage } from './fence-languages'
import { formattingKeymap } from './formatting'
import { linkClickHandler, type LinkNav } from './links'
import { askAgentTooltip } from './askAgent'
import { frontmatterExtension } from './frontmatter'
import { mermaidExtension } from './mermaid'
import { languageForPath, validityStatus } from './languages'
import { headingSlide } from './heading-slide'
import {
  docExistsFacet,
  inlineOnlyFacet,
  livePreview,
  notePathFacet,
  taskByPathFacet,
  type TaskChip,
} from './livePreview'
import { mentionSource, type MentionData } from './mentions'
import { alphaListKeymap } from './lists'
import { slashCommands } from './slash'
import { wikiHoverPreview, type ReadNote } from './wikiHover'
import { colorModeAware } from './color-mode'
import { codeHighlighting, editorTheme, markdownHighlighting, notesFontTheme } from './theme'

/** Live seams the editor pulls on demand (the docExistsFacet pattern — closures
 * over the renderer's atoms, read when the user triggers `@`, never baked in). */
export interface EditorDeps {
  docExists: (path: string) => boolean
  /** Title + status for a `[[path]]` chip whose path is a task, else null. */
  taskByPath: (path: string) => TaskChip | null
  /** Reads a note's text for the hover preview; null when the target is missing. */
  readNote: ReadNote
  /** Notes + tasks for `@`-mention completion (FR-8). */
  mentionData: () => MentionData
  /** Where a clicked link goes (FR-6/FR-7). */
  nav: () => LinkNav
  /** Hand the current selection to the agent as a seeded turn (#5). On
   *  `EditorDeps` rather than on a facet because only `baseEditorExtensions`
   *  takes these: the mail composer is a separate stack precisely so that it
   *  knows nothing about a vault, and a seeded vault prompt is exactly the kind
   *  of thing it must not grow. */
  askAgent: (prompt: string) => void
  /** The open note's vault path, for note-relative image resolution. */
  notePath: string
  /** The document is locked — a reconcile is resolving this file
   *  (`prd/vaults-sync.md` FR-19). Both halves are needed: `readOnly` stops the
   *  commands, `editable` stops the caret, and a caret in a document that
   *  silently swallows input reads as a broken editor rather than a locked one. */
  readOnly?: boolean
}

/**
 * The trimmed stack (notes-editor PRD FR-1).
 *
 * **CodeMirror's own history is back.** It was deliberately absent while
 * `Y.UndoManager` owned undo, and the CRDT went with D60 — so without this,
 * ⌘Z did nothing at all. Whether an external reload should be undoable is a
 * separate question, and it is settled: it should not be. `lib/apply-reload.ts`
 * dispatches a reload with `addToHistory:false`, so ⌘Z unwinds your keystrokes
 * rather than backing out a co-author's text (`notes-editor.md` §Undo).
 *
 * One shared `autocompletion` instance hosts every completion source.
 */
export function baseEditorExtensions(deps: EditorDeps): Extension[] {
  return [
    EditorState.readOnly.of(deps.readOnly === true),
    EditorView.editable.of(deps.readOnly !== true),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    indentUnit.of('    '),
    EditorView.lineWrapping,
    // GFM base — the codemirror-markdown-tables widget needs the Lezer GFM Table
    // grammar in the tree; plain markdown() defaults to CommonMark (no tables).
    // `codeLanguages` is what makes a ```python fence parse as python instead of
    // as text: without it the body has no tokens to colour and the block renders
    // as one flat grey slab (fence-languages.ts).
    markdown({ base: markdownLanguage, codeLanguages: fenceLanguage }),
    // …and this is what colours those tokens. It used to be in the plain stack
    // only, on the reasoning that the markdown editor paints itself with
    // live-preview decorations rather than through the highlight pipeline —
    // true of markdown's OWN syntax, and false of the code nested inside it.
    // The one overlap is `processingInstruction`: markdown's `#`/`**` marks now
    // take the punctuation grey, and only on the active line, since livePreview
    // conceals them everywhere else.
    codeHighlighting,
    docExistsFacet.of(deps.docExists),
    taskByPathFacet.of(deps.taskByPath),
    notePathFacet.of(deps.notePath),
    // Select a passage, press one button, and the agent opens knowing which note
    // and which lines you meant (#5). The notes stack only.
    askAgentTooltip(deps.notePath, deps.askAgent),
    livePreview,
    // The caret's half of the heading slide: the transition is CSS, and
    // CodeMirror has to be told to measure again while it runs.
    headingSlide,
    // After livePreview: the block-replace owns the frontmatter region, and
    // livePreview is told to skip it (FR-2 hide / FR-16 reveal).
    frontmatterExtension,
    // Also a StateField, and for the same reason as the line above: CodeMirror
    // refuses block decorations from a plugin. ```mermaid draws as a diagram
    // (#6).
    mermaidExtension,
    linkClickHandler(deps.nav),
    wikiHoverPreview(deps.readNote),
    // The document's own markdown tags, so a rendered table's cells read as
    // prose (#11). Everything else in this stack styles the body through
    // decorations; a cell is reached only by a HighlightStyle, and `theme.ts`
    // says why.
    markdownHighlighting,
    // Nested in-cell editors mutate the same doc — verify live that these
    // transactions compose with yCollab (FR-10 risk), no binding bypass.
    //
    // A cell that has been CLICKED INTO gets a real editor, and it is given the
    // inline half of this stack so that editing a cell behaves like editing
    // anywhere else (#11). It has to be built here rather than at module scope
    // because `livePreview` reads three facets off `deps`: unwired, a wiki-link
    // in a cell would claim a missing note exists and a task chip would never
    // appear.
    //
    // `markdownHighlighting` is deliberately NOT among them: the plugin already
    // hands both the unfocused cell and the cell editor the ROOT editor's
    // highlighter, so passing it again would be a third copy of the same classes.
    markdownTables({
      extensions: [
        inlineOnlyFacet.of(true),
        docExistsFacet.of(deps.docExists),
        notePathFacet.of(deps.notePath),
        taskByPathFacet.of(deps.taskByPath),
        livePreview,
      ],
    }),
    autocompletion({
      override: [mentionSource(deps.mentionData), slashCommands, markdownTableAutocompleter()],
    }),
    // Code-editor keys. Multi-cursor is off by default — enable it so ⌘D's
    // next-occurrence selections actually stack instead of collapsing to one.
    EditorState.allowMultipleSelections.of(true),
    formattingKeymap, // ⌘B / ⌘I / ⌘E / ⌘K / ⌘⇧X — higher precedence than defaults
    // `markdown()` installs its own Enter, which continues every list the
    // parser knows. This one continues `a.` / `A.` / `a)`, which it does not.
    alphaListKeymap,
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
    // …and which of `editorTheme`'s two halves CodeMirror should wear.
    colorModeAware(),
    // Notes only. The mail composer and the plain/code editor take `editorTheme`
    // alone and stay mono — see `notesFontTheme`.
    notesFontTheme,
  ]
}

/**
 * The editor stack for writing a mail (D71).
 *
 * **`baseEditorExtensions` cannot be reused, and not merely for convenience.**
 * It takes `docExists`, `taskByPath`, `readNote`, `mentionData`, `nav` and
 * `notePath` — all vault machinery a composer has no access to and no business
 * having. More to the point, its markdown layers are *about the vault*:
 * `[[wiki links]]` mean nothing to a recipient, and `@`-mention completion
 * would paste vault paths into an email.
 *
 * So this is a third stack rather than a parameterised second one. What it
 * keeps is everything that makes markdown pleasant to type — history, bracket
 * matching, line wrapping, GFM tables and ⌘B/⌘I/⌘K — and nothing that knows a
 * vault exists.
 */
export function mailComposerExtensions(): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    indentUnit.of('    '),
    EditorView.lineWrapping,
    // Same GFM base as the notes editor: the table widget needs the Lezer GFM
    // Table grammar in the tree, which plain markdown() (CommonMark) omits.
    // Fences highlight here too — quoting code at someone is a thing people do
    // in mail, and the composer is the same markdown editor with the vault
    // machinery taken out, not a lesser one.
    markdown({ base: markdownLanguage, codeLanguages: fenceLanguage }),
    codeHighlighting,
    markdownTables(),
    // Table completion only. No `mentionSource` — `@` is how you type an email
    // address — and no `slashCommands`, whose commands are all vault actions.
    autocompletion({ override: [markdownTableAutocompleter()] }),
    EditorState.allowMultipleSelections.of(true),
    formattingKeymap,
    keymap.of([
      ...completionKeymap,
      { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
      indentWithTab,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    editorTheme,
    // …and which of `editorTheme`'s two halves CodeMirror should wear.
    colorModeAware(),
  ]
}

/**
 * The editor stack for a plain (non-markdown) text file — a `.json`, `.csv`,
 * `.env` and the like (spec §Arbitrary files). Same theme and editing keymap as
 * the notes editor, but NONE of the markdown-specific layers: no live-preview
 * decorations, no frontmatter widget, no wiki-link chips, no `@`/slash/table
 * completion, no ⌘B-style markdown formatting. It is just text.
 *
 * `languageForPath` adds syntax highlighting (and, for JSON, a validity linter)
 * when the extension is a known config/shell format; otherwise it is empty and
 * the file renders as undecorated text.
 */
export function plainTextExtensions(path: string, readOnly = false): Extension[] {
  return [
    // FR-19 reaches the plain stack too: a conflicted `.holi/settings/app.json` or
    // `.gitignore` is at least as common as conflicted prose.
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    ...languageForPath(path),
    validityStatus(path),
    codeHighlighting,
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
    // …and which of `editorTheme`'s two halves CodeMirror should wear.
    colorModeAware(),
  ]
}
