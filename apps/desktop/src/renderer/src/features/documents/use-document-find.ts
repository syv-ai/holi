import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'

import { isMac } from '@/lib/platform'

import type { FindRequest } from './document-find-bar'

/**
 * Finding in the document: the find bar's request, ⌘F inside the view and
 * (from outside every view) in the document in front. `viewRef` is the
 * document view's root.
 */
export function useDocumentFind(
  editor: Editor | null,
  viewRef: React.RefObject<HTMLDivElement | null>,
) {
  const apple = isMac()
  /** The find bar, open while set; a new request refocuses it. */
  const [find, setFind] = useState<FindRequest | null>(null)

  /**
   * ⌘F (Ctrl+F elsewhere) anywhere in this document's view opens its own find
   * bar, so each view of a split has its own. The selection seeds the query
   * when it is one line. With the bar open, ⌘G and ⇧⌘G step from the text
   * too, and Escape in the text closes it.
   */
  function isFindKey(event: KeyboardEvent | React.KeyboardEvent) {
    const mod = apple ? event.metaKey : event.ctrlKey
    return mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f'
  }

  function openFind() {
    if (!editor) return
    const { from, to, $from, $to } = editor.state.selection
    const text = from < to && $from.sameParent($to) ? editor.state.doc.textBetween(from, to) : null
    setFind((current) => ({ token: (current?.token ?? 0) + 1, text }))
  }

  /**
   * ⌘F with focus outside every view (the sidebar after opening a document
   * from it, or nothing at all) finds in the document in front: the only
   * view, or a split's focused member. A view that took the key itself has
   * already claimed it, and a dialog keeps its keys.
   */
  const openFindRef = useRef(openFind)
  openFindRef.current = openFind
  useEffect(() => {
    if (!editor) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !isFindKey(event)) return
      const root = viewRef.current
      const target = event.target instanceof Element ? event.target : null
      if (!root || target?.closest("[data-pane], [role='dialog']")) return
      const pane = root.closest('[data-pane]')
      const inFront =
        !pane ||
        pane.hasAttribute('data-pane-focused') ||
        document.querySelectorAll('[data-pane]').length === 1
      if (!inFront) return
      event.preventDefault()
      openFindRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, apple])

  return { find, setFind, apple, isFindKey, openFind }
}
