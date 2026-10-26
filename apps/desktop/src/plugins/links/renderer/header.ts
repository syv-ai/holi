/**
 * A link file's card in its own tab, between the frontmatter and the body:
 * the page it saves, with Open. It follows the `url` in the text as it is
 * now, so editing the address redraws it.
 *
 * A StateField, since CodeMirror refuses block decorations from a plugin.
 */
import { type EditorState, type Extension, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { bodyStart } from '@/plugin-api'
import { linkTitle, parseLinkFile } from '../shared/link-file'
import { PreviewCard } from './PreviewCard'

/** Each card's React root, by its DOM: CodeMirror keeps an equal widget's
 *  DOM when the document changes and destroys only the newest widget, so the
 *  root belongs to the DOM, not to whichever widget made it. */
const roots = new WeakMap<HTMLElement, Root>()

class CardWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly title: string,
  ) {
    super()
  }

  override eq(other: CardWidget): boolean {
    return other.url === this.url && other.title === this.title
  }

  override toDOM(): HTMLElement {
    const dom = document.createElement('div')
    dom.className = 'cm-link-card pt-1 pb-4'
    // In the text's column, as the editor's other blocks (a diagram) are.
    dom.style.margin = '0 var(--editor-inset)'
    const root = createRoot(dom)
    roots.set(dom, root)
    root.render(createElement(PreviewCard, { url: this.url, title: this.title }))
    return dom
  }

  override destroy(dom: HTMLElement): void {
    const root = roots.get(dom)
    roots.delete(dom)
    // After CodeMirror's own update, never inside a render.
    if (root !== undefined) queueMicrotask(() => root.unmount())
  }

  override ignoreEvent(): boolean {
    return true
  }
}

/** The card for `path`'s file as `state` holds it, or none while its address
 *  is missing or not a web address (the frontmatter row says why). */
function cardFor(state: EditorState, path: string): DecorationSet {
  const text = state.doc.toString()
  let url: string
  try {
    url = parseLinkFile(text, path).url
  } catch {
    return Decoration.none
  }
  // Below the frontmatter's closing fence, at the end of its line, so the
  // body's first line comes after the card; above everything with none.
  const start = bodyStart(text)
  const at = start > 0 && text[start - 1] === '\n' ? start - 1 : start
  return Decoration.set([
    Decoration.widget({
      widget: new CardWidget(url, linkTitle(path)),
      block: true,
      side: at === 0 ? -1 : 1,
    }).range(at),
  ])
}

/** The card for the link file at `path`. */
export function linkHeader(path: string): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => cardFor(state, path),
    update: (deco, tr) => (tr.docChanged ? cardFor(tr.state, path) : deco),
    provide: (field) => EditorView.decorations.from(field),
  })
}
