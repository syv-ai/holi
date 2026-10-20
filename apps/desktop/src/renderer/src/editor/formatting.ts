/**
 * Toggle-aware inline formatting. Pure functions over EditorState →
 * TransactionSpec so they are headless-testable; the keymap wraps them as
 * commands.
 */
import type { EditorState, TransactionSpec } from '@codemirror/state'
import { keymap } from '@codemirror/view'

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

/** A typed address as an href, or null when it is not a web, mail or phone
 *  link. A bare domain gets `https://`. */
export function normalizeHref(value: string): string | null {
  const href = value.trim()
  if (/^(https?:\/\/|mailto:|tel:)\S+$/i.test(href)) return href
  if (BARE_DOMAIN.test(href)) return `https://${href}`
  return null
}

/** A markdown `[text](url)` around a position: its range, its text and its address. */
export interface LinkRange {
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
export function linkAt(state: EditorState, from: number, to = from): LinkRange | null {
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

/**
 * Applies an address from the link field: a link the selection is in gets the
 * new address; selected text becomes a link; with nothing selected the address
 * is written as its own link text. `href` is already normalized.
 */
export function setLink(state: EditorState, href: string, typed = href): TransactionSpec {
  const sel = state.selection.main
  const link = linkAt(state, sel.from, sel.to)
  if (link !== null) {
    return {
      changes: { from: link.urlFrom, to: link.urlTo, insert: href },
      selection: { anchor: link.textFrom, head: link.textTo },
    }
  }
  if (sel.empty) {
    const insert = `[${typed}](${href})`
    return {
      changes: { from: sel.from, insert },
      selection: { anchor: sel.from + insert.length },
    }
  }
  const text = state.sliceDoc(sel.from, sel.to)
  return {
    changes: { from: sel.from, to: sel.to, insert: `[${text}](${href})` },
    selection: { anchor: sel.from + 1, head: sel.from + 1 + text.length },
  }
}

/** Takes the link away and keeps its text, selected. */
export function removeLink(state: EditorState): TransactionSpec | null {
  const sel = state.selection.main
  const link = linkAt(state, sel.from, sel.to)
  if (link === null) return null
  const text = state.sliceDoc(link.textFrom, link.textTo)
  return {
    changes: { from: link.from, to: link.to, insert: text },
    selection: { anchor: link.from, head: link.from + text.length },
  }
}
