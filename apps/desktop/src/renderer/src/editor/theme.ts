import { EditorView } from '@codemirror/view'

export const editorTheme = EditorView.baseTheme({
  '&': { height: '100%', fontSize: '14px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SF Mono, monospace', lineHeight: '1.6' },
  '.cm-content': { padding: '16px 0', maxWidth: '48rem', margin: '0 auto', caretColor: '#e5e5e5' },

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
  '.cm-md-link': { color: '#7dd3fc', textDecoration: 'underline', cursor: 'pointer' },

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
  // A task chip is a different destination (the board, not a note), so it reads as a
  // different thing — same shape, its own hue, and the board's own amber.
  '.cm-wikilink-task': { background: 'rgba(251,191,36,0.12)', color: '#fbbf24' },
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
})
