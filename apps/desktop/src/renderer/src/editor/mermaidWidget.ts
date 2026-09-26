/**
 * A rendered mermaid diagram, standing in for its fence in live preview.
 *
 * `toDOM` must return now and mermaid resolves later, so the element holds the
 * fence's source until the SVG replaces it. A diagram that will not parse is
 * never replaced and shows its source, not an error.
 *
 * Lazy, and once: mermaid pulls d3 and every diagram parser, so the import sits
 * behind one module-level promise.
 */
import { WidgetType } from '@codemirror/view'

type Mermaid = {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, source: string) => Promise<{ svg: string }>
}

let loading: Promise<Mermaid> | null = null
/** The palette the loaded instance was configured with, so a flip is noticed. */
let configured: 'light' | 'dark' | null = null

/** The app's current mode, from the stamp `state/color-scheme.ts` puts on the
 *  root (both modes are stamped explicitly, D85). */
function appTheme(): 'light' | 'dark' {
  return document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'
}

function mermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then((mod) => mod.default as unknown as Mermaid)
  return loading.then((api) => {
    // Mermaid bakes the palette in at `initialize`, so re-run it when the mode
    // changes. Diagrams already on screen keep their DOM (`eq`) and stay in the
    // old palette until the fence is edited or the note reopened; fixing that
    // needs a StateEffect on the theme.
    const theme = appTheme()
    if (configured !== theme) {
      // No `startOnLoad`: the editor says what renders and when.
      //
      // `securityLevel: 'loose'` is deliberately NOT set: a diagram can come from
      // a collaborator or the agent, and the strict default keeps click handlers
      // out of a note.
      api.initialize({ startOnLoad: false, theme: theme === 'light' ? 'default' : 'dark' })
      configured = theme
    }
    return api
  })
}

/** Test seam: resets the module-level memo between tests. */
export function resetMermaidForTests(): void {
  loading = null
  configured = null
}

let seq = 0

export class MermaidWidget extends WidgetType {
  constructor(readonly source: string) {
    super()
  }

  /** Source equality only, or mermaid re-runs on every rebuild. */
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
        // Often gone by the time the render lands; do not write a detached node.
        if (!wrap.isConnected) return
        wrap.innerHTML = svg
      })
      .catch(() => {
        // Nothing: the source is already what is on screen.
      })

    return wrap
  }

  /** The widget takes no editor events; moving the caret in reveals the source. */
  override ignoreEvent(): boolean {
    return true
  }
}
