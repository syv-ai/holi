/**
 * A note's comment threads, in the page: the panel's open state, the passage
 * a new thread is being written on, and where every thread's passage was
 * found in the text (`placeThreads`). `save` is the document's: a comment
 * quotes the file, so the file has to be what is shown.
 */
import { useEffect, useRef, useState } from 'react'
import { isResolved, type CommentAnchor } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'

import {
  addThreadAtom,
  refreshThreadsAtom,
  replyThreadAtom,
  resolveThreadAtom,
  threadsLoadAtom,
} from '@/state/comments'

import {
  placeThreads,
  selectionAnchor,
  setCommentRanges,
  type PlacedRange,
} from './document-comments'
import { useRichTextSelector } from './rich-text/rich-text-state'

export function useDocumentComments({
  editor,
  path,
  docs,
  head,
  save,
}: {
  editor: Editor | null
  path: string
  docs: readonly { path: string }[]
  /** The frontmatter and anything else the editor does not hold. */
  head: React.RefObject<string>
  save: () => Promise<void>
}) {
  // The note's comment threads: the panel, and their passages in the text.
  const threadsLoad = useAtomValue(threadsLoadAtom)(path)
  const refreshThreads = useSetAtom(refreshThreadsAtom)
  const addThread = useSetAtom(addThreadAtom)
  const replyThread = useSetAtom(replyThreadAtom)
  const resolveThread = useSetAtom(resolveThreadAtom)
  const [commentsOpen, setCommentsOpen] = useState(false)
  /** The passage a new thread is being written on. */
  const [draft, setDraft] = useState<CommentAnchor | null>(null)
  const [activeThread, setActiveThread] = useState<string | null>(null)
  /** Every thread whose passage was found in the text at the last placing. */
  const [placed, setPlaced] = useState<ReadonlySet<string>>(new Set())
  const threads = threadsLoad.state === 'ready' ? threadsLoad.threads : null
  const commentable = threadsLoad.state !== 'unavailable'
  const hasSelection = useRichTextSelector(editor, (current) =>
    current ? !current.state.selection.empty : false,
  )

  // Read again whenever the vault is: a pull or the agent may have written
  // the sidecar.
  useEffect(() => {
    void refreshThreads(path)
  }, [refreshThreads, path, docs])

  /** Place every thread in the text again and tint the open ones; between
   *  placings the tints follow the edits on their own. */
  const placeRef = useRef(() => undefined as void)
  placeRef.current = () => {
    if (!editor || editor.isDestroyed || threads === null) return
    const ranges: PlacedRange[] = placeThreads(editor, head.current, threads)
    setPlaced(new Set(ranges.map((range) => range.id)))
    const open = new Set(threads.filter((t) => !isResolved(t)).map((t) => t.id))
    setCommentRanges(editor, {
      ranges: ranges.filter((range) => open.has(range.id)),
    })
  }
  useEffect(() => placeRef.current(), [editor, threads])
  useEffect(() => {
    if (editor) setCommentRanges(editor, { active: activeThread })
  }, [editor, activeThread])

  /** The panel's thread, its passage scrolled into view. */
  function showThread(id: string) {
    setActiveThread(id)
    const thread = threads?.find((t) => t.id === id)
    if (!editor || !thread) return
    const [range] = placeThreads(editor, head.current, [thread])
    if (!range) return
    const { node } = editor.view.domAtPos(range.from)
    const element = node instanceof Element ? node : node.parentElement
    element?.scrollIntoView({ block: 'center' })
  }

  async function commentOnSelection() {
    if (!editor || !commentable) return
    // The anchor quotes the file, so the file has to be what is shown.
    await save()
    const anchor = selectionAnchor(editor, head.current)
    if (anchor === null) {
      toast.error('That passage can’t take a comment', {
        description: 'Select text in the note, outside images and raw HTML.',
      })
      return
    }
    setDraft(anchor)
    setActiveThread(null)
    setCommentsOpen(true)
  }

  /** A comment write: said when it fails, and rejected so its text stays. */
  async function commentWrite(what: string, run: () => Promise<unknown>) {
    try {
      await run()
    } catch (err) {
      toast.error(what, {
        description: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  /** A tint pressed in the text opens the panel on its thread. */
  const pressThread = (id: string) => {
    setCommentsOpen(true)
    setActiveThread(id)
  }

  return {
    threadsLoad,
    threads,
    commentable,
    commentsOpen,
    setCommentsOpen,
    draft,
    setDraft,
    activeThread,
    setActiveThread,
    placed,
    hasSelection,
    placeRef,
    pressThread,
    showThread,
    commentOnSelection,
    commentWrite,
    addThread,
    replyThread,
    resolveThread,
    refreshThreads,
  }
}
