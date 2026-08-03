import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'

export const editorTheme = EditorView.baseTheme({
  '&': { height: '100%', fontSize: '14px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SF Mono, monospace', lineHeight: '1.6' },
  /**
   * Left-aligned, NOT centred (`margin: 0 auto` was here and is deliberately
   * gone).
   *
   * A centred column moves its own centre whenever the pane resizes, so opening
   * the right sidebar slid the text you were reading 88px to the left — the
   * editor is supposed to get *narrower*, not shift. Anchoring the column to the
   * left makes the sidebar take width off the right-hand end only, and the words
   * under the caret stay where they were.
   *
   * The horizontal padding is the other half: with the pane narrower than the
   * column, `maxWidth` stops applying and the text ran flush to both edges.
   */
  '.cm-content': { padding: '16px 24px', maxWidth: '48rem', caretColor: '#e5e5e5' },

  // drawSelection() draws its own cursor and hides the native one, so caretColor
  // alone is invisible — the drawn cursor is a border-left element, style it.
  '.cm-cursor, .cm-cursor-primary': { borderLeftColor: '#e5e5e5', borderLeftWidth: '2px' },
  '.cm-selectionBackground': { background: 'rgba(125,211,252,0.20)' },
  '&.cm-focused .cm-selectionBackground': { background: 'rgba(125,211,252,0.28)' },

  // headings: size only — no extra margins, so render/un-render doesn't jump (FR-3b)
  '.cm-heading': { fontWeight: '600' },
  '.cm-heading-1': { fontSize: '1.5em' },
  '.cm-heading-2': { fontSize: '1.25em' },
  '.cm-heading-3': { fontSize: '1.1em' },

  '.cm-strong': { fontWeight: '700' },
  '.cm-emphasis': { fontStyle: 'italic' },
  '.cm-strikethrough': { textDecoration: 'line-through' },
  '.cm-inline-code': {
    background: 'rgba(255,255,255,0.08)',
    borderRadius: '3px',
    padding: '0 3px',
  },
  '.cm-code-line': { background: 'rgba(255,255,255,0.04)' },
  '.cm-quote-mark': { color: '#737373' },
  // No pointer by default: a markdown link is editable text and a plain click
  // places the caret — only ⌘/Ctrl-click navigates (links.ts). The cursor is
  // therefore gated on the modifier actually being held, so it never advertises
  // a click that does nothing. Wiki-link chips below keep theirs: a plain click
  // on one does navigate.
  '.cm-md-link': { color: '#7dd3fc', textDecoration: 'underline' },
  '&.cm-mod-held .cm-md-link': { cursor: 'pointer' },

  // compact HR (FR-3b: thin rule, minimal margins — not a chunky block)
  '.cm-hr': {
    borderTop: '1px solid #404040',
    margin: '0.3em 0',
    height: '1px',
  },

  '.cm-wikilink': {
    background: 'rgba(125,211,252,0.12)',
    color: '#7dd3fc',
    borderRadius: '4px',
    padding: '0 4px',
    cursor: 'pointer',
  },
  // A task chip reads as a task, not a note: same shape, the board's amber tint, and a
  // status orb before the title. `inline-flex` so the orb and title share a baseline row.
  '.cm-wikilink-task': {
    background: 'rgba(251,191,36,0.12)',
    color: '#fbbf24',
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '4px',
  },
  '.cm-task-orb': {
    display: 'inline-block',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    alignSelf: 'center',
  },
  '.cm-task-orb-todo': { background: '#6e7681' },
  '.cm-task-orb-doing': { background: '#d29922' },
  '.cm-task-orb-done': { background: '#3fb950' },
  // A done task strikes its title, matching the board card.
  '.cm-wikilink-done': { textDecoration: 'line-through', color: '#8b949e' },
  // Last: a missing target outranks the kind tint, for a note and a task alike.
  '.cm-wikilink-missing': { color: '#f0abfc', background: 'rgba(240,171,252,0.10)' },

  // remote cursors (y-codemirror.next)
  '.cm-ySelectionInfo': { fontSize: '10px', padding: '0 3px', borderRadius: '3px' },

  // autocomplete popover (mentions / slash / table) — dark, or CM's default light
  // tooltip renders our inherited light text white-on-white.
  '.cm-tooltip.cm-tooltip-autocomplete': {
    background: '#1f1f1f',
    border: '1px solid #404040',
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'inherit', maxHeight: '18em' },
  '.cm-tooltip-autocomplete > ul > li': { color: '#e5e5e5', padding: '2px 8px', lineHeight: '1.5' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: '#2563eb', color: '#ffffff' },
  '.cm-completionDetail': { color: '#a3a3a3', fontStyle: 'normal', marginLeft: '0.6em' },
  '.cm-completionMatchedText': { color: '#7dd3fc', textDecoration: 'none' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText': { color: '#e0f2fe' },

  // Validity status strip (plain/code editor). A bottom panel; strip CM's default
  // panel chrome so it reads as part of the dark editor, not a boxed toolbar.
  '.cm-panels, .cm-panels-bottom': { background: 'transparent', border: 'none' },
  '.cm-validity': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '0.4rem',
    padding: '3px 12px',
    borderTop: '1px solid #262626',
    fontFamily: 'ui-monospace, SF Mono, monospace',
    fontSize: '0.72rem',
    // Neutral while valid — the app's "quiet until wrong" cue, same as the
    // frontmatter chevron. `.cm-validity-invalid` reddens both dot and label.
    color: '#737373',
  },
  '.cm-validity-dot': {
    width: '7px',
    height: '7px',
    borderRadius: '9999px',
    background: '#737373',
  },
  '.cm-validity-invalid': { color: '#f87171' },
  '.cm-validity-invalid .cm-validity-dot': { background: '#f87171' },
})

/**
 * Token colours for the plain/code editor (`plainTextExtensions`).
 *
 * The markdown editor never needed this — it paints itself with the live-preview
 * decorations (`.cm-heading`, `.cm-strong`, …), not the highlight-tag pipeline —
 * so a language's parse tree produced tags that nothing coloured. This is the
 * missing `HighlightStyle`: it maps Lezer tags to the editor's existing dark
 * palette (sky for keys, green for strings, amber for literals). Legacy
 * StreamLanguage modes (toml/ini/shell) route through the same standard tags.
 */
const codeHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.operatorKeyword], color: '#f0abfc' },
  { tag: [t.propertyName, t.attributeName], color: '#7dd3fc' },
  { tag: [t.string, t.special(t.string)], color: '#86efac' },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal], color: '#fbbf24' },
  { tag: [t.typeName, t.className, t.tagName], color: '#93c5fd' },
  { tag: [t.variableName, t.definition(t.variableName)], color: '#e5e5e5' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#7dd3fc' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#737373', fontStyle: 'italic' },
  { tag: [t.escape, t.special(t.brace)], color: '#fbbf24' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: '#a3a3a3' },
  { tag: [t.meta, t.processingInstruction], color: '#a3a3a3' },
  { tag: t.invalid, color: '#f87171' },
])

/** The highlight extension to add to the plain/code stack. */
export const codeHighlighting = syntaxHighlighting(codeHighlightStyle)
