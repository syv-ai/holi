/**
 * Click-to-navigate for links (notes-editor PRD FR-6 wiki-links, FR-7 markdown links).
 *
 * The chip widget was always built for this — it sets `data-wiki-target` and returns
 * `ignoreEvent() → false` so clicks reach the editor — but nothing ever listened. This is
 * the missing consumer.
 *
 * Wiki-links and markdown links deliberately behave differently, because one is a widget
 * and the other is text:
 *
 *  - A **wiki-link chip** is a `Decoration.replace` — there is no caret position "inside"
 *    it to want. Clicking it can only sensibly mean *go there*. And a chip only exists on
 *    a non-active line: the moment your caret is on that line the live-preview reveal
 *    un-renders it to raw `[[path]]`, where clicks are ordinary text clicks again. So
 *    "click navigates" never fights "click to edit" — the two never coexist.
 *
 *    That un-rendering is also why navigation is handled on `mousedown`: the press that
 *    navigates is the press that makes the line active, and the DOM it started on is gone
 *    before a `click` event could be dispatched. See `linkClickHandler`.
 *
 *  - A **markdown link** is a `Decoration.mark` over real, editable text. A plain click
 *    there means *put my caret in it*, so navigation takes ⌘/Ctrl-click — the same bargain
 *    VS Code strikes, and the only one that leaves the link text editable. `data-href` is
 *    only present on a non-active (rendered) line, so ⌘-click the link while your caret is
 *    elsewhere; clicking into its line first reveals the raw `[text](url)` to edit.
 */
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/** On the editor root while ⌘/Ctrl is down. The theme hangs the markdown-link
 *  pointer cursor off it — see `modifierHeldClass`. */
const MOD_HELD = 'cm-mod-held'

export interface LinkNav {
  /** Open a note by its vault-relative path. No-op if nothing is there. */
  openNote: (path: string) => void
  /** Open a task by its stable id (D27). No-op if it is gone. */
  openTask: (id: string) => void
  openExternal: (url: string) => void
}

/** What a click resolves to. `null` — the common case — means "not a link, leave it
 * alone", which is what keeps ordinary clicks placing the caret. */
export type LinkAction =
  | { kind: 'note'; path: string }
  | { kind: 'task'; id: string }
  | { kind: 'external'; url: string }
  | null

export interface ClickTargets {
  /** `data-wiki-target` of the nearest note-chip ancestor, if any. */
  wikiTarget?: string | undefined
  /** `data-task-target` of the nearest task-chip ancestor, if any. */
  taskTarget?: string | undefined
  /** `data-href` of the nearest markdown-link ancestor, if any. */
  href?: string | undefined
  /** ⌘ (mac) or Ctrl. */
  modifier: boolean
}

/** The pure routing decision — a headless core, per the slash-command shape. The DOM
 * lookup is the adapter's problem; the branches worth being sure about are here. */
export function resolveLinkClick({
  wikiTarget,
  taskTarget,
  href,
  modifier,
}: ClickTargets): LinkAction {
  // A chip wins over any enclosing link: it is the innermost thing you clicked, and it
  // is a widget, so there is no caret to place inside it. A chip is note-kind or
  // task-kind and never both, so the order between these two is not a precedence rule.
  if (taskTarget) return { kind: 'task', id: taskTarget }
  if (wikiTarget) return { kind: 'note', path: wikiTarget }
  // A markdown link is editable text, so navigation takes ⌘/Ctrl-click; a plain click
  // keeps placing the caret.
  if (!href || !modifier) return null
  // Only http(s) leaves the app. A relative href is a vault path, so it routes internally
  // like a wiki-link rather than handing the OS something it cannot open.
  return /^https?:\/\//i.test(href) ? { kind: 'external', url: href } : { kind: 'note', path: href }
}

/**
 * Mark the editor while ⌘/Ctrl is held, so the cursor can tell the truth.
 *
 * A markdown link only navigates on ⌘/Ctrl-click (see the header), but the theme
 * gave it `cursor: pointer` unconditionally — so plain hover advertised a click
 * that does nothing, on text whose plain click actually means *place the caret*.
 * The cursor now changes exactly when the click would.
 *
 * Listens on `window`, not on the editor: the pointer matters while you are
 * *hovering*, which does not require the editor to have focus. `blur` is not
 * optional — ⌘-Tab away and the keyup never arrives, which would leave every
 * link stuck showing a pointer until the next ⌘ press.
 *
 * Wiki-link chips are deliberately untouched: they navigate on a plain click, so
 * their pointer was already honest.
 */
const modifierHeldClass = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      window.addEventListener('keydown', this.sync)
      window.addEventListener('keyup', this.sync)
      window.addEventListener('blur', this.clear)
    }

    // Read off the event rather than tracked per-key: a `keyup` for some other
    // key while ⌘ is still down must not clear it, and `metaKey`/`ctrlKey` are
    // on every keyboard event precisely so this can be a single question.
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
 * `nav` is a thunk, read at click time — the renderer's atoms move under us, and the
 * editor is rebuilt per doc (the docExistsFacet/mentionData pattern).
 *
 * **Bound to `mousedown`, not `click`, and it has to be.**
 *
 * Live preview un-renders whichever line holds the caret, so the press that is
 * supposed to navigate is also the press that makes that line active — and
 * CodeMirror rebuilds the line's DOM between `mousedown` and `mouseup`. The
 * browser only fires `click` when both halves share a target, so with the chip
 * or link element replaced underneath it, **no `click` event is ever
 * dispatched**. The handler sat on `click` and simply never ran: measured, a
 * press on a wiki chip reported `mousedown` on `.cm-wikilink`, `mouseup` on a
 * different span, and no `click` at all. Links appeared dead with and without
 * the modifier.
 *
 * `mousedown` is the last moment the rendered decoration still exists, which is
 * exactly the moment the decision needs to be made. Returning `true` also stops
 * CodeMirror moving the caret into a link we are navigating away from.
 */
export function linkClickHandler(nav: () => LinkNav): Extension {
  return [
    modifierHeldClass,
    EditorView.domEventHandlers({
      mousedown(event) {
        // Primary button only: a right-click wants its context menu and a
        // middle-click paste is not a navigation.
        if (event.button !== 0) return false
        const el = event.target as HTMLElement | null
        if (!el?.closest) return false
        const action = resolveLinkClick({
          wikiTarget: el.closest<HTMLElement>('[data-wiki-target]')?.dataset['wikiTarget'],
          taskTarget: el.closest<HTMLElement>('[data-task-target]')?.dataset['taskTarget'],
          href: el.closest<HTMLElement>('[data-href]')?.dataset['href'],
          modifier: event.metaKey || event.ctrlKey,
        })
        // Not a link, or a plain press on a markdown link: fall through so the
        // press keeps placing the caret and starting a selection as usual.
        if (!action) return false
        if (action.kind === 'note') nav().openNote(action.path)
        else if (action.kind === 'task') nav().openTask(action.id)
        else nav().openExternal(action.url)
        event.preventDefault()
        return true
      },
    }),
  ]
}
