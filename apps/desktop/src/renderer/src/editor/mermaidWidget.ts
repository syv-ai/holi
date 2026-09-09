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
/** The palette the loaded instance was configured with, so a flip is noticed. */
let configured: 'light' | 'dark' | null = null

/** The app's current mode, from the stamp `color-scheme.ts` puts on the root.
 *  Both modes are stamped explicitly (D85), and `lib/mail-frame.ts` reads it the
 *  same way for the same reason: a surface that paints its own colours has to be
 *  told which ones. */
function appTheme(): 'light' | 'dark' {
  return document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'
}

function mermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then((mod) => mod.default as unknown as Mermaid)
  return loading.then((api) => {
    // Mermaid bakes the palette in at `initialize`, so this runs again whenever
    // the app's mode has changed since the last one — otherwise a vault switched
    // to light draws black-on-black diagrams. What it does NOT do is repaint the
    // diagrams already on screen: their DOM is reused (that is what `eq` is for)
    // and nothing recomputes a decoration on a theme flip. They come right when
    // the fence is next edited or the note reopened, and closing that properly
    // means a StateEffect on the theme, which is more machinery than the case
    // has yet earned.
    const theme = appTheme()
    if (configured !== theme) {
      // `startOnLoad` would have it scan the document for `.mermaid` elements on
      // its own, which is the opposite of what a decoration wants: the editor
      // says what renders and when.
      //
      // `securityLevel: 'loose'` is NOT set, deliberately. A vault is shared, so
      // a diagram can arrive from a collaborator or from the agent, and
      // mermaid's strict default is what keeps a click handler out of a note.
      api.initialize({ startOnLoad: false, theme: theme === 'light' ? 'default' : 'dark' })
      configured = theme
    }
    return api
  })
}

/** Test seam: the memo above is module state, so one test's load would
 *  otherwise still be held when the next one asserts on it. */
export function resetMermaidForTests(): void {
  loading = null
  configured = null
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
