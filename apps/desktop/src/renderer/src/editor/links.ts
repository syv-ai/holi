/**
 * Click-to-navigate for links (docs/features/wiki-links.md). Wiki-links and
 * markdown links behave differently, because one is a widget and the other is
 * text:
 *
 *  - A wiki-link chip is a `Decoration.replace`, with no caret position inside
 *    it, so a plain click means go there. Once the selection touches it, live
 *    preview shows the raw `[[path]]`, where clicks are text clicks again.
 *
 *  - A markdown link is a `Decoration.mark` over editable text. A plain click
 *    places the caret, so navigation takes ⌘/Ctrl-click, as in VS Code.
 */
import { EditorView, ViewPlugin } from '@codemirror/view'
import { Facet, type Extension } from '@codemirror/state'

/** On the editor root while ⌘/Ctrl is down. The theme hangs the markdown-link
 *  pointer cursor off it — see `modifierHeldClass`. */
const MOD_HELD = 'cm-mod-held'

export interface LinkNav {
  /** Open a note or task file by its vault-relative path. No-op if nothing is
   *  there. */
  openNote: (path: string) => void
  openExternal: (url: string) => void
  /** Open the history sidebar for the focused note (the frontmatter header's
   *  `v.N`). Absent where there is no sidebar to open, and the version is then
   *  plain text. */
  openHistory?: () => void
}

/**
 * The same `nav` seam, for widgets that are not document text (the frontmatter
 * summary's links), so there is one path to `openExternal`.
 */
export const linkNavFacet = Facet.define<() => LinkNav, (() => LinkNav) | null>({
  combine: (values) => values[0] ?? null,
})

/** What a click resolves to. `null` means not a link: the click places the caret. */
export type LinkAction = { kind: 'note'; path: string } | { kind: 'external'; url: string } | null

export interface ClickTargets {
  /** `data-wiki-target` of the nearest chip ancestor, if any (note or task path). */
  wikiTarget?: string | undefined
  /** `data-href` of the nearest markdown-link ancestor, if any. */
  href?: string | undefined
  /** ⌘ (mac) or Ctrl. */
  modifier: boolean
}

/** The pure routing decision; the DOM lookup is the adapter's job. */
export function resolveLinkClick({ wikiTarget, href, modifier }: ClickTargets): LinkAction {
  // A chip wins over any enclosing link: it is the innermost thing clicked.
  if (wikiTarget) return { kind: 'note', path: wikiTarget }
  if (!href || !modifier) return null
  // Only http(s) leaves the app. A relative href is a vault path and routes internally.
  return /^https?:\/\//i.test(href) ? { kind: 'external', url: href } : { kind: 'note', path: href }
}

/**
 * Mark the editor while ⌘/Ctrl is held, so a markdown link shows a pointer only
 * when a click would navigate.
 *
 * Listens on `window`: hovering does not need editor focus. `blur` matters:
 * after ⌘-Tab away the keyup never arrives.
 */
const modifierHeldClass = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      window.addEventListener('keydown', this.sync)
      window.addEventListener('keyup', this.sync)
      window.addEventListener('blur', this.clear)
    }

    // Read off the event, not tracked per key: a `keyup` for another key while
    // ⌘ is still down must not clear it.
    sync = (e: KeyboardEvent): void => {
      this.view.dom.classList.toggle(MOD_HELD, e.metaKey || e.ctrlKey)
    }

    clear = (): void => {
      this.view.dom.classList.remove(MOD_HELD)
    }

    destroy(): void {
      window.removeEventListener('keydown', this.sync)
      window.removeEventListener('keyup', this.sync)
      window.removeEventListener('blur', this.clear)
    }
  },
)

/**
 * `nav` is a thunk, read at click time, since the renderer's state moves.
 *
 * Bound to `mousedown`, not `click`, and it has to be. The press moves the
 * selection, live preview un-renders the element, and CodeMirror rebuilds its
 * DOM before `mouseup`. The browser fires `click` only when both halves share a
 * target, so no `click` is ever dispatched. Returning `true` also stops
 * CodeMirror moving the caret into a link we are leaving.
 */
export function linkClickHandler(nav: () => LinkNav): Extension {
  return [
    modifierHeldClass,
    linkNavFacet.of(nav),
    EditorView.domEventHandlers({
      mousedown(event) {
        // Primary button only.
        if (event.button !== 0) return false
        const el = event.target as HTMLElement | null
        if (!el?.closest) return false
        const action = resolveLinkClick({
          wikiTarget: el.closest<HTMLElement>('[data-wiki-target]')?.dataset['wikiTarget'],
          href: el.closest<HTMLElement>('[data-href]')?.dataset['href'],
          modifier: event.metaKey || event.ctrlKey,
        })
        // Not a link, or a plain press on a markdown link: place the caret as usual.
        if (!action) return false
        if (action.kind === 'note') nav().openNote(action.path)
        else nav().openExternal(action.url)
        event.preventDefault()
        return true
      },
    }),
  ]
}
