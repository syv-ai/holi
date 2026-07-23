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
 *    "click navigates" can never fight "click to edit" — the two never coexist.
 *
 *  - A **markdown link** is a `Decoration.mark` over real, editable text, but it only
 *    carries `data-href` on a **non-active** line — the moment your caret is on the line
 *    live-preview un-renders it to raw `[text](url)`, where a click is ordinary text again.
 *    So a plain click on the *rendered* link navigates (the handler prevents the default,
 *    so the line never activates); to edit the link text you click into the line first,
 *    which reveals the raw markdown. ⌘/Ctrl-click was the original bargain, but any click
 *    on the line un-rendered the link before the modifier could land — navigation you
 *    could not actually reach. Plain-click matches wiki-links and is what a link should do.
 */
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

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
export function resolveLinkClick({ wikiTarget, taskTarget, href }: ClickTargets): LinkAction {
  // A chip wins over any enclosing link: it is the innermost thing you clicked, and it
  // is a widget, so there is no caret to place inside it. A chip is note-kind or
  // task-kind and never both, so the order between these two is not a precedence rule.
  if (taskTarget) return { kind: 'task', id: taskTarget }
  if (wikiTarget) return { kind: 'note', path: wikiTarget }
  // A rendered markdown link navigates on a plain click. `data-href` is only present on
  // a non-active (rendered) line, so this never fires on raw `[text](url)` text you are
  // editing — the modifier requirement is gone because the un-render-on-active-line
  // behaviour made it unreachable in practice.
  if (!href) return null
  // Only http(s) leaves the app. A relative href is a vault path, so it routes internally
  // like a wiki-link rather than handing the OS something it cannot open.
  return /^https?:\/\//i.test(href) ? { kind: 'external', url: href } : { kind: 'note', path: href }
}

/** `nav` is a thunk, read at click time — the renderer's atoms move under us, and the
 * editor is rebuilt per doc (the docExistsFacet/mentionData pattern). */
export function linkClickHandler(nav: () => LinkNav): Extension {
  return EditorView.domEventHandlers({
    click(event) {
      const el = event.target as HTMLElement | null
      if (!el?.closest) return false
      const action = resolveLinkClick({
        wikiTarget: el.closest<HTMLElement>('[data-wiki-target]')?.dataset['wikiTarget'],
        taskTarget: el.closest<HTMLElement>('[data-task-target]')?.dataset['taskTarget'],
        href: el.closest<HTMLElement>('[data-href]')?.dataset['href'],
        modifier: event.metaKey || event.ctrlKey,
      })
      if (!action) return false
      if (action.kind === 'note') nav().openNote(action.path)
      else if (action.kind === 'task') nav().openTask(action.id)
      else nav().openExternal(action.url)
      event.preventDefault()
      return true
    },
  })
}
