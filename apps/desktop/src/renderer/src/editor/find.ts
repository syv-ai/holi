/**
 * Find (and replace) in the open file: CodeMirror's search, with the app's own
 * find bar in place of CodeMirror's panel.
 *
 * CodeMirror's rather than Electron's `findInPage`: the editor renders only the
 * lines in view, so a page-level find would miss text further down a long note.
 *
 * The bar is drawn by React (`features/editor/FindBarHost.tsx`) into the empty
 * panel this publishes, the same way the frontmatter block is drawn (see
 * `frontmatter-portals.ts`). This module keeps the store, because the editor
 * layer must not depend on React.
 *
 * A match inside hidden markup or a widget (a table, the frontmatter block) is
 * found like any other: stepping to it selects it, which reveals the source.
 */
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  openSearchPanel,
  search,
  selectSelectionMatches,
} from '@codemirror/search'
import type { Extension } from '@codemirror/state'
import { EditorView, type KeyBinding, type Panel } from '@codemirror/view'

/** One open find bar, waiting to be drawn into. */
export interface FindPortal {
  /** Stable for the life of the panel; the React key. */
  readonly id: number
  /** The empty panel element, portalled into. */
  readonly el: HTMLElement
  readonly view: EditorView
  /** Bumped on every editor update the bar shows (query, matches, selection). */
  readonly version: number
  /** Whether the replace row is showing. */
  readonly replace: boolean
}

let nextId = 1
const portals = new Map<number, FindPortal>()
const listeners = new Set<() => void>()

/** Cached so `useSyncExternalStore` sees a stable reference between changes. */
let snapshot: readonly FindPortal[] = []

function publish(): void {
  snapshot = [...portals.values()]
  for (const listener of listeners) listener()
}

function change(id: number, patch: Partial<Pick<FindPortal, 'version' | 'replace'>>): void {
  const portal = portals.get(id)
  if (portal === undefined) return
  portals.set(id, { ...portal, ...patch })
  publish()
}

export function subscribeFindPortals(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function findPortals(): readonly FindPortal[] {
  return snapshot
}

/** Show or hide the replace row of a view's open bar. */
export function setFindReplace(view: EditorView, replace: boolean): void {
  for (const portal of portals.values()) {
    if (portal.view === view) change(portal.id, { replace })
  }
}

function findPanel(view: EditorView): Panel {
  const el = document.createElement('div')
  el.className = 'cm-find'
  const id = nextId++
  return {
    dom: el,
    top: true,
    mount() {
      portals.set(id, { id, el, view, version: 0, replace: false })
      publish()
    },
    update(u) {
      const portal = portals.get(id)
      if (portal === undefined) return
      if (u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.length > 0)) {
        change(id, { version: portal.version + 1 })
      }
    },
    destroy() {
      if (portals.delete(id)) publish()
    },
  }
}

/** ⌘⌥F: the bar with its replace row. A read-only file gets find only. */
function openFindAndReplace(view: EditorView): boolean {
  openSearchPanel(view)
  if (!view.state.readOnly) setFindReplace(view, true)
  return true
}

/**
 * The keys, in place of CodeMirror's `searchKeymap`: the same find keys, plus
 * ⌘⌥F. Its go-to-line (⌘⌥G) is left out, since it opens an unstyled dialog of
 * CodeMirror's own, and ⌘D is bound by each stack already. `search-panel` is
 * the scope the bar replays its own key presses in.
 */
export const findKeymap: readonly KeyBinding[] = [
  { key: 'Mod-f', run: openSearchPanel, scope: 'editor search-panel', preventDefault: true },
  {
    key: 'Mod-Alt-f',
    run: openFindAndReplace,
    scope: 'editor search-panel',
    preventDefault: true,
  },
  {
    key: 'F3',
    run: findNext,
    shift: findPrevious,
    scope: 'editor search-panel',
    preventDefault: true,
  },
  {
    key: 'Mod-g',
    run: findNext,
    shift: findPrevious,
    scope: 'editor search-panel',
    preventDefault: true,
  },
  { key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' },
  { key: 'Mod-Shift-l', run: selectSelectionMatches },
]

/**
 * The bar floats over the editor's top right corner rather than pushing the
 * text down. CodeMirror still counts it as a top panel, so a match it scrolls
 * to is never left under the bar. `EditorView.theme`, not a base theme, so it
 * beats `@codemirror/search`'s own match colours.
 */
const findTheme = EditorView.theme({
  '.cm-panels.cm-panels-top': {
    position: 'absolute',
    left: 'auto',
    right: '0',
    margin: '8px 12px 0 0',
    // A narrow pane squeezes the bar rather than pushing it past its left edge.
    maxWidth: 'calc(100% - 24px)',
    background: 'transparent',
    border: 'none',
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in oklab, var(--brand) 22%, transparent)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in oklab, var(--brand) 50%, transparent)',
  },
})

/**
 * A read-only editor's content is not `contenteditable`, so it could never take
 * focus, and CodeMirror only hears keys on its content: ⌘F would do nothing in
 * the one case where finding is all there is to do. A tab stop gives it focus.
 */
const focusableWhenReadOnly = EditorView.contentAttributes.compute(
  [EditorView.editable],
  (state): Record<string, string> => (state.facet(EditorView.editable) ? {} : { tabindex: '0' }),
)

/** Find in this editor: the search state, its bar, and its colours. */
export function findInFile(): Extension {
  return [search({ top: true, createPanel: findPanel }), findTheme, focusableWhenReadOnly]
}
