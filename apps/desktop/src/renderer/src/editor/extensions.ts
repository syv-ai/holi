import { completionKeymap } from '@codemirror/autocomplete'
import { markdownTableAutocompleter, markdownTables } from 'codemirror-markdown-tables'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { emptyTaskMarker } from './empty-task'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { selectNextOccurrence } from '@codemirror/search'
import {
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
  placeholder,
  tooltips,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { holiCompletion } from './completion'
import { fenceLanguage } from './fence-languages'
import { findInFile, findKeymap } from './find'
import { formattingKeymap } from './formatting'
import { linkClickHandler, type LinkNav } from './links'
import { askAgentTooltip, commentSeamFacet, type AskAgentSeam, type CommentSeam } from './askAgent'
import { commentThreads } from './comment-threads'
import { frontmatterAlwaysOpenFacet, frontmatterExtension } from './frontmatter'
import { mermaidExtension } from './mermaid'
import { commentExtension } from './comments'
import { languageForPath, validityStatus } from './languages'
import { settingsCompletion } from './settings-completion'
import { markSlide } from './mark-slide'
import {
  docExistsFacet,
  inlineOnlyFacet,
  livePreview,
  linkChipFacet,
  notePathFacet,
  type LinkChip,
} from './livePreview'
import { mentionSource, type MentionData } from './mentions'
import { memberMentionSource } from './member-mentions'
import { alphaListKeymap, alphaLists, listKindByTyping, renumberOrderedLists } from './lists'
import { arrowsByTyping } from './arrows'
import { slashCommandsWith, tableSizes, type SlashCommand } from './slash'
import { wikiHoverPreview, type ReadNote } from './wikiHover'
import { colorModeAware } from './color-mode'
import { codeHighlighting, editorTheme, markdownHighlighting, notesFontTheme } from './theme'

/**
 * A note's column is centred in the pane it is in, whatever is beside it. The
 * child combinators keep it to the editor's own column: the properties widget
 * nests a whole CodeMirror, whose column must not centre.
 */
const noteColumn = EditorView.theme({
  '& > .cm-scroller > .cm-content': { marginInline: 'auto' },
})

/** Live seams the editor pulls on demand: closures over the renderer's state,
 * read when needed rather than baked in, so new data never rebuilds the view. */
export interface EditorDeps {
  docExists: (path: string) => boolean
  /** How a `[[path]]` to a claimed file (a task) is drawn, else null: a note
   *  chip. */
  linkChip?: (path: string) => LinkChip | null
  /** Reads a note's text for the hover preview; null when the target is missing. */
  readNote: ReadNote
  /** Notes, and what claims offer, for `@`-mention completion. */
  mentionData: () => MentionData
  /** Where a clicked link goes. */
  nav: () => LinkNav
  /** Hand the current selection to one of the vault's agent sessions.
   *  Absent with no agent, and then there is no button. */
  askAgent?: AskAgentSeam
  /** The slash commands the running plugins add, read each time the menu
   *  opens. */
  slashCommands?: () => readonly SlashCommand[]
  /** Open a comment thread on the selection. Absent where a note's threads
   *  are not shown (a task's description), and then there is no button and
   *  no marks. */
  comment?: CommentSeam
  /** The open note's vault path, for note-relative image resolution. */
  notePath: string
  /** The document is locked while a reconcile resolves this file
   *  (docs/features/vaults-sync.md). Both halves are needed: `readOnly` stops
   *  the commands, `editable` stops the caret, since a caret that swallows input
   *  reads as a broken editor. */
  readOnly?: boolean
  /** The note's properties bar; off for text that is not a note (a task's
   *  description, whose file's frontmatter is the task's own). */
  frontmatter?: boolean
  /** The properties bar has no collapsed state (`ClaimFrontmatter.alwaysOpen`). */
  frontmatterAlwaysOpen?: boolean
  /** What the file's claim adds to the editor (`ClaimEditor.extensions`). */
  claimExtensions?: Extension
  /** What running plugins add to every note (`RendererPlugin.editorExtensions`). */
  pluginExtensions?: Extension
}

/** What the file's claim brings: its frontmatter mode and its own layer, and
 *  what running plugins add to every note. A compartment, so a plugin turned
 *  on or off reaches a view already open. */
const claimLayer = new Compartment()

/** The note's comment threads and the selection's Comment button. Whether a
 *  note takes threads follows its claim too (`isCommentableNote`), so this is
 *  a compartment for the same reason. */
const commentLayer = new Compartment()

type ClaimLayer = Pick<
  EditorDeps,
  'frontmatterAlwaysOpen' | 'claimExtensions' | 'pluginExtensions' | 'comment'
>

function claimLayerOf(deps: ClaimLayer): Extension {
  return [
    frontmatterAlwaysOpenFacet.of(deps.frontmatterAlwaysOpen === true),
    deps.claimExtensions ?? [],
    deps.pluginExtensions ?? [],
  ]
}

function commentLayerOf(deps: ClaimLayer): Extension {
  if (deps.comment === undefined) return []
  // The selection's Comment button, and the passages the threads are about.
  return [commentSeamFacet.of(deps.comment), commentThreads]
}

/** Swap an open view's claim and comment layers for the file's claim now,
 *  caret and undo kept. A view without them (a plain-text file) is left
 *  alone. */
export function reconfigureClaimLayer(view: EditorView, deps: ClaimLayer): void {
  if (claimLayer.get(view.state) === undefined) return
  view.dispatch({
    effects: [
      claimLayer.reconfigure(claimLayerOf(deps)),
      commentLayer.reconfigure(commentLayerOf(deps)),
    ],
  })
}

/**
 * The notes editor stack.
 *
 * An external reload is not undoable: `lib/apply-reload.ts` dispatches it with
 * `addToHistory:false`, so ⌘Z unwinds your keystrokes rather than backing out
 * someone else's text.
 *
 * Every completion source is hosted by one `holiCompletion`, the renderer's
 * only caller of CodeMirror's autocompletion (guarded by
 * `test/completion.test.ts`).
 */
export function baseEditorExtensions(deps: EditorDeps): Extension[] {
  const slash = slashCommandsWith(deps.slashCommands ?? (() => []), deps.notePath)
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
    // GFM base: the table widget needs the GFM Table grammar, which plain
    // markdown() (CommonMark) omits. `codeLanguages` parses fenced code in its
    // own language (fence-languages.ts).
    markdown({
      base: markdownLanguage,
      codeLanguages: fenceLanguage,
      extensions: [emptyTaskMarker, alphaLists],
    }),
    // Colours the code nested in fences. Overlap: markdown's `#`/`**` marks take
    // the punctuation grey, visible only on the active line.
    codeHighlighting,
    docExistsFacet.of(deps.docExists),
    linkChipFacet.of(deps.linkChip ?? (() => null)),
    notePathFacet.of(deps.notePath),
    // Outside the comment layer, so a claim change keeps an open ask open.
    askAgentTooltip(deps.notePath, deps.askAgent),
    commentLayer.of(commentLayerOf(deps)),
    livePreview,
    // The caret's half of a mark's slide: the transition is CSS, and the
    // drawn caret has to be moved along while it runs.
    markSlide,
    // After livePreview: the block-replace owns the frontmatter region, and
    // livePreview skips it.
    deps.frontmatter === false ? [] : frontmatterExtension,
    // Also a StateField: CodeMirror refuses block decorations from a plugin.
    mermaidExtension,
    // `<!-- … -->` on its own lines, as a banner. A StateField for the same reason.
    commentExtension,
    linkClickHandler(deps.nav),
    wikiHoverPreview(deps.readNote),
    // Styles a rendered table's cells, which only a HighlightStyle reaches
    // (see `theme.ts`).
    markdownHighlighting,
    // A focused cell gets a real editor with the inline half of this stack.
    // Built here, not at module scope, because `livePreview` reads three facets
    // off `deps`. `markdownHighlighting` is not repeated: the plugin already
    // hands cells the root editor's highlighter.
    markdownTables({
      extensions: [
        inlineOnlyFacet.of(true),
        docExistsFacet.of(deps.docExists),
        notePathFacet.of(deps.notePath),
        linkChipFacet.of(deps.linkChip ?? (() => null)),
        livePreview,
      ],
    }),
    holiCompletion([
      mentionSource(deps.mentionData),
      slash.source,
      tableSizes,
      markdownTableAutocompleter(),
    ]),
    slash.extension,
    // Multi-cursor is off by default; ⌘D's next-occurrence selections need it.
    EditorState.allowMultipleSelections.of(true),
    formattingKeymap, // ⌘B / ⌘I / ⌘E / ⌘K / ⌘⇧X — higher precedence than defaults
    // `markdown()`'s Enter continues decimal and bullet lists; this one
    // continues `a.` / `A.` / `a)`, which it cannot write.
    alphaListKeymap,
    // Tab, Enter and Backspace inside an ordered list keep its numbers right.
    renumberOrderedLists,
    // `1. a.` in a list's empty first item makes it a letter list, and back.
    listKindByTyping,
    // ` -> ` becomes ` → ` in the file, its own undo step.
    arrowsByTyping,
    // ⌘F / ⌘⌥F: find and replace in this file, with the app's own bar.
    findInFile(),
    keymap.of([
      ...completionKeymap,
      // After completion, so Escape closes an open popup before the bar.
      ...findKeymap,
      // ⌘D: select the word, then each press adds the next matching occurrence.
      { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
      indentWithTab, // Tab indents the line/selection, ⇧Tab dedents
      // Before defaultKeymap.
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    editorTheme,
    // …and which of `editorTheme`'s two halves CodeMirror should wear.
    colorModeAware(),
    // Notes only; the other stacks stay mono (see `notesFontTheme`).
    notesFontTheme,
    noteColumn,
    claimLayer.of(claimLayerOf(deps)),
  ]
}

/**
 * Markdown typing comforts with nothing that knows a vault exists, for text
 * that leaves the vault (a mail, written in the Google plugin). A separate
 * stack, not a parameterised notes stack: its markdown layers are about the
 * vault, and `[[wiki links]]` or `@`-mentions would paste vault paths into it.
 */
export function plainMarkdownExtensions(): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    indentUnit.of('    '),
    EditorView.lineWrapping,
    // Same GFM base as the notes editor, fences highlighted too.
    markdown({
      base: markdownLanguage,
      codeLanguages: fenceLanguage,
      extensions: emptyTaskMarker,
    }),
    codeHighlighting,
    markdownTables(),
    // Table completion only: `@` types an email address here.
    holiCompletion([markdownTableAutocompleter()]),
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
 * The editor stack for a plain (non-markdown) text file such as `.json`,
 * `.csv` or `.env`. Same theme and editing keys as the notes editor, none of
 * the markdown layers. `languageForPath` adds highlighting (and a validity
 * check) for known formats.
 */
export function plainTextExtensions(path: string, readOnly = false): Extension[] {
  return [
    // Reconcile locking applies here too: a conflicted `.gitignore` or
    // `.holi/settings/app.yaml` is as common as conflicted prose.
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    ...languageForPath(path),
    // Settings keys and their values, from the schema. Colour swatches come
    // from `languageForPath`'s CSS support.
    ...settingsCompletion(path),
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
    findInFile(),
    keymap.of([
      // First: Enter, Tab and the arrows are bound further down, and the popup
      // would appear but be unusable.
      ...completionKeymap,
      ...findKeymap,
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

/** What a comment field is told to do: its people, and its two keys. */
export interface CommentFieldDeps {
  /** Who `@` offers, read on each `@`. */
  logins: () => readonly string[]
  placeholder: string
  /** ⌘↵. */
  submit: () => void
  /** Escape, once the popup (if any) is closed. */
  cancel?: () => void
}

/**
 * A comment's text field (the comments panel's composer and reply): plain
 * text in the app's own face, with `@login` completion of the vault's people
 * through the one completion popup. No markdown layers: a comment's body is
 * shown as it was typed.
 */
export function commentFieldExtensions(deps: CommentFieldDeps): Extension[] {
  return [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    placeholder(deps.placeholder),
    holiCompletion([memberMentionSource(deps.logins)]),
    // On the body, not in the panel: the drawer scrolls and clips, and the
    // popup must not be cut off at its edge.
    tooltips({ parent: document.body }),
    keymap.of([
      // First, so Enter and Escape act on an open popup before the field.
      ...completionKeymap,
      {
        key: 'Mod-Enter',
        run: () => {
          deps.submit()
          return true
        },
      },
      {
        key: 'Escape',
        run: () => {
          if (deps.cancel === undefined) return false
          deps.cancel()
          return true
        },
      },
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    editorTheme,
    colorModeAware(),
    commentFieldTheme,
  ]
}

/** The field sits in a panel, not a pane: the panel's face and size, and
 *  none of the notes column's inset. */
const commentFieldTheme = EditorView.theme({
  '&': { height: 'auto', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.5' },
  '.cm-content': { padding: '0', caretColor: 'var(--foreground)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-cursor-primary': { borderLeftColor: 'var(--foreground)' },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
})
