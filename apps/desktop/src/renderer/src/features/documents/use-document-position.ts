import { useEffect } from 'react'
import { useAtom } from 'jotai'
import type { Editor } from '@tiptap/react'

import { pendingHeadingAtom } from '@/state/open-document'
import { useViewMemory } from '@/state/view-memory'

import { landOnHeading } from './document-headings'

/**
 * Where the reader is in the document: a tab switched back to opens with the
 * caret and the scroll where it was left, and a Holi link that named a
 * heading lands the caret on it once the document is in the editor.
 * `markdown` is the document as it would be saved.
 */
export function useDocumentPosition({
  editor,
  remote,
  path,
  scrollerRef,
  markdown,
}: {
  editor: Editor | null
  remote: string | null
  path: string
  scrollerRef: React.RefObject<HTMLDivElement | null>
  markdown: () => string
}): void {
  // A tab switched back to opens where it was left: the caret and the
  // scroll, kept as they move (`view-memory.ts`). A link to a heading
  // lands on the heading instead.
  const memory = useViewMemory()
  const [pendingHeading, setPendingHeading] = useAtom(pendingHeadingAtom)
  const headingWaiting = pendingHeading?.path === path
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!editor || editor.isDestroyed || remote === null || scroller === null) return
    const spot = memory.get(remote, path)
    if (spot !== undefined && !headingWaiting) {
      const size = editor.state.doc.content.size
      const clamp = (at: number) => Math.min(Math.max(at, 1), size - 1)
      try {
        editor.commands.setTextSelection({
          from: clamp(spot.anchor),
          to: clamp(spot.head),
        })
      } catch {
        // A position the text no longer has: the caret stays at the top.
      }
      scroller.scrollTop = spot.scrollTop
      // Again once the page has laid out, should it not have yet.
      requestAnimationFrame(() => {
        scroller.scrollTop = spot.scrollTop
      })
    }
    const noteSelection = () => {
      const { anchor, head } = editor.state.selection
      memory.note(remote, path, { anchor, head })
    }
    const noteScroll = () => memory.note(remote, path, { scrollTop: scroller.scrollTop })
    editor.on('selectionUpdate', noteSelection)
    scroller.addEventListener('scroll', noteScroll, { passive: true })
    return () => {
      editor.off('selectionUpdate', noteSelection)
      scroller.removeEventListener('scroll', noteScroll)
    }
    // Once per editor: a heading arriving later is the effect below's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, remote, path, memory])

  // A Holi link that named a heading lands the caret on it once the
  // document is in the editor.
  useEffect(() => {
    if (!editor || editor.isDestroyed || pendingHeading?.path !== path) return
    landOnHeading(editor, markdown(), pendingHeading.heading)
    setPendingHeading(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, pendingHeading, path])
}
