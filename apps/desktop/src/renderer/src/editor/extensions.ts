import { completionKeymap } from '@codemirror/autocomplete'
import { markdownTableAutocompleter, markdownTables } from 'codemirror-markdown-tables'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { emptyTaskMarker } from './empty-task'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { selectNextOccurrence } from '@codemirror/search'
import { drawSelection, dropCursor, EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { EditorState, type Extension } from '@codemirror/state'
import { holiCompletion } from './completion'
import { fenceLanguage } from './fence-languages'
import { formattingKeymap } from './formatting'
import { languageForPath, validityStatus } from './languages'
import { settingsCompletion } from './settings-completion'
import { colorModeAware } from './color-mode'
import { codeHighlighting, editorTheme } from './theme'

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
    keymap.of([
      // First: Enter, Tab and the arrows are bound further down, and the popup
      // would appear but be unusable.
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
