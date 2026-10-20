/**
 * The Contents block (after ReUI's `rich-text-outline-node`): a `[toc]` line on
 * its own draws as the note's headings, each a link that jumps to it, kept
 * live as they change. `[toc]` is the Typora and Python-Markdown spelling, so
 * the note stays markdown other tools already read; GitHub shows it as text,
 * which says what it was meant to be.
 *
 * The line shows its source while the caret is on it, like a mermaid fence. A
 * block decoration, so a `StateField` (CodeMirror refuses block decorations
 * from a plugin).
 */
import { RangeSetBuilder, StateField, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { CONTENTS_LINE } from './blocks'
import { outlineOf, type OutlineHeading } from './outline'

/** The `[toc]` lines of a document, by their start. */
export function contentsLines(state: EditorState): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  let pos = 0
  let inFence = false
  for (const text of state.doc.iterLines()) {
    if (/^\s*(```|~~~)/.test(text)) inFence = !inFence
    if (!inFence && CONTENTS_LINE.test(text.trim()) && text.trim() === text) {
      out.push({ from: pos, to: pos + text.length })
    }
    pos += text.length + 1
  }
  return out
}

class ContentsWidget extends WidgetType {
  constructor(readonly headings: readonly OutlineHeading[]) {
    super()
  }

  override eq(other: ContentsWidget): boolean {
    return (
      other.headings.length === this.headings.length &&
      other.headings.every((h, i) => {
        const mine = this.headings[i]!
        return h.text === mine.text && h.level === mine.level && h.from === mine.from
      })
    )
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-contents'
    const title = document.createElement('p')
    title.className = 'cm-contents-title'
    title.textContent = 'Contents'
    box.append(title)
    if (this.headings.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'cm-contents-empty'
      empty.textContent = 'No headings yet. Add one and it shows up here.'
      box.append(empty)
      return box
    }
    const nav = document.createElement('nav')
    nav.setAttribute('aria-label', 'Contents')
    nav.className = 'cm-contents-list'
    const top = Math.min(...this.headings.map((h) => h.level))
    for (const h of this.headings) {
      const link = document.createElement('button')
      link.type = 'button'
      link.className = 'cm-contents-link'
      link.style.setProperty('--contents-depth', String(Math.min(h.level - top, 2)))
      link.textContent = h.text
      link.onmousedown = (e) => e.preventDefault()
      link.onclick = () => {
        // Read again at the press: the heading may have moved since this drew.
        const now = outlineOf(view.state).find((o) => o.text === h.text && o.level === h.level)
        const at = now?.from ?? h.from
        view.dispatch({
          selection: { anchor: at },
          effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 24 }),
        })
        view.focus()
      }
      nav.append(link)
    }
    box.append(nav)
    return box
  }

  /** The links take their own presses; anywhere else puts the caret there. */
  override ignoreEvent(event: Event): boolean {
    return event.target instanceof Element && event.target.closest('.cm-contents-link') !== null
  }
}

function build(state: EditorState): DecorationSet {
  const lines = contentsLines(state)
  if (lines.length === 0) return Decoration.none
  const headings = outlineOf(state)
  const sel = state.selection.main
  const builder = new RangeSetBuilder<Decoration>()
  for (const line of lines) {
    if (sel.from <= line.to && sel.to >= line.from) continue
    builder.add(
      line.from,
      line.to,
      Decoration.replace({ widget: new ContentsWidget(headings), block: true }),
    )
  }
  return builder.finish()
}

export const contentsBlock = StateField.define<DecorationSet>({
  create: build,
  update(value, tr) {
    return tr.docChanged || tr.selection !== undefined ? build(tr.state) : value
  },
  provide: (f) => EditorView.decorations.from(f),
})
