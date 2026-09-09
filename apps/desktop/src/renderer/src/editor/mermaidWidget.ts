/**
 * A rendered mermaid diagram, standing in for its fence in live preview (#6).
 *
 * **Asynchronous, in a synchronous API.** `toDOM` has to return an element now,
 * and mermaid resolves later — so the element it returns holds the fence's own
 * source, and the SVG replaces it when the render lands. That ordering is also
 * the whole failure story: a diagram that will not parse simply never gets
 * replaced, and what is on screen is the source you are still writing. A
 * diagram being wrong is an ordinary state of a document, not an error state,
 * and it degrades the way a broken image degrades to its alt text.
 *
 * **Lazy, and once.** Mermaid pulls d3 and a parser for every diagram type, and
 * a vault that never draws one should not pay for it. The import and the
 * `initialize` sit behind one module-level promise, so a note with five diagrams
 * loads it once.
 */
import { WidgetType } from '@codemirror/view'

type Mermaid = {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, source: string) => Promise<{ svg: string }>
}

let loading: Promise<Mermaid> | null = null

function mermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then((mod) => {
    const api = mod.default as unknown as Mermaid
    // `startOnLoad` would have it scan the document for `.mermaid` elements on
    // its own, which is the opposite of what a decoration wants: the editor says
    // what renders and when.
    //
    // `securityLevel: 'loose'` is NOT set, deliberately. A vault is shared, so a
    // diagram can arrive from a collaborator or from the agent, and mermaid's
    // strict default is what keeps a click handler out of a note.
    api.initialize({ startOnLoad: false, theme: 'dark' })
    return api
  })
  return loading
}

/** Test seam: the memo above is module state, so one test's load would
 *  otherwise still be held when the next one asserts on it. */
export function resetMermaidForTests(): void {
  loading = null
}

let seq = 0

export class MermaidWidget extends WidgetType {
  constructor(readonly source: string) {
    super()
  }

  /** Source equality and nothing else. `livePreview` rebuilds on docChanged,
   *  selectionSet AND viewport change, so a looser `eq` re-runs mermaid on every
   *  arrow key — which is the one thing that would make this feature cost
   *  something to have. */
  override eq(other: MermaidWidget): boolean {
    return other.source === this.source
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-mermaid'
    const source = document.createElement('pre')
    source.className = 'cm-mermaid-source'
    source.textContent = this.source
    wrap.appendChild(source)

    void mermaid()
      .then((api) => api.render(`cm-mermaid-${++seq}`, this.source))
      .then(({ svg }) => {
        // The decoration is rebuilt on every selection change, so this widget is
        // routinely gone by the time its render lands. Writing into a detached
        // node is wasted work and holds the DOM it wrote into alive.
        if (!wrap.isConnected) return
        wrap.innerHTML = svg
      })
      .catch(() => {
        // Nothing: the source is already what is on screen.
      })

    return wrap
  }

  /** The caret cannot land inside it — the fence's source is one keystroke away
   *  and is the thing to edit. Same contract as the image widget. */
  override ignoreEvent(): boolean {
    return true
  }
}
