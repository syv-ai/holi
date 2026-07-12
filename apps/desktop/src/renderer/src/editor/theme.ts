import { EditorView } from '@codemirror/view'

export const editorTheme = EditorView.baseTheme({
  '&': { height: '100%', fontSize: '14px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SF Mono, monospace', lineHeight: '1.6' },
  '.cm-content': { padding: '16px 0', maxWidth: '48rem', margin: '0 auto', caretColor: '#e5e5e5' },

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
  '.cm-wikilink-missing': { color: '#f0abfc', background: 'rgba(240,171,252,0.10)' },

  // remote cursors (y-codemirror.next)
  '.cm-ySelectionInfo': { fontSize: '10px', padding: '0 3px', borderRadius: '3px' },
})
