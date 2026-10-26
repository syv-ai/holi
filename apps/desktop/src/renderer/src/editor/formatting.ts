/**
 * Toggle-aware inline formatting. Pure functions over EditorState →
 * TransactionSpec so they are headless-testable; the keymap wraps them as
 * commands.
 */
import type { EditorState, TransactionSpec } from '@codemirror/state'
import { keymap } from '@codemirror/view'

/** @public exported for its test */
export function toggleInline(state: EditorState, marker: string): TransactionSpec | null {
  const sel = state.selection.main
  let { from, to } = sel
  if (from === to) {
    const word = state.wordAt(from)
    if (!word) return null
    from = word.from
    to = word.to
  }
  const len = marker.length
  const before = state.sliceDoc(Math.max(0, from - len), from)
  const after = state.sliceDoc(to, Math.min(state.doc.length, to + len))
  const inner = state.sliceDoc(from, to)

  if (before === marker && after === marker) {
    // **|hello|** → strip surrounding markers
    return {
      changes: [
        { from: from - len, to: from },
        { from: to, to: to + len },
      ],
      selection: { anchor: from - len, head: to - len },
    }
  }
  if (inner.startsWith(marker) && inner.endsWith(marker) && inner.length >= 2 * len) {
    // |**hello**| → strip markers inside the selection
    return {
      changes: { from, to, insert: inner.slice(len, inner.length - len) },
      selection: { anchor: from, head: to - 2 * len },
    }
  }
  return {
    changes: [
      { from, insert: marker },
      { from: to, insert: marker },
    ],
    selection: { anchor: from + len, head: to + len },
  }
}

/** @public exported for its test */
export function toggleLink(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main
  if (sel.empty) return null
  const text = state.sliceDoc(sel.from, sel.to)
  const insert = `[${text}](url)`
  const urlStart = sel.from + text.length + 3 // past "[text]("
  return {
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: urlStart, head: urlStart + 3 },
  }
}

/** Handled even with nothing to wrap: in the editor these keys are always the
 *  editor's, so ⌘B with the caret between words does not fall through to the
 *  sidebar's ⌘B (`state/commands.ts`). */
function run(marker: string) {
  return (view: { state: EditorState; dispatch(spec: TransactionSpec): void }): boolean => {
    const spec = toggleInline(view.state, marker)
    if (spec) view.dispatch(spec)
    return true
  }
}

/** ⌘/Ctrl-B bold, ⌘I italic, ⌘E inline code, ⌘K link, ⌘⇧X or ⌘⇧S
 *  strikethrough (⌘⇧S is ReUI's and Tiptap's). */
export const formattingKeymap = keymap.of([
  { key: 'Mod-b', run: run('**') },
  { key: 'Mod-i', run: run('*') },
  { key: 'Mod-e', run: run('`') },
  { key: 'Mod-Shift-x', run: run('~~') },
  { key: 'Mod-Shift-s', run: run('~~') },
  {
    key: 'Mod-k',
    run: (view) => {
      const spec = toggleLink(view.state)
      if (!spec) return false
      view.dispatch(spec)
      return true
    },
  },
])

// ─────────────────────────────────────────────────────────────────────────────
// Links, as the bubble's link field edits them (after ReUI's `rich-text-link`)
// ─────────────────────────────────────────────────────────────────────────────

const BARE_DOMAIN = /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/

/** A markdown `[text](url)` around a position: its range, its text and its address. */
interface LinkRange {
  from: number
  to: number
  textFrom: number
  textTo: number
  urlFrom: number
  urlTo: number
  url: string
}

const INLINE_LINK = /\[((?:[^\]\\]|\\.)*)\]\(([^()\s]*)\)/g

/** The inline link holding `[from, to]`, read off the line rather than the tree
 *  so a link inside a table cell's source reads the same. */
function linkAt(state: EditorState, from: number, to = from): LinkRange | null {
  const line = state.doc.lineAt(from)
  if (to > line.to) return null
  for (const m of line.text.matchAll(INLINE_LINK)) {
    const start = line.from + m.index
    const end = start + m[0].length
    if (start > from || end < to) continue
    // `![alt](src)` is an image, not a link.
    if (m.index > 0 && line.text[m.index - 1] === '!') continue
    const textFrom = start + 1
    const textTo = textFrom + m[1]!.length
    const urlFrom = textTo + 2
    return {
      from: start,
      to: end,
      textFrom,
      textTo,
      urlFrom,
      urlTo: urlFrom + m[2]!.length,
      url: m[2]!,
    }
  }
  return null
}
